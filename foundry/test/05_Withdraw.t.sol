// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BTRForkTest} from "./BTRForkTest.sol";
import {IERC20, IPool} from "../src/interfaces/IBTR.sol";

/**
 * Example 5, on chain: withdrawing liquidity, with the floor set from `previewWithdraw`.
 *
 * Guide: https://btr.markets/docs/5-1-1-basic-operations#4-deposit--withdraw
 * Off-chain twins: ../../typescript/sdk/05-withdraw.ts, ../../typescript/rpc/05-withdraw.ts
 *
 * TWO THINGS MAKE A WITHDRAW DIFFERENT FROM A DEPOSIT.
 *
 *   1. THERE IS A HAIRCUT. A same-asset exit pays `face * min(coverage(leg), C)` less a small
 *      exit toll, so a leg short of reserves pays out less than the shares' face value, and it
 *      must: the alternative is first-out-gets-paid-in-full, which is a bank run with extra
 *      steps. `previewWithdraw` returns BOTH the amount and the haircut. Read both.
 *   2. THERE IS AN ANTI-JIT COOLDOWN. Shares deposited in the last `flowCooldownSecs` cannot be
 *      redeemed. This is what stops a deposit-donate-withdraw sandwich from harvesting the index
 *      move, and it is why the test below warps time before redeeming.
 *
 * `minAmountOut` should come from `previewWithdraw`, not from what you deposited. Those differ by
 * the haircut, and floor-from-deposit is how an integrator gets a revert on a healthy pool.
 *
 * Run: forge test --match-path 'test/05_*' -vv
 */
