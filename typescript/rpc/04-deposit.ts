/**
 * Example 4, off chain, VANILLA JSON-RPC: depositing liquidity with viem only.
 *
 * Guide:    https://btr.markets/docs/5-1-1-basic-operations#4-deposit--withdraw
 * Twin:     ../sdk/04-deposit.ts     (same job, using @btr-protocol/sdk)
 * On chain: ../../foundry/test/04_Deposit.t.sol
 *
 * WHY THIS ONE. `deposit(token, amount)` is the simplest entry point BTR has. Single sided, per
 * leg: one token, no pair, no ratio to match. No deadline and no minOut, because nothing is
 * quoted and there is therefore nothing stale to protect.
 *
 * Run: bun run rpc/04-deposit.ts
 */
import { encodeFunctionData } from 'viem';
import { config, demoLeg, feedId, fmt, need, unitsWorth, withRetry, type Address } from '../src/config.ts';
import { POOL_ABI, armed, publicClient, send, senderOrPlaceholder, type Call } from '../src/viem-client.ts';
import { getFeed } from './01-oracle.ts';
import { approveCall } from './03-pool-swap.ts';

export const lpBalance = (p: Address, user: Address, tk: Address) =>
  withRetry(() =>
    publicClient.readContract({ address: p, abi: POOL_ABI, functionName: 'getLPBalance', args: [user, tk] }),
  );

export const coverage = (p: Address, tk: Address) =>
  withRetry(() =>
    publicClient.readContract({ address: p, abi: POOL_ABI, functionName: 'getCoverageRatio', args: [tk] }),
  );

/** Face (token units) per share, WAD: what `lpAmount * index / 1e18` converts a share count by. */
export const liquidityIndex = (p: Address, tk: Address) =>
  withRetry(() =>
    publicClient.readContract({ address: p, abi: POOL_ABI, functionName: 'getAsset', args: [tk] }),
  ).then((a) => a.liquidityIndexWad);

/** Pool-wide solvency C, WAD: the rate a deposit mints at. */
export const solvency = (p: Address) =>
  withRetry(() =>
    publicClient.readContract({ address: p, abi: POOL_ABI, functionName: 'poolSolvencyWad' }),
  ).then(([c]) => c);

export const depositCalls = (p: Address, tk: Address, amount: bigint): Call[] => [
  approveCall(tk, p, amount),
  { to: p, data: encodeFunctionData({ abi: POOL_ABI, functionName: 'deposit', args: [tk, amount] }), label: 'deposit' },
];

if (import.meta.main) {
  const leg = need(demoLeg(), 'pool with a non-base leg');
  const p = leg.pool;
  const tk = leg.token;
  // $10,000 of the leg, sized by value so the same line serves a stable and a volatile.
  const mark = (await getFeed(config.contracts.poolFactory, feedId(leg.symbol))).mark1e18;
  const amount = unitsWorth(mark, leg.decimals, 10_000);
  const user = senderOrPlaceholder;

  console.log(`pool        ${p}`);
  // Coverage is reserves over liabilities. A deposit mints at the pool-wide solvency C: it adds
  // `amount` to reserves and `amount / C` of face to liabilities, so the leg's coverage moves
  // TOWARD C (down if the leg sits above it, up if below), not toward 1.0. Use `donate` to raise
  // coverage without diluting it.
  console.log(`coverage    ${fmt(await coverage(p, tk))}   (pool C ${fmt(await solvency(p))})`);
  console.log(`lp before   ${fmt(await lpBalance(p, user, tk))}`);
  console.log(`depositing  ${fmt(amount, leg.decimals)} ${leg.symbol}`);

  await send(depositCalls(p, tk, amount));
  if (armed) console.log(`lp after    ${fmt(await lpBalance(p, user, tk))}`);
}
