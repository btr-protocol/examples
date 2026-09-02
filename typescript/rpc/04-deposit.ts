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
import { fmt, pool, token, withRetry, type Address } from '../src/config.ts';
import { POOL_ABI, armed, decimalsOf, publicClient, send, senderOrPlaceholder, type Call } from '../src/viem-client.ts';
import { approveCall } from './03-pool-swap.ts';

export const lpBalance = (p: Address, user: Address, tk: Address) =>
  withRetry(() =>
    publicClient.readContract({ address: p, abi: POOL_ABI, functionName: 'getLPBalance', args: [user, tk] }),
  );

export const coverage = (p: Address, tk: Address) =>
  withRetry(() =>
    publicClient.readContract({ address: p, abi: POOL_ABI, functionName: 'getCoverageRatio', args: [tk] }),
  );

export const depositCalls = (p: Address, tk: Address, amount: bigint): Call[] => [
  approveCall(tk, p, amount),
  { to: p, data: encodeFunctionData({ abi: POOL_ABI, functionName: 'deposit', args: [tk, amount] }), label: 'deposit' },
];

if (import.meta.main) {
  const p = pool('stablePool');
  const tk = token('USDT');
  const amount = 10_000n * 10n ** BigInt(await decimalsOf(tk));
  const user = senderOrPlaceholder;

  console.log(`pool        ${p}`);
  // Coverage is reserves over liabilities. A deposit credits BOTH by the same value, so it moves
  // coverage TOWARD 1.0: it lifts an under-covered leg and lowers an over-covered one. Use
  // `donate` if the intent is to raise coverage.
  console.log(`coverage    ${fmt(await coverage(p, tk))}`);
  console.log(`lp before   ${fmt(await lpBalance(p, user, tk))}`);
  console.log(`depositing  ${fmt(amount)} USDT`);

  await send(depositCalls(p, tk, amount));
  if (armed) console.log(`lp after    ${fmt(await lpBalance(p, user, tk))}`);
}
