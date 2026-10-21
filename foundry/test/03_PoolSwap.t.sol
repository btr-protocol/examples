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

  function test_quoteThenSwap() public {
    uint256 amountIn = units(USDCB, 1_000);
    fund(USDCB, amountIn, address(stablePool));

    IPool.SwapQuote memory q = stablePool.getSwapQuote(USDCB, USDT, amountIn);
    assertGt(q.amountOut, 0, "a zero quote is a failure, not a price");

    uint256 minOut = q.amountOut * (10_000 - SLIPPAGE_BPS) / 10_000;

    uint256 before = IERC20(USDT).balanceOf(alice);
    vm.prank(alice);
    uint256 out = stablePool.swap_qe(USDCB, USDT, amountIn, minOut, alice, block.timestamp + 600);

    assertEq(out, IERC20(USDT).balanceOf(alice) - before, "return value must equal what arrived");
    assertGe(out, minOut, "below the floor the pool accepted");
    assertEq(IERC20(USDCB).balanceOf(alice), 0, "the whole input should have been pulled");

    emit log_named_uint("amountIn  (USDCB)", amountIn);
    emit log_named_uint("quoted    (USDT) ", q.amountOut);
    emit log_named_uint("filled    (USDT) ", out);
    emit log_named_uint("spreadPbps       ", q.spreadPbps);
    emit log_named_decimal_uint("markPrice        ", q.markPrice, 18);
    emit log_named_decimal_uint("midPrice         ", q.midPrice, 18);
  }

  /// The quote is exact when nothing moves between the read and the fill, which on a fork is
  /// guaranteed. Any gap here is a modelling bug, not slippage.
  function test_quoteMatchesFillOnAStillMarket() public {
    uint256 amountIn = units(USDCB, 500);
    fund(USDCB, amountIn, address(stablePool));

    IPool.SwapQuote memory q = stablePool.getSwapQuote(USDCB, USDS, amountIn);
    vm.prank(alice);
    uint256 out = stablePool.swap_qe(USDCB, USDS, amountIn, 0, alice, block.timestamp + 600);

    assertEq(out, q.amountOut, "getSwapQuote and swap must agree on a still market");
  }

  /// A spoke-to-spoke swap is routed through the pool's base internally. One call, two legs.
  function test_spokeToSpokeIsOneCall() public {
    uint256 amountIn = units(USDT, 250);
    fund(USDT, amountIn, address(stablePool));

    IPool.SwapQuote memory q = stablePool.getSwapQuote(USDT, USDS, amountIn);
    assertEq(q.routeHops.length, 3, "spoke -> base -> spoke");
    assertEq(q.routeHops[1], stablePool.baseToken(), "the middle hop is the pool base");

    vm.prank(alice);
    uint256 out = stablePool.swap_qe(USDT, USDS, amountIn, q.amountOut, alice, block.timestamp + 600);
    assertGe(out, q.amountOut);
  }

  /// `minAmountOut` is the protection and it must actually bite. Asking for more than the pool
  /// will pay has to revert, not fill short.
  function test_unreachableFloorReverts() public {
    uint256 amountIn = units(USDCB, 1_000);
    fund(USDCB, amountIn, address(stablePool));

    IPool.SwapQuote memory q = stablePool.getSwapQuote(USDCB, USDT, amountIn);
    vm.prank(alice);
    vm.expectRevert();
    stablePool.swap_qe(USDCB, USDT, amountIn, q.amountOut * 2, alice, block.timestamp + 600);
  }

  /// An expired deadline reverts before anything moves.
  function test_expiredDeadlineReverts() public {
    uint256 amountIn = units(USDCB, 10);
    fund(USDCB, amountIn, address(stablePool));
    vm.prank(alice);
    vm.expectRevert();
    stablePool.swap_qe(USDCB, USDT, amountIn, 0, alice, block.timestamp - 1);
  }

  /// Without an approval the pool cannot pull the input. Stated because it is the single most
  /// common first-integration failure, and the revert does not say "you forgot to approve".
  function test_missingApprovalReverts() public {
    uint256 amountIn = units(USDCB, 100);
    deal(USDCB, alice, amountIn, true);
    vm.prank(alice);
    vm.expectRevert();
    stablePool.swap_qe(USDCB, USDT, amountIn, 0, alice, block.timestamp + 600);
  }

  /// A cross-asset swap on the crypto pool: stable in, volatile out, priced off the WETH feed.
  function test_stableToVolatile() public {
    uint256 amountIn = units(USDCB, 5_000);
    fund(USDCB, amountIn, address(cryptoPool));

    IPool.SwapQuote memory q = cryptoPool.getSwapQuote(USDCB, WETH, amountIn);
    assertGt(q.amountOut, 0);

    vm.prank(alice);
    uint256 out =
      cryptoPool.swap_qe(USDCB, WETH, amountIn, q.amountOut * 995 / 1000, alice, block.timestamp + 600);

    // Implied price must sit within a sane band of the pool's own mark. This catches a decimals
    // mistake, which is the failure mode that otherwise looks like a successful swap.
    uint256 implied = out * 1e18 / amountIn;
    assertApproxEqRel(implied, q.markPrice, 0.02e18, "fill diverged from the mark by over 2%");

    emit log_named_uint("USDCB in ", amountIn);
    emit log_named_uint("WETH out ", out);
  }

  /// ------------------------------------------------------------------------------------------
  /// FX and tokenised equities. Same three steps, two assumptions that only hold on stables.
  /// ------------------------------------------------------------------------------------------

  /// EURC is a 6-DECIMAL leg against USDCB's 18. `units()` builds the input from each token's own
  /// `decimals()` and `impliedWad` divides both out before comparing against the mark, because
  /// the raw ratio is off by 1e12 here and off by nothing at all on a stable pair, which is
  /// exactly why the bug ships.
  function test_fxPoolSixDecimalLeg() public {
    assertEq(IERC20(EURC).decimals(), 6, "the premise of this test");
    assertEq(IERC20(USDCB).decimals(), 18);

    uint256 amountIn = units(USDCB, 1_000);
    fund(USDCB, amountIn, address(fxPool));

    IPool.SwapQuote memory q = fxPool.getSwapQuote(USDCB, EURC, amountIn);
    assertGt(q.amountOut, 0, "a zero quote is a failure, not a price");

    uint256 minOut = q.amountOut * (10_000 - SLIPPAGE_BPS) / 10_000;
    vm.prank(alice);
    uint256 out = fxPool.swap_qe(USDCB, EURC, amountIn, minOut, alice, block.timestamp + 600);

    assertGe(out, minOut);
    assertLt(diffBps(impliedWad(USDCB, amountIn, EURC, out), q.markPrice), 200, "off the mark");
    // And the trap, stated: the same comparison without the decimals correction is nowhere near.
    assertGt(diffBps(out * 1e18 / amountIn, q.markPrice), 9_000, "raw ratio should be absurd");

    emit log_named_uint("filled (EURC, 6dp)", out);
    emit log_named_decimal_uint("markPrice         ", q.markPrice, 18);
  }

  /// JPYC is worth a fraction of a cent, so the OUTPUT is two orders of magnitude ABOVE the
  /// input. Any slippage or sizing helper written against stables assumes the opposite.
  function test_fxPoolSubUnitPrice() public {
    uint256 amountIn = units(USDCB, 1_000);
    fund(USDCB, amountIn, address(fxPool));

    IPool.SwapQuote memory q = fxPool.getSwapQuote(USDCB, JPYC, amountIn);
    uint256 minOut = q.amountOut * (10_000 - SLIPPAGE_BPS) / 10_000;

    vm.prank(alice);
    uint256 out = fxPool.swap_qe(USDCB, JPYC, amountIn, minOut, alice, block.timestamp + 600);

    assertGe(out, minOut);
    assertGt(out, amountIn * 100, "~159k JPYC for 1k USDCB: output dwarfs the input");
    assertLt(diffBps(impliedWad(USDCB, amountIn, JPYC, out), q.markPrice), 200);

    emit log_named_uint("filled (JPYC)", out);
  }

  /// An integrator trading tokenised equities calls the STOCKS pool. One share costs hundreds of
  /// dollars, so the output is two orders of magnitude BELOW the input, and `markPrice` is a
  /// small WAD (~4.6e15 for NVDA). A sanity check of the form `markPrice > 1e18` rejects every
  /// equity on the venue.
  function test_stocksPoolBaseToEquity() public {
    uint256 amountIn = units(USDCB, 1_000);
    fund(USDCB, amountIn, address(stocksPool));

    IPool.SwapQuote memory q = stocksPool.getSwapQuote(USDCB, NVDA, amountIn);
    assertGt(q.amountOut, 0, "a zero quote is a failure, not a price");
    assertLt(q.markPrice, 1e18, "tokenOut per USDCB is a SMALL wad for a share worth hundreds");

    uint256 minOut = q.amountOut * (10_000 - SLIPPAGE_BPS) / 10_000;
    vm.prank(alice);
    uint256 out = stocksPool.swap_qe(USDCB, NVDA, amountIn, minOut, alice, block.timestamp + 600);

    assertGe(out, minOut);
    assertLt(out, amountIn / 100, "1k USDCB buys single-digit shares");
    assertLt(diffBps(impliedWad(USDCB, amountIn, NVDA, out), q.markPrice), 200);

    emit log_named_uint("filled (NVDA)", out);
    emit log_named_decimal_uint("markPrice    ", q.markPrice, 18);
  }

  /// Equity to equity is ONE call: the pool hops through its own base internally, and the base
  /// never lands on the recipient.
  function test_stocksPoolEquityToEquityIsOneCall() public {
    uint256 amountIn = units(NVDA, 1);
    fund(NVDA, amountIn, address(stocksPool));

    IPool.SwapQuote memory q = stocksPool.getSwapQuote(NVDA, TSLA, amountIn);
    assertEq(q.routeHops.length, 3, "NVDA -> USDCB -> TSLA");
    assertEq(q.routeHops[1], USDCB, "the middle hop is the pool base");

    uint256 minOut = q.amountOut * (10_000 - SLIPPAGE_BPS) / 10_000;
    vm.prank(alice);
    uint256 out = stocksPool.swap_qe(NVDA, TSLA, amountIn, minOut, alice, block.timestamp + 600);

    assertGe(out, minOut);
    assertEq(IERC20(USDCB).balanceOf(alice), 0, "the intermediate must never be paid out");

    emit log_named_uint("filled (TSLA)", out);
  }
}
