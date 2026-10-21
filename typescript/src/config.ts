/**
 * Deployment config, loaded from `config/<chainId>.json` at the repo root.
 *
 * Not one address is inlined in an example file. Point the examples at another BTR fleet by
 * dropping a second config file next to the first and setting `BTR_CHAIN_ID`.
 *
 * Environment:
 *   BTR_CHAIN_ID     which config to load                     (default 5042002)
 *   BTR_RPC_URL      endpoint to use                          (default: `rpcUrl` from the config)
 *   BTR_PRIVATE_KEY  set to actually SEND transactions. Unset, the write examples print the
 *                    calldata and stop, which is the mode you want against a live chain you do
 *                    not intend to touch. NEVER put a funded mainnet key here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export interface BtrConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;
  nativeSymbol: string;
  contracts: {
    /** Serves the oracle too: `feedOf(feedId, 1)` primary tier, `feedOf(feedId, 2)` reference. */
    poolFactory: Address;
    router: Address;
    faucet: Address;
  };
  pools: Record<string, Address>;
  baseToken: string;
  tokens: Record<string, Address>;
  feeds: Record<string, Hex>;
  /**
   * Which trading calendar a feed follows. NOT a risk class: `ttlSecs` is on chain and is read
   * from there. This is the one fact the chain cannot tell you, namely whether a stale feed is an
   * outage or a closed market, and it belongs in config for the same reason every address does.
   */
  calendars: Record<string, string[]>;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

export function loadConfig(chainId = Number(process.env.BTR_CHAIN_ID ?? 5042002)): BtrConfig {
  const path = join(repoRoot, 'config', `${chainId}.json`);
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as BtrConfig;
  if (cfg.chainId !== chainId) throw new Error(`${path} declares chainId ${cfg.chainId}`);
  return cfg;
}

export const config = loadConfig();

/** The endpoint every example talks to. Override to point at a local anvil fork. */
export const rpcUrl = process.env.BTR_RPC_URL ?? config.rpcUrl;

/** Present only when the caller opted into sending transactions. */
export const privateKey = process.env.BTR_PRIVATE_KEY as Hex | undefined;

export const token = (symbol: string): Address => {
  const a = config.tokens[symbol];
  if (!a) throw new Error(`token ${symbol} is not in config/${config.chainId}.json`);
  return a;
};

export const feedId = (symbol: string): Hex => {
  const f = config.feeds[symbol];
  if (!f) throw new Error(`feed ${symbol} is not in config/${config.chainId}.json`);
  return f;
};

export const pool = (name: string): Address => {
  const p = config.pools[name];
  if (!p) throw new Error(`pool ${name} is not in config/${config.chainId}.json`);
  return p;
};

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
 * both token decimals are divided out. EURC is 6 decimals against USDCB's 18: compare the raw
 * ratio and you are out by 1e12, which does not throw. It reads as a 99.9999% price impact, or,
 * if you floor it, as a clean zero that an `expect(x).toBe(0n)` will happily certify.
 */
export const impliedWad = (
  amountIn: bigint,
  decimalsIn: number,
  amountOut: bigint,
  decimalsOut: number,
): bigint => (amountOut * 10n ** BigInt(18 + decimalsIn)) / (amountIn * 10n ** BigInt(decimalsOut));

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
