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
import { config, deadline, floorFrom, fmt, pool, token, type Address } from '../src/config.ts';
import { ROUTER_ABI, armed, balanceOf, decimalsOf, send, senderOrPlaceholder, type Call } from '../src/viem-client.ts';
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
  const USDT = token('USDT');
  const USDS = token('USDS');
  const USDCB = token(config.baseToken);
  const WETH = token('WETH');
  const recipient = senderOrPlaceholder;

  const dec = BigInt(await decimalsOf(USDT));
  const inA = 1_000n * 10n ** dec;
  const inB = 1_000n * 10n ** dec;

  const hopsA: Hop[] = [
    { pool: pool('stablePool'), tokenOut: USDCB },
    { pool: pool('cryptoPool'), tokenOut: WETH },
  ];
  const hopsB: Hop[] = [{ pool: pool('stablePool'), tokenOut: USDCB }];

  const outA = await quotePath(USDT, inA, hopsA);
  const outB = await quotePath(USDS, inB, hopsB);

  const parts: Part[] = [
    { tokenIn: USDT, amountIn: inA, hops: hopsA },
    { tokenIn: USDS, amountIn: inB, hops: hopsB },
  ];
  const floors: Floor[] = [
    { token: WETH, minOut: floorFrom(outA, 100) },
    { token: USDCB, minOut: floorFrom(outB, 100) },
  ];

  console.log(`router      ${config.contracts.router}`);
  console.log(`part A      ${fmt(inA)} USDT -> USDCB -> WETH   expect ${fmt(outA)} WETH`);
  console.log(`part B      ${fmt(inB)} USDS -> USDCB           expect ${fmt(outB)} USDCB`);

  const before = armed ? [await balanceOf(WETH, recipient), await balanceOf(USDCB, recipient)] : [0n, 0n];
  await send([
    approveCall(USDT, config.contracts.router, inA),
    approveCall(USDS, config.contracts.router, inB),
    routerCall(parts, floors, recipient),
  ]);
  if (armed) {
    console.log(`\nreceived    ${fmt((await balanceOf(WETH, recipient)) - before[0])} WETH, ` +
      `${fmt((await balanceOf(USDCB, recipient)) - before[1])} USDCB`);
  }
}
