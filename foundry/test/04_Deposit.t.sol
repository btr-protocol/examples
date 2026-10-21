// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BTRForkTest, PlainToken} from "./BTRForkTest.sol";
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
  /// @dev A leg `alice` can deposit into, or skip. A gated leg would make every assertion below
  ///      fail, or revert-test pass, for a reason unrelated to the code under test.
  function _leg(string memory cls, string memory why) internal returns (Leg memory l) {
    bool ok;
    (l, ok) = bytes(cls).length == 0 ? demoLeg() : firstLeg(cls);
    skipUnless(ok, why);
    skipIfDepositGated(l);
  }

  function test_depositMintsShares() public {
    Leg memory l = _leg("", "no pool holds a non-base leg");
    uint256 amount = unitsWorth(l.sym, 10_000);
    fund(l.token, amount, address(l.pool));

    uint256 sharesBefore = l.pool.getLPBalance(alice, l.token);

    vm.prank(alice);
    IPool.DepositResult memory r = l.pool.deposit(l.token, amount);

    uint256 minted = l.pool.getLPBalance(alice, l.token) - sharesBefore;
    assertGt(r.lpAmount, 0, "a zero mint is a failure, not a deposit");
    assertEq(r.actualDeposit, amount, "the pool took a different amount than asked");
    assertEq(minted, r.lpAmount - r.deadLp, "receipt balance must match the mint less deadLp");
    assertEq(IERC20(l.token).balanceOf(alice), 0, "the whole deposit should have been pulled");

    emit log_named_uint(string.concat("deposited (", l.sym, ")"), r.actualDeposit);
    emit log_named_uint("shares minted   ", r.lpAmount);
    emit log_named_uint("deadLp sunk     ", r.deadLp);
  }

  /// The receipt is a real ERC-20 per leg. `getLPBalance` is a convenience over it, not a
  /// separate ledger, and the distinction matters the moment you want to transfer a position.
  function test_receiptTokenTracksTheBalance() public {
    (, Leg memory l, bool ok) = demoPair();
    if (!ok) (l, ok) = demoLeg();
    skipUnless(ok, "no pool holds a non-base leg");
    skipIfDepositGated(l);
    uint256 amount = unitsWorth(l.sym, 5_000);
    fund(l.token, amount, address(l.pool));

    address receipt = l.pool.lpToken(l.token);
    assertTrue(receipt != address(0), "leg is not listed");

    vm.prank(alice);
    l.pool.deposit(l.token, amount);

    assertEq(
      IERC20(receipt).balanceOf(alice),
      l.pool.getLPBalance(alice, l.token),
      "getLPBalance must equal the receipt ERC-20 balance"
    );
  }

  /// What the shares are worth, right now, if redeemed. `previewWithdraw` returns the amount AND
  /// the coverage haircut, and reading only the first return is how an integrator books a
  /// position at a value the pool would not actually pay.
  function test_previewRoundTripIsCloseToDeposited() public {
    Leg memory l = _leg("", "no pool holds a non-base leg");
    uint256 amount = unitsWorth(l.sym, 10_000);
    fund(l.token, amount, address(l.pool));

    vm.prank(alice);
    IPool.DepositResult memory r = l.pool.deposit(l.token, amount);

    (uint256 back, uint256 haircut) = l.pool.previewWithdraw(l.token, r.lpAmount - r.deadLp);
    assertGt(back, 0);
    assertLe(back, amount, "a same-block round trip must never return more than it took");

    emit log_named_uint("deposited", amount);
    emit log_named_uint("preview  ", back);
    emit log_named_uint("haircut  ", haircut);
  }

  /// Deposits are additive and the index is shared, so a second deposit at an unchanged index
  /// mints proportionally. Not exactly equal: the index advances with accrued fees.
  function test_secondDepositMintsProportionally() public {
    Leg memory l = _leg("", "no pool holds a non-base leg");
    uint256 amount = unitsWorth(l.sym, 1_000);
    fund(l.token, amount * 2, address(l.pool));

    vm.prank(alice);
    IPool.DepositResult memory a = l.pool.deposit(l.token, amount);
    vm.prank(alice);
    IPool.DepositResult memory b = l.pool.deposit(l.token, amount);

    assertApproxEqRel(b.lpAmount, a.lpAmount, 0.001e18, "equal deposits should mint near-equal shares");
    assertEq(b.deadLp, 0, "deadLp is carved once, when the leg opens");
  }

  /// Depositing into a token the pool does not list has to revert, not mint worthless shares.
  function test_unlistedTokenReverts() public {
    Leg memory l = _leg("", "no pool holds a non-base leg");
    PlainToken stray = new PlainToken();
    uint256 amount = 1e18;
    stray.mint(alice, amount);
    vm.prank(alice);
    stray.approve(address(l.pool), type(uint256).max);
    vm.prank(alice);
    vm.expectRevert();
    l.pool.deposit(address(stray), amount);
  }

  /// COVERAGE MOVES TOWARD THE POOL SOLVENCY C, NOT UP. A deposit mints at C: reserves grow by
  /// `amount` and liabilities by `amount / C`. So the leg's coverage is dragged toward C: down
  /// from above it, up from below it. It is not toward 1.0, and depositing is not a way to
  /// improve a leg's coverage; `donate` is (it adds reserves without liabilities).
  function test_depositMovesCoverageTowardPoolSolvency() public {
    Leg memory l = _leg("", "no pool holds a non-base leg");
    uint256 amount = unitsWorth(l.sym, 50_000);
    fund(l.token, amount, address(l.pool));

    (uint256 c,) = l.pool.poolSolvencyWad();
    uint256 before = l.pool.getCoverageRatio(l.token);
    vm.prank(alice);
    l.pool.deposit(l.token, amount);
    uint256 afterCov = l.pool.getCoverageRatio(l.token);

    emit log_named_decimal_uint("coverage before", before, 18);
    emit log_named_decimal_uint("coverage after ", afterCov, 18);
    emit log_named_decimal_uint("pool C         ", c, 18);

    assertLe(_gap(afterCov, c), _gap(before, c), "a deposit must move coverage toward C, never away from it");
  }

  function _gap(uint256 x, uint256 y) private pure returns (uint256) {
    return x > y ? x - y : y - x;
  }

  /// ------------------------------------------------------------------------------------------
  /// The same flow on an FX and an equity leg. An LP leg is denominated in the LEG'S OWN token,
  /// so every amount below is built from that token's `decimals()` and mark, never from a
  /// literal 1e18.
  /// ------------------------------------------------------------------------------------------

  /// An FX token can have fewer decimals than the base. `unitsWorth()` is the only reason this
  /// reads the same as the stable case, and a hardcoded `10_000e18` here would ask the pool for
  /// a trillion short-decimals tokens.
  function test_fxLegMintsShares() public {
    Leg memory l = _leg("fx", "no pool holds an FX leg");
    uint256 amount = unitsWorth(l.sym, 10_000);
    fund(l.token, amount, address(l.pool));

    vm.prank(alice);
    IPool.DepositResult memory r = l.pool.deposit(l.token, amount);

    assertGt(r.lpAmount, 0, "a zero mint is a failure, not a deposit");
    assertEq(r.actualDeposit, amount, "the pool took a different amount than asked");
    assertEq(l.pool.getLPBalance(alice, l.token), r.lpAmount - r.deadLp);
    assertEq(IERC20(l.token).balanceOf(alice), 0, "the whole deposit should have been pulled");

    (uint256 back,) = l.pool.previewWithdraw(l.token, r.lpAmount - r.deadLp);
    assertGt(back, 0, "a zero preview is a failure, not a valuation");
    assertLe(back, amount, "a same-block round trip must never return more than it took");

    emit log_named_uint(string.concat("deposited (", l.sym, ")"), amount);
    emit log_named_uint("shares minted        ", r.lpAmount);
  }

  /// A tokenised-equity leg. $10,000 of it is a three-digit token amount, which is the opposite
  /// shape to every stable example above it.
  function test_equityLegMintsShares() public {
    Leg memory l = _leg("equity", "no pool holds an equity leg");
    uint256 amount = unitsWorth(l.sym, 10_000);
    fund(l.token, amount, address(l.pool));

    uint256 before = l.pool.getLPBalance(alice, l.token);
    vm.prank(alice);
    IPool.DepositResult memory r = l.pool.deposit(l.token, amount);

    assertGt(r.lpAmount, 0);
    assertEq(l.pool.getLPBalance(alice, l.token) - before, r.lpAmount - r.deadLp);
    assertTrue(l.pool.lpToken(l.token) != address(0), "leg is not listed");

    emit log_named_uint(string.concat("deposited (", l.sym, ")"), amount);
    emit log_named_uint("shares minted   ", r.lpAmount);
  }

  /// Coverage is dragged toward C on an equity leg exactly as it is on a stable one. The asset
  /// class does not change the accounting.
  function test_equityDepositMovesCoverageTowardPoolSolvency() public {
    Leg memory l = _leg("equity", "no pool holds an equity leg");
    uint256 amount = unitsWorth(l.sym, 50_000);
    fund(l.token, amount, address(l.pool));

    (uint256 c,) = l.pool.poolSolvencyWad();
    uint256 before = l.pool.getCoverageRatio(l.token);
    vm.prank(alice);
    l.pool.deposit(l.token, amount);
    uint256 afterCov = l.pool.getCoverageRatio(l.token);

    assertLe(_gap(afterCov, c), _gap(before, c), "a deposit must move coverage toward C");

    emit log_named_decimal_uint("coverage before", before, 18);
    emit log_named_decimal_uint("coverage after ", afterCov, 18);
  }
}
