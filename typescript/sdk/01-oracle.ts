/**
 * Example 1, off chain, WITH THE SDK: consuming BTR price feeds.
 *
 * Guide:   https://btr.markets/docs/5-1-5-consuming-price-feeds
 * Twin:    ../rpc/01-oracle.ts        (same job, viem only, no SDK)
 * On chain: ../../foundry/src/OracleConsumer.sol
 *
 * WHY THIS ONE. The SDK ships the deployed ABIs, a typed `FeedDataV2`, and `observedAtSecs`,
 * which is the freshness clock the contracts actually gate on. You get the right answer without
 * having to know that `updatedAtSecs` alone understates age by the relay lag. Pick this when you
 * are already in TypeScript and want the protocol's own semantics rather than your reading of them.
 *
 * Run: bun run sdk/01-oracle.ts
 */
import { createHttpProvider, readContract } from '@btr-protocol/sdk/eth';
import { EXTERNAL_ORACLE_V2_ABI } from '@btr-protocol/sdk/abis';
import { observedAtSecs, type FeedDataV2 } from '@btr-protocol/sdk/oracle';
import { config, feedId, fmt, rpcUrl, withRetry, type Address, type Hex } from '../src/config.ts';

/** Your risk appetite, not the protocol's. `ttlSecs` is the outer bound; this is tighter. */
export interface Gate {
  maxAgeSecs: number;
  maxConfidenceBps: number;
  maxTierDivergenceBps: number;
}

export const DEFAULT_GATE: Gate = {
  maxAgeSecs: 600,
  maxConfidenceBps: 100,
  maxTierDivergenceBps: 100,
};

export class FeedRejected extends Error {}

const provider = createHttpProvider(rpcUrl);

/** Raw read. Note the bigint fields: the SDK does not narrow them, and neither should you. */
export async function getFeed(oracle: Address, id: Hex): Promise<FeedDataV2> {
  return withRetry(() =>
    readContract<FeedDataV2>(provider, oracle, EXTERNAL_ORACLE_V2_ABI, 'getFeed', [id]),
  );
}

/**
 * The four checks. Skip any one of them and you have a read that is wrong in a specific way:
 *
 *  1. `mark1e18 === 0` is the STALE SENTINEL, not a price. It is what a registered feed carries
 *     before its first accepted push. Divide by it and you brick.
 *  2. Age is measured on `min(sourceTs, updatedAt)`, which is what `observedAtSecs` returns.
 *     Measuring off `updatedAtSecs` alone reads fresh off chain and reverts on chain.
 *  3. `flags & 1` is a guardian pause. It means a human decided not to trust this number.
 *  4. `confidenceBps` is the mark's one-sigma interval. A mark is a distribution, not a number,
 *     and `sigmaPbps` (1e6 = 100%) is the volatility you should be sizing against.
 */
export function gate(f: FeedDataV2, id: Hex, g: Gate = DEFAULT_GATE, nowSecs = Date.now() / 1000) {
  if (Number(f.flags) & 1) throw new FeedRejected(`feed ${id} is paused (flags & 1)`);
  if (f.mark1e18 === 0n) throw new FeedRejected(`feed ${id} has no mark yet (zero sentinel)`);

  const seen = observedAtSecs({
    sourceTsMs: Number(f.sourceTsMs),
    updatedAtSecs: Number(f.updatedAtSecs),
  });
  const age = Math.floor(nowSecs) - seen;
  if (age > g.maxAgeSecs) throw new FeedRejected(`feed ${id} is ${age}s old, bound ${g.maxAgeSecs}s`);
  if (age > Number(f.ttlSecs)) throw new FeedRejected(`feed ${id} is past its own ttl`);
  if (Number(f.confidenceBps) > g.maxConfidenceBps) {
    throw new FeedRejected(`feed ${id} confidence ${f.confidenceBps}bps exceeds ${g.maxConfidenceBps}`);
  }
  return { mark1e18: f.mark1e18, ageSecs: age, sigmaPbps: Number(f.sigmaPbps) };
}

/**
 * Read BOTH tiers and require agreement. The reference oracle is an independently pushed second
 * opinion; requiring the two to agree turns a single wedged or compromised relay from a loss into
 * a rejection. It returns the PRIMARY mark, never an average: averaging hides the disagreement
 * that was the entire reason to read twice.
 */
export async function readAgreedMark(id: Hex, g: Gate = DEFAULT_GATE) {
  const [p, r] = await Promise.all([
    getFeed(config.contracts.oracle, id),
    getFeed(config.contracts.refOracle, id),
  ]);
  const primary = gate(p, id, g);
  const reference = gate(r, id, g);

  const hi = primary.mark1e18 > reference.mark1e18 ? primary.mark1e18 : reference.mark1e18;
  const lo = primary.mark1e18 > reference.mark1e18 ? reference.mark1e18 : primary.mark1e18;
  const divergenceBps = Number(((hi - lo) * 10_000n) / reference.mark1e18);
  if (divergenceBps > g.maxTierDivergenceBps) {
    throw new FeedRejected(`tiers disagree by ${divergenceBps}bps on ${id}`);
  }
  return { ...primary, referenceMark1e18: reference.mark1e18, divergenceBps };
}

/**
 * Size a position off the confidence interval rather than the bare mark. `sigmas = 1` is the
 * floor, not the answer: pick it from what a wrong mark costs you.
 */
export function conservativeValue1e18(mark1e18: bigint, confidenceBps: number, amount: bigint, sigmas = 2) {
  const haircutBps = BigInt(confidenceBps * sigmas);
  if (haircutBps >= 10_000n) return 0n;
  return (amount * mark1e18 * (10_000n - haircutBps)) / 10_000n / 10n ** 18n;
}

if (import.meta.main) {
  const symbols = ['WETH', 'WBTC', 'EURC', 'USDT'];
  console.log(`${config.name} (chain ${config.chainId})`);
  console.log(`primary   ${config.contracts.oracle}`);
  console.log(`reference ${config.contracts.refOracle}\n`);

  for (const s of symbols) {
    const id = feedId(s);
    const raw = await getFeed(config.contracts.oracle, id);
    try {
      const agreed = await readAgreedMark(id);
      console.log(
        `${s.padEnd(6)} mark=${fmt(agreed.mark1e18).padStart(18)}  age=${String(agreed.ageSecs).padStart(4)}s` +
          `  sigma=${agreed.sigmaPbps}pbps  conf=${raw.confidenceBps}bps  tierDiff=${agreed.divergenceBps}bps`,
      );
    } catch (e) {
      // A rejection is the correct outcome, not a crash. Print it and carry on.
      console.log(`${s.padEnd(6)} REJECTED: ${(e as Error).message}`);
    }
  }
}
