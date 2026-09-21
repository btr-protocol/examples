/**
 * Example 1, off chain, VANILLA JSON-RPC: consuming BTR price feeds with viem only.
 *
 * Guide:    https://btr.markets/docs/5-1-5-consuming-price-feeds
 * Twin:     ../sdk/01-oracle.ts     (same job, using @btr-protocol/sdk)
 * On chain: ../../foundry/src/OracleConsumer.sol
 *
 * WHY THIS ONE. Nothing here imports the BTR SDK. The oracle is one `eth_call` against a
 * four-line ABI, so a Python, Rust or Go consumer is the same shape. Pick it when you do not want
 * a dependency, or when your stack is not TypeScript and this is your reference.
 *
 * WHAT YOU GIVE UP: the freshness rule below is transcribed by hand. `observedAt` must be
 * `min(sourceTs, updatedAt)`; getting that wrong is not a crash, it is a feed that reads fresh
 * off chain and reverts on chain.
 *
 * Run: bun run rpc/01-oracle.ts
 */
import {
  config, feedId, fmt, followsUsEquityCalendar, usMarketOpen, withRetry, type Hex,
} from '../src/config.ts';
import { ORACLE_ABI, publicClient } from '../src/viem-client.ts';

export interface Feed {
  mark1e18: bigint;
  sigmaPbps: number;
  updatedAtSecs: number;
  ttlSecs: number;
  confidenceBps: number;
  flags: number;
  maxDevBps: number;
  /** uint48: viem decodes it as a `number`, the SDK as a `bigint`. Normalise before comparing. */
  sourceTsMs: number | bigint;
}

export const getFeed = (oracle: Hex, id: Hex) =>
  withRetry(() =>
    publicClient.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'getFeed', args: [id] }),
  ) as Promise<Feed>;

/** The clock the CONTRACTS gate on. Transcribe it exactly: `min(sourceTs, updatedAt)`, falling
 *  back to `updatedAt` when the feed is unsigned. */
export function observedAtSecs(f: Feed): number {
  const ms = Number(f.sourceTsMs);
  if (ms === 0) return f.updatedAtSecs;
  const src = Math.floor(ms / 1000);
  return src > f.updatedAtSecs ? f.updatedAtSecs : src;
}

export class FeedRejected extends Error {}

/**
 * The same four checks as the SDK version and the Solidity one, in the same order:
 *   1. `flags & 1` is a guardian pause. Stop.
 *   2. `mark1e18 === 0` is the STALE SENTINEL, never a price.
 *   3. age on the observed clock, against YOUR bound and the feed's own `ttlSecs`.
 *   4. `confidenceBps` is the one-sigma interval; `sigmaPbps` (1e6 = 100%) is the volatility.
 */
export function gate(f: Feed, id: Hex, maxAgeSecs = 600, maxConfidenceBps = 100, nowSecs = Date.now() / 1000) {
  if (f.flags & 1) throw new FeedRejected(`feed ${id} is paused`);
  if (f.mark1e18 === 0n) throw new FeedRejected(`feed ${id} has no mark yet (zero sentinel)`);
  const age = Math.floor(nowSecs) - observedAtSecs(f);
  if (age > maxAgeSecs || age > f.ttlSecs) throw new FeedRejected(`feed ${id} is ${age}s old`);
  if (f.confidenceBps > maxConfidenceBps) throw new FeedRejected(`feed ${id} confidence too wide`);
  return { mark1e18: f.mark1e18, ageSecs: age, sigmaPbps: f.sigmaPbps };
}

/** Read both tiers and require agreement. Returns the PRIMARY mark, never an average. */
export async function readAgreedMark(id: Hex, maxDivergenceBps = 100) {
  const [p, r] = await Promise.all([
    getFeed(config.contracts.oracle, id),
    getFeed(config.contracts.refOracle, id),
  ]);
  const a = gate(p, id);
  const b = gate(r, id);
  const hi = a.mark1e18 > b.mark1e18 ? a.mark1e18 : b.mark1e18;
  const lo = a.mark1e18 > b.mark1e18 ? b.mark1e18 : a.mark1e18;
  const divergenceBps = Number(((hi - lo) * 10_000n) / b.mark1e18);
  if (divergenceBps > maxDivergenceBps) throw new FeedRejected(`tiers disagree by ${divergenceBps}bps`);
  return { ...a, referenceMark1e18: b.mark1e18, divergenceBps };
}

/**
 * The same three-way verdict as the SDK twin, transcribed. `live` | `closed` | `incident`.
 *
 * Crypto and FX trade continuously, so a stale WETH, EURC or JPYC feed is unconditionally an
 * incident. An equity feed is stale for most of the week BY DESIGN: the US cash session is about
 * 30% of it, and the keeper does not heartbeat a frozen record. Page on `incident` only.
 */
export type Verdict = 'live' | 'closed' | 'incident';

export function classify(symbol: string, f: Feed, nowSecs = Date.now() / 1000) {
  const ageSecs = Math.floor(nowSecs) - observedAtSecs(f);
  const base = { mark1e18: f.mark1e18, ageSecs, ttlSecs: f.ttlSecs };
  if (f.flags & 1) return { ...base, verdict: 'incident' as Verdict, page: true };
  if (f.mark1e18 === 0n) return { ...base, verdict: 'incident' as Verdict, page: true };
  if (ageSecs <= f.ttlSecs) return { ...base, verdict: 'live' as Verdict, page: false };
  const closed = followsUsEquityCalendar(symbol) && !usMarketOpen();
  return { ...base, verdict: (closed ? 'closed' : 'incident') as Verdict, page: !closed };
}

if (import.meta.main) {
  console.log(`${config.name} (chain ${config.chainId}), no SDK\n`);
  // FX (ttl 3600) beside equities and crypto (ttl 600). Same struct, three different meanings for
  // the same age in seconds.
  for (const s of ['EURC', 'JPYC', 'NVDA', 'ASML', 'TSLA', 'WETH']) {
    const id = feedId(s);
    const raw = await getFeed(config.contracts.oracle, id);
    const st = classify(s, raw);
    const head =
      `${s.padEnd(6)} ${st.verdict.padEnd(8)} ttl=${String(st.ttlSecs).padStart(4)}s` +
      ` age=${String(st.ageSecs).padStart(6)}s page=${st.page ? 'YES' : 'no '}`;
    try {
      const m = await readAgreedMark(id);
      console.log(
        `${head}  mark=${fmt(m.mark1e18).padStart(22)}` +
          `  sigma=${m.sigmaPbps}pbps  conf=${raw.confidenceBps}bps  tierDiff=${m.divergenceBps}bps`,
      );
    } catch (e) {
      console.log(`${head}  REJECTED: ${(e as Error).message}`);
    }
  }

  // An id the oracle has never been configured with REVERTS `FeedNotFound`. It does NOT return a
  // zero struct, so this is not a soft miss you can branch on.
  try {
    await getFeed(config.contracts.oracle, `0x${'11'.repeat(32)}` as Hex);
    console.log('\nunknown feed: returned a value (unexpected)');
  } catch (e) {
    console.log(`\nunknown feed: reverted as expected (${(e as Error).name})`);
  }
}
