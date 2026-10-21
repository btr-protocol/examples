/**
 * Shared test plumbing: skipping what a chain cannot run, and sizing by value.
 *
 * The suites iterate the legs the config declares, so a chain without an FX pool or without
 * equities has nothing to run for those tests. They SKIP, and the reason is in the test name.
 */
import { test } from 'bun:test';
import { DEPOSIT_GATED_BIT, SWAP_GATED_BIT } from '@btr-protocol/sdk/abis';
import { base, config, feedId, unitsWorth, type Address, type Leg } from '../src/config.ts';
import { getFeed } from '../rpc/01-oracle.ts';
import { riskFlags } from '../rpc/06-debt-swap.ts';

/** `testIf(ok, why)(name, fn, timeout)` runs the test, or registers it skipped with `why` in its name. */
export const testIf = (ok: unknown, why: string): typeof test =>
  (ok
    ? test
    : (name: string, fn?: () => unknown, timeout?: number) =>
        test.skip(`${name} [SKIP: ${why}]`, fn as () => void, timeout)) as typeof test;

/** Raw units of `symbol` worth `usd` dollars at the live mark. */
export async function worth(symbol: string, usd: number): Promise<bigint> {
  const f = await getFeed(config.contracts.poolFactory, feedId(symbol));
  return unitsWorth(f.mark1e18, config.tokens[symbol].decimals, usd);
}

const gateCache = new Map<string, Promise<string | undefined>>();

/**
 * Why an UNLISTED caller cannot use `leg`, or undefined when it can. A leg can be gated for
 * swaps (SWAP_GATED) or for deposits (DEPOSIT_GATED): an allowlist the example account is not
 * on, so every state-changing test against it would revert for a reason unrelated to the code.
 */
export function gatedFor(kind: 'swap' | 'deposit', leg: Leg): Promise<string | undefined> {
  const bit = kind === 'swap' ? SWAP_GATED_BIT : DEPOSIT_GATED_BIT;
  const tokens: [string, Address][] = kind === 'swap' ? [[base.symbol, base.address], [leg.symbol, leg.token]] : [[leg.symbol, leg.token]];
  const key = `${kind}:${leg.pool}:${leg.symbol}`;
  if (!gateCache.has(key)) {
    gateCache.set(
      key,
      (async () => {
        for (const [symbol, tk] of tokens) {
          if ((await riskFlags(leg.pool, tk)) & bit) return `${kind}s on ${symbol} in ${leg.poolName} need an allowlisted caller`;
        }
        return undefined;
      })(),
    );
  }
  return gateCache.get(key)!;
}

/** First reason any of `legs` is gated for `kind`, or undefined when none is. */
export async function gatedForAny(kind: 'swap' | 'deposit', ...legs: (Leg | undefined)[]): Promise<string | undefined> {
  for (const l of legs) {
    if (!l) continue;
    const why = await gatedFor(kind, l);
    if (why) return why;
  }
  return undefined;
}
