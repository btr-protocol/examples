/**
 * State-changing tests against a LOCAL ANVIL FORK of the live chain.
 *
 * Every one of these executes the example code end to end and asserts the OUTCOME, not that the
 * call compiled. Real contracts, real marks, real inventories; a throwaway prefunded account and
 * a clean slate each run, so nothing here needs a funded key.
 *
 * Run: bun run test:fork      (never `bun test test/fork` directly: it needs the anvil harness)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { encodeFunctionData } from 'viem';
import { config, deadline, fmt, pool, token, type Address } from '../../src/config.ts';
import { POOL_ABI, account, armed, balanceOf, publicClient, send } from '../../src/viem-client.ts';
import * as sdkSwap from '../../sdk/03-pool-swap.ts';
import * as rpcSwap from '../../rpc/03-pool-swap.ts';
import * as sdkRouter from '../../sdk/02-router-swap.ts';
import * as rpcRouter from '../../rpc/02-router-swap.ts';
import { deal, revert, snapshot } from './helpers.ts';

const USDCB = token(config.baseToken);
const USDT = token('USDT');
const USDS = token('USDS');
const WETH = token('WETH');
const stable = pool('stablePool');
const crypto = pool('cryptoPool');
const ONE_K = 1_000n * 10n ** 18n;

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
  test('SDK path fills at or above the floor', async () => {
    await deal(USDCB, me, ONE_K * 10n);
    const before = await balanceOf(USDT, me);

    const { q, minAmountOut, calls } = await sdkSwap.swapCalls(stable, USDCB, USDT, ONE_K, 50, me);
    await send(calls);

    const got = (await balanceOf(USDT, me)) - before;
    expect(got).toBeGreaterThanOrEqual(minAmountOut);
    // CLOSE TO, NOT EQUAL TO, the quote. Off chain the approval mines its own block, so the swap
    // is priced one block later than the quote, and the spread carries a time-dependent staleness
    // premium. Only a same-transaction quote (the Solidity twin) is exact. Budget for this: an
    // off-chain integration that asserts quote == fill will flake.
    const drift = got > q.amountOut ? got - q.amountOut : q.amountOut - got;
    expect(Number((drift * 10_000n) / q.amountOut)).toBeLessThan(10); // < 10 bps
    console.log(`    filled ${fmt(got)} USDT for ${fmt(ONE_K)} USDCB`);
  }, 120_000);

  test('vanilla JSON-RPC path fills identically', async () => {
    await deal(USDCB, me, ONE_K * 10n);
    const before = await balanceOf(USDS, me);

    const { q, minAmountOut, calls } = await rpcSwap.swapCalls(stable, USDCB, USDS, ONE_K, 50, me);
    await send(calls);

    const got = (await balanceOf(USDS, me)) - before;
    expect(got).toBeGreaterThanOrEqual(minAmountOut);
    const drift = got > q.amountOut ? got - q.amountOut : q.amountOut - got;
    expect(Number((drift * 10_000n) / q.amountOut)).toBeLessThan(10);
    console.log(`    filled ${fmt(got)} USDS for ${fmt(ONE_K)} USDCB`);
  }, 120_000);

  test('stable to volatile lands within 2% of the pool mark', async () => {
    await deal(USDCB, me, ONE_K * 10n);
    const before = await balanceOf(WETH, me);

    const { q, calls } = await sdkSwap.swapCalls(crypto, USDCB, WETH, ONE_K * 5n, 100, me);
    await send(calls);

    const got = (await balanceOf(WETH, me)) - before;
    expect(got).toBeGreaterThan(0n);
    const implied = (got * 10n ** 18n) / (ONE_K * 5n);
    const diff = implied > q.markPrice ? implied - q.markPrice : q.markPrice - implied;
    expect(Number((diff * 10_000n) / q.markPrice)).toBeLessThan(200);
    console.log(`    filled ${fmt(got)} WETH for ${fmt(ONE_K * 5n)} USDCB`);
  }, 120_000);

  test('an unreachable floor reverts instead of filling short', async () => {
    await deal(USDCB, me, ONE_K * 10n);
    const q = await sdkSwap.quote(stable, USDCB, USDT, ONE_K);
    await send([rpcSwap.approveCall(USDCB, stable, ONE_K)]);

    // Demanding double the quote must revert. Simulated, so the assertion is about the pool's
    // behaviour rather than about a gas estimate.
    await expect(
      publicClient.simulateContract({
        address: stable, abi: POOL_ABI, functionName: 'swap',
        args: [USDCB, USDT, ONE_K, q.amountOut * 2n, me, deadline()], account: me,
      }),
    ).rejects.toThrow();

    // And the honest floor clears, so the revert above was the floor and not something else.
    const before = await balanceOf(USDT, me);
    await send([{
      to: stable,
      data: encodeFunctionData({
        abi: POOL_ABI, functionName: 'swap',
        args: [USDCB, USDT, ONE_K, (q.amountOut * 99n) / 100n, me, deadline()],
      }),
      label: 'swap',
    }]);
    expect((await balanceOf(USDT, me)) - before).toBeGreaterThan(0n);
  }, 120_000);
});

describe('example 2: multi-hop, multi-part route through the Router', () => {
  test('SDK path: two hops across two pools, one signature', async () => {
    await deal(USDT, me, ONE_K * 10n);
    const before = await balanceOf(WETH, me);
    const usdcbBefore = await balanceOf(USDCB, me);

    const hops = [{ pool: stable, tokenOut: USDCB }, { pool: crypto, tokenOut: WETH }];
    const expected = await sdkRouter.quotePath(USDT, ONE_K, hops);
    const parts = [{ tokenIn: USDT, amountIn: ONE_K, hops }];
    const floors = [{ token: WETH, minOut: (expected * 99n) / 100n }];

    await send([
      rpcSwap.approveCall(USDT, config.contracts.router, ONE_K),
      sdkRouter.routerCall(parts, floors, me),
    ]);

    const got = (await balanceOf(WETH, me)) - before;
    expect(got).toBeGreaterThanOrEqual(floors[0].minOut);
    // The intermediate must never reach the recipient: USDCB is consumed inside the route.
    expect(await balanceOf(USDCB, me)).toBe(usdcbBefore);
    console.log(`    routed ${fmt(ONE_K)} USDT -> USDCB -> ${fmt(got)} WETH`);
  }, 120_000);

  test('vanilla path: two parts, two inputs, two output tokens, one call', async () => {
    await deal(USDT, me, ONE_K * 10n);
    await deal(USDS, me, ONE_K * 10n);
    const beforeW = await balanceOf(WETH, me);
    const beforeU = await balanceOf(USDCB, me);

    const hopsA = [{ pool: stable, tokenOut: USDCB }, { pool: crypto, tokenOut: WETH }];
    const hopsB = [{ pool: stable, tokenOut: USDCB }];
    const outA = await rpcRouter.quotePath(USDT, ONE_K, hopsA);
    const outB = await rpcRouter.quotePath(USDS, ONE_K, hopsB);

    const parts = [
      { tokenIn: USDT, amountIn: ONE_K, hops: hopsA },
      { tokenIn: USDS, amountIn: ONE_K, hops: hopsB },
    ];
    const floors = [
      { token: WETH, minOut: (outA * 99n) / 100n },
      { token: USDCB, minOut: (outB * 99n) / 100n },
    ];

    await send([
      rpcSwap.approveCall(USDT, config.contracts.router, ONE_K),
      rpcSwap.approveCall(USDS, config.contracts.router, ONE_K),
      rpcRouter.routerCall(parts, floors, me),
    ]);

    const gotW = (await balanceOf(WETH, me)) - beforeW;
    const gotU = (await balanceOf(USDCB, me)) - beforeU;
    expect(gotW).toBeGreaterThanOrEqual(floors[0].minOut);
    expect(gotU).toBeGreaterThanOrEqual(floors[1].minOut);
    console.log(`    part A -> ${fmt(gotW)} WETH, part B -> ${fmt(gotU)} USDCB`);
  }, 120_000);

  test('an unreachable end-to-end floor reverts the WHOLE route', async () => {
    await deal(USDT, me, ONE_K * 10n);
    const hops = [{ pool: stable, tokenOut: USDCB }, { pool: crypto, tokenOut: WETH }];
    const expected = await sdkRouter.quotePath(USDT, ONE_K, hops);
    const parts = [{ tokenIn: USDT, amountIn: ONE_K, hops }];
    const floors = [{ token: WETH, minOut: expected * 2n }];

    await send([rpcSwap.approveCall(USDT, config.contracts.router, ONE_K)]);
    const held = await balanceOf(USDT, me);
    await expect(send([sdkRouter.routerCall(parts, floors, me)])).rejects.toThrow();
    // A reverted route leaves the input intact.
    expect(await balanceOf(USDT, me)).toBe(held);
  }, 120_000);
});
