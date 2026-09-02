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
import { getCoverageRatio, getLPBalance } from '@btr-protocol/sdk/pool';
import { fmt, pool, token, withRetry, type Address } from '../src/config.ts';
import { account, approve, armed, call, decimalsOf, provider, send } from '../src/sdk-wallet.ts';

export const lpBalance = (p: Address, user: Address, tk: Address) =>
  withRetry(() => getLPBalance(provider, p, user, tk));

export const coverage = (p: Address, tk: Address) =>
  withRetry(() => getCoverageRatio(provider, p, tk));

export const depositCalls = (p: Address, tk: Address, amount: bigint) => [
  approve(tk, p, amount),
  call(p, POOL_ABI, 'deposit', [tk, amount], 'deposit'),
];

if (import.meta.main) {
  const p = pool('stablePool');
  const tk = token('USDT');
  const amount = 10_000n * 10n ** BigInt(await decimalsOf(tk));
  const user = (account ?? '0x000000000000000000000000000000000000dEaD') as Address;

  console.log(`pool        ${p}`);
  console.log(`leg         USDT ${tk}`);
  // Coverage is reserves over liabilities. A deposit credits BOTH by the same value, so it moves
  // coverage TOWARD 1.0: it lifts an under-covered leg and lowers an over-covered one. Depositing
  // is not a way to improve a leg's coverage; `donate` is.
  console.log(`coverage    ${fmt(await coverage(p, tk))}`);
  console.log(`lp before   ${fmt(await lpBalance(p, user, tk))}`);
  console.log(`depositing  ${fmt(amount)} USDT`);

  await send(depositCalls(p, tk, amount));

  if (armed) console.log(`lp after    ${fmt(await lpBalance(p, user, tk))}`);
}
