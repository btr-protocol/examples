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
import { config, feedId, followsUsEquityCalendar, usMarketOpen } from '../../src/config.ts';
import * as sdk from '../../sdk/01-oracle.ts';
import * as rpc from '../../rpc/01-oracle.ts';

/** Feeds that trade continuously. Stale is unconditionally a failure for these. */
const SYMBOLS = ['WETH', 'WBTC', 'USDT', 'EURC'] as const;

/** FX. Continuous, but a LONGER ttl than everything else and a very different unit price. */
const FX = ['EURC', 'JPYC'] as const;

/** Tokenised equities. Live during the US cash session, stale by design outside it. */
const EQUITIES = ['NVDA', 'ASML', 'TSLA'] as const;

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

describe('oracle, asset classes', () => {
  // The class difference that actually bites: FX carries a 3600s ttl, equities and crypto 600s.
  // An integrator who hardcodes one bound rejects healthy FX or accepts stale equity.
  test('FX ttl is longer than the equity and crypto ttl', async () => {
    const eurc = await sdk.getFeed(config.contracts.oracle, feedId('EURC'));
    const jpyc = await sdk.getFeed(config.contracts.oracle, feedId('JPYC'));
    const nvda = await sdk.getFeed(config.contracts.oracle, feedId('NVDA'));
    const weth = await sdk.getFeed(config.contracts.oracle, feedId('WETH'));
    expect(Number(eurc.ttlSecs)).toBe(Number(jpyc.ttlSecs));
    expect(Number(nvda.ttlSecs)).toBe(Number(weth.ttlSecs));
    expect(Number(eurc.ttlSecs)).toBeGreaterThan(Number(nvda.ttlSecs));
  }, 60_000);

  // JPYC is ~0.0063 USD and ASML is ~1658 USD: six orders of magnitude in the SAME uint256.
  // Anything that rounds a mark to whole units reads JPYC as zero and calls it a pass.
  test('a sub-unit FX mark survives the read without rounding to zero', async () => {
    const f = await sdk.getFeed(config.contracts.oracle, feedId('JPYC'));
    expect(f.mark1e18).toBeGreaterThan(0n);
    expect(f.mark1e18).toBeLessThan(10n ** 18n); // below 1.0: the whole point
    expect(f.mark1e18 / 10n ** 18n).toBe(0n); // and this is what truncating it would give you
    // Sanity band on the real rate, so a decimals regression cannot pass as "small number".
    expect(f.mark1e18).toBeGreaterThan(10n ** 15n); // > 0.001
    expect(f.mark1e18).toBeLessThan(10n ** 17n); // < 0.1
  }, 30_000);

  test('every FX feed is live: FX trades continuously, so stale is never normal', async () => {
    for (const s of FX) {
      const st = await sdk.classify(s);
      expect(st.verdict).toBe('live');
      expect(st.page).toBe(false);
      expect(st.mark1e18).toBeGreaterThan(0n);
    }
  }, 60_000);

  // Equity feeds go stale outside the US cash session, and that is the system working, not an
  // outage. Asserting freshness unconditionally would make this suite fail every weekend, so the
  // assertion is on the VERDICT, and the execution case skips loudly when the market is shut.
  test('an equity feed is either live or explained by a closed market', async () => {
    for (const s of EQUITIES) {
      expect(followsUsEquityCalendar(s)).toBe(true);
      const st = await sdk.classify(s);
      expect(st.verdict).not.toBe('incident');
      if (st.verdict === 'closed') {
        console.log(`    SKIPPED (${s}): market closed, feed ${st.ageSecs}s old against a ${st.ttlSecs}s ttl. Not an outage.`);
        expect(st.page).toBe(false);
        expect(usMarketOpen()).toBe(false);
        continue;
      }
      expect(st.mark1e18).toBeGreaterThan(0n);
      expect(st.ageSecs).toBeLessThanOrEqual(st.ttlSecs);
    }
  }, 90_000);

  // Both surfaces must reach the same verdict from the same struct, or the vanilla twin is a
  // different monitor wearing the same name.
  test('the SDK and vanilla classifiers agree', async () => {
    for (const s of [...FX, ...EQUITIES]) {
      const raw = await rpc.getFeed(config.contracts.oracle, feedId(s));
      const viaRpc = rpc.classify(s, raw);
      const viaSdk = await sdk.classify(s);
      expect(viaRpc.verdict).toBe(viaSdk.verdict);
      expect(viaRpc.page).toBe(viaSdk.page);
    }
  }, 90_000);

  // The oracle's feed set is a SUPERSET of what the pools trade. ASML has a mark and no token, so
  // "I can read a price" is not evidence that a pair is swappable.
  test('a feed can exist with no listed token', async () => {
    const f = await sdk.getFeed(config.contracts.oracle, feedId('ASML'));
    expect(f.mark1e18).toBeGreaterThan(0n);
    expect(config.tokens.ASML).toBeUndefined();
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
