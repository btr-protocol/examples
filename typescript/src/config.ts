/**
 * Deployment config, loaded from `config/<chainId>.json` at the repo root.
 *
 * Not one address is inlined in an example file. `config/<chainId>.json` is generated from the
 * dex-evm deployment records (`bun scripts/gen-config.ts <chainId> <deployments dir>`), so
 * pointing the examples at another BTR fleet is: generate its config, set `BTR_CHAIN_ID`.
 *
 * Environment:
 *   BTR_CHAIN_ID     which config to load                     (REQUIRED, no default)
 *   BTR_RPC_URL      endpoint to use                          (default: first of `rpcUrls`)
 *   BTR_PRIVATE_KEY  set to actually SEND transactions. Unset, the write examples print the
 *                    calldata and stop, which is the mode you want against a live chain you do
 *                    not intend to touch. NEVER put a funded mainnet key here.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/**
 * `volatile` is everything that is neither a stable nor FX and is not an equity: crypto and
 * metals. `equity` is a token that follows the US cash session (see `calendars`).
 */
export type TokenClass = 'stable' | 'fx' | 'volatile' | 'equity';

export interface TokenCfg {
  address: Address;
  decimals: number;
  class: TokenClass;
}

export interface PoolCfg {
  address: Address;
  /** Symbols of the legs the pool holds, base included. */
  assets: string[];
}

export interface BtrConfig {
  name: string;
  chainId: number;
  /** Public endpoints from the deployment records, best first. */
  rpcUrls: string[];
  nativeSymbol: string;
  manifestHash: Hex;
  contracts: {
    /** Also the oracle: `feedOf(feedId, 1)` is the primary tier, `feedOf(feedId, 2)` the reference. */
    poolFactory: Address;
    router: Address;
    faucet?: Address;
  };
  /** Symbol of the token every pool prices against. */
  baseToken: string;
  tokens: Record<string, TokenCfg>;
  /** Feed id per token symbol. */
  feeds: Record<string, Hex>;
  pools: Record<string, PoolCfg>;
  /**
   * Which trading calendar a feed follows. NOT a risk class: `ttlSecs` is on chain and is read
   * from there. This is the one fact the chain cannot tell you, namely whether a stale feed is an
   * outage or a closed market, and it belongs in config for the same reason every address does.
   */
  calendars: Record<string, string[]>;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

export function loadConfig(chainId = Number(process.env.BTR_CHAIN_ID)): BtrConfig {
  const dir = join(repoRoot, 'config');
  const path = join(dir, `${chainId}.json`);
  if (!Number.isInteger(chainId) || !existsSync(path)) {
    const have = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).map((f) => f.slice(0, -5));
    throw new Error(`BTR_CHAIN_ID is required and must name a file in config/ (have: ${have.join(', ')})`);
  }
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as BtrConfig;
  if (cfg.chainId !== chainId) throw new Error(`${path} declares chainId ${cfg.chainId}`);
  return cfg;
}

export const config = loadConfig();

/** The endpoint every example talks to. Override to point at a local anvil fork. */
export const rpcUrl = process.env.BTR_RPC_URL ?? config.rpcUrls[0];

/** Present only when the caller opted into sending transactions. */
export const privateKey = process.env.BTR_PRIVATE_KEY as Hex | undefined;

export const token = (symbol: string): Address => {
  const t = config.tokens[symbol];
  if (!t) throw new Error(`token ${symbol} is not in config/${config.chainId}.json`);
  return t.address;
};

export const feedId = (symbol: string): Hex => {
  const f = config.feeds[symbol];
  if (!f) throw new Error(`feed ${symbol} is not in config/${config.chainId}.json`);
  return f;
};

export const pool = (name: string): Address => {
  const p = config.pools[name];
  if (!p) throw new Error(`pool ${name} is not in config/${config.chainId}.json`);
  return p.address;
};

/** The pool base: every pool prices its other legs against it. */
export const base = { symbol: config.baseToken, ...config.tokens[config.baseToken] };

/** Base-token units for `whole` whole tokens, in the base token's own decimals. */
export const baseUnits = (whole: number | bigint): bigint => BigInt(whole) * 10n ** BigInt(base.decimals);

/** One non-base asset of one pool. A token listed in two pools is two legs. */
export interface Leg {
  poolName: string;
  pool: Address;
  symbol: string;
  token: Address;
  decimals: number;
  class: TokenClass;
}

export const legs: Leg[] = Object.entries(config.pools).flatMap(([poolName, p]) =>
  p.assets
    .filter((symbol) => symbol !== config.baseToken)
    .map((symbol) => ({
      poolName,
      pool: p.address,
      symbol,
      token: config.tokens[symbol].address,
      decimals: config.tokens[symbol].decimals,
      class: config.tokens[symbol].class,
    })),
);

export const legsOf = (cls: TokenClass): Leg[] => legs.filter((l) => l.class === cls);

