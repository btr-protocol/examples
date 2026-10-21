/**
 * Example 2, off chain, WITH THE SDK: a multi-hop, multi-part route through the Router.
 *
 * Guide:    https://btr.markets/docs/5-1-4-composability#2-routing-through-the-router
 * Twin:     ../rpc/02-router-swap.ts     (same job, viem only, no SDK)
 * On chain: ../../foundry/test/02_RouterSwap.t.sol
 *
 * WHY THIS ONE. The SDK carries the deployed `ROUTER_ABI`, so the nested `Part[] / Hop[] /
 * Floor[]` tuples encode from plain objects instead of a hand-written tuple string. That nesting
 * is exactly where a hand-rolled encoder goes wrong, silently, and produces a call that reverts
 * with no useful data.
 *
 * THE ROUTER DOES NOT FIND ROUTES. It executes the one you bring, atomically, and enforces one
 * end-to-end promise per output token. Route SELECTION is a search over every pool's curve,
 * coverage and marks, which is why it lives here rather than on chain.
 *
 * FLOORS ARE END TO END. `minOut` is checked ONCE per output token on what actually reached the
 * router, after every part has run. There is no per-hop floor: a per-hop floor makes each hop
 * spend the previous hop's floor rather than its real output, so tolerances compound and a
 * two-hop route rejects itself on a market that has not moved.
 *
 * Run: bun run sdk/02-router-swap.ts
 */
import { ROUTER_ABI } from '@btr-protocol/sdk/abis';
import { base, config, deadline, floorFrom, fmt, need, routeSet, type Address } from '../src/config.ts';
import { account, approve, armed, balanceOf, call, send } from '../src/sdk-wallet.ts';
import { quote } from './03-pool-swap.ts';

export interface Hop { pool: Address; tokenOut: Address }
export interface Part { tokenIn: Address; amountIn: bigint; hops: Hop[] }
export interface Floor { token: Address; minOut: bigint }

/**
 * Chain the per-leg quotes to learn what the whole path pays. This is the "route finding" the
 * router deliberately does not do: each hop is quoted on the PREVIOUS hop's output.
 */
export async function quotePath(tokenIn: Address, amountIn: bigint, hops: Hop[]): Promise<bigint> {
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

/**
 * Build the router call. Two rules the encoder cannot check for you:
 *   - EVERY part's terminal token needs a floor entry, or the router reverts `UnclaimedOutput`
 *     rather than leaving proceeds stranded in itself.
 *   - each output token may appear in `floors` ONCE, or it reverts `DuplicateFloor`.
 */
export function routerCall(parts: Part[], floors: Floor[], recipient: Address) {
  const terminals = new Set(parts.map((p) => p.hops[p.hops.length - 1].tokenOut.toLowerCase()));
  const floored = new Set(floors.map((f) => f.token.toLowerCase()));
  for (const t of terminals) if (!floored.has(t)) throw new Error(`no floor for terminal token ${t}`);
  if (floored.size !== floors.length) throw new Error('a token appears twice in floors');

  return call(
    config.contracts.router,
    ROUTER_ABI,
    'swap',
    [
      parts.map((p) => [p.tokenIn, p.amountIn, p.hops.map((h) => [h.pool, h.tokenOut])]),
      floors.map((f) => [f.token, f.minOut]),
      recipient,
      deadline(),
    ],
    'router.swap',
  );
}

if (import.meta.main) {
  const { a, a2, b } = need(routeSet(), 'two pools sharing a base, one of them with two non-base legs');
  const tokA = a.token;
  const tokA2 = a2.token;
  const tokBase = base.address;
  const tokB = b.token;
  const stable = a.pool;
  const crypto = b.pool;
  const recipient = (account ?? '0x000000000000000000000000000000000000dEaD') as Address;

  const inA = 1_000n * 10n ** BigInt(a.decimals);
  const inB = 1_000n * 10n ** BigInt(a2.decimals);

  // Part A crosses TWO pools. Neither holds both ends: the base is shared, so the route is
  // only expressible as a chain, and by hand it is two approvals, two signatures and an unhedged
  // base position in between.
  const hopsA: Hop[] = [
    { pool: stable, tokenOut: tokBase },
    { pool: crypto, tokenOut: tokB },
  ];
  // Part B is a plain single hop with a different input. Parts run IN ORDER but do NOT feed each
  // other: this is a split, not a chain.
  const hopsB: Hop[] = [{ pool: stable, tokenOut: tokBase }];

  const [outA, outB] = [await quotePath(tokA, inA, hopsA), await quotePath(tokA2, inB, hopsB)];

  const parts: Part[] = [
    { tokenIn: tokA, amountIn: inA, hops: hopsA },
    { tokenIn: tokA2, amountIn: inB, hops: hopsB },
  ];
  // Part A's terminal is the far leg, part B's is the base. The base that part A produced is NOT claimable:
  // part A consumed it in its second hop.
  const floors: Floor[] = [
    { token: tokB, minOut: floorFrom(outA, 100) },
    { token: tokBase, minOut: floorFrom(outB, 100) },
  ];

  console.log(`router      ${config.contracts.router}`);
  console.log(`part A      ${fmt(inA, a.decimals)} ${a.symbol} -> ${base.symbol} -> ${b.symbol}   expect ${fmt(outA, b.decimals)} ${b.symbol}`);
  console.log(`part B      ${fmt(inB, a2.decimals)} ${a2.symbol} -> ${base.symbol}   expect ${fmt(outB, base.decimals)} ${base.symbol}`);
  console.log(`floors      ${b.symbol} >= ${fmt(floors[0].minOut, b.decimals)}, ${base.symbol} >= ${fmt(floors[1].minOut, base.decimals)}`);

  const before = armed
    ? [await balanceOf(tokB, recipient), await balanceOf(tokBase, recipient)]
    : [0n, 0n];

  await send([
    approve(tokA, config.contracts.router, inA),
    approve(tokA2, config.contracts.router, inB),
    routerCall(parts, floors, recipient),
  ]);

  if (armed) {
    const gotW = (await balanceOf(tokB, recipient)) - before[0];
    const gotU = (await balanceOf(tokBase, recipient)) - before[1];
    console.log(`\nreceived    ${fmt(gotW, b.decimals)} ${b.symbol}, ${fmt(gotU, base.decimals)} ${base.symbol}`);
    if (gotW < floors[0].minOut || gotU < floors[1].minOut) throw new Error('filled below a floor');
  }
}
