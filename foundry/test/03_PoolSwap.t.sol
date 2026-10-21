// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BTRForkTest} from "./BTRForkTest.sol";
import {IERC20, IPool} from "../src/interfaces/IBTR.sol";

/**
 * Example 3, on chain: swapping directly against one pool.
 *
 * Guide: https://btr.markets/docs/5-1-1-basic-operations#3-swap
 * Off-chain twins: ../../typescript/sdk/03-pool-swap.ts, ../../typescript/rpc/03-pool-swap.ts
 *
 * Call one pool when the venue is already decided: an aggregator hop, a vault rebalance, a
 * strategy with a fixed leg. When the venue is NOT decided, route off chain and settle through
 * the Router instead (example 2).
 *
 * Order is always the same three steps, and skipping the first is the usual bug:
 *   1. `getSwapQuote` to learn `amountOut`
 *   2. `approve` the pool for `amountIn`  (the pool pulls with transferFrom(msg.sender))
 *   3. `swap` with `minAmountOut` derived from the quote and YOUR tolerance
 *
 * Run: forge test --match-path 'test/03_*' -vv
 */
contract PoolSwapTest is BTRForkTest {
  /// 50 bps. A quote is a snapshot; the mark can move between the read and the fill.
  uint256 constant SLIPPAGE_BPS = 50;
  /// A thin leg moves on a trade, so the FX bound is wider than the stable one. A decimals bug is
  /// out by orders of magnitude, not by percent.
  uint256 constant THIN_BPS = 500;

  /// @dev A leg `alice` can swap against `base`, or skip. A gated leg would turn every revert
  ///      assertion below into a pass for the wrong reason.
  function _leg(string memory cls, string memory why) internal returns (Leg memory l) {
    bool ok;
    (l, ok) = bytes(cls).length == 0 ? demoLeg() : firstLeg(cls);
    skipUnless(ok, why);
    skipIfSwapGated(l);
  }

  function test_quoteThenSwap() public {
    Leg memory l = _leg("", "no pool holds a non-base leg");
    uint256 amountIn = units(base, 1_000);
    fund(base, amountIn, address(l.pool));

    IPool.SwapQuote memory q = l.pool.getSwapQuote(base, l.token, amountIn);
    assertGt(q.amountOut, 0, "a zero quote is a failure, not a price");

    uint256 minOut = q.amountOut * (10_000 - SLIPPAGE_BPS) / 10_000;

    uint256 before = IERC20(l.token).balanceOf(alice);
    vm.prank(alice);
    uint256 out = l.pool.swap_qe(base, l.token, amountIn, minOut, alice, block.timestamp + 600);

    assertEq(out, IERC20(l.token).balanceOf(alice) - before, "return value must equal what arrived");
    assertGe(out, minOut, "below the floor the pool accepted");
    assertEq(IERC20(base).balanceOf(alice), 0, "the whole input should have been pulled");

    emit log_named_uint(string.concat("amountIn  (", baseSym, ")"), amountIn);
    emit log_named_uint(string.concat("quoted    (", l.sym, ")"), q.amountOut);
    emit log_named_uint(string.concat("filled    (", l.sym, ")"), out);
    emit log_named_uint("spreadPbps       ", q.spreadPbps);
    emit log_named_decimal_uint("markPrice        ", q.markPrice, 18);
    emit log_named_decimal_uint("midPrice         ", q.midPrice, 18);
  }

  /// The quote is exact when nothing moves between the read and the fill, which on a fork is
  /// guaranteed. Any gap here is a modelling bug, not slippage.
  function test_quoteMatchesFillOnAStillMarket() public {
    (, Leg memory b, bool ok) = demoPair();
    skipUnless(ok, "no pool holds two non-base legs");
    skipIfSwapGated(b);
    uint256 amountIn = units(base, 500);
    fund(base, amountIn, address(b.pool));

    IPool.SwapQuote memory q = b.pool.getSwapQuote(base, b.token, amountIn);
    vm.prank(alice);
    uint256 out = b.pool.swap_qe(base, b.token, amountIn, 0, alice, block.timestamp + 600);

    assertEq(out, q.amountOut, "getSwapQuote and swap must agree on a still market");
  }

  /// A spoke-to-spoke swap is routed through the pool's base internally. One call, two legs.
  function test_spokeToSpokeIsOneCall() public {
    (Leg memory a, Leg memory b, bool ok) = demoPair();
    skipUnless(ok, "no pool holds two non-base legs");
    skipIfSwapGated(a);
    skipIfSwapGated(b);
    uint256 amountIn = unitsWorth(a.sym, 250);
    fund(a.token, amountIn, address(a.pool));

    IPool.SwapQuote memory q = a.pool.getSwapQuote(a.token, b.token, amountIn);
    assertEq(q.routeHops.length, 3, "spoke -> base -> spoke");
    assertEq(q.routeHops[1], a.pool.baseToken(), "the middle hop is the pool base");

    vm.prank(alice);
    uint256 out = a.pool.swap_qe(a.token, b.token, amountIn, q.amountOut, alice, block.timestamp + 600);
    assertGe(out, q.amountOut);
  }

  /// `minAmountOut` is the protection and it must actually bite. Asking for more than the pool
  /// will pay has to revert, not fill short.
  function test_unreachableFloorReverts() public {
    Leg memory l = _leg("", "no pool holds a non-base leg");
    uint256 amountIn = units(base, 1_000);
    fund(base, amountIn, address(l.pool));

    IPool.SwapQuote memory q = l.pool.getSwapQuote(base, l.token, amountIn);
    vm.prank(alice);
    vm.expectRevert();
    l.pool.swap_qe(base, l.token, amountIn, q.amountOut * 2, alice, block.timestamp + 600);
  }

  /// An expired deadline reverts before anything moves.
  function test_expiredDeadlineReverts() public {
    Leg memory l = _leg("", "no pool holds a non-base leg");
    uint256 amountIn = units(base, 10);
    fund(base, amountIn, address(l.pool));
    vm.prank(alice);
    vm.expectRevert();
    l.pool.swap_qe(base, l.token, amountIn, 0, alice, block.timestamp - 1);
  }

  /// Without an approval the pool cannot pull the input. Stated because it is the single most
  /// common first-integration failure, and the revert does not say "you forgot to approve".
  function test_missingApprovalReverts() public {
    Leg memory l = _leg("", "no pool holds a non-base leg");
    uint256 amountIn = units(base, 100);
    deal(base, alice, amountIn, true);
    vm.prank(alice);
    vm.expectRevert();
    l.pool.swap_qe(base, l.token, amountIn, 0, alice, block.timestamp + 600);
  }

  /// A cross-asset swap: base in, volatile out, priced off that leg's feed.
  function test_baseToVolatile() public {
    Leg memory l = _leg("volatile", "no pool holds a volatile leg");
    uint256 amountIn = units(base, 5_000);
    fund(base, amountIn, address(l.pool));

    IPool.SwapQuote memory q = l.pool.getSwapQuote(base, l.token, amountIn);
    assertGt(q.amountOut, 0);

    vm.prank(alice);
    uint256 out =
      l.pool.swap_qe(base, l.token, amountIn, q.amountOut * 995 / 1000, alice, block.timestamp + 600);

    // Implied price must sit within a sane band of the pool's own mark. This catches a decimals
    // mistake, which is the failure mode that otherwise looks like a successful swap.
    assertApproxEqRel(
      impliedWad(base, amountIn, l.token, out), q.markPrice, 0.02e18, "fill diverged from the mark by over 2%"
    );

    emit log_named_uint(string.concat(baseSym, " in "), amountIn);
    emit log_named_uint(string.concat(l.sym, " out "), out);
  }

  /// ------------------------------------------------------------------------------------------
  /// FX and tokenised equities. Same three steps, two assumptions that only hold on stables.
  /// ------------------------------------------------------------------------------------------

  /// An FX token can have fewer decimals than the base. `units()` builds the input from each
  /// token's own `decimals()` and `impliedWad` divides both out before comparing against the
  /// mark, because the raw ratio is off by 10^(base - leg decimals) on a short-decimals leg and
  /// off by nothing at all on a same-decimals pair, which is exactly why the bug ships.
  function test_fxLegShortDecimals() public {
    Leg memory l = _leg("fx", "no pool holds an FX leg");
    uint256 baseDec = IERC20(base).decimals();
    uint256 legDec = IERC20(l.token).decimals();

    uint256 amountIn = units(base, 100); // FX legs can be shallow
    fund(base, amountIn, address(l.pool));

    IPool.SwapQuote memory q = l.pool.getSwapQuote(base, l.token, amountIn);
    assertGt(q.amountOut, 0, "a zero quote is a failure, not a price");

    uint256 minOut = q.amountOut * (10_000 - SLIPPAGE_BPS) / 10_000;
    vm.prank(alice);
    uint256 out = l.pool.swap_qe(base, l.token, amountIn, minOut, alice, block.timestamp + 600);

    assertGe(out, minOut);
    assertLt(diffBps(impliedWad(base, amountIn, l.token, out), q.markPrice), THIN_BPS, "off the mark");
    if (baseDec > legDec + 1 || legDec > baseDec + 1) {
      // And the trap, stated: the same comparison without the decimals correction is nowhere near.
      assertGt(diffBps(out * 1e18 / amountIn, q.markPrice), 9_000, "raw ratio should be absurd");
    }

    emit log_named_uint(string.concat("filled (", l.sym, ")"), out);
    emit log_named_decimal_uint("markPrice         ", q.markPrice, 18);
  }

  /// A token worth a fraction of a cent: the OUTPUT is far ABOVE the input. Any slippage or
  /// sizing helper written against stables assumes the opposite. Runs on the first FX leg that is
  /// quoted at more than 10 tokens per base unit.
  function test_fxSubUnitPrice() public {
    Leg[] memory fxs = legsOf("fx");
    skipUnless(fxs.length != 0, "no pool holds an FX leg");
    uint256 amountIn = units(base, 100);

    for (uint256 i; i < fxs.length; ++i) {
      if (fxs[i].pool.getSwapQuote(base, fxs[i].token, amountIn).markPrice <= 10e18) continue;
      Leg memory l = fxs[i];
      skipIfSwapGated(l);
      fund(base, amountIn, address(l.pool));

      IPool.SwapQuote memory q = l.pool.getSwapQuote(base, l.token, amountIn);
      uint256 minOut = q.amountOut * (10_000 - SLIPPAGE_BPS) / 10_000;
      vm.prank(alice);
      uint256 out = l.pool.swap_qe(base, l.token, amountIn, minOut, alice, block.timestamp + 600);

      assertGe(out, minOut);
      assertGt(out / (10 ** IERC20(l.token).decimals()), amountIn / (10 ** IERC20(base).decimals()) * 10);
      assertLt(diffBps(impliedWad(base, amountIn, l.token, out), q.markPrice), THIN_BPS);
      emit log_named_uint(string.concat("filled (", l.sym, ")"), out);
      return;
    }
    skipUnless(false, "no FX leg is quoted below a tenth of a base unit");
  }

  /// An integrator trading tokenised equities calls the pool that holds them. One share costs
  /// hundreds of dollars, so the output is two orders of magnitude BELOW the input, and
  /// `markPrice` is a small WAD. A sanity check of the form `markPrice > 1e18` rejects every
  /// equity on the venue.
  function test_equityBaseToEquity() public {
    Leg memory l = _leg("equity", "no pool holds an equity leg");
    uint256 amountIn = units(base, 1_000);
    fund(base, amountIn, address(l.pool));

    IPool.SwapQuote memory q = l.pool.getSwapQuote(base, l.token, amountIn);
    assertGt(q.amountOut, 0, "a zero quote is a failure, not a price");
    assertLt(q.markPrice, 1e18, "tokenOut per base is a SMALL wad for a share worth hundreds");

    uint256 minOut = q.amountOut * (10_000 - SLIPPAGE_BPS) / 10_000;
    vm.prank(alice);
    uint256 out = l.pool.swap_qe(base, l.token, amountIn, minOut, alice, block.timestamp + 600);

    assertGe(out, minOut);
    assertLt(diffBps(impliedWad(base, amountIn, l.token, out), q.markPrice), 200);

    emit log_named_uint(string.concat("filled (", l.sym, ")"), out);
    emit log_named_decimal_uint("markPrice    ", q.markPrice, 18);
  }

  /// Equity to equity is ONE call: the pool hops through its own base internally, and the base
  /// never lands on the recipient.
  function test_equityToEquityIsOneCall() public {
    (Leg memory a, Leg memory b, bool ok) = pairIn("equity");
    skipUnless(ok, "no pool holds two equity legs");
    skipIfSwapGated(a);
    skipIfSwapGated(b);
    uint256 amountIn = units(a.token, 1);
    fund(a.token, amountIn, address(a.pool));

    IPool.SwapQuote memory q = a.pool.getSwapQuote(a.token, b.token, amountIn);
    assertEq(q.routeHops.length, 3, "a -> base -> b");
    assertEq(q.routeHops[1], base, "the middle hop is the pool base");

    uint256 minOut = q.amountOut * (10_000 - SLIPPAGE_BPS) / 10_000;
    vm.prank(alice);
    uint256 out = a.pool.swap_qe(a.token, b.token, amountIn, minOut, alice, block.timestamp + 600);

    assertGe(out, minOut);
    assertEq(IERC20(base).balanceOf(alice), 0, "the intermediate must never be paid out");

    emit log_named_uint(string.concat("filled (", b.sym, ")"), out);
  }
}
