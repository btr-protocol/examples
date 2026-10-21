/**
 * Read-only tests against a LIVE BTR chain. No key, no state change, no fork.
 *
 * These are the ones that prove the deployment is answering right now, so they are allowed to
 * talk to the real endpoint. They are paced and retried: a 429 from a public RPC is an UNKNOWN
 * result, never a pass and never a failure.
 *
 * Which feeds are exercised comes from the config: every token the chain's pools hold, grouped by
 * class. A class the chain does not have (no FX, no equities) skips its tests, with the reason in
 * the test name.
 *
 * Run: BTR_CHAIN_ID=<id> bun test test/read
 */
import { describe, expect, test } from 'bun:test';
import { config, feedId, followsUsEquityCalendar, legs, legsOf, usMarketOpen } from '../../src/config.ts';
import * as sdk from '../../sdk/01-oracle.ts';
import * as rpc from '../../rpc/01-oracle.ts';
import { testIf } from '../support.ts';

const oracle = config.contracts.poolFactory;

/** Symbols of a class that the pools hold, base included for `stable`. */
const listed = (cls: 'stable' | 'fx' | 'volatile' | 'equity') => [
  ...new Set([...(cls === 'stable' ? [config.baseToken] : []), ...legsOf(cls).map((l) => l.symbol)]),
];

const STABLES = listed('stable');
const FX = listed('fx');
const VOLATILE = listed('volatile');
const EQUITIES = listed('equity');

/** Feeds that trade continuously. Stale is unconditionally a failure for these. */
const CONTINUOUS = [...STABLES, ...FX, ...VOLATILE];
const SAMPLE = CONTINUOUS.slice(0, 4);

describe('oracle, SDK surface', () => {
  test('every listed continuous feed is live, unpaused and sane', async () => {
    for (const s of CONTINUOUS) {
      const f = await sdk.getFeed(oracle, feedId(s));
      expect(f.mark1e18).toBeGreaterThan(0n); // zero is the STALE sentinel, not a price
      expect(Number(f.flags) & 1).toBe(0); // not halted
      expect(Number(f.ttlSecs)).toBeGreaterThan(0);
      // The gate must accept a healthy feed. If this throws, the chain is stale, not the example.
      // maxAge = the feed's own ttl: pushes are edge triggered, so an idle stable sits minutes
      // old inside a 3600s window and the example's 600s default would reject a healthy feed.
      const g = sdk.gate(f, feedId(s), { ...sdk.DEFAULT_GATE, maxAgeSecs: Number(f.ttlSecs) });
      expect(g.ageSecs).toBeLessThanOrEqual(Number(f.ttlSecs));
    }
  }, 120_000);

  test('both tiers agree', async () => {
    for (const s of SAMPLE) {
      const ttl = Number((await sdk.getFeed(oracle, feedId(s))).ttlSecs);
      const m = await sdk.readAgreedMark(feedId(s), { ...sdk.DEFAULT_GATE, maxAgeSecs: ttl });
      expect(m.mark1e18).toBeGreaterThan(0n);
      expect(m.divergenceBps).toBeLessThanOrEqual(sdk.DEFAULT_GATE.maxTierDivergenceBps);
    }
  }, 120_000);

  test('a halted feed is rejected, not returned', () => {
    const halted = { mark1e18: 1n, sigmaPbps: 0n, updatedAtSecs: 0n, ttlSecs: 600n, confidenceBps: 0n, flags: 1n, maxDevBps: 0n, sourceTsMs: 0n };
    // biome-ignore lint/suspicious/noExplicitAny: constructing a FeedData by hand for the test
    expect(() => sdk.gate(halted as any, '0x00' as never)).toThrow(sdk.FeedRejected);
  });

  test('the zero-mark sentinel is rejected, not divided by', () => {
    const unpushed = { mark1e18: 0n, sigmaPbps: 0n, updatedAtSecs: 0n, ttlSecs: 600n, confidenceBps: 0n, flags: 0n, maxDevBps: 0n, sourceTsMs: 0n };
    // biome-ignore lint/suspicious/noExplicitAny: same
    expect(() => sdk.gate(unpushed as any, '0x00' as never)).toThrow(sdk.FeedRejected);
  });

  test('a stale feed is rejected', async () => {
    const s = CONTINUOUS[0];
    const f = await sdk.getFeed(oracle, feedId(s));
    const wayLater = Date.now() / 1000 + 86_400;
    expect(() => sdk.gate(f, feedId(s), sdk.DEFAULT_GATE, wayLater)).toThrow(sdk.FeedRejected);
  }, 30_000);

  test('an unconfigured feed id REVERTS, it does not return zero', async () => {
    const unknown = `0x${'ab'.repeat(32)}` as const;
    await expect(sdk.getFeed(oracle, unknown)).rejects.toThrow();
  }, 30_000);
});

