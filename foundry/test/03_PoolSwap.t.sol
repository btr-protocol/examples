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
    uint256 out = stablePool.swap(USDCB, USDT, amountIn, minOut, alice, block.timestamp + 600);

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
    uint256 out = stablePool.swap(USDCB, USDS, amountIn, 0, alice, block.timestamp + 600);

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
    uint256 out = stablePool.swap(USDT, USDS, amountIn, q.amountOut, alice, block.timestamp + 600);
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
    stablePool.swap(USDCB, USDT, amountIn, q.amountOut * 2, alice, block.timestamp + 600);
  }

  /// An expired deadline reverts before anything moves.
  function test_expiredDeadlineReverts() public {
    uint256 amountIn = units(USDCB, 10);
    fund(USDCB, amountIn, address(stablePool));
    vm.prank(alice);
    vm.expectRevert();
    stablePool.swap(USDCB, USDT, amountIn, 0, alice, block.timestamp - 1);
  }

  /// Without an approval the pool cannot pull the input. Stated because it is the single most
  /// common first-integration failure, and the revert does not say "you forgot to approve".
  function test_missingApprovalReverts() public {
    uint256 amountIn = units(USDCB, 100);
    deal(USDCB, alice, amountIn, true);
    vm.prank(alice);
    vm.expectRevert();
    stablePool.swap(USDCB, USDT, amountIn, 0, alice, block.timestamp + 600);
  }

  /// A cross-asset swap on the crypto pool: stable in, volatile out, priced off the WETH feed.
  function test_stableToVolatile() public {
    uint256 amountIn = units(USDCB, 5_000);
    fund(USDCB, amountIn, address(cryptoPool));

    IPool.SwapQuote memory q = cryptoPool.getSwapQuote(USDCB, WETH, amountIn);
    assertGt(q.amountOut, 0);

    vm.prank(alice);
    uint256 out =
      cryptoPool.swap(USDCB, WETH, amountIn, q.amountOut * 995 / 1000, alice, block.timestamp + 600);

    // Implied price must sit within a sane band of the pool's own mark. This catches a decimals
    // mistake, which is the failure mode that otherwise looks like a successful swap.
    uint256 implied = out * 1e18 / amountIn;
    assertApproxEqRel(implied, q.markPrice, 0.02e18, "fill diverged from the mark by over 2%");

    emit log_named_uint("USDCB in ", amountIn);
    emit log_named_uint("WETH out ", out);
  }
}
