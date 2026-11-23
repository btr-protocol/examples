/**
 * The one piece of plumbing the SDK examples share: send a transaction, or, when no key is
 * supplied, print what would have been sent and stop.
 *
 * DRY-RUN IS THE DEFAULT ON PURPOSE. `bun run sdk/03-pool-swap.ts` against a live chain should
 * not move anyone's money because they were reading an example. Set `BTR_PRIVATE_KEY` to arm it,
 * and point `BTR_RPC_URL` at a local anvil fork while you are learning.
 */
import { createHttpProvider, privateKeyProvider, privateKeyToAddress, send as sdkSend } from '@btr-protocol/sdk/eth';
import { encodeFn } from '@btr-protocol/sdk/eth';
import { ERC20_ABI } from '@btr-protocol/sdk/eth';
import { readContract } from '@btr-protocol/sdk/eth';
import { privateKey, rpcUrl, withRetry, type Address, type Hex } from './config.ts';

export const provider = createHttpProvider(rpcUrl);
/** The signing wallet: answers `eth_accounts` and signs `eth_sendTransaction` locally. Every write
 *  goes through the SDK's one writer, `send()`. */
const signer = privateKey ? privateKeyProvider(rpcUrl, privateKey) : null;
export const account: Address | null = privateKey ? privateKeyToAddress(privateKey) : null;
export const armed = signer !== null;

export interface Call {
  to: Address;
  data: Hex;
  label: string;
}

/** Build one call from an ABI. Kept separate from sending so a dry run can print it. */
export function call(to: Address, abi: unknown, functionName: string, args: readonly unknown[], label = functionName): Call {
  // biome-ignore lint/suspicious/noExplicitAny: the SDK's Abi type is structural
  return { to, data: encodeFn({ abi: abi as any, functionName, args }) as Hex, label };
}

/**
 * Send the calls in order, or print them. Returns the receipts, empty on a dry run.
 *
 * Sequential, never `Promise.all`: these are nonce-ordered transactions from one account, and
 * an approval that lands after the swap it was meant to authorise is not an approval.
 */
export async function send(calls: Call[]): Promise<unknown[]> {
  if (!signer) {
    console.log('\nDRY RUN (set BTR_PRIVATE_KEY to send). Calldata:');
    for (const c of calls) console.log(`  ${c.label.padEnd(16)} to=${c.to}\n    ${c.data}`);
    return [];
  }
  const receipts: unknown[] = [];
  for (const c of calls) {
    // send() estimates, signs, broadcasts and waits; a mined revert throws TxRevertedError. No
    // withRetry here: a timeout after the broadcast must not send the same call twice.
    const [{ hash, receipt }] = await sdkSend(signer, [c], { label: c.label });
    console.log(`  ${c.label.padEnd(16)} ${hash}`);
    receipts.push(receipt);
  }
  return receipts;
}

export const approve = (token: Address, spender: Address, amount: bigint): Call =>
  call(token, ERC20_ABI, 'approve', [spender, amount], 'approve');

export const balanceOf = (token: Address, owner: Address): Promise<bigint> =>
  withRetry(() => readContract<bigint>(provider, token, ERC20_ABI, 'balanceOf', [owner]));

export const decimalsOf = (token: Address): Promise<number> =>
  withRetry(() => readContract<bigint>(provider, token, ERC20_ABI, 'decimals', [])).then(Number);
