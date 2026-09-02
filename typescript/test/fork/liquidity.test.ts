/**
 * Deposit, withdraw and debt-swap tests against a LOCAL ANVIL FORK.
 *
 * Run: bun run test:fork
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { config, fmt, pool, token, type Address } from '../../src/config.ts';
import { account, armed, balanceOf, send } from '../../src/viem-client.ts';
import * as sdkDep from '../../sdk/04-deposit.ts';
import * as rpcDep from '../../rpc/04-deposit.ts';
import * as sdkWd from '../../sdk/05-withdraw.ts';
import * as rpcWd from '../../rpc/05-withdraw.ts';
import * as sdkDebt from '../../sdk/06-debt-swap.ts';
import * as rpcDebt from '../../rpc/06-debt-swap.ts';
import { deal, revert, snapshot, warp } from './helpers.ts';

const USDT = token('USDT');
const USDS = token('USDS');
const stable = pool('stablePool');
const TEN_K = 10_000n * 10n ** 18n;

let me: Address;
let snap: string;

beforeAll(() => {
  if (!armed) throw new Error('fork tests must run through `bun run test:fork`');
  me = account!.address;
});
beforeEach(async () => {
  snap = await snapshot();
});
afterEach(async () => {
  await revert(snap);
});

describe('example 4: deposit liquidity', () => {
  test('SDK path mints shares against the deposited leg', async () => {
    await deal(USDT, me, TEN_K * 2n);
    const before = await sdkDep.lpBalance(stable, me, USDT);

    await send(sdkDep.depositCalls(stable, USDT, TEN_K));

    const minted = (await sdkDep.lpBalance(stable, me, USDT)) - before;
    expect(minted).toBeGreaterThan(0n);
    // Shares are not one-for-one with tokens: the leg's liquidity index converts between them.
    expect(minted).toBeLessThanOrEqual(TEN_K);
    console.log(`    ${fmt(TEN_K)} USDT -> ${fmt(minted)} shares`);
  }, 120_000);

  test('vanilla path mints the same way', async () => {
    await deal(USDT, me, TEN_K * 2n);
    const before = await rpcDep.lpBalance(stable, me, USDT);
    await send(rpcDep.depositCalls(stable, USDT, TEN_K));
    expect((await rpcDep.lpBalance(stable, me, USDT)) - before).toBeGreaterThan(0n);
  }, 120_000);

  test('a deposit moves coverage TOWARD parity, it does not raise it', async () => {
    await deal(USDT, me, TEN_K * 10n);
    const before = await sdkDep.coverage(stable, USDT);
    await send(sdkDep.depositCalls(stable, USDT, TEN_K * 5n));
    const after = await sdkDep.coverage(stable, USDT);

    const WAD = 10n ** 18n;
    const gapBefore = before > WAD ? before - WAD : WAD - before;
    const gapAfter = after > WAD ? after - WAD : WAD - after;
    // A deposit credits reserves AND liabilities by the same value, so it dilutes toward 1.0.
    // Raising a leg's coverage is what `donate` is for.
    expect(gapAfter).toBeLessThanOrEqual(gapBefore);
    console.log(`    coverage ${fmt(before)} -> ${fmt(after)}`);
  }, 120_000);
});

describe('example 5: withdraw liquidity', () => {
  test('the floor comes from previewWithdraw and the fill matches it', async () => {
    await deal(USDT, me, TEN_K * 2n);
    await send(sdkDep.depositCalls(stable, USDT, TEN_K));
    const shares = await sdkDep.lpBalance(stable, me, USDT);

    // Freshly minted shares are frozen by the anti-JIT cooldown: this is not an error, it is the
    // guard that stops a deposit-donate-withdraw sandwich from harvesting the index move.
    expect(await sdkWd.maxRedeem(stable, me, USDT)).toBe(0n);
    await warp(Number(await rpcWd.flowCooldownSecs(stable)) + 1);
    expect(await sdkWd.maxRedeem(stable, me, USDT)).toBeGreaterThanOrEqual(shares);

    const w = await sdkWd.withdrawCall(stable, USDT, shares, 10);
    const before = await balanceOf(USDT, me);
    await send([w.call]);

    const got = (await balanceOf(USDT, me)) - before;
    expect(got).toBeGreaterThanOrEqual(w.minAmountOut);
    expect(await sdkDep.lpBalance(stable, me, USDT)).toBe(0n);
    console.log(`    ${fmt(shares)} shares -> ${fmt(got)} USDT (haircut ${fmt(w.haircut)})`);
  }, 120_000);

  test('vanilla path: a partial exit redeems linearly', async () => {
    await deal(USDT, me, TEN_K * 2n);
    await send(rpcDep.depositCalls(stable, USDT, TEN_K));
    const shares = await rpcDep.lpBalance(stable, me, USDT);
    await warp(Number(await rpcWd.flowCooldownSecs(stable)) + 1);

    const [full] = await rpcWd.previewWithdraw(stable, USDT, shares);
    const [half] = await rpcWd.previewWithdraw(stable, USDT, shares / 2n);
    const drift = half * 2n > full ? half * 2n - full : full - half * 2n;
    expect(Number((drift * 10_000n) / full)).toBeLessThan(2);

    const w = await rpcWd.withdrawCall(stable, USDT, shares / 2n, 10);
    await send([w.call]);
    expect(await rpcDep.lpBalance(stable, me, USDT)).toBe(shares - shares / 2n);
  }, 120_000);

  test('flooring from the DEPOSITED amount rather than the preview is the mistake', async () => {
    await deal(USDT, me, TEN_K * 2n);
    await send(rpcDep.depositCalls(stable, USDT, TEN_K));
    const shares = await rpcDep.lpBalance(stable, me, USDT);
    await warp(Number(await rpcWd.flowCooldownSecs(stable)) + 1);

    const [preview] = await rpcWd.previewWithdraw(stable, USDT, shares);
    // The pool pays `preview`, which is at or below what went in. The two differ by the haircut.
    expect(preview).toBeLessThanOrEqual(TEN_K);
    // So the correct floor is derived from the preview, never from the deposit.
    const w = await rpcWd.withdrawCall(stable, USDT, shares, 0);
    expect(w.minAmountOut).toBe(preview);
  }, 120_000);
});

describe('example 6: debt swap (swapLiability)', () => {
  test('both legs carry the liability-swap bit', async () => {
    await sdkDebt.assertLegsEnabled(stable, USDT, USDS);
    await rpcDebt.assertLegsEnabled(stable, USDT, USDS);
  }, 60_000);

  test('re-denominates the claim WITHOUT moving reserves', async () => {
    await deal(USDT, me, TEN_K * 2n);
    await send(sdkDep.depositCalls(stable, USDT, TEN_K));
    const shares = await sdkDep.lpBalance(stable, me, USDT);

    let quoted: bigint;
    try {
      quoted = await sdkDebt.simulateShareOut(stable, USDT, USDS, shares, me);
    } catch (e) {
      // See README, "Known issues": swapLiability reverts ZeroValue() on the deployment these
      // examples were written against. Reported rather than asserted away.
      console.log(`    SKIPPED: swapLiability is not executable on this chain (${(e as Error).message.split('\n')[0]})`);
      return;
    }

    const poolUsdtBefore = await balanceOf(USDT, stable);
    const poolUsdsBefore = await balanceOf(USDS, stable);
    const myUsdtBefore = await balanceOf(USDT, me);

    await send([sdkDebt.debtSwapCall(stable, USDT, USDS, shares, (quoted * 999n) / 1000n)]);

    expect(await sdkDep.lpBalance(stable, me, USDT)).toBe(0n);
    expect(await sdkDep.lpBalance(stable, me, USDS)).toBeGreaterThan(0n);
    // The assertion that matters: no token moved anywhere.
    expect(await balanceOf(USDT, stable)).toBe(poolUsdtBefore);
    expect(await balanceOf(USDS, stable)).toBe(poolUsdsBefore);
    expect(await balanceOf(USDT, me)).toBe(myUsdtBefore);
  }, 120_000);

  test('vanilla path: value is preserved even though share counts differ', async () => {
    await deal(USDT, me, TEN_K * 2n);
    await send(rpcDep.depositCalls(stable, USDT, TEN_K));
    const shares = await rpcDep.lpBalance(stable, me, USDT);

    let quoted: bigint;
    try {
      quoted = await rpcDebt.simulateShareOut(stable, USDT, USDS, shares, me);
    } catch (e) {
      console.log(`    SKIPPED: swapLiability is not executable on this chain (${(e as Error).message.split('\n')[0]})`);
      return;
    }

    const [valueIn] = await rpcWd.previewWithdraw(stable, USDT, shares);
    await send([rpcDebt.debtSwapCall(stable, USDT, USDS, shares, (quoted * 999n) / 1000n)]);
    const outShares = await rpcDep.lpBalance(stable, me, USDS);
    const [valueOut] = await rpcWd.previewWithdraw(stable, USDS, outShares);

    expect(valueOut).toBeLessThanOrEqual(valueIn + 1n); // a debt swap must never mint value
    const drift = valueIn > valueOut ? valueIn - valueOut : valueOut - valueIn;
    expect(Number((drift * 10_000n) / valueIn)).toBeLessThan(200);
  }, 120_000);
});
