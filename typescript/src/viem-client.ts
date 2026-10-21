/**
 * Plumbing for the vanilla-JSON-RPC examples: a viem public client, an optional wallet, and the
 * ABI fragments themselves.
 *
 * THE POINT OF THE `rpc/` DIRECTORY is that BTR needs no SDK. Everything below is a human-readable
 * ABI fragment you could equally paste into ethers, web3.py, cast or a raw `eth_call`. Nothing
 * here imports `@btr-protocol/sdk`.
 *
 * DRY RUN IS THE DEFAULT. Without `BTR_PRIVATE_KEY` the write examples print calldata and stop.
 */
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config, privateKey, rpcUrl, type Address, type Hex } from './config.ts';

export const chain = {
  id: config.chainId,
  name: config.name,
  nativeCurrency: { name: config.nativeSymbol, symbol: config.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
} as const;

export const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

export const account = privateKey ? privateKeyToAccount(privateKey) : null;
export const walletClient = account
  ? createWalletClient({ account, chain, transport: http(rpcUrl) })
  : null;
export const armed = walletClient !== null;

/** The whole read surface a consumer needs, as text. Copy the lines you call. */
export const ORACLE_ABI = parseAbi([
  'struct FeedData { uint256 mark1e18; uint32 sigmaPbps; uint32 updatedAtSecs; uint16 ttlSecs; uint16 confidenceBps; uint16 flags; uint16 maxDevBps; uint48 sourceTsMs; }',
  'function getFeed(bytes32 feedId) view returns (FeedData)',
  'function isFeedFresh(bytes32 feedId) view returns (bool)',
  'function isFeedFresh(bytes32 feedId, uint32 maxAge) view returns (bool)',
  'error FeedNotFound(bytes32 feedId)',
]);

export const POOL_ABI = parseAbi([
  'struct SwapQuote { uint256 amountOut; uint256 amountIn; uint16 spreadPbps; uint256 protoFee; uint256 lpFee; int8 skewIn; int8 skewOut; uint256 markPrice; uint256 midPrice; uint256 covToll; address[] routeHops; uint256[] hopAmounts; uint256[] hopPrices; }',
  'struct DepositResult { uint256 lpAmount; uint256 actualDeposit; uint256 deadLp; }',
  'struct WithdrawResult { uint256 amountOut; }',
  'function getSwapQuote(address tokenIn, address tokenOut, uint256 amountIn) view returns (SwapQuote)',
  'function swap_qe(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient, uint256 deadline) payable returns (uint256)',
  'function deposit(address token, uint256 amount) payable returns (DepositResult)',
  'function withdraw(address token, uint256 lpAmount, uint256 minAmountOut, uint256 deadline) returns (WithdrawResult)',
  'function swapLiability(address tokenIn, address tokenOut, uint256 lpAmountIn, uint256 minLpAmountOut, uint256 deadline) returns (uint256)',
  'function previewWithdraw(address tk, uint256 lp) view returns (uint256 amountOut, uint256 haircut)',
  'function getLPBalance(address user, address tk) view returns (uint256)',
  'function maxRedeem(address owner, address tk) view returns (uint256)',
  'function getCoverageRatio(address tk) view returns (uint256)',
  'function getRiskFlags(address tk) view returns (uint16)',
  'function baseToken() view returns (address)',
  'function flowCooldownSecs() view returns (uint16)',
]);

export const ROUTER_ABI = parseAbi([
  'struct Hop { address pool; address tokenOut; }',
  'struct Part { address tokenIn; uint256 amountIn; Hop[] hops; }',
  'struct Floor { address token; uint256 minOut; }',
  'function swap(Part[] parts, Floor[] floors, address recipient, uint256 deadline) returns (uint256[])',
  'function factory() view returns (address)',
]);

export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

export interface Call {
  to: Address;
  data: Hex;
  label: string;
}

/**
 * Send in order, or print. Sequential, never `Promise.all`: these are nonce-ordered transactions
 * from one account, and an approval that lands after the swap it authorised is not an approval.
 */
export async function send(calls: Call[]) {
  if (!walletClient) {
    console.log('\nDRY RUN (set BTR_PRIVATE_KEY to send). Calldata:');
    for (const c of calls) console.log(`  ${c.label.padEnd(16)} to=${c.to}\n    ${c.data}`);
    return;
  }
  for (const c of calls) {
    const hash = await walletClient.sendTransaction({ to: c.to, data: c.data });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${c.label} reverted: ${hash}`);
    console.log(`  ${c.label.padEnd(16)} ${hash}`);
  }
}

export const balanceOf = (token: Address, owner: Address) =>
  publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });

export const decimalsOf = (token: Address) =>
  publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' });

export const senderOrPlaceholder = (account?.address ??
  '0x000000000000000000000000000000000000dEaD') as Address;
