/**
 * Deposit, withdraw and debt-swap tests against a LOCAL ANVIL FORK.
 *
 * Positions are sized by VALUE ($10,000 of the leg at the live mark), so one number serves a
 * stable, a short-decimals FX token and a share worth hundreds of dollars. Legs come from the
 * config; a chain without them, or whose legs are deposit-gated to an allowlist the throwaway
 * account is not on, SKIPS the test with the reason in its name.
 *
 * Run: BTR_CHAIN_ID=<id> bun run test:fork
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { config, demoLeg, diffBps, feedId, fmt, legPair, legsOf, type Address } from '../../src/config.ts';
import { account, armed, balanceOf, send } from '../../src/viem-client.ts';
import * as sdkDep from '../../sdk/04-deposit.ts';
import * as rpcDep from '../../rpc/04-deposit.ts';
import * as sdkWd from '../../sdk/05-withdraw.ts';
import * as rpcWd from '../../rpc/05-withdraw.ts';
import * as sdkDebt from '../../sdk/06-debt-swap.ts';
import * as rpcDebt from '../../rpc/06-debt-swap.ts';
import * as rpcOracle from '../../rpc/01-oracle.ts';
import { gatedForAny, testIf, worth } from '../support.ts';
import { deal, revert, snapshot, warp } from './helpers.ts';

const leg = demoLeg();
const pair = legPair('stable') ?? legPair();
const fx = legsOf('fx')[0];
const equity = legsOf('equity')[0];

const gate = {
  leg: await gatedForAny('deposit', leg),
  pair: await gatedForAny('deposit', pair?.[0]),
  fx: await gatedForAny('deposit', fx),
  equity: await gatedForAny('deposit', equity),
};

/** $10,000 of a leg, in the leg's own decimals. */
const tenK = (l: { symbol: string } | undefined) => (l ? worth(l.symbol, 10_000) : Promise.resolve(0n));
const TEN_K = await tenK(leg);
const PAIR_TEN_K = await tenK(pair?.[0]);
const FX_TEN_K = await tenK(fx);
const EQUITY_TEN_K = await tenK(equity);

const WAD = 10n ** 18n;
const gap = (a: bigint, b: bigint) => (a > b ? a - b : b - a);

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
  testIf(leg && !gate.leg, gate.leg ?? 'no pool holds a non-base leg')('SDK path mints shares against the deposited leg', async () => {
    const { pool: p, token: tk } = leg!;
    await deal(tk, me, TEN_K * 2n);
    const before = await sdkDep.lpBalance(p, me, tk);

    await send(sdkDep.depositCalls(p, tk, TEN_K));

    const minted = (await sdkDep.lpBalance(p, me, tk)) - before;
    expect(minted).toBeGreaterThan(0n);
    // Shares are not one-for-one with tokens: the leg's liquidity index converts between them.
    expect(minted).toBeLessThanOrEqual(TEN_K);
    console.log(`    ${fmt(TEN_K, leg!.decimals)} ${leg!.symbol} -> ${fmt(minted, leg!.decimals)} shares`);
  }, 120_000);

  testIf(leg && !gate.leg, gate.leg ?? 'no pool holds a non-base leg')('vanilla path mints the same way', async () => {
    const { pool: p, token: tk } = leg!;
    await deal(tk, me, TEN_K * 2n);
    const before = await rpcDep.lpBalance(p, me, tk);
    await send(rpcDep.depositCalls(p, tk, TEN_K));
    expect((await rpcDep.lpBalance(p, me, tk)) - before).toBeGreaterThan(0n);
  }, 120_000);

  testIf(leg && !gate.leg, gate.leg ?? 'no pool holds a non-base leg')('a deposit moves coverage TOWARD the pool solvency C, it does not raise it', async () => {
    const { pool: p, token: tk } = leg!;
    await deal(tk, me, TEN_K * 10n);
    const c = await sdkDep.solvency(p);
    const before = await sdkDep.coverage(p, tk);
    await send(sdkDep.depositCalls(p, tk, TEN_K * 5n));
    const after = await sdkDep.coverage(p, tk);

    // A deposit mints at C: reserves grow by `amount`, liabilities by `amount / C`. The leg's
    // coverage is dragged toward C, down from above it and up from below, not toward 1.0.
    // Raising a leg's coverage is what `donate` is for.
    expect(gap(after, c)).toBeLessThanOrEqual(gap(before, c));
    console.log(`    coverage ${fmt(before)} -> ${fmt(after)} (C ${fmt(c)})`);
  }, 120_000);
});

