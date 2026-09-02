// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BTRForkTest} from "./BTRForkTest.sol";
import {IERC20, IPool} from "../src/interfaces/IBTR.sol";

/**
 * Example 4, on chain: depositing liquidity into one leg of a pool.
 *
 * Guide: https://btr.markets/docs/5-1-1-basic-operations#4-deposit--withdraw
 * Off-chain twins: ../../typescript/sdk/04-deposit.ts, ../../typescript/rpc/04-deposit.ts
 *
 * BTR liquidity is SINGLE SIDED and PER LEG. You deposit one token; there is no pair, no ratio to
 * match, no second asset to source. Shares are minted on that leg's own ERC-20 receipt, and the
 * share-to-value rate is the leg's liquidity index, which fees compound into over time.
 *
 * `deposit` carries no deadline and no minOut, and that is not an omission: nothing is quoted, so
 * there is nothing stale to protect. Shares mint at the leg's current index.
 *
 * Run: forge test --match-path 'test/04_*' -vv
 */
contract DepositTest is BTRForkTest {
  function test_depositMintsShares() public {
    uint256 amount = units(USDT, 10_000);
    fund(USDT, amount, address(stablePool));

    uint256 sharesBefore = stablePool.getLPBalance(alice, USDT);

    vm.prank(alice);
    IPool.DepositResult memory r = stablePool.deposit(USDT, amount);

    uint256 minted = stablePool.getLPBalance(alice, USDT) - sharesBefore;
    assertGt(r.lpAmount, 0, "a zero mint is a failure, not a deposit");
    assertEq(r.actualDeposit, amount, "the pool took a different amount than asked");
    assertEq(minted, r.lpAmount - r.deadLp, "receipt balance must match the mint less deadLp");
    assertEq(IERC20(USDT).balanceOf(alice), 0, "the whole deposit should have been pulled");

    emit log_named_uint("deposited (USDT)", r.actualDeposit);
    emit log_named_uint("shares minted   ", r.lpAmount);
    emit log_named_uint("deadLp sunk     ", r.deadLp);
  }

  /// The receipt is a real ERC-20 per leg. `getLPBalance` is a convenience over it, not a
  /// separate ledger, and the distinction matters the moment you want to transfer a position.
  function test_receiptTokenTracksTheBalance() public {
    uint256 amount = units(USDS, 5_000);
    fund(USDS, amount, address(stablePool));

    address receipt = stablePool.lpToken(USDS);
    assertTrue(receipt != address(0), "leg is not listed");

    vm.prank(alice);
    stablePool.deposit(USDS, amount);

    assertEq(
      IERC20(receipt).balanceOf(alice),
      stablePool.getLPBalance(alice, USDS),
      "getLPBalance must equal the receipt ERC-20 balance"
    );
  }

  /// What the shares are worth, right now, if redeemed. `previewWithdraw` returns the amount AND
  /// the coverage haircut, and reading only the first return is how an integrator books a
  /// position at a value the pool would not actually pay.
  function test_previewRoundTripIsCloseToDeposited() public {
    uint256 amount = units(USDT, 10_000);
    fund(USDT, amount, address(stablePool));

    vm.prank(alice);
    IPool.DepositResult memory r = stablePool.deposit(USDT, amount);

    (uint256 back, uint256 haircut) = stablePool.previewWithdraw(USDT, r.lpAmount - r.deadLp);
    assertGt(back, 0);
    assertLe(back, amount, "a same-block round trip must never return more than it took");

    emit log_named_uint("deposited", amount);
    emit log_named_uint("preview  ", back);
    emit log_named_uint("haircut  ", haircut);
  }

  /// Deposits are additive and the index is shared, so a second deposit at an unchanged index
  /// mints proportionally. Not exactly equal: the index advances with accrued fees.
  function test_secondDepositMintsProportionally() public {
    uint256 amount = units(USDT, 1_000);
    fund(USDT, amount * 2, address(stablePool));

    vm.prank(alice);
    IPool.DepositResult memory a = stablePool.deposit(USDT, amount);
    vm.prank(alice);
    IPool.DepositResult memory b = stablePool.deposit(USDT, amount);

    assertApproxEqRel(b.lpAmount, a.lpAmount, 0.001e18, "equal deposits should mint near-equal shares");
    assertEq(b.deadLp, 0, "deadLp is carved once, when the leg opens");
  }

  /// Depositing into a token the pool does not list has to revert, not mint worthless shares.
  function test_unlistedTokenReverts() public {
    // WETH is on the crypto pool, never listed on the stable pool.
    uint256 amount = 1e18;
    deal(WETH, alice, amount, true);
    vm.prank(alice);
    IERC20(WETH).approve(address(stablePool), type(uint256).max);
    vm.prank(alice);
    vm.expectRevert();
    stablePool.deposit(WETH, amount);
  }

  /// COVERAGE MOVES TOWARD 1.0, NOT UP. A deposit credits reserves AND liabilities by the same
  /// value, so it dilutes coverage toward parity: it lifts an under-covered leg and it lowers an
  /// over-covered one. Depositing is not a way to improve a leg's coverage; `donate` is (it adds
  /// reserves without liabilities). This test asserted "coverage cannot fall" in its first draft
  /// and failed against the live chain, which is why it is worded the way it is now.
  function test_depositMovesCoverageTowardParity() public {
    uint256 amount = units(USDT, 50_000);
    fund(USDT, amount, address(stablePool));

    uint256 before = stablePool.getCoverageRatio(USDT);
    vm.prank(alice);
    stablePool.deposit(USDT, amount);
    uint256 afterCov = stablePool.getCoverageRatio(USDT);

    emit log_named_decimal_uint("coverage before", before, 18);
    emit log_named_decimal_uint("coverage after ", afterCov, 18);

    uint256 gapBefore = before > 1e18 ? before - 1e18 : 1e18 - before;
    uint256 gapAfter = afterCov > 1e18 ? afterCov - 1e18 : 1e18 - afterCov;
    assertLe(gapAfter, gapBefore, "a deposit must move coverage toward parity, never away from it");
  }
}
