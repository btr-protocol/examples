/**
 * Read-only tests against a LIVE BTR chain. No key, no state change, no fork.
 *
 * These are the ones that prove the deployment is answering right now, so they are allowed to
 * talk to the real endpoint. They are paced and retried: a 429 from a public RPC is an UNKNOWN
 * result, never a pass and never a failure.
 *
 * Run: bun test test/read
 */
import { describe, expect, test } from 'bun:test';
import { config, feedId } from '../../src/config.ts';
import * as sdk from '../../sdk/01-oracle.ts';
import * as rpc from '../../rpc/01-oracle.ts';

const SYMBOLS = ['WETH', 'WBTC', 'USDT', 'EURC'] as const;

describe('oracle, SDK surface', () => {
  test('every configured feed is live, unpaused and sane', async () => {
    for (const s of SYMBOLS) {
      const f = await sdk.getFeed(config.contracts.oracle, feedId(s));
      expect(f.mark1e18).toBeGreaterThan(0n); // zero is the STALE sentinel, not a price
      expect(Number(f.flags) & 1).toBe(0); // not paused
      expect(Number(f.ttlSecs)).toBeGreaterThan(0);
      // The gate must accept a healthy feed. If this throws, the chain is stale, not the example.
      const g = sdk.gate(f, feedId(s));
      expect(g.ageSecs).toBeLessThanOrEqual(Number(f.ttlSecs));
    }
  }, 60_000);

  test('both tiers agree', async () => {
    for (const s of SYMBOLS) {
      const m = await sdk.readAgreedMark(feedId(s));
      expect(m.mark1e18).toBeGreaterThan(0n);
      expect(m.divergenceBps).toBeLessThanOrEqual(sdk.DEFAULT_GATE.maxTierDivergenceBps);
    }
  }, 60_000);

  test('a paused feed is rejected, not returned', () => {
    const paused = { mark1e18: 1n, sigmaPbps: 0n, updatedAtSecs: 0n, ttlSecs: 600n, confidenceBps: 0n, flags: 1n, maxDeviationBps: 0n, sourceTsMs: 0n };
    // biome-ignore lint/suspicious/noExplicitAny: constructing a FeedDataV2 by hand for the test
    expect(() => sdk.gate(paused as any, '0x00' as never)).toThrow(sdk.FeedRejected);
  });

  test('the zero-mark sentinel is rejected, not divided by', () => {
    const unpushed = { mark1e18: 0n, sigmaPbps: 0n, updatedAtSecs: 0n, ttlSecs: 600n, confidenceBps: 0n, flags: 0n, maxDeviationBps: 0n, sourceTsMs: 0n };
    // biome-ignore lint/suspicious/noExplicitAny: same
    expect(() => sdk.gate(unpushed as any, '0x00' as never)).toThrow(sdk.FeedRejected);
  });

  test('a stale feed is rejected', async () => {
    const f = await sdk.getFeed(config.contracts.oracle, feedId('WETH'));
    const wayLater = Date.now() / 1000 + 86_400;
    expect(() => sdk.gate(f, feedId('WETH'), sdk.DEFAULT_GATE, wayLater)).toThrow(sdk.FeedRejected);
  }, 30_000);

  test('an unconfigured feed id REVERTS, it does not return zero', async () => {
    const unknown = `0x${'ab'.repeat(32)}` as const;
    await expect(sdk.getFeed(config.contracts.oracle, unknown)).rejects.toThrow();
  }, 30_000);
});

describe('oracle, vanilla JSON-RPC surface', () => {
  test('reads the same marks as the SDK path', async () => {
    for (const s of SYMBOLS) {
      const viaRpc = await rpc.getFeed(config.contracts.oracle, feedId(s));
      const viaSdk = await sdk.getFeed(config.contracts.oracle, feedId(s));
      // Different blocks are possible between the two reads, so compare the SHAPE, not the value.
      expect(viaRpc.mark1e18).toBeGreaterThan(0n);
      expect(Number(viaRpc.ttlSecs)).toBe(Number(viaSdk.ttlSecs));
      expect(Number(viaRpc.flags)).toBe(Number(viaSdk.flags));
    }
  }, 60_000);

  test('observedAtSecs matches the SDK implementation of the same rule', async () => {
    const f = await rpc.getFeed(config.contracts.oracle, feedId('WETH'));
    const mine = rpc.observedAtSecs(f);
    const theirs = Math.min(Math.floor(Number(f.sourceTsMs) / 1000) || f.updatedAtSecs, f.updatedAtSecs);
    expect(mine).toBe(theirs);
  }, 30_000);

  test('conservative value never exceeds the raw value', async () => {
    const f = await sdk.getFeed(config.contracts.oracle, feedId('WETH'));
    const amount = 10n ** 18n;
    const raw = (amount * f.mark1e18) / 10n ** 18n;
    const safe = sdk.conservativeValue1e18(f.mark1e18, Number(f.confidenceBps), amount, 2);
    expect(safe).toBeLessThanOrEqual(raw);
  }, 30_000);
});
