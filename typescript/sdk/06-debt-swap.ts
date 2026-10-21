/**
 * Example 6, off chain, WITH THE SDK: the DEBT SWAP, `Pool.swapLiability`.
 *
 * Guide:    https://btr.markets/docs/5-1-1-basic-operations#5-swap-liability
 * Twin:     ../rpc/06-debt-swap.ts     (same job, viem only, no SDK)
 * On chain: ../../foundry/test/06_DebtSwap.t.sol
 *
 * WHY THIS ONE. `@btr-protocol/sdk/pool` ships `quoteSwapLiability`, `liabilitySwapEnabled` and
 * `minLpAmountOut`: an off-chain replica of the haircut maths, so you can size the trade and set
 * the share floor WITHOUT a simulated call. There is no `previewSwapLiability` on the pool, so
 * without the SDK you are reduced to `eth_call`-ing the real function to learn its output.
 *
 * WHAT IT IS. An LP re-denominating a claim from one leg to another: burn USDT shares, mint USDS
 * shares, in one call, without leaving the pool.
 *
 * WHAT IT IS NOT: A TRADE. RESERVES DO NOT MOVE. Only the liability side of two legs changes.
 * Consequences you have to encode for:
 *   - both legs need `LIABILITY_SWAP_ENABLED_BIT` (bit 5) in `getRiskFlags`
 *   - an UNDER-COVERED input leg takes a haircut, so leaving it does not dump the shortfall on
 *     whoever stays; symmetrically, an UNDER-COVERED destination leg marks the arriving
 *     claim down to its coverage, so joining one is not free either
 *   - BOTH amounts are in LP SHARES, not token units. `minLpAmountOut` is a SHARE floor. Passing
 *     a token amount there is a units bug no passing test will catch.
 *   - THE FLOW COOLDOWN APPLIES. A debt swap moves an LP claim, so it is gated by the same
 *     anti-flow-abuse freeze as a withdraw: shares minted less than `flowCooldownSecs` ago cannot
 *     be re-denominated and the call reverts `CooldownActive()`. Deposit and swap in one block
 *     does not work. Read the window off the pool, it is an admin-settable `uint16`.
 *
 * Run: bun run sdk/06-debt-swap.ts
 */
import { LIABILITY_SWAP_ENABLED_BIT, POOL_ABI } from '@btr-protocol/sdk/abis';
import { readContract } from '@btr-protocol/sdk/eth';
import { liabilitySwapEnabled } from '@btr-protocol/sdk/pool';
import { deadline, fmt, pool, token, withRetry, type Address } from '../src/config.ts';
import { account, armed, call, provider, send } from '../src/sdk-wallet.ts';
import { lpBalance } from './04-deposit.ts';
import { flowCooldownSecs } from './05-withdraw.ts';

export const riskFlags = (p: Address, tk: Address) =>
  withRetry(() => readContract<bigint>(provider, p, POOL_ABI, 'getRiskFlags', [tk])).then(Number);

/** Check the gate BEFORE building the call: the revert does not say which leg was the problem. */
export async function assertLegsEnabled(p: Address, tokenIn: Address, tokenOut: Address) {
  for (const [name, tk] of [['tokenIn', tokenIn], ['tokenOut', tokenOut]] as const) {
    const flags = await riskFlags(p, tk);
    if (!liabilitySwapEnabled(flags)) {
      throw new Error(`${name} ${tk}: liability swap disabled (flags=${flags}, need bit ${LIABILITY_SWAP_ENABLED_BIT})`);
    }
  }
}

/**
 * There is no `previewSwapLiability`, so the honest way to learn the output SHARE count against a
 * live chain is to `eth_call` the real function. It is a state-changing signature, so the call is
 * simulated, never mined.
 */
export async function simulateShareOut(
  p: Address,
  tokenIn: Address,
  tokenOut: Address,
  lpAmountIn: bigint,
  from: Address,
): Promise<bigint> {
  const c = call(p, POOL_ABI, 'swapLiability', [tokenIn, tokenOut, lpAmountIn, 0n, deadline()]);
  const ret = (await withRetry(() =>
    provider.request({ method: 'eth_call', params: [{ from, to: p, data: c.data }, 'latest'] }),
  )) as `0x${string}`;
  return BigInt(ret);
}

export const debtSwapCall = (
  p: Address,
  tokenIn: Address,
  tokenOut: Address,
  lpAmountIn: bigint,
  minLpAmountOut: bigint,
) => call(p, POOL_ABI, 'swapLiability', [tokenIn, tokenOut, lpAmountIn, minLpAmountOut, deadline()], 'swapLiability');

if (import.meta.main) {
  const p = pool('stablePool');
  const from = token('USDT');
  const to = token('USDS');
  const user = (account ?? '0x000000000000000000000000000000000000dEaD') as Address;

  await assertLegsEnabled(p, from, to);
  console.log(`pool        ${p}`);
  console.log(`legs        USDT -> USDS, both liability-swap enabled`);
  console.log(`cooldown    ${await flowCooldownSecs(p)}s   (shares minted inside it cannot be re-denominated)`);

  const shares = await lpBalance(p, user, from);
  console.log(`lp balance  ${fmt(shares)} USDT shares`);
  if (shares === 0n) {
    console.log('nothing to re-denominate. Run sdk/04-deposit.ts first (against a fork).');
    process.exit(0);
  }

  let quoted: bigint;
  try {
    quoted = await simulateShareOut(p, from, to, shares, user);
  } catch (e) {
    // Fail loudly. A debt swap that cannot even be simulated must not be sent with a zero floor.
    console.error(`simulation reverted: ${(e as Error).message}`);
    console.error('`CooldownActive()` (0xaa9a98df) means the shares are still inside the flow');
    console.error('cooldown printed above. Anything else: check the risk flags on both legs.');
    process.exit(1);
  }

  // Shares are NOT comparable across legs: the two legs carry different liquidity indexes. Compare
  // VALUE with previewWithdraw, or you will think liquidity vanished when it did not.
  const [valueIn] = await withRetry(() =>
    readContract<[bigint, bigint]>(provider, p, POOL_ABI, 'previewWithdraw', [from, shares]),
  );
  const [valueOut] = await withRetry(() =>
    readContract<[bigint, bigint]>(provider, p, POOL_ABI, 'previewWithdraw', [to, quoted]),
  );

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