describe('example 5: withdraw liquidity', () => {
  testIf(leg && !gate.leg, gate.leg ?? 'no pool holds a non-base leg')('the floor comes from previewWithdraw and the fill matches it', async () => {
    const { pool: p, token: tk } = leg!;
    await deal(tk, me, TEN_K * 2n);
    await send(sdkDep.depositCalls(p, tk, TEN_K));
    const shares = await sdkDep.lpBalance(p, me, tk);

    // Freshly minted shares are frozen by the anti-JIT cooldown: this is not an error, it is the
    // guard that stops a deposit-donate-withdraw sandwich from harvesting the index move.
    expect(await sdkWd.maxRedeem(p, me, tk)).toBe(0n);
    await warp(Number(await rpcWd.flowCooldownSecs(p)) + 1);
    expect(await sdkWd.maxRedeem(p, me, tk)).toBeGreaterThanOrEqual(shares);

    const w = await sdkWd.withdrawCall(p, tk, shares, 10);
    const before = await balanceOf(tk, me);
    await send([w.call]);

    const got = (await balanceOf(tk, me)) - before;
    expect(got).toBeGreaterThanOrEqual(w.minAmountOut);
    expect(await sdkDep.lpBalance(p, me, tk)).toBe(0n);
    console.log(`    ${fmt(shares, leg!.decimals)} shares -> ${fmt(got, leg!.decimals)} ${leg!.symbol} (haircut ${fmt(w.haircut, leg!.decimals)})`);
  }, 120_000);

  testIf(leg && !gate.leg, gate.leg ?? 'no pool holds a non-base leg')('vanilla path: a partial exit redeems linearly', async () => {
    const { pool: p, token: tk } = leg!;
    await deal(tk, me, TEN_K * 2n);
    await send(rpcDep.depositCalls(p, tk, TEN_K));
    const shares = await rpcDep.lpBalance(p, me, tk);
    await warp(Number(await rpcWd.flowCooldownSecs(p)) + 1);

    const [full] = await rpcWd.previewWithdraw(p, tk, shares);
    const [half] = await rpcWd.previewWithdraw(p, tk, shares / 2n);
    const drift = half * 2n > full ? half * 2n - full : full - half * 2n;
    expect(Number((drift * 10_000n) / full)).toBeLessThan(2);

    const w = await rpcWd.withdrawCall(p, tk, shares / 2n, 10);
    await send([w.call]);
    expect(await rpcDep.lpBalance(p, me, tk)).toBe(shares - shares / 2n);
  }, 120_000);

  testIf(leg && !gate.leg, gate.leg ?? 'no pool holds a non-base leg')('flooring from the DEPOSITED amount rather than the preview is the mistake', async () => {
    const { pool: p, token: tk } = leg!;
    await deal(tk, me, TEN_K * 2n);
    await send(rpcDep.depositCalls(p, tk, TEN_K));
    const shares = await rpcDep.lpBalance(p, me, tk);
    await warp(Number(await rpcWd.flowCooldownSecs(p)) + 1);

    const [preview] = await rpcWd.previewWithdraw(p, tk, shares);
    // The pool pays `preview`, which is at or below what went in. The two differ by the haircut.
    expect(preview).toBeLessThanOrEqual(TEN_K);
    // So the correct floor is derived from the preview, never from the deposit.
    const w = await rpcWd.withdrawCall(p, tk, shares, 0);
    expect(w.minAmountOut).toBe(preview);
  }, 120_000);
});

