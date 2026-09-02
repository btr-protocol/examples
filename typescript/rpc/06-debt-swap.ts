/**
 * Example 6, off chain, VANILLA JSON-RPC: the DEBT SWAP, `Pool.swapLiability`, with viem only.
 *
 * Guide:    https://btr.markets/docs/5-1-1-basic-operations#5-swap-liability
 * Twin:     ../sdk/06-debt-swap.ts     (same job, using @btr-protocol/sdk)
 * On chain: ../../foundry/test/06_DebtSwap.t.sol
 *
 * WHAT IT IS. An LP re-denominating a claim from one leg to another: burn USDT shares, mint USDS
 * shares, one call, without leaving the pool.
 *
 * WHAT IT IS NOT: A TRADE. RESERVES DO NOT MOVE. Only the liability side of two legs changes.
 *   - both legs need bit 2 (`LIABILITY_SWAP_ENABLED_BIT`) set in `getRiskFlags`
 *   - an UNDER-COVERED input leg takes a haircut on the way out, and an UNDER-COVERED
 *     destination leg marks the arriving claim down to its coverage: joining a weak leg at
 *     par would be arbing the shortfall at the expense of whoever is already in it
 *   - BOTH amounts are LP SHARES, not token units. `minLpAmountOut` is a SHARE floor, and shares
 *     are NOT comparable across legs: the two legs carry different liquidity indexes. Compare
 *     VALUE with `previewWithdraw` on each side.
 *   - THE FLOW COOLDOWN APPLIES. A debt swap moves an LP claim, so the same anti-flow-abuse
 *     freeze that gates a withdraw gates this: shares minted less than `flowCooldownSecs` ago
 *     revert `CooldownActive()`. Deposit and swap in one block does not work. Read the window off
 *     the pool, it is an admin-settable `uint16`.
 *
 * THERE IS NO `previewSwapLiability`. The honest way to learn the output share count is to
 * `eth_call` the real function: a state-changing signature simulated, never mined.
 *
 * Run: bun run rpc/06-debt-swap.ts
 */
import { encodeFunctionData } from 'viem';
import { deadline, fmt, pool, token, withRetry, type Address } from '../src/config.ts';
import { POOL_ABI, armed, publicClient, send, senderOrPlaceholder, type Call } from '../src/viem-client.ts';
import { lpBalance } from './04-deposit.ts';
import { flowCooldownSecs, previewWithdraw } from './05-withdraw.ts';

export const LIABILITY_SWAP_ENABLED_BIT = 1 << 2;

export const riskFlags = (p: Address, tk: Address) =>
  withRetry(() => publicClient.readContract({ address: p, abi: POOL_ABI, functionName: 'getRiskFlags', args: [tk] }));

/** Check the gate BEFORE building the call: the revert does not say which leg was the problem. */
export async function assertLegsEnabled(p: Address, tokenIn: Address, tokenOut: Address) {
  for (const [name, tk] of [['tokenIn', tokenIn], ['tokenOut', tokenOut]] as const) {
    const flags = await riskFlags(p, tk);
    if (!(flags & LIABILITY_SWAP_ENABLED_BIT)) {
      throw new Error(`${name} ${tk}: liability swap disabled (flags=${flags})`);
    }
  }
}

/** Simulate the real call to learn the output SHARE count. */
export async function simulateShareOut(
  p: Address, tokenIn: Address, tokenOut: Address, lpAmountIn: bigint, from: Address,
) {
  const { result } = await publicClient.simulateContract({
    address: p, abi: POOL_ABI, functionName: 'swapLiability',
    args: [tokenIn, tokenOut, lpAmountIn, 0n, deadline()], account: from,
  });
  return result as bigint;
}

export const debtSwapCall = (
  p: Address, tokenIn: Address, tokenOut: Address, lpAmountIn: bigint, minLpAmountOut: bigint,
): Call => ({
  to: p,
  data: encodeFunctionData({
    abi: POOL_ABI, functionName: 'swapLiability',
    args: [tokenIn, tokenOut, lpAmountIn, minLpAmountOut, deadline()],
  }),
  label: 'swapLiability',
});

if (import.meta.main) {
  const p = pool('stablePool');
  const from = token('USDT');
  const to = token('USDS');
  const user = senderOrPlaceholder;

  await assertLegsEnabled(p, from, to);
  console.log(`pool        ${p}`);
  console.log('legs        USDT -> USDS, both liability-swap enabled');
  console.log(`cooldown    ${await flowCooldownSecs(p)}s   (shares minted inside it cannot be re-denominated)`);

  const shares = await lpBalance(p, user, from);
  console.log(`lp balance  ${fmt(shares)} USDT shares`);
  if (shares === 0n) {
    console.log('nothing to re-denominate. Run rpc/04-deposit.ts first (against a fork).');
    process.exit(0);
  }

  let quoted: bigint;
  try {
    quoted = await simulateShareOut(p, from, to, shares, user);
  } catch (e) {
    console.error(`simulation reverted: ${(e as Error).message.split('\n')[0]}`);
    console.error('`CooldownActive()` (0xaa9a98df) means the shares are still inside the flow');
    console.error('cooldown printed above. Anything else: check the risk flags on both legs.');
    process.exit(1);
  }

  const [valueIn] = await previewWithdraw(p, from, shares);
  const [valueOut] = await previewWithdraw(p, to, quoted);
  const minLpAmountOut = (quoted * 9_990n) / 10_000n; // 10 bps, in SHARES

  console.log(`shares out  ${fmt(quoted)} USDS shares  (floor ${fmt(minLpAmountOut)})`);
  console.log(`value in    ${fmt(valueIn)}`);
  console.log(`value out   ${fmt(valueOut)}`);

  await send([debtSwapCall(p, from, to, shares, minLpAmountOut)]);
  if (armed) {
    console.log(`\nUSDT shares ${fmt(await lpBalance(p, user, from))}`);
    console.log(`USDS shares ${fmt(await lpBalance(p, user, to))}`);
  }
}
