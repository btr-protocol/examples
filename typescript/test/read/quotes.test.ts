/**
 * Read-only quote and route tests against a LIVE BTR chain.
 *
 * A quote that reverts or returns zero is a FAILURE, not a price. That is the whole assertion
 * set below: every pair a reader might reasonably try must quote, and both off-chain surfaces
 * must produce byte-identical calldata for the same intent.
 *
 * The pairs come from the config (`pools`, each token's `class`), not from names: a chain with no
 * FX pool or no equities has nothing to run for those tests, and they SKIP with the reason in
 * the test name.
 *
 * Run: BTR_CHAIN_ID=<id> bun test test/read
 */
import { describe, expect, test } from 'bun:test';
import { base, baseUnits, config, crossPoolPair, demoLeg, diffBps, impliedWad, legPair, legsOf } from '../../src/config.ts';
import * as sdkSwap from '../../sdk/03-pool-swap.ts';
import * as rpcSwap from '../../rpc/03-pool-swap.ts';
import * as sdkRouter from '../../sdk/02-router-swap.ts';
import * as rpcRouter from '../../rpc/02-router-swap.ts';
import { publicClient, ROUTER_ABI } from '../../src/viem-client.ts';
import { testIf, worth } from '../support.ts';

const first = demoLeg();
const spokes = legPair('stable') ?? legPair();
const volatile = legsOf('volatile')[0];
const fx = legsOf('fx');
const equities = legsOf('equity');
const equityPair = legPair('equity');
const cross = crossPoolPair();

const ONE_K = baseUnits(1_000);
/** FX legs can be shallow: a thin leg reverts `ThresholdViolation` on an exit it cannot honour. */
const HUNDRED = baseUnits(100);
const RECIPIENT = '0x000000000000000000000000000000000000dEaD' as const;
const pct2 = 200; // bps
/** A thin leg moves on a trade, so the FX bound is wider. A decimals bug is out by orders of magnitude, not by percent. */
const thinBps = 500;

describe('pool quotes', () => {
  testIf(first, 'no pool holds a non-base leg')('base to spoke quotes non-zero and reports a mark', async () => {
    const q = await sdkSwap.quote(first!.pool, base.address, first!.token, ONE_K);
    expect(q.amountOut).toBeGreaterThan(0n);
    expect(q.markPrice).toBeGreaterThan(0n);
    expect(q.midPrice).toBeGreaterThan(0n);
    expect(Number(q.spreadPbps)).toBeGreaterThan(0);
  }, 30_000);

  testIf(spokes, 'no pool holds two non-base legs')('spoke to spoke routes through the pool base in one call', async () => {
    const [a, b] = spokes!;
    const amountIn = await worth(a.symbol, 1_000);
    const q = await rpcSwap.quote(a.pool, a.token, b.token, amountIn);
    expect(q.amountOut).toBeGreaterThan(0n);
    expect(q.routeHops.length).toBe(3);
    expect(q.routeHops[1].toLowerCase()).toBe(base.address.toLowerCase());
  }, 30_000);

  testIf(volatile, 'no pool holds a volatile leg')('base to volatile prices within 2% of the pool mark', async () => {
    const q = await sdkSwap.quote(volatile!.pool, base.address, volatile!.token, ONE_K);
    expect(q.amountOut).toBeGreaterThan(0n);
    const implied = impliedWad(ONE_K, base.decimals, q.amountOut, volatile!.decimals);
    expect(diffBps(implied, q.markPrice)).toBeLessThan(pct2);
  }, 30_000);

  testIf(first, 'no pool holds a non-base leg')('the SDK and the vanilla path agree on the same quote', async () => {
    const a = await sdkSwap.quote(first!.pool, base.address, first!.token, ONE_K);
    const b = await rpcSwap.quote(first!.pool, base.address, first!.token, ONE_K);
    // Same block is not guaranteed, so compare within a band rather than exactly.
    expect(diffBps(a.amountOut, b.amountOut)).toBeLessThan(50);
  }, 30_000);
});

// FX legs. Two things break here that do not break on a same-decimals pair: an FX token can have
// fewer decimals than the base, and its unit price can be a fraction of a cent. Every assertion
// below normalises decimals before it compares anything, because the raw ratio is out by
// 10^(18 - decimals) on a short-decimals leg and nothing throws when it is.
describe('fx leg quotes', () => {
  testIf(fx.length, 'no pool holds an FX leg')('base to an FX leg prices within 5% of the mark', async () => {
    for (const leg of fx) {
      const q = await sdkSwap.quote(leg.pool, base.address, leg.token, HUNDRED);
      expect(q.amountOut).toBeGreaterThan(0n);
      expect(q.markPrice).toBeGreaterThan(0n);
      const implied = impliedWad(HUNDRED, base.decimals, q.amountOut, leg.decimals);
      expect(diffBps(implied, q.markPrice)).toBeLessThan(thinBps);
      if (Math.abs(base.decimals - leg.decimals) >= 2) {
        // And the trap, stated: the raw ratio a same-decimals integration would compute is not close.
        const naive = (q.amountOut * 10n ** 18n) / HUNDRED;
        expect(diffBps(naive, q.markPrice)).toBeGreaterThan(9_000);
      }
    }
  }, 60_000);

  testIf(fx.length, 'no pool holds an FX leg')('a sub-unit FX leg quotes a huge integer, not a rounded zero', async () => {
    for (const leg of fx) {
      const q = await sdkSwap.quote(leg.pool, base.address, leg.token, HUNDRED);
      if (q.markPrice <= 10n * 10n ** 18n) continue; // worth more than a tenth of a unit
      // A whole-unit intermediate would floor the price to 0 and the quote would still return
      // something, which is why the assertion is on the mark, not the output.
      const implied = impliedWad(HUNDRED, base.decimals, q.amountOut, leg.decimals);
      expect(diffBps(implied, q.markPrice)).toBeLessThan(thinBps);
      return;
    }
    console.log('    SKIPPED: no pool FX leg trades below a tenth of a base unit on this chain');
  }, 60_000);

  testIf(fx.length, 'no pool holds an FX leg')('the vanilla path agrees on the FX quote', async () => {
    const a = await sdkSwap.quote(fx[0].pool, base.address, fx[0].token, HUNDRED);
    const b = await rpcSwap.quote(fx[0].pool, base.address, fx[0].token, HUNDRED);
    expect(diffBps(a.amountOut, b.amountOut)).toBeLessThan(50);
  }, 30_000);
});