describe('example 6: debt swap (swapLiability)', () => {
  testIf(pair, 'no pool holds two non-base legs')('both legs carry the liability-swap bit', async () => {
    const [a, b] = pair!;
    await sdkDebt.assertLegsEnabled(a.pool, a.token, b.token);
    await rpcDebt.assertLegsEnabled(a.pool, a.token, b.token);
  }, 60_000);

  testIf(pair && !gate.pair, gate.pair ?? 'no pool holds two non-base legs')('re-denominates the claim WITHOUT moving reserves', async () => {
    const [a, b] = pair!;
    await deal(a.token, me, PAIR_TEN_K * 2n);
    await send(sdkDep.depositCalls(a.pool, a.token, PAIR_TEN_K));
    const shares = await sdkDep.lpBalance(a.pool, me, a.token);

    // A debt swap moves an LP claim, so the anti-flow-abuse freeze gates it exactly as it gates a
    // withdraw: shares minted less than `flowCooldownSecs` ago revert `CooldownActive()`. Wait it
    // out, and read the window off the pool rather than hardcoding it.
    await warp(Number(await rpcWd.flowCooldownSecs(a.pool)) + 1);

    const quoted = await sdkDebt.simulateShareOut(a.pool, a.token, b.token, shares, me);

    const poolABefore = await balanceOf(a.token, a.pool);
    const poolBBefore = await balanceOf(b.token, a.pool);
    const myABefore = await balanceOf(a.token, me);

    await send([sdkDebt.debtSwapCall(a.pool, a.token, b.token, shares, (quoted * 999n) / 1000n)]);

    expect(await sdkDep.lpBalance(a.pool, me, a.token)).toBe(0n);
    expect(await sdkDep.lpBalance(a.pool, me, b.token)).toBeGreaterThan(0n);
    // The assertion that matters: no token moved anywhere.
    expect(await balanceOf(a.token, a.pool)).toBe(poolABefore);
    expect(await balanceOf(b.token, a.pool)).toBe(poolBBefore);
    expect(await balanceOf(a.token, me)).toBe(myABefore);
  }, 120_000);

  testIf(pair && !gate.pair, gate.pair ?? 'no pool holds two non-base legs')('vanilla path: the face crosses at the mark ratio, with no per-leg haircut', async () => {
    const [a, b] = pair!;
    await deal(a.token, me, PAIR_TEN_K * 2n);
    await send(rpcDep.depositCalls(a.pool, a.token, PAIR_TEN_K));
    const shares = await rpcDep.lpBalance(a.pool, me, a.token);
    await warp(Number(await rpcWd.flowCooldownSecs(a.pool)) + 1);

    const quoted = await rpcDebt.simulateShareOut(a.pool, a.token, b.token, shares, me);

    const idxIn = await rpcDep.liquidityIndex(a.pool, a.token);
    const idxOut = await rpcDep.liquidityIndex(a.pool, b.token);
    await send([rpcDebt.debtSwapCall(a.pool, a.token, b.token, shares, (quoted * 999n) / 1000n)]);
    const outShares = await rpcDep.lpBalance(a.pool, me, b.token);

    // The swap settles at the pool-wide C and re-credits the destination at the same face, so the
    // FACE crosses at the two legs' mark ratio: there is no per-leg haircut, only the swap
    // spread. Face is `shares * liquidityIndexWad / 1e18` in the leg's own token units; priced at
    // the oracle mark the two sides agree to within the spread. (Compare face, not
    // `previewWithdraw`: a share's exit value is `face * min(coverage(leg), C)` and the swap
    // itself moves the destination leg's coverage, so an exit preview afterwards is a different
    // number by design.)
    const usd = async (symbol: string, shareCount: bigint, idx: bigint, decimals: number) => {
      const mark = (await rpcOracle.getFeed(config.contracts.poolFactory, feedId(symbol))).mark1e18;
      return (((shareCount * idx) / WAD) * mark) / 10n ** BigInt(decimals);
    };
    const usdIn = await usd(a.symbol, shares, idxIn, a.decimals);
    const usdOut = await usd(b.symbol, outShares, idxOut, b.decimals);
    expect(diffBps(usdOut, usdIn)).toBeLessThan(100);
    console.log(`    face ${fmt(usdIn)} -> ${fmt(usdOut)} (USD, WAD)`);
  }, 120_000);
});

/**
 * The same deposit and withdraw flow on an FX and an equity leg.
 *
 * It is here because an LP leg is denominated in the LEG'S OWN token, not in the pool base, and
 * these break the assumption an 18-decimal stable pair lets you keep: an FX token can have fewer
 * decimals, and one share costs hundreds of dollars. Every amount is built from the token's own
 * `decimals()` and its mark, never from a hardcoded 1e18, and every floor comes from
 * `previewWithdraw`.
 */