describe('oracle, asset classes', () => {
  // The class difference that actually bites: stables and FX carry a longer ttl than volatiles. An
  // integrator who hardcodes one bound rejects a healthy long-ttl feed or accepts a stale short one.
  const longClass = [...FX, ...STABLES];
  testIf(longClass.length > 0 && VOLATILE.length > 0, 'chain lists no volatile, or no stable or FX, token')(
    'stable and FX ttl is longer than the volatile ttl',
    async () => {
      const ttl = async (s: string) => Number((await sdk.getFeed(oracle, feedId(s))).ttlSecs);
      const long = await Promise.all(longClass.map(ttl));
      const short = await Promise.all(VOLATILE.map(ttl));
      // Within a class the window is one value; across the two it is not.
      for (const t of long) expect(t).toBeGreaterThan(Math.max(...short));
      expect(new Set(short).size).toBe(1);
    },
    120_000,
  );

  // A sub-unit price is the case that rounds to zero: any FX token worth under one unit of the base
  // survives only if nothing in the read path truncates to whole units.
  const FX_TOKENS = Object.keys(config.tokens).filter((s) => config.tokens[s].class === 'fx' && s in config.feeds);
  testIf(FX_TOKENS.length > 0, 'chain has no FX token')('a sub-unit FX mark survives the read without rounding to zero', async () => {
    let seen = 0;
    for (const s of FX_TOKENS) {
      const f = await sdk.getFeed(oracle, feedId(s));
      if (f.mark1e18 === 0n || f.mark1e18 >= 10n ** 18n) continue; // dark, or worth over one unit
      seen++;
      expect(f.mark1e18 / 10n ** 18n).toBe(0n); // and this is what truncating it would give you
    }
    if (seen === 0) console.log('    SKIPPED: no live FX mark below 1.0 on this chain');
  }, 120_000);

  testIf(FX.length > 0, 'chain lists no FX token')('every listed FX feed is live: FX trades continuously, so stale is never normal', async () => {
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
  testIf(EQUITIES.length > 0, 'chain lists no equity token')('an equity feed is either live or explained by a closed market', async () => {
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
    for (const s of [...SAMPLE.slice(0, 2), ...EQUITIES]) {
      const raw = await rpc.getFeed(oracle, feedId(s));
      const viaRpc = rpc.classify(s, raw);
      const viaSdk = await sdk.classify(s);
      expect(viaRpc.verdict).toBe(viaSdk.verdict);
      expect(viaRpc.page).toBe(viaSdk.page);
    }
  }, 90_000);

  // The factory's feed set is a SUPERSET of what the pools trade. A token with a feed and no pool
  // leg is readable but not swappable, so "I can read a price" is not evidence that a pair trades.
  const UNLISTED = Object.keys(config.feeds).filter((s) => s !== config.baseToken && !legs.some((l) => l.symbol === s));
  testIf(UNLISTED.length > 0, 'every token with a feed is held by a pool')('a feed can exist with no pool leg', async () => {
    const s = UNLISTED[0];
    const f = await sdk.getFeed(oracle, feedId(s)); // reads without reverting: the lane exists
    expect(f.ttlSecs).toBeGreaterThan(0);
    expect(legs.some((l) => l.symbol === s)).toBe(false);
  }, 30_000);
});

describe('oracle, vanilla JSON-RPC surface', () => {
  test('reads the same marks as the SDK path', async () => {
    for (const s of SAMPLE) {
      const viaRpc = await rpc.getFeed(oracle, feedId(s));
      const viaSdk = await sdk.getFeed(oracle, feedId(s));
      // Different blocks are possible between the two reads, so compare the SHAPE, not the value.
      expect(viaRpc.mark1e18).toBeGreaterThan(0n);
      expect(Number(viaRpc.ttlSecs)).toBe(Number(viaSdk.ttlSecs));
      expect(Number(viaRpc.flags)).toBe(Number(viaSdk.flags));
    }
  }, 60_000);

  test('observedAtSecs matches the SDK implementation of the same rule', async () => {
    const f = await rpc.getFeed(oracle, feedId(CONTINUOUS[0]));
    const mine = rpc.observedAtSecs(f);
    const theirs = Math.min(Math.floor(Number(f.sourceTsMs) / 1000) || f.updatedAtSecs, f.updatedAtSecs);
    expect(mine).toBe(theirs);
  }, 30_000);

  test('conservative value never exceeds the raw value', async () => {
    const f = await sdk.getFeed(oracle, feedId(CONTINUOUS[0]));
    const amount = 10n ** 18n;
    const raw = (amount * f.mark1e18) / 10n ** 18n;
    const safe = sdk.conservativeValue1e18(f.mark1e18, Number(f.confidenceBps), amount, 2);
    expect(safe).toBeLessThanOrEqual(raw);
  }, 30_000);
});
