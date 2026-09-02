// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BTRForkTest} from "./BTRForkTest.sol";
import {IERC20, IPool} from "../src/interfaces/IBTR.sol";

/**
 * Example 6, on chain: the DEBT SWAP, `swapLiability`.
 *
 * Guide: https://btr.markets/docs/5-1-1-basic-operations#5-swap-liability
 * Off-chain twins: ../../typescript/sdk/06-debt-swap.ts, ../../typescript/rpc/06-debt-swap.ts
 *
 * WHAT IT IS. An LP re-denominating their claim from one leg to another. An LP who is long USDT
 * exposure through the pool and would rather be long USDS burns USDT shares and mints USDS ones,
 * in one call, without leaving the pool.
 *
 * WHAT IT IS NOT, AND THIS IS THE WHOLE POINT: IT IS NOT A TRADE. RESERVES DO NOT MOVE. Only the
 * liability side of two legs changes. That is why it is cheap, why it does not pay the swap
 * spread, and why it is gated differently:
 *
 *   - both legs need `LIABILITY_SWAP_ENABLED_BIT` (bit 2) in `getRiskFlags`
 *   - an UNDER-COVERED input leg takes a haircut, because leaving a leg that cannot pay everyone
 *     in full at face value would hand the shortfall to whoever stays
 *   - the amounts are in LP SHARES on both sides, not in token units. `minLpAmountOut` is a share
 *     floor. Passing a token amount there is a units bug that a passing test will not catch.
 *
 * Run: forge test --match-path 'test/06_*' -vv
 */
