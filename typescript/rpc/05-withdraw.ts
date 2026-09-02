/**
 * Example 5, off chain, VANILLA JSON-RPC: withdrawing liquidity with viem only.
 *
 * Guide:    https://btr.markets/docs/5-1-1-basic-operations#4-deposit--withdraw
 * Twin:     ../sdk/05-withdraw.ts     (same job, using @btr-protocol/sdk)
 * On chain: ../../foundry/test/05_Withdraw.t.sol
 *
 * `minAmountOut` COMES FROM `previewWithdraw`, NOT FROM WHAT YOU DEPOSITED. Below 100% coverage
 * a leg pays out less than face value, and it must: the alternative is first-out-gets-paid-in-full,
 * which is a bank run with extra steps. Flooring from the deposit is how an integrator gets a
 * revert on a perfectly healthy pool.
 *
 * `previewWithdraw` returns TWO values, `(amountOut, haircut)`. Read both.
 *
 * `maxRedeem` is capacity, not value: it folds in the anti-JIT freeze on freshly minted shares
 * and the leg's liquid reserves. Zero right after a deposit is the cooldown, not an error.
 *
 * Run: bun run rpc/05-withdraw.ts
 */
import { encodeFunctionData } from 'viem';
import { deadline, floorFrom, fmt, pool, token, withRetry, type Address } from '../src/config.ts';
import { POOL_ABI, armed, publicClient, send, senderOrPlaceholder, type Call } from '../src/viem-client.ts';
import { lpBalance } from './04-deposit.ts';

export const previewWithdraw = (p: Address, tk: Address, lp: bigint) =>
  withRetry(() =>
    publicClient.readContract({ address: p, abi: POOL_ABI, functionName: 'previewWithdraw', args: [tk, lp] }),
  ) as Promise<readonly [bigint, bigint]>;

export const maxRedeem = (p: Address, user: Address, tk: Address) =>
  withRetry(() =>
    publicClient.readContract({ address: p, abi: POOL_ABI, functionName: 'maxRedeem', args: [user, tk] }),
  );

export const flowCooldownSecs = (p: Address) =>
  withRetry(() => publicClient.readContract({ address: p, abi: POOL_ABI, functionName: 'flowCooldownSecs' }));

export async function withdrawCall(p: Address, tk: Address, lp: bigint, slippageBps: number) {
  const [amountOut, haircut] = await previewWithdraw(p, tk, lp);
  if (amountOut === 0n) throw new Error('preview returned zero: that is a failure, not a valuation');
  const minAmountOut = floorFrom(amountOut, slippageBps);
  const c: Call = {
    to: p,
    data: encodeFunctionData({ abi: POOL_ABI, functionName: 'withdraw', args: [tk, lp, minAmountOut, deadline()] }),
    label: 'withdraw',
  };
  return { amountOut, haircut, minAmountOut, call: c };
}

if (import.meta.main) {
  const p = pool('stablePool');
  const tk = token('USDT');
  const user = senderOrPlaceholder;

  const shares = await lpBalance(p, user, tk);
  console.log(`pool        ${p}`);
  console.log(`cooldown    ${await flowCooldownSecs(p)}s   (anti-JIT freeze on freshly minted shares)`);
  console.log(`lp balance  ${fmt(shares)}`);
  if (shares === 0n) {
    console.log('nothing to withdraw. Run rpc/04-deposit.ts first (against a fork).');
    process.exit(0);
  }

  const redeemable = await maxRedeem(p, user, tk);
  console.log(`maxRedeem   ${fmt(redeemable)}`);
  const lp = redeemable < shares ? redeemable : shares;

  const w = await withdrawCall(p, tk, lp, 10);
  console.log(`preview     ${fmt(w.amountOut)} USDT   haircut ${fmt(w.haircut)}`);
  console.log(`floor       ${fmt(w.minAmountOut)} USDT   (10 bps, off the PREVIEW)`);

  await send([w.call]);
  if (armed) console.log(`lp after    ${fmt(await lpBalance(p, user, tk))}`);
}
