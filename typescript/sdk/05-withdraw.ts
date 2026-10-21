/**
 * Example 5, off chain, WITH THE SDK: withdrawing liquidity, floor set from `previewWithdraw`.
 *
 * Guide:    https://btr.markets/docs/5-1-1-basic-operations#4-deposit--withdraw
 * Twin:     ../rpc/05-withdraw.ts     (same job, viem only, no SDK)
 * On chain: ../../foundry/test/05_Withdraw.t.sol
 *
 * TWO THINGS MAKE A WITHDRAW DIFFERENT FROM A DEPOSIT.
 *
 *   1. THERE IS A HAIRCUT. A same-asset exit pays `face * min(coverage(leg), C)` less a small
 *      exit toll, so a leg short of reserves pays less than the shares' face value, and it must:
 *      the alternative is first-out-gets-paid-in-full, which is a bank run with extra steps.
 *      `previewWithdraw` returns BOTH the amount and the haircut. Read both.
 *   2. THERE IS AN ANTI-JIT COOLDOWN. Shares minted within the last `flowCooldownSecs` cannot be
 *      redeemed, which is what stops a deposit-donate-withdraw sandwich harvesting the index move.
 *      `maxRedeem` is the capacity check: it folds in the freeze and the liquid reserves.
 *
 * `minAmountOut` MUST come from `previewWithdraw`, not from what you deposited. Those two differ
 * by exactly the haircut, and flooring from the deposit is how an integrator gets a revert on a
 * perfectly healthy pool.
 *
 * Run: bun run sdk/05-withdraw.ts
 */
import { POOL_ABI } from '@btr-protocol/sdk/abis';
import { readContract } from '@btr-protocol/sdk/eth';
import { deadline, demoLeg, floorFrom, fmt, need, withRetry, type Address } from '../src/config.ts';
import { account, armed, call, provider, send } from '../src/sdk-wallet.ts';
import { lpBalance } from './04-deposit.ts';

/** @returns `[amountOut, haircut]`. Reading only the first is how a position gets booked at a
 *           value the pool would not actually pay. */
export const previewWithdraw = (p: Address, tk: Address, lp: bigint) =>
  withRetry(() => readContract<[bigint, bigint]>(provider, p, POOL_ABI, 'previewWithdraw', [tk, lp]));

export const maxRedeem = (p: Address, user: Address, tk: Address) =>
  withRetry(() => readContract<bigint>(provider, p, POOL_ABI, 'maxRedeem', [user, tk]));

/** The anti-JIT window, seconds. Admin-settable, so READ it rather than pinning a literal. It
 *  gates `swapLiability` as well as `withdraw`: both move an LP claim. */
export const flowCooldownSecs = (p: Address) =>
  withRetry(() => readContract<bigint>(provider, p, POOL_ABI, 'flowCooldownSecs', []));

export async function withdrawCall(p: Address, tk: Address, lp: bigint, slippageBps: number) {
  const [amountOut, haircut] = await previewWithdraw(p, tk, lp);
  if (amountOut === 0n) throw new Error('preview returned zero: that is a failure, not a valuation');
  const minAmountOut = floorFrom(amountOut, slippageBps);
  return {
    amountOut,
    haircut,
    minAmountOut,
    call: call(p, POOL_ABI, 'withdraw', [tk, lp, minAmountOut, deadline()], 'withdraw'),
  };
}

if (import.meta.main) {
  const leg = need(demoLeg(), 'pool with a non-base leg');
  const p = leg.pool;
  const tk = leg.token;
  const user = (account ?? '0x000000000000000000000000000000000000dEaD') as Address;

  const shares = await lpBalance(p, user, tk);
  console.log(`pool        ${p}`);
  console.log(`lp balance  ${fmt(shares)}`);
  if (shares === 0n) {
    console.log('nothing to withdraw. Run sdk/04-deposit.ts first (against a fork).');
    process.exit(0);
  }

  const redeemable = await maxRedeem(p, user, tk);
  console.log(`maxRedeem   ${fmt(redeemable)}   (capacity, not value: 0 means the anti-JIT freeze)`);
  const lp = redeemable < shares ? redeemable : shares;

  const w = await withdrawCall(p, tk, lp, 10);
  console.log(`preview     ${fmt(w.amountOut, leg.decimals)} ${leg.symbol}`);
  console.log(`haircut     ${fmt(w.haircut, leg.decimals)}`);
  console.log(`floor       ${fmt(w.minAmountOut, leg.decimals)} ${leg.symbol}   (10 bps tolerance, off the PREVIEW)`);

  await send([w.call]);
  if (armed) console.log(`lp after    ${fmt(await lpBalance(p, user, tk))}`);
}