contract WithdrawTest is BTRForkTest {
  /// @dev A leg `alice` can deposit into (and so withdraw from), or skip.
  function _leg(string memory cls, string memory why) internal returns (Leg memory l) {
    bool ok;
    (l, ok) = bytes(cls).length == 0 ? demoLeg() : firstLeg(cls);
    skipUnless(ok, why);
    skipIfDepositGated(l);
  }

  /// @dev Deposit `usd` dollars of `l` and return the redeemable shares. `unitsWorth()` reads the
  ///      token's own decimals and mark, which is what lets the same helper serve a stable, a
  ///      short-decimals FX leg and an equity one.
  function _deposit(Leg memory l, uint256 usd) internal returns (uint256 shares) {
    uint256 amount = unitsWorth(l.sym, usd);
    fund(l.token, amount, address(l.pool));
    vm.prank(alice);
    IPool.DepositResult memory r = l.pool.deposit(l.token, amount);
    return r.lpAmount - r.deadLp;
  }

  function test_previewThenWithdraw() public {
    Leg memory l = _leg("", "no pool holds a non-base leg");
    uint256 shares = _deposit(l, 10_000);

    // Wait out the anti-JIT window. Skipping this is the usual "why does my withdraw revert".
    warpPastCooldown(l.pool);

    (uint256 preview, uint256 haircut) = l.pool.previewWithdraw(l.token, shares);
    assertGt(preview, 0, "a zero preview is a failure, not a valuation");

    // The floor comes from the PREVIEW, with your own tolerance on top.
    uint256 minOut = preview * 9_990 / 10_000; // 10 bps

    uint256 before = IERC20(l.token).balanceOf(alice);
    vm.prank(alice);
    IPool.WithdrawResult memory r = l.pool.withdraw(l.token, shares, minOut, block.timestamp + 600);

    assertEq(r.amountOut, IERC20(l.token).balanceOf(alice) - before, "receipt must match what arrived");
    assertGe(r.amountOut, minOut);
    assertEq(r.amountOut, preview, "preview and fill must agree on a still market");
    assertEq(l.pool.getLPBalance(alice, l.token), 0);

    emit log_named_uint("shares in    ", shares);
    emit log_named_uint(string.concat(l.sym, " out"), r.amountOut);
    emit log_named_uint("haircut      ", haircut);
  }

  /// A partial exit. Shares are fungible within the leg, so half the shares redeem for about
  /// half the value.
  function test_partialWithdraw() public {
    Leg memory l = _leg("", "no pool holds a non-base leg");
    uint256 shares = _deposit(l, 10_000);
    warpPastCooldown(l.pool);

    (uint256 full,) = l.pool.previewWithdraw(l.token, shares);
    (uint256 half,) = l.pool.previewWithdraw(l.token, shares / 2);
    assertApproxEqRel(half * 2, full, 0.0001e18, "shares must redeem linearly");

    vm.prank(alice);
    IPool.WithdrawResult memory r = l.pool.withdraw(l.token, shares / 2, half, block.timestamp + 600);

    assertEq(r.amountOut, half);
    assertEq(l.pool.getLPBalance(alice, l.token), shares - shares / 2);
  }

  /// The anti-JIT cooldown, proven rather than asserted in a comment: the same call that
  /// succeeds after the warp fails before it.
  function test_immediateWithdrawIsBlockedByCooldown() public {
    Leg memory l = _leg("", "no pool holds a non-base leg");
    skipUnless(cooldownOf(l.pool) != 0, "the pool has the cooldown disabled");
    uint256 shares = _deposit(l, 1_000);

    vm.prank(alice);
    vm.expectRevert();
    l.pool.withdraw(l.token, shares, 0, block.timestamp + 600);

    warpPastCooldown(l.pool);
    vm.prank(alice);
    IPool.WithdrawResult memory r = l.pool.withdraw(l.token, shares, 0, block.timestamp + 600);
    assertGt(r.amountOut, 0);
  }

  /// `maxRedeem` is capacity, not value: how many shares the leg can honour right now, folding
  /// in liquid reserves and the anti-JIT freeze. Check it before sizing an exit.
  function test_maxRedeemBoundsTheExit() public {
    Leg memory l = _leg("", "no pool holds a non-base leg");
    uint256 shares = _deposit(l, 1_000);
    assertEq(l.pool.maxRedeem(alice, l.token), 0, "freshly minted shares are frozen");

    warpPastCooldown(l.pool);
    assertGe(l.pool.maxRedeem(alice, l.token), shares, "cooldown elapsed, the position is redeemable");
  }

  /// Flooring from the DEPOSITED amount instead of the preview. Shown as a failing shape on
  /// purpose: it is the mistake, and it only bites on the leg that has a haircut.
  function test_flooringFromDepositRatherThanPreviewIsWrong() public {
    Leg memory l = _leg("", "no pool holds a non-base leg");
    uint256 deposited = unitsWorth(l.sym, 10_000);
    fund(l.token, deposited, address(l.pool));
    vm.prank(alice);
    IPool.DepositResult memory d = l.pool.deposit(l.token, deposited);
    uint256 shares = d.lpAmount - d.deadLp;

    warpPastCooldown(l.pool);
    (uint256 preview,) = l.pool.previewWithdraw(l.token, shares);

    // The pool will pay `preview`, which is at or below what went in. Demanding the deposited
    // amount back is a floor the pool can only meet when the haircut is exactly zero.
    if (preview < deposited) {
      vm.prank(alice);
      vm.expectRevert();
      l.pool.withdraw(l.token, shares, deposited, block.timestamp + 600);
    }
    // And the correct floor always clears.
    vm.prank(alice);
    IPool.WithdrawResult memory r = l.pool.withdraw(l.token, shares, preview, block.timestamp + 600);
    assertGe(r.amountOut, preview);
  }

  /// An expired deadline reverts. Unlike `deposit`, `withdraw` quotes an output, so it carries one.
  function test_expiredDeadlineReverts() public {
    Leg memory l = _leg("", "no pool holds a non-base leg");
    uint256 shares = _deposit(l, 1_000);
    warpPastCooldown(l.pool);
    uint256 past = block.timestamp - 1;
    vm.prank(alice);
    vm.expectRevert();
    l.pool.withdraw(l.token, shares, 0, past);
  }

  /// ------------------------------------------------------------------------------------------
  /// FX and equity legs. Same two rules (floor from the preview, wait out the cooldown), applied
  /// where the token amounts no longer look like the stable case.
  /// ------------------------------------------------------------------------------------------

  /// An FX leg, exited in full. Every amount is in the token's own decimals, and the floor still
  /// comes from `previewWithdraw` rather than from what went in.
  function test_fxLegFullExit() public {
    Leg memory l = _leg("fx", "no pool holds an FX leg");
    uint256 shares = _deposit(l, 10_000);
    assertEq(l.pool.maxRedeem(alice, l.token), 0, "freshly minted shares are frozen");

    warpPastCooldown(l.pool);
    assertGe(l.pool.maxRedeem(alice, l.token), shares);

    (uint256 preview, uint256 haircut) = l.pool.previewWithdraw(l.token, shares);
    assertGt(preview, 0, "a zero preview is a failure, not a valuation");

    uint256 before = IERC20(l.token).balanceOf(alice);
    vm.prank(alice);
    IPool.WithdrawResult memory r =
      l.pool.withdraw(l.token, shares, preview * 9_990 / 10_000, block.timestamp + 600);

    assertEq(r.amountOut, IERC20(l.token).balanceOf(alice) - before);
    assertEq(r.amountOut, preview, "preview and fill must agree on a still market");
    // The payout is in the token's own decimals. Compared against an 18-decimal constant it
    // could look like nothing came back at all, so the bound is derived from `unitsWorth()` too.
    assertLe(r.amountOut, unitsWorth(l.sym, 10_000));
    assertGt(r.amountOut, unitsWorth(l.sym, 5_000));
    assertEq(l.pool.getLPBalance(alice, l.token), 0);

    emit log_named_uint(string.concat(l.sym, " out"), r.amountOut);
    emit log_named_uint("haircut       ", haircut);
  }

  /// An equity leg, exited by half. Shares redeem linearly on an equity leg exactly as they do on
  /// a stable one; the asset class does not change the share maths.
  function test_equityLegPartialExit() public {
    Leg memory l = _leg("equity", "no pool holds an equity leg");
    uint256 shares = _deposit(l, 10_000);
    warpPastCooldown(l.pool);

    (uint256 full,) = l.pool.previewWithdraw(l.token, shares);
    (uint256 half,) = l.pool.previewWithdraw(l.token, shares / 2);
    assertGt(full, 0);
    assertApproxEqRel(half * 2, full, 0.0002e18, "shares must redeem linearly");

    uint256 before = IERC20(l.token).balanceOf(alice);
    vm.prank(alice);
    IPool.WithdrawResult memory r = l.pool.withdraw(l.token, shares / 2, half, block.timestamp + 600);

    assertEq(r.amountOut, IERC20(l.token).balanceOf(alice) - before);
    assertGe(r.amountOut, half);
    assertEq(l.pool.getLPBalance(alice, l.token), shares - shares / 2);

    emit log_named_uint(string.concat(l.sym, " out"), r.amountOut);
  }
}