describe('examples 4 and 5 on an FX leg', () => {
  testIf(fx && !gate.fx, gate.fx ?? 'no pool holds an FX leg')('deposit then full exit, with the floor taken from the preview', async () => {
    const { pool: p, token: tk, decimals: dec, symbol } = fx!;
    const amount = FX_TEN_K;

    await deal(tk, me, amount * 2n);
    const before = await sdkDep.lpBalance(p, me, tk);
    await send(sdkDep.depositCalls(p, tk, amount));

    const minted = (await sdkDep.lpBalance(p, me, tk)) - before;
    expect(minted).toBeGreaterThan(0n);

    // Freshly minted shares are frozen, on this leg exactly as on any other.
    expect(await sdkWd.maxRedeem(p, me, tk)).toBe(0n);
    await warp(Number(await rpcWd.flowCooldownSecs(p)) + 1);

    const shares = await sdkDep.lpBalance(p, me, tk);
    const w = await sdkWd.withdrawCall(p, tk, shares, 10);
    const bal = await balanceOf(tk, me);
    await send([w.call]);

    const got = (await balanceOf(tk, me)) - bal;
    expect(got).toBeGreaterThanOrEqual(w.minAmountOut);
    // The payout is in the token's own decimals. Asserting it against an 18-decimal constant
    // would pass on a number orders of magnitude too small, which is why the bound is derived.
    expect(got).toBeGreaterThan(amount / 2n);
    expect(got).toBeLessThanOrEqual(amount);
    console.log(`    ${fmt(shares, dec)} shares -> ${fmt(got, dec)} ${symbol} (haircut ${fmt(w.haircut, dec)})`);
  }, 180_000);
});

describe('examples 4 and 5 on an equity leg', () => {
  testIf(equity && !gate.equity, gate.equity ?? 'no pool holds an equity leg')('deposit then partial exit redeems linearly', async () => {
    const { pool: p, token: tk, decimals: dec, symbol } = equity!;
    const amount = EQUITY_TEN_K;

    await deal(tk, me, amount * 2n);
    await send(rpcDep.depositCalls(p, tk, amount));
    const shares = await rpcDep.lpBalance(p, me, tk);
    expect(shares).toBeGreaterThan(0n);
    await warp(Number(await rpcWd.flowCooldownSecs(p)) + 1);

    const [full] = await rpcWd.previewWithdraw(p, tk, shares);
    const [half] = await rpcWd.previewWithdraw(p, tk, shares / 2n);
    expect(full).toBeGreaterThan(0n);
    const drift = half * 2n > full ? half * 2n - full : full - half * 2n;
    expect(Number((drift * 10_000n) / full)).toBeLessThan(2);

    const w = await rpcWd.withdrawCall(p, tk, shares / 2n, 10);
    const bal = await balanceOf(tk, me);
    await send([w.call]);

    const got = (await balanceOf(tk, me)) - bal;
    expect(got).toBeGreaterThanOrEqual(w.minAmountOut);
    expect(await rpcDep.lpBalance(p, me, tk)).toBe(shares - shares / 2n);
    console.log(`    ${fmt(shares / 2n, dec)} shares -> ${fmt(got, dec)} ${symbol}`);
  }, 180_000);

  testIf(equity && !gate.equity, gate.equity ?? 'no pool holds an equity leg')('a deposit moves the equity leg coverage TOWARD the pool solvency C', async () => {
    const { pool: p, token: tk } = equity!;
    const amount = EQUITY_TEN_K / 2n;
    await deal(tk, me, amount * 2n);

    const c = await sdkDep.solvency(p);
    const before = await sdkDep.coverage(p, tk);
    await send(sdkDep.depositCalls(p, tk, amount));
    const after = await sdkDep.coverage(p, tk);

    expect(gap(after, c)).toBeLessThanOrEqual(gap(before, c));
    console.log(`    coverage ${fmt(before)} -> ${fmt(after)} (C ${fmt(c)})`);
  }, 180_000);
});

