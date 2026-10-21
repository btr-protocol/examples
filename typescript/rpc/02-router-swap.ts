/**
 * Example 2, off chain, VANILLA JSON-RPC: a multi-hop, multi-part route with viem only.
 *
 * Guide:    https://btr.markets/docs/5-1-4-composability#2-routing-through-the-router
 * Twin:     ../sdk/02-router-swap.ts     (same job, using @btr-protocol/sdk)
 * On chain: ../../foundry/test/02_RouterSwap.t.sol
 *
 * WHY THIS ONE. It shows the whole Router surface as three struct declarations. If you are
 * building the call from Python or Rust, this is the file to translate.
 *
 * WHAT YOU GIVE UP: `Part[]` contains a nested `Hop[]`, which is where hand-rolled encoders go
 * wrong. viem handles it from plain objects; a hand-written tuple string usually does not, and
 * the failure is a revert with no data.
 *
 * THE THREE RULES:
 *   1. Floors are END TO END, keyed by OUTPUT TOKEN, checked ONCE after every part has run.
 *   2. Parts run in order but do NOT feed each other. They are independent paths.
 *   3. Every part's terminal token needs exactly one floor entry: none reverts `UnclaimedOutput`,
 *      two revert `DuplicateFloor`.
 *
 * Run: bun run rpc/02-router-swap.ts
 */
import { encodeFunctionData } from 'viem';
import { base, config, deadline, floorFrom, fmt, need, routeSet, type Address } from '../src/config.ts';
import { ROUTER_ABI, armed, balanceOf, send, senderOrPlaceholder, type Call } from '../src/viem-client.ts';
import { approveCall, quote } from './03-pool-swap.ts';

export interface Hop { pool: Address; tokenOut: Address }
export interface Part { tokenIn: Address; amountIn: bigint; hops: Hop[] }
export interface Floor { token: Address; minOut: bigint }

/** Chain per-leg quotes to price the whole path. Each hop is quoted on the PREVIOUS hop's output. */
export async function quotePath(tokenIn: Address, amountIn: bigint, hops: Hop[]) {
  let amount = amountIn;
  let from = tokenIn;
  for (const h of hops) {
    const q = await quote(h.pool, from, h.tokenOut, amount);
    if (q.amountOut === 0n) throw new Error(`leg ${from} -> ${h.tokenOut} quoted zero`);
    amount = q.amountOut;
    from = h.tokenOut;
  }
  return amount;
}

export function routerCall(parts: Part[], floors: Floor[], recipient: Address): Call {
  const terminals = new Set(parts.map((p) => p.hops.at(-1)!.tokenOut.toLowerCase()));
  const floored = new Set(floors.map((f) => f.token.toLowerCase()));
  for (const t of terminals) if (!floored.has(t)) throw new Error(`no floor for terminal token ${t}`);
  if (floored.size !== floors.length) throw new Error('a token appears twice in floors');

  return {
    to: config.contracts.router,
    data: encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'swap',
      args: [parts, floors, recipient, deadline()],
    }),
    label: 'router.swap',
  };
}

if (import.meta.main) {
  const { a, a2, b } = need(routeSet(), 'two pools sharing a base, one of them with two non-base legs');
  const tokA = a.token;
  const tokA2 = a2.token;
  const tokBase = base.address;
  const tokB = b.token;
  const recipient = senderOrPlaceholder;

  const inA = 1_000n * 10n ** BigInt(a.decimals);
  const inB = 1_000n * 10n ** BigInt(a2.decimals);

  const hopsA: Hop[] = [
    { pool: a.pool, tokenOut: tokBase },
    { pool: b.pool, tokenOut: tokB },
  ];
  const hopsB: Hop[] = [{ pool: a.pool, tokenOut: tokBase }];

  const outA = await quotePath(tokA, inA, hopsA);
  const outB = await quotePath(tokA2, inB, hopsB);

  const parts: Part[] = [
    { tokenIn: tokA, amountIn: inA, hops: hopsA },
    { tokenIn: tokA2, amountIn: inB, hops: hopsB },
  ];
  const floors: Floor[] = [
    { token: tokB, minOut: floorFrom(outA, 100) },
    { token: tokBase, minOut: floorFrom(outB, 100) },
  ];

  console.log(`router      ${config.contracts.router}`);
  console.log(`part A      ${fmt(inA, a.decimals)} ${a.symbol} -> ${base.symbol} -> ${b.symbol}   expect ${fmt(outA, b.decimals)} ${b.symbol}`);
  console.log(`part B      ${fmt(inB, a2.decimals)} ${a2.symbol} -> ${base.symbol}   expect ${fmt(outB, base.decimals)} ${base.symbol}`);

  const before = armed ? [await balanceOf(tokB, recipient), await balanceOf(tokBase, recipient)] : [0n, 0n];
  await send([
    approveCall(tokA, config.contracts.router, inA),
    approveCall(tokA2, config.contracts.router, inB),
    routerCall(parts, floors, recipient),
  ]);
  if (armed) {
    console.log(`\nreceived    ${fmt((await balanceOf(tokB, recipient)) - before[0], b.decimals)} ${b.symbol}, ` +
      `${fmt((await balanceOf(tokBase, recipient)) - before[1], base.decimals)} ${base.symbol}`);
  }
}