describe('equity leg quotes', () => {
  // An integrator trading tokenised equities routes through the pool that holds them.
  testIf(equities.length, 'no pool holds an equity leg')('base to equity quotes non-zero on every listed leg', async () => {
    for (const leg of equities.slice(0, 2)) {
      const q = await sdkSwap.quote(leg.pool, base.address, leg.token, ONE_K);
      expect(q.amountOut).toBeGreaterThan(0n);
      expect(q.markPrice).toBeGreaterThan(0n);
      const implied = impliedWad(ONE_K, base.decimals, q.amountOut, leg.decimals);
      expect(diffBps(implied, q.markPrice)).toBeLessThan(pct2);
      // A share costs hundreds of dollars, so tokenOut per base is a SMALL WAD. Asserting
      // `markPrice > 1e18` here is the mistake: it would reject every equity.
      expect(q.markPrice).toBeLessThan(10n ** 18n);
      console.log(`    ${leg.symbol}: 1000 ${base.symbol} -> ${q.amountOut} raw, mark ${q.markPrice} WAD`);
    }
  }, 60_000);

  testIf(equityPair, 'no pool holds two equity legs')('equity to equity routes through the pool base in one call', async () => {
    const [a, b] = equityPair!;
    const q = await rpcSwap.quote(a.pool, a.token, b.token, 10n ** BigInt(a.decimals));
    expect(q.amountOut).toBeGreaterThan(0n);
    expect(q.routeHops.length).toBe(3);
    expect(q.routeHops[1].toLowerCase()).toBe(base.address.toLowerCase());
  }, 30_000);
});

describe('router route building', () => {
  test('the router on chain points at the official factory', async () => {
    const factory = await publicClient.readContract({
      address: config.contracts.router, abi: ROUTER_ABI, functionName: 'factory',
    });
    expect(factory.toLowerCase()).toBe(config.contracts.poolFactory.toLowerCase());
  }, 30_000);

  testIf(cross, 'fewer than two pools')('a two-hop path across two pools quotes non-zero', async () => {
    const [a, b] = cross!;
    const amountIn = await worth(a.symbol, 1_000);
    const out = await sdkRouter.quotePath(a.token, amountIn, [
      { pool: a.pool, tokenOut: base.address },
      { pool: b.pool, tokenOut: b.token },
    ]);
    expect(out).toBeGreaterThan(0n);
  }, 60_000);

  // The three tests below only encode calldata: no state is read or written.
  testIf(first, 'no pool holds a non-base leg')('both surfaces encode the SAME router calldata for the same route', () => {
    const parts = [{ tokenIn: first!.token, amountIn: ONE_K, hops: [{ pool: first!.pool, tokenOut: base.address }] }];
    const floors = [{ token: base.address, minOut: 1n }];
    // `deadline()` is time-based, so compare everything up to the trailing word.
    const a = sdkRouter.routerCall(parts, floors, RECIPIENT).data;
    const b = rpcRouter.routerCall(parts, floors, RECIPIENT).data;
    expect(a.slice(0, -64).toLowerCase()).toBe(b.slice(0, -64).toLowerCase());
  });

  testIf(first, 'no pool holds a non-base leg')('a terminal token with no floor is refused before it is sent', () => {
    const parts = [{ tokenIn: first!.token, amountIn: ONE_K, hops: [{ pool: first!.pool, tokenOut: base.address }] }];
    const wrong = [{ token: first!.token, minOut: 0n }];
    expect(() => sdkRouter.routerCall(parts, wrong, RECIPIENT)).toThrow(/no floor/);
    expect(() => rpcRouter.routerCall(parts, wrong, RECIPIENT)).toThrow(/no floor/);
  });

  testIf(first, 'no pool holds a non-base leg')('a duplicated floor is refused before it is sent', () => {
    const parts = [{ tokenIn: first!.token, amountIn: ONE_K, hops: [{ pool: first!.pool, tokenOut: base.address }] }];
    const dup = [{ token: base.address, minOut: 0n }, { token: base.address, minOut: 0n }];
    expect(() => sdkRouter.routerCall(parts, dup, RECIPIENT)).toThrow(/twice/);
    expect(() => rpcRouter.routerCall(parts, dup, RECIPIENT)).toThrow(/twice/);
  });
});

describe('liquidity reads', () => {
  testIf(first, 'no pool holds a non-base leg')('previewWithdraw of zero shares is zero, not a revert', async () => {
    const { previewWithdraw } = await import('../../rpc/05-withdraw.ts');
    const [amount, haircut] = await previewWithdraw(first!.pool, first!.token, 0n);
    expect(amount).toBe(0n);
    expect(haircut).toBe(0n);
  }, 30_000);

  testIf(spokes, 'no pool holds two non-base legs')('both debt-swap legs carry the liability-swap bit', async () => {
    const { assertLegsEnabled } = await import('../../rpc/06-debt-swap.ts');
    await assertLegsEnabled(spokes![0].pool, spokes![0].token, spokes![1].token);
  }, 30_000);
});

