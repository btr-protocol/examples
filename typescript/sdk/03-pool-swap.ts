/**
 * Example 3, off chain, WITH THE SDK: swapping directly against one pool.
 *
 * Guide:    https://btr.markets/docs/5-1-1-basic-operations#3-swap
 * Twin:     ../rpc/03-pool-swap.ts     (same job, viem only, no SDK)
 * On chain: ../../foundry/test/03_PoolSwap.t.sol
 *
 * WHY THIS ONE. `getSwapQuote` is a first-class SDK call: the quote comes back as a typed
 * `SwapQuote` with `markPrice`, `midPrice`, `spreadPbps` and `covToll` already named, and
 * `POOL_ABI` is the deployed one (the swap entry point is `swap_qe`) rather than a hand-copied
 * fragment. Pick it when you want the pool's own analytics along with the fill.
 *
 * Run:  bun run sdk/03-pool-swap.ts          (dry run: prints calldata)
 *       BTR_PRIVATE_KEY=0x.. BTR_RPC_URL=http://127.0.0.1:8545 bun run sdk/03-pool-swap.ts
 */
import { getSwapQuote, type SwapQuote } from '@btr-protocol/sdk/pool';
import { POOL_ABI } from '@btr-protocol/sdk/abis';
import { deadline, floorFrom, fmt, pool, token, withRetry, type Address } from '../src/config.ts';
import { account, approve, armed, balanceOf, call, decimalsOf, provider, send } from '../src/sdk-wallet.ts';

export const quote = (p: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint) =>
  withRetry(() => getSwapQuote(provider, p, tokenIn, tokenOut, amountIn)) as Promise<SwapQuote>;

/**
 * Three calls, always in this order. Skipping the quote is how you end up with `minAmountOut = 0`
 * and no protection at all; skipping the approval is the most common first-integration failure,
 * because the pool pulls `tokenIn` with `transferFrom(msg.sender)`.
 */
export async function swapCalls(
  p: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number,
  recipient: Address,
) {
  const q = await quote(p, tokenIn, tokenOut, amountIn);
  if (q.amountOut === 0n) throw new Error('quote returned zero: that is a failure, not a price');
  const minAmountOut = floorFrom(q.amountOut, slippageBps);
  return {
    q,
    minAmountOut,
    calls: [
      approve(tokenIn, p, amountIn),
      call(p, POOL_ABI, 'swap_qe', [tokenIn, tokenOut, amountIn, minAmountOut, recipient, deadline()], 'swap'),
    ],
  };
}

if (import.meta.main) {
  const p = pool('stablePool');
  const tokenIn = token('USDCB');
  const tokenOut = token('USDT');
  const amountIn = 1_000n * 10n ** BigInt(await decimalsOf(tokenIn));
  const recipient = (account ?? '0x000000000000000000000000000000000000dEaD') as Address;

  const { q, minAmountOut, calls } = await swapCalls(p, tokenIn, tokenOut, amountIn, 50, recipient);

  console.log(`pool        ${p}`);
  console.log(`amountIn    ${fmt(amountIn)} USDCB`);
  console.log(`quoted out  ${fmt(q.amountOut)} USDT`);
  console.log(`floor       ${fmt(minAmountOut)} USDT   (50 bps tolerance)`);
  console.log(`spread      ${q.spreadPbps} pbps        (realised fee is half of this)`);
  console.log(`mark / mid  ${fmt(q.markPrice)} / ${fmt(q.midPrice)}`);
  console.log(`covToll     ${fmt(q.covToll)}`);

  const before = armed ? await balanceOf(tokenOut, recipient) : 0n;
  await send(calls);
  if (armed) {
    const got = (await balanceOf(tokenOut, recipient)) - before;
    console.log(`\nfilled      ${fmt(got)} USDT`);
    if (got < minAmountOut) throw new Error('filled below the floor: the pool should have reverted');
  }
}