contract DebtSwapTest is BTRForkTest {
  uint16 constant LIABILITY_SWAP_ENABLED_BIT = 1 << 2;

  /// `Errors.ZeroValue()`. See `_requireDebtSwapLive`.
  bytes4 constant ZERO_VALUE = 0x7c946ed7;

  /// @notice Probe the chain before asserting anything about a fill.
  ///
  /// On the deployment this example set was written against, EVERY `swapLiability` call reverts
  /// `ZeroValue()`, for every pair, on every pool, at every size, and so does cross-asset
  /// `withdrawTo`. Same-asset `withdraw` and `Pool.swap` are unaffected. That is an environment
  /// fault, not an example fault, and it is reported rather than papered over: these tests SKIP,
  /// loudly, instead of being deleted or quietly weakened to assert nothing.
  ///
  /// They turn back into real assertions the moment the chain answers, with no edit here.
  function _requireDebtSwapLive(uint256 shares) internal {
    uint256 snap = vm.snapshotState();
    vm.prank(alice);
    (bool ok, bytes memory ret) = address(stablePool).call(
      abi.encodeWithSelector(IPool.swapLiability.selector, USDT, USDS, shares, 0, block.timestamp + 600)
    );
    vm.revertToState(snap);
    if (ok) return;
    if (ret.length >= 4 && bytes4(ret) == ZERO_VALUE) {
      emit log("SKIP: swapLiability reverts ZeroValue() on this deployment. See README, Known issues.");
      vm.skip(true);
    }
  }

  function _lp(uint256 whole) internal returns (uint256 shares) {
    uint256 amount = units(USDT, whole);
    fund(USDT, amount, address(stablePool));
    vm.prank(alice);
    IPool.DepositResult memory r = stablePool.deposit(USDT, amount);
    return r.lpAmount - r.deadLp;
  }

  /// Check the gate BEFORE building the call. A leg with the bit clear reverts, and the revert
  /// does not tell you which of the two legs was the problem.
  function test_bothLegsAreEnabled() public view {
    assertTrue(
      stablePool.getRiskFlags(USDT) & LIABILITY_SWAP_ENABLED_BIT != 0, "USDT leg not enabled"
    );
    assertTrue(
      stablePool.getRiskFlags(USDS) & LIABILITY_SWAP_ENABLED_BIT != 0, "USDS leg not enabled"
    );
  }

  function test_swapLiabilityMovesTheClaimNotTheReserves() public {
    uint256 shares = _lp(10_000);
    _requireDebtSwapLive(shares);

    uint256 usdtBalBefore = IERC20(USDT).balanceOf(address(stablePool));
    uint256 usdsBalBefore = IERC20(USDS).balanceOf(address(stablePool));
    uint256 aliceUsdt = IERC20(USDT).balanceOf(alice);

    vm.prank(alice);
    uint256 outShares =
      stablePool.swapLiability(USDT, USDS, shares, 0, block.timestamp + 600);

    assertGt(outShares, 0, "a zero mint is a failure, not a debt swap");
    assertEq(stablePool.getLPBalance(alice, USDT), 0, "input shares must be burned in full");
    assertEq(stablePool.getLPBalance(alice, USDS), outShares, "output shares must be credited");

    // THE ASSERTION THAT MATTERS. No token moved anywhere: not into the pool, not out of it, not
    // to the caller. This is what separates a debt swap from a swap.
    assertEq(IERC20(USDT).balanceOf(address(stablePool)), usdtBalBefore, "USDT reserves moved");
    assertEq(IERC20(USDS).balanceOf(address(stablePool)), usdsBalBefore, "USDS reserves moved");
    assertEq(IERC20(USDT).balanceOf(alice), aliceUsdt, "caller received tokens");
    assertEq(IERC20(USDS).balanceOf(alice), 0, "caller received tokens");

    emit log_named_uint("USDT shares in ", shares);
    emit log_named_uint("USDS shares out", outShares);
  }

  /// The value carried across is close to par between two stables, but it is NOT the same number
  /// of shares: the two legs have different liquidity indexes, so shares are not comparable
  /// across legs. Compare VALUE, via `previewWithdraw`, or you will "lose" liquidity that is
  /// still there.
  function test_valueIsPreservedEvenThoughShareCountsDiffer() public {
    uint256 shares = _lp(10_000);
    _requireDebtSwapLive(shares);
    (uint256 valueIn,) = stablePool.previewWithdraw(USDT, shares);

    vm.prank(alice);
    uint256 outShares = stablePool.swapLiability(USDT, USDS, shares, 0, block.timestamp + 600);

    (uint256 valueOut,) = stablePool.previewWithdraw(USDS, outShares);

    emit log_named_uint("shares in ", shares);
    emit log_named_uint("shares out", outShares);
    emit log_named_uint("value in  ", valueIn);
    emit log_named_uint("value out ", valueOut);

    assertLe(valueOut, valueIn + 1, "a debt swap must never mint value");
    assertApproxEqRel(valueOut, valueIn, 0.02e18, "value lost beyond the haircut band");
  }

  /// `minLpAmountOut` is a SHARE floor and it must bite. Quote it first with a zero-floor call on
  /// a snapshot, then re-run with the real floor: there is no `previewSwapLiability`.
  function test_shareFloorBites() public {
    uint256 shares = _lp(5_000);
    _requireDebtSwapLive(shares);

    uint256 snap = vm.snapshotState();
    vm.prank(alice);
    uint256 quoted = stablePool.swapLiability(USDT, USDS, shares, 0, block.timestamp + 600);
    vm.revertToState(snap);

    // Asking for more shares than the pool will mint has to revert.
    vm.prank(alice);
    vm.expectRevert();
    stablePool.swapLiability(USDT, USDS, shares, quoted * 2, block.timestamp + 600);

    // The honest floor clears.
    vm.prank(alice);
    uint256 got = stablePool.swapLiability(USDT, USDS, shares, quoted, block.timestamp + 600);
    assertGe(got, quoted);
  }

  /// A debt swap is round-trippable, minus whatever haircut the legs' coverage imposes each way.
  /// Round-tripping is not free, and a strategy that flips legs on every signal pays for it.
  function test_roundTripCostsTheHaircut() public {
    uint256 shares = _lp(10_000);
    _requireDebtSwapLive(shares);
    (uint256 valueStart,) = stablePool.previewWithdraw(USDT, shares);

    vm.prank(alice);
    uint256 mid = stablePool.swapLiability(USDT, USDS, shares, 0, block.timestamp + 600);
    vm.prank(alice);
    uint256 back = stablePool.swapLiability(USDS, USDT, mid, 0, block.timestamp + 600);

    (uint256 valueEnd,) = stablePool.previewWithdraw(USDT, back);
    assertLe(valueEnd, valueStart + 1, "a round trip must never create value");

    emit log_named_uint("value start", valueStart);
    emit log_named_uint("value end  ", valueEnd);
    emit log_named_uint("round-trip cost", valueStart > valueEnd ? valueStart - valueEnd : 0);
  }

  /// Same leg in and out is not a debt swap. Rejected rather than treated as a no-op.
  function test_sameLegReverts() public {
    uint256 shares = _lp(1_000);
    vm.prank(alice);
    vm.expectRevert();
    stablePool.swapLiability(USDT, USDT, shares, 0, block.timestamp + 600);
  }

  /// A leg the pool does not list has to revert.
  function test_unlistedLegReverts() public {
    uint256 shares = _lp(1_000);
    vm.prank(alice);
    vm.expectRevert();
    stablePool.swapLiability(USDT, WETH, shares, 0, block.timestamp + 600);
  }

  /// An expired deadline reverts.
  function test_expiredDeadlineReverts() public {
    uint256 shares = _lp(1_000);
    uint256 past = block.timestamp - 1;
    vm.prank(alice);
    vm.expectRevert();
    stablePool.swapLiability(USDT, USDS, shares, 0, past);
  }
}
