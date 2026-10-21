/**
 * Example 4, off chain, WITH THE SDK: depositing liquidity into one leg.
 *
 * Guide:    https://btr.markets/docs/5-1-1-basic-operations#4-deposit--withdraw
 * Twin:     ../rpc/04-deposit.ts     (same job, viem only, no SDK)
 * On chain: ../../foundry/test/04_Deposit.t.sol
 *
 * WHY THIS ONE. The SDK exposes `getLPBalance`, `getCoverageRatio` and `getAsset` as typed reads,
 * so the position you just opened can be valued without hand-decoding the pool's asset struct.
 *
 * BTR liquidity is SINGLE SIDED and PER LEG: one token, no pair, no ratio to match. Shares are
 * minted on that leg's own ERC-20 receipt and the share-to-value rate is the leg's liquidity
 * index, which fees compound into.
 *
 * `deposit` takes no deadline and no minOut. Nothing is quoted, so there is nothing stale to
 * protect: shares mint at the leg's current index.
 *
 * Run: bun run sdk/04-deposit.ts
 */
import { POOL_ABI } from '@btr-protocol/sdk/abis';
import { readContract } from '@btr-protocol/sdk/eth';
import { getCoverageRatio, getLPBalance } from '@btr-protocol/sdk/pool';
import { demoLeg, feedId, fmt, need, config, unitsWorth, withRetry, type Address } from '../src/config.ts';
import { account, approve, armed, call, provider, send } from '../src/sdk-wallet.ts';
import { getFeed } from './01-oracle.ts';

export const lpBalance = (p: Address, user: Address, tk: Address) =>
  withRetry(() => getLPBalance(provider, p, user, tk));

export const coverage = (p: Address, tk: Address) =>
  withRetry(() => getCoverageRatio(provider, p, tk));

/** Pool-wide solvency C, WAD: the rate a deposit mints at. */
export const solvency = (p: Address) =>
  withRetry(() => readContract<[bigint, boolean]>(provider, p, POOL_ABI, 'poolSolvencyWad', [])).then(([c]) => c);

export const depositCalls = (p: Address, tk: Address, amount: bigint) => [
  approve(tk, p, amount),
  call(p, POOL_ABI, 'deposit', [tk, amount], 'deposit'),
];

if (import.meta.main) {
  const leg = need(demoLeg(), 'pool with a non-base leg');
  const p = leg.pool;
  const tk = leg.token;
  // $10,000 of the leg, sized by value so the same line serves a stable and a volatile.
  const mark = (await getFeed(config.contracts.poolFactory, feedId(leg.symbol))).mark1e18;
  const amount = unitsWorth(mark, leg.decimals, 10_000);
  const user = (account ?? '0x000000000000000000000000000000000000dEaD') as Address;

  console.log(`pool        ${p}`);
  console.log(`leg         ${leg.symbol} ${tk}`);
  // Coverage is reserves over liabilities. A deposit mints at the pool-wide solvency C: it adds
  // `amount` to reserves and `amount / C` of face to liabilities, so the leg's coverage moves
  // TOWARD C (down if the leg sits above it, up if below), not toward 1.0. `donate` is the
  // non-dilutive way to raise a leg's coverage.
  console.log(`coverage    ${fmt(await coverage(p, tk))}   (pool C ${fmt(await solvency(p))})`);
  console.log(`lp before   ${fmt(await lpBalance(p, user, tk))}`);
  console.log(`depositing  ${fmt(amount, leg.decimals)} ${leg.symbol}`);

  await send(depositCalls(p, tk, amount));

  if (armed) console.log(`lp after    ${fmt(await lpBalance(p, user, tk))}`);
}
