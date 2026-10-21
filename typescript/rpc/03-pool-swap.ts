/**
 * Example 3, off chain, VANILLA JSON-RPC: swapping directly against one pool with viem only.
 *
 * Guide:    https://btr.markets/docs/5-1-1-basic-operations#3-swap
 * Twin:     ../sdk/03-pool-swap.ts     (same job, using @btr-protocol/sdk)
 * On chain: ../../foundry/test/03_PoolSwap.t.sol
 *
 * WHY THIS ONE. Two `eth_call`s and two transactions against ABI fragments you can read. No BTR
 * dependency, so the same shape ports to ethers, web3.py or `cast` unchanged.
 *
 * WHAT YOU GIVE UP: `SwapQuote` is a 13-field tuple and you are decoding it yourself. Get a field
 * order wrong and you will read `protoFee` as a price without anything throwing.
 *
 * Run:  bun run rpc/03-pool-swap.ts
 *       BTR_PRIVATE_KEY=0x.. BTR_RPC_URL=http://127.0.0.1:8545 bun run rpc/03-pool-swap.ts
 */
import { encodeFunctionData } from 'viem';
import { deadline, floorFrom, fmt, pool, token, withRetry, type Address } from '../src/config.ts';
import {
  ERC20_ABI, POOL_ABI, armed, balanceOf, decimalsOf, publicClient, send, senderOrPlaceholder,
  type Call,
} from '../src/viem-client.ts';

export const quote = (p: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint) =>
  withRetry(() =>
    publicClient.readContract({
      address: p, abi: POOL_ABI, functionName: 'getSwapQuote', args: [tokenIn, tokenOut, amountIn],
    }),
  );

export const approveCall = (tk: Address, spender: Address, amount: bigint): Call => ({
  to: tk,
  data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }),
  label: 'approve',
});

/** Quote, then approve, then swap. In that order, every time. */
export async function swapCalls(
  p: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint, slippageBps: number, recipient: Address,
) {
  const q = await quote(p, tokenIn, tokenOut, amountIn);
  if (q.amountOut === 0n) throw new Error('quote returned zero: that is a failure, not a price');
  const minAmountOut = floorFrom(q.amountOut, slippageBps);
  const calls: Call[] = [
    approveCall(tokenIn, p, amountIn),
    {
      to: p,
      // The pool pulls `tokenIn` with `transferFrom(msg.sender)`, which is why the approval above
      // is not optional and why this cannot be batched through Multicall3: under Multicall3 the
      // `msg.sender` the pool sees is the multicall contract, not the user.
      data: encodeFunctionData({
        abi: POOL_ABI, functionName: 'swap_qe',
        args: [tokenIn, tokenOut, amountIn, minAmountOut, recipient, deadline()],
      }),
      label: 'swap',
    },
  ];
  return { q, minAmountOut, calls };
}

if (import.meta.main) {
  const p = pool('stablePool');
  const tokenIn = token('USDCB');
  const tokenOut = token('USDT');
  const amountIn = 1_000n * 10n ** BigInt(await decimalsOf(tokenIn));
  const recipient = senderOrPlaceholder;

  const { q, minAmountOut, calls } = await swapCalls(p, tokenIn, tokenOut, amountIn, 50, recipient);
  console.log(`pool        ${p}`);
  console.log(`amountIn    ${fmt(amountIn)} USDCB`);
  console.log(`quoted out  ${fmt(q.amountOut)} USDT`);
  console.log(`floor       ${fmt(minAmountOut)} USDT   (50 bps)`);
  console.log(`spread      ${q.spreadPbps} pbps`);
  console.log(`mark / mid  ${fmt(q.markPrice)} / ${fmt(q.midPrice)}`);
  console.log(`route       ${q.routeHops.join(' -> ')}`);

  const before = armed ? await balanceOf(tokenOut, recipient) : 0n;
  await send(calls);
  if (armed) {
    const got = (await balanceOf(tokenOut, recipient)) - before;
    console.log(`\nfilled      ${fmt(got)} USDT`);
    if (got < minAmountOut) throw new Error('filled below the floor');
  }
}
