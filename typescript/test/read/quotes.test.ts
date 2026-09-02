/**
 * Read-only quote and route tests against a LIVE BTR chain.
 *
 * A quote that reverts or returns zero is a FAILURE, not a price. That is the whole assertion
 * set below: every pair a reader might reasonably try must quote, and both off-chain surfaces
 * must produce byte-identical calldata for the same intent.
 *
 * Run: bun test test/read
 */
import { describe, expect, test } from 'bun:test';
import { config, pool, token } from '../../src/config.ts';
import * as sdkSwap from '../../sdk/03-pool-swap.ts';
import * as rpcSwap from '../../rpc/03-pool-swap.ts';
import * as sdkRouter from '../../sdk/02-router-swap.ts';
import * as rpcRouter from '../../rpc/02-router-swap.ts';
import { publicClient, ROUTER_ABI } from '../../src/viem-client.ts';

const USDCB = token(config.baseToken);
const USDT = token('USDT');
const USDS = token('USDS');
const WETH = token('WETH');
const stable = pool('stablePool');
const crypto = pool('cryptoPool');
const ONE_K = 1_000n * 10n ** 18n;
const RECIPIENT = '0x000000000000000000000000000000000000dEaD' as const;

describe('pool quotes', () => {
  test('base to spoke quotes non-zero and reports a mark', async () => {
    const q = await sdkSwap.quote(stable, USDCB, USDT, ONE_K);
    expect(q.amountOut).toBeGreaterThan(0n);
    expect(q.markPrice).toBeGreaterThan(0n);
    expect(q.midPrice).toBeGreaterThan(0n);
    expect(Number(q.spreadPbps)).toBeGreaterThan(0);
  }, 30_000);

  test('spoke to spoke routes through the pool base in one call', async () => {
    const q = await rpcSwap.quote(stable, USDT, USDS, ONE_K);
    expect(q.amountOut).toBeGreaterThan(0n);
    expect(q.routeHops.length).toBe(3);
    expect(q.routeHops[1].toLowerCase()).toBe(USDCB.toLowerCase());
  }, 30_000);

  test('stable to volatile prices within 2% of the pool mark', async () => {
    const q = await sdkSwap.quote(crypto, USDCB, WETH, ONE_K);
    expect(q.amountOut).toBeGreaterThan(0n);
    const implied = (q.amountOut * 10n ** 18n) / ONE_K;
    const diff = implied > q.markPrice ? implied - q.markPrice : q.markPrice - implied;
    expect(Number((diff * 10_000n) / q.markPrice)).toBeLessThan(200);
  }, 30_000);

  test('the SDK and the vanilla path agree on the same quote', async () => {
    const a = await sdkSwap.quote(stable, USDCB, USDT, ONE_K);
    const b = await rpcSwap.quote(stable, USDCB, USDT, ONE_K);
    // Same block is not guaranteed, so compare within a band rather than exactly.
    const diff = a.amountOut > b.amountOut ? a.amountOut - b.amountOut : b.amountOut - a.amountOut;
    expect(Number((diff * 10_000n) / a.amountOut)).toBeLessThan(50);
  }, 30_000);
});

describe('router route building', () => {
  test('the router on chain points at the official factory', async () => {
    const factory = await publicClient.readContract({
      address: config.contracts.router, abi: ROUTER_ABI, functionName: 'factory',
    });
    expect(factory.toLowerCase()).toBe(config.contracts.poolFactory.toLowerCase());
  }, 30_000);

  test('a two-hop path across two pools quotes non-zero', async () => {
    const out = await sdkRouter.quotePath(USDT, ONE_K, [
      { pool: stable, tokenOut: USDCB },
      { pool: crypto, tokenOut: WETH },
    ]);
    expect(out).toBeGreaterThan(0n);
  }, 60_000);

  test('both surfaces encode the SAME router calldata for the same route', async () => {
    const parts = [{ tokenIn: USDT, amountIn: ONE_K, hops: [{ pool: stable, tokenOut: USDCB }] }];
    const floors = [{ token: USDCB, minOut: 1n }];
    // `deadline()` is time-based, so compare everything up to the trailing word.
    const a = sdkRouter.routerCall(parts, floors, RECIPIENT).data;
    const b = rpcRouter.routerCall(parts, floors, RECIPIENT).data;
    expect(a.slice(0, -64).toLowerCase()).toBe(b.slice(0, -64).toLowerCase());
  });

  test('a terminal token with no floor is refused before it is sent', () => {
    const parts = [{ tokenIn: USDT, amountIn: ONE_K, hops: [{ pool: stable, tokenOut: USDCB }] }];
    expect(() => sdkRouter.routerCall(parts, [{ token: WETH, minOut: 0n }], RECIPIENT)).toThrow(/no floor/);
    expect(() => rpcRouter.routerCall(parts, [{ token: WETH, minOut: 0n }], RECIPIENT)).toThrow(/no floor/);
  });

  test('a duplicated floor is refused before it is sent', () => {
    const parts = [{ tokenIn: USDT, amountIn: ONE_K, hops: [{ pool: stable, tokenOut: USDCB }] }];
    const dup = [{ token: USDCB, minOut: 0n }, { token: USDCB, minOut: 0n }];
    expect(() => sdkRouter.routerCall(parts, dup, RECIPIENT)).toThrow(/twice/);
    expect(() => rpcRouter.routerCall(parts, dup, RECIPIENT)).toThrow(/twice/);
  });
});

describe('liquidity reads', () => {
  test('previewWithdraw of zero shares is zero, not a revert', async () => {
    const { previewWithdraw } = await import('../../rpc/05-withdraw.ts');
    const [amount, haircut] = await previewWithdraw(stable, USDT, 0n);
    expect(amount).toBe(0n);
    expect(haircut).toBe(0n);
  }, 30_000);

  test('both debt-swap legs carry the liability-swap bit', async () => {
    const { assertLegsEnabled } = await import('../../rpc/06-debt-swap.ts');
    await assertLegsEnabled(stable, USDT, USDS);
  }, 30_000);
});