/** Two different non-base legs of ONE pool, of class `cls` when given. */
export function legPair(cls?: TokenClass): [Leg, Leg] | undefined {
  for (const name of Object.keys(config.pools)) {
    const ls = legs.filter((l) => l.poolName === name && (!cls || l.class === cls));
    if (ls.length >= 2) return [ls[0], ls[1]];
  }
  return undefined;
}

/**
 * Two legs in DIFFERENT pools, the only shape a multi-pool route can take. Prefers a stable in
 * the first pool and a volatile in the second, else any two.
 */
export function crossPoolPair(): [Leg, Leg] | undefined {
  const pick = (a: Leg[], b: Leg[]) => {
    for (const x of a) for (const y of b) if (x.poolName !== y.poolName) return [x, y] as [Leg, Leg];
    return undefined;
  };
  return pick(legsOf('stable'), legsOf('volatile')) ?? pick(legs, legs);
}

/**
 * What the router example needs: `a` and `a2` in one pool, `b` in another. Part A runs
 * a -> base -> b across both pools, part B runs a2 -> base inside the first.
 */
export function routeSet(): { a: Leg; a2: Leg; b: Leg } | undefined {
  const pair = crossPoolPair();
  if (!pair) return undefined;
  const [a, b] = pair;
  const a2 = legs.find((l) => l.poolName === a.poolName && l.symbol !== a.symbol);
  return a2 && { a, a2, b };
}

/** The leg the single-leg examples run on: a stable when the chain has one. */
export const demoLeg = (): Leg | undefined => legsOf('stable')[0] ?? legs[0];

/** Two legs of one pool for the debt swap and spoke-to-spoke examples. */
export const demoPair = (): [Leg, Leg] | undefined => legPair('stable') ?? legPair();

/** Unwrap a config-derived selection, or say why this chain cannot run the example and stop. */
export function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    console.log(`${config.name} (chain ${config.chainId}) has no ${what}: nothing to demonstrate here.`);
    process.exit(0);
  }
  return value;
}

/** True when `symbol` tracks a market that closes, i.e. when stale can be normal. */
export const followsUsEquityCalendar = (symbol: string): boolean =>
  (config.calendars.usEquity ?? []).includes(symbol);

/**
 * Rough US cash session, in UTC. Holidays are not modelled: widen it to taste. It exists to tell
 * a CLOSED MARKET apart from an OUTAGE, and nothing else depends on its precision.
 */
export function usMarketOpen(d = new Date()): boolean {
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= 13 * 60 + 30 && mins < 20 * 60; // 13:30-20:00Z
}

/**
 * Whole-unit price of `tokenOut` per `tokenIn`, WAD, from a RAW in/out pair.
 *
 * The pool quotes `markPrice` in whole units, so a raw-amount ratio only lines up with it once
 * both token decimals are divided out. a 6-decimal token against an 18-decimal base: compare the raw
 * ratio and you are out by 1e12, which does not throw. It reads as a 99.9999% price impact, or,
 * if you floor it, as a clean zero that an `expect(x).toBe(0n)` will happily certify.
 */
export const impliedWad = (
  amountIn: bigint,
  decimalsIn: number,
  amountOut: bigint,
  decimalsOut: number,
): bigint => (amountOut * 10n ** BigInt(18 + decimalsIn)) / (amountIn * 10n ** BigInt(decimalsOut));

/**
 * Raw units of a token worth `usd` dollars, from its feed mark (USD per whole token, WAD). Sizes a
 * position by VALUE, so one number serves a stable, a token at a fraction of a cent and a share
 * worth hundreds of dollars.
 */
export const unitsWorth = (mark1e18: bigint, decimals: number, usd: number | bigint): bigint =>
  (BigInt(usd) * 10n ** BigInt(decimals) * 10n ** 18n) / mark1e18;

/** Absolute difference between two WAD prices, in bps of `b`. */
export const diffBps = (a: bigint, b: bigint): number =>
  Number(((a > b ? a - b : b - a) * 10_000n) / b);

/** Unix-seconds deadline, `secs` from now. */
export const deadline = (secs = 600): bigint => BigInt(Math.floor(Date.now() / 1000) + secs);

/** Apply a slippage tolerance in basis points to a quoted amount. */
export const floorFrom = (quoted: bigint, bps: number): bigint =>
  (quoted * BigInt(10_000 - bps)) / 10_000n;

/** Format a raw integer amount for reading. Display only. */
export const fmt = (raw: bigint, decimals = 18, places = 6): string => {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').slice(0, places);
  return `${neg ? '-' : ''}${whole}${places ? `.${frac}` : ''}`;
};

/**
 * Public RPC endpoints rate limit. A 429 is an UNKNOWN result, never a failure and never a pass:
 * retry it. Every example routes its reads through here so a throttled endpoint does not read as
 * "the pool returned nothing".
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e);
      const throttled = /429|rate.?limit|too many requests|timeout|ETIMEDOUT|ECONNRESET/i.test(msg);
      if (!throttled) throw e;
      await new Promise((r) => setTimeout(r, 300 * 2 ** i));
    }
  }
  throw lastErr;
}
