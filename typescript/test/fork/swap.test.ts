/**
 * State-changing tests against a LOCAL ANVIL FORK of the live chain.
 *
 * Every one of these executes the example code end to end and asserts the OUTCOME, not that the
 * call compiled. Real contracts, real marks, real inventories; a throwaway prefunded account and
 * a clean slate each run, so nothing here needs a funded key.
 *
 * Legs come from the config. A chain without an FX pool, without equities, or whose legs are
 * gated to an allowlist the throwaway account is not on, SKIPS those tests, reason in the name.
 *
 * Run: BTR_CHAIN_ID=<id> bun run test:fork   (never `bun test test/fork` directly: it needs the anvil harness)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { encodeFunctionData } from 'viem';
import {
  base, baseUnits, config, deadline, demoLeg, diffBps, fmt, impliedWad, legPair, legsOf, routeSet, type Address,
} from '../../src/config.ts';
import { POOL_ABI, account, armed, balanceOf, publicClient, send } from '../../src/viem-client.ts';
import * as sdkSwap from '../../sdk/03-pool-swap.ts';
import * as rpcSwap from '../../rpc/03-pool-swap.ts';
import * as sdkRouter from '../../sdk/02-router-swap.ts';
import * as rpcRouter from '../../rpc/02-router-swap.ts';
import { gatedForAny, testIf, worth } from '../support.ts';
import { deal, revert, snapshot } from './helpers.ts';

const first = demoLeg();
const spokes = legPair('stable') ?? legPair();
const volatile = legsOf('volatile')[0];
const fx = legsOf('fx')[0];
const equity = legsOf('equity')[0];
const equityPair = legPair('equity');
const route = routeSet();
const ONE_K = baseUnits(1_000);
const thinBps = 500; // a thin leg moves on a trade; a decimals bug is out by orders of magnitude

// Swaps against a gated leg revert for an account not on the allowlist, for a reason unrelated to
// the code under test. Resolve it once, up front, so the test can be skipped with the reason.
const gate = {
  first: await gatedForAny('swap', first),
  spokes: await gatedForAny('swap', ...(spokes ?? [])),
  volatile: await gatedForAny('swap', volatile),
  fx: await gatedForAny('swap', fx),
  equity: await gatedForAny('swap', equity),
  equityPair: await gatedForAny('swap', ...(equityPair ?? [])),
  route: await gatedForAny('swap', ...(route ? [route.a, route.a2, route.b] : [])),
};

let me: Address;
let snap: string;

beforeAll(() => {
  if (!armed) throw new Error('fork tests must run through `bun run test:fork`');
  me = account!.address;
});

// Every test starts from the same forked state. Without this, one test's leftover balances are
// the next one's silent precondition, and an assertion like "the intermediate never reached the
// recipient" passes or fails on execution order rather than on behaviour.
beforeEach(async () => {
  snap = await snapshot();
});
afterEach(async () => {
  await revert(snap);
});

describe('example 3: swap directly against one pool', () => {
  testIf(first && !gate.first, gate.first ?? 'no pool holds a non-base leg')('SDK path fills at or above the floor', async () => {
    const leg = first!;
    await deal(base.address, me, ONE_K * 10n);
    const before = await balanceOf(leg.token, me);

    const { q, minAmountOut, calls } = await sdkSwap.swapCalls(leg.pool, base.address, leg.token, ONE_K, 50, me);
    await send(calls);

    const got = (await balanceOf(leg.token, me)) - before;
    expect(got).toBeGreaterThanOrEqual(minAmountOut);
    // CLOSE TO, NOT EQUAL TO, the quote. Off chain the approval mines its own block, so the swap
    // is priced one block later than the quote, and the spread carries a time-dependent staleness
    // premium. Only a same-transaction quote (the Solidity twin) is exact. Budget for this: an
    // off-chain integration that asserts quote == fill will flake.
    expect(diffBps(got, q.amountOut)).toBeLessThan(10);
    console.log(`    filled ${fmt(got, leg.decimals)} ${leg.symbol} for ${fmt(ONE_K, base.decimals)} ${base.symbol}`);
  }, 120_000);

  testIf(spokes && !gate.spokes, gate.spokes ?? 'no pool holds two non-base legs')('vanilla JSON-RPC path fills identically', async () => {
    const leg = spokes![1];
    await deal(base.address, me, ONE_K * 10n);
    const before = await balanceOf(leg.token, me);

    const { q, minAmountOut, calls } = await rpcSwap.swapCalls(leg.pool, base.address, leg.token, ONE_K, 50, me);
    await send(calls);

    const got = (await balanceOf(leg.token, me)) - before;
    expect(got).toBeGreaterThanOrEqual(minAmountOut);
    expect(diffBps(got, q.amountOut)).toBeLessThan(10);
    console.log(`    filled ${fmt(got, leg.decimals)} ${leg.symbol} for ${fmt(ONE_K, base.decimals)} ${base.symbol}`);
  }, 120_000);

  testIf(volatile && !gate.volatile, gate.volatile ?? 'no pool holds a volatile leg')('base to volatile lands within 2% of the pool mark', async () => {
    const leg = volatile!;
    const amountIn = ONE_K * 5n;
    await deal(base.address, me, ONE_K * 10n);
    const before = await balanceOf(leg.token, me);

    const { q, calls } = await sdkSwap.swapCalls(leg.pool, base.address, leg.token, amountIn, 100, me);
    await send(calls);

    const got = (await balanceOf(leg.token, me)) - before;
    expect(got).toBeGreaterThan(0n);
    expect(diffBps(impliedWad(amountIn, base.decimals, got, leg.decimals), q.markPrice)).toBeLessThan(200);
    console.log(`    filled ${fmt(got, leg.decimals)} ${leg.symbol} for ${fmt(amountIn, base.decimals)} ${base.symbol}`);
  }, 120_000);

  testIf(first && !gate.first, gate.first ?? 'no pool holds a non-base leg')('an unreachable floor reverts instead of filling short', async () => {
    const leg = first!;
    await deal(base.address, me, ONE_K * 10n);
    const q = await sdkSwap.quote(leg.pool, base.address, leg.token, ONE_K);
    await send([rpcSwap.approveCall(base.address, leg.pool, ONE_K)]);

    // Demanding double the quote must revert. Simulated, so the assertion is about the pool's
    // behaviour rather than about a gas estimate.
    await expect(
      publicClient.simulateContract({
        address: leg.pool, abi: POOL_ABI, functionName: 'swap_qe',
        args: [base.address, leg.token, ONE_K, q.amountOut * 2n, me, deadline()], account: me,
      }),
    ).rejects.toThrow();

    // And the honest floor clears, so the revert above was the floor and not something else.
    const before = await balanceOf(leg.token, me);
    await send([{
      to: leg.pool,
      data: encodeFunctionData({
        abi: POOL_ABI, functionName: 'swap_qe',
        args: [base.address, leg.token, ONE_K, (q.amountOut * 99n) / 100n, me, deadline()],
      }),
      label: 'swap',
    }]);
    expect((await balanceOf(leg.token, me)) - before).toBeGreaterThan(0n);
  }, 120_000);
});

describe('example 2: multi-hop, multi-part route through the Router', () => {
  // Part A crosses two pools: a -> base (pool 1), base -> b (pool 2). Part B stays in pool 1.
  const amountOf = (decimals: number) => 1_000n * 10n ** BigInt(decimals);

  testIf(route && !gate.route, gate.route ?? 'needs two pools sharing a base, one with two non-base legs')('SDK path: two hops across two pools, one signature', async () => {
    const { a, b } = route!;
    const amountIn = amountOf(a.decimals);
    await deal(a.token, me, amountIn * 10n);
    const before = await balanceOf(b.token, me);
    const baseBefore = await balanceOf(base.address, me);

    const hops = [{ pool: a.pool, tokenOut: base.address }, { pool: b.pool, tokenOut: b.token }];
    const expected = await sdkRouter.quotePath(a.token, amountIn, hops);
    const parts = [{ tokenIn: a.token, amountIn, hops }];
    const floors = [{ token: b.token, minOut: (expected * 99n) / 100n }];

    await send([
      rpcSwap.approveCall(a.token, config.contracts.router, amountIn),
      sdkRouter.routerCall(parts, floors, me),
    ]);

    const got = (await balanceOf(b.token, me)) - before;
    expect(got).toBeGreaterThanOrEqual(floors[0].minOut);
    // The intermediate must never reach the recipient: the base is consumed inside the route.
    expect(await balanceOf(base.address, me)).toBe(baseBefore);
    console.log(`    routed ${fmt(amountIn, a.decimals)} ${a.symbol} -> ${base.symbol} -> ${fmt(got, b.decimals)} ${b.symbol}`);
  }, 120_000);

  testIf(route && !gate.route, gate.route ?? 'needs two pools sharing a base, one with two non-base legs')('vanilla path: two parts, two inputs, two output tokens, one call', async () => {
    const { a, a2, b } = route!;
    // Parts run in order against the SAME pools: part B is priced after part A has moved
    // them, so its independent quote is only a fair floor while the parts are small next to the
    // pool. 100 units each, 3% tolerance.
    const inA = amountOf(a.decimals) / 10n;
    const inB = amountOf(a2.decimals) / 10n;
    await deal(a.token, me, inA * 10n);
    await deal(a2.token, me, inB * 10n);
    const beforeB = await balanceOf(b.token, me);
    const beforeBase = await balanceOf(base.address, me);

    const hopsA = [{ pool: a.pool, tokenOut: base.address }, { pool: b.pool, tokenOut: b.token }];
    const hopsB = [{ pool: a.pool, tokenOut: base.address }];
    const outA = await rpcRouter.quotePath(a.token, inA, hopsA);
    const outB = await rpcRouter.quotePath(a2.token, inB, hopsB);

    const parts = [
      { tokenIn: a.token, amountIn: inA, hops: hopsA },
      { tokenIn: a2.token, amountIn: inB, hops: hopsB },
    ];
    const floors = [
      { token: b.token, minOut: (outA * 97n) / 100n },
      { token: base.address, minOut: (outB * 97n) / 100n },
    ];

    await send([
      rpcSwap.approveCall(a.token, config.contracts.router, inA),
      rpcSwap.approveCall(a2.token, config.contracts.router, inB),
      rpcRouter.routerCall(parts, floors, me),
    ]);

    const gotFar = (await balanceOf(b.token, me)) - beforeB;
    const gotBase = (await balanceOf(base.address, me)) - beforeBase;
    expect(gotFar).toBeGreaterThanOrEqual(floors[0].minOut);
    expect(gotBase).toBeGreaterThanOrEqual(floors[1].minOut);
    console.log(`    part A -> ${fmt(gotFar, b.decimals)} ${b.symbol}, part B -> ${fmt(gotBase, base.decimals)} ${base.symbol}`);
  }, 120_000);

  testIf(route && !gate.route, gate.route ?? 'needs two pools sharing a base, one with two non-base legs')('an unreachable end-to-end floor reverts the WHOLE route', async () => {
    const { a, b } = route!;
    const amountIn = amountOf(a.decimals);
    await deal(a.token, me, amountIn * 10n);
    const hops = [{ pool: a.pool, tokenOut: base.address }, { pool: b.pool, tokenOut: b.token }];
    const expected = await sdkRouter.quotePath(a.token, amountIn, hops);
    const parts = [{ tokenIn: a.token, amountIn, hops }];
    const floors = [{ token: b.token, minOut: expected * 2n }];

    await send([rpcSwap.approveCall(a.token, config.contracts.router, amountIn)]);
    const held = await balanceOf(a.token, me);
    await expect(send([sdkRouter.routerCall(parts, floors, me)])).rejects.toThrow();
    // A reverted route leaves the input intact.
    expect(await balanceOf(a.token, me)).toBe(held);
  }, 120_000);
});

describe('example 3 on an FX leg: a short-decimals token and a sub-unit price', () => {
  // The token may have fewer decimals than the base. Everything below normalises before it
  // compares, and the floor is derived from the quote rather than from the input amount, which is
  // the only way a floor means anything across a decimals boundary.
  testIf(fx && !gate.fx, gate.fx ?? 'no pool holds an FX leg')('base to an FX leg fills at or above the floor', async () => {
    const leg = fx!;
    const amountIn = baseUnits(100); // FX legs can be shallow
    await deal(base.address, me, ONE_K * 10n);
    const before = await balanceOf(leg.token, me);

    const { q, minAmountOut, calls } = await sdkSwap.swapCalls(leg.pool, base.address, leg.token, amountIn, 50, me);
    await send(calls);

    const got = (await balanceOf(leg.token, me)) - before;
    expect(got).toBeGreaterThanOrEqual(minAmountOut);
    expect(got).toBeGreaterThan(0n);
    // Normalised, the fill sits near the pool mark. Compared raw it would be out by orders of
    // magnitude on a short-decimals leg, and a test that only asserted `got > 0` would never notice.
    expect(diffBps(impliedWad(amountIn, base.decimals, got, leg.decimals), q.markPrice)).toBeLessThan(thinBps);
    console.log(`    filled ${fmt(got, leg.decimals)} ${leg.symbol} for ${fmt(amountIn, base.decimals)} ${base.symbol}`);
  }, 120_000);

  testIf(fx && !gate.fx, gate.fx ?? 'no pool holds an FX leg')('a sub-unit FX price fills a larger token amount than the input', async () => {
    const leg = fx!;
    const amountIn = baseUnits(100);
    const q = await sdkSwap.quote(leg.pool, base.address, leg.token, amountIn);
    if (q.markPrice <= 10n * 10n ** 18n) {
      console.log(`    SKIPPED: ${leg.symbol} is not a sub-unit price (mark ${fmt(q.markPrice)} per ${base.symbol})`);
      return;
    }
    await deal(base.address, me, ONE_K * 10n);
    const before = await balanceOf(leg.token, me);
    const { minAmountOut, calls } = await rpcSwap.swapCalls(leg.pool, base.address, leg.token, amountIn, 50, me);
    await send(calls);
    const got = (await balanceOf(leg.token, me)) - before;
    expect(got).toBeGreaterThanOrEqual(minAmountOut);
    // The output dwarfs the input: exactly the direction a slippage helper written for stables gets wrong.
    expect(got / 10n ** BigInt(leg.decimals)).toBeGreaterThan(amountIn / 10n ** BigInt(base.decimals));
  }, 120_000);
});

describe('example 3 on an equity leg: tokenised equities', () => {
  testIf(equity && !gate.equity, gate.equity ?? 'no pool holds an equity leg')('base to equity fills at or above the floor', async () => {
    const leg = equity!;
    await deal(base.address, me, ONE_K * 10n);
    const before = await balanceOf(leg.token, me);

    const { q, minAmountOut, calls } = await sdkSwap.swapCalls(leg.pool, base.address, leg.token, ONE_K, 100, me);
    await send(calls);

    const got = (await balanceOf(leg.token, me)) - before;
    expect(got).toBeGreaterThanOrEqual(minAmountOut);
    // A share is worth hundreds of dollars, so 1000 base buys single-digit units. The output is
    // two orders of magnitude BELOW the input; asserting "out >= in * something" fails here.
    expect(got).toBeGreaterThan(0n);
    expect(diffBps(impliedWad(ONE_K, base.decimals, got, leg.decimals), q.markPrice)).toBeLessThan(200);
    console.log(`    filled ${fmt(got, leg.decimals)} ${leg.symbol} for ${fmt(ONE_K, base.decimals)} ${base.symbol}`);
  }, 120_000);

  testIf(equityPair && !gate.equityPair, gate.equityPair ?? 'no pool holds two equity legs')('equity to equity is one call and never pays the intermediate out', async () => {
    const [a, b] = equityPair!;
    const amountIn = await worth(a.symbol, 1_000);
    await deal(a.token, me, amountIn * 10n);
    const baseBefore = await balanceOf(base.address, me);
    const before = await balanceOf(b.token, me);

    const { q, minAmountOut, calls } = await rpcSwap.swapCalls(a.pool, a.token, b.token, amountIn, 100, me);
    expect(q.routeHops.length).toBe(3); // a -> base -> b, inside one pool call
    await send(calls);

    const got = (await balanceOf(b.token, me)) - before;
    expect(got).toBeGreaterThanOrEqual(minAmountOut);
    // The pool base is consumed inside the hop: it must never land on the recipient.
    expect(await balanceOf(base.address, me)).toBe(baseBefore);
    console.log(`    filled ${fmt(got, b.decimals)} ${b.symbol} for ${fmt(amountIn, a.decimals)} ${a.symbol}`);
  }, 120_000);
});

