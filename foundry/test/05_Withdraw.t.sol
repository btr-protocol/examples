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
 *   1. THERE IS A HAIRCUT. Below 100% coverage a leg pays out less than the shares' face value,
 *      and it must: the alternative is first-out-gets-paid-in-full, which is a bank run with
 *      extra steps. `previewWithdraw` returns BOTH the amount and the haircut. Read both.
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
  /// @dev Seconds to wait out the anti-JIT cooldown. Read from the pool, not hardcoded.
  function cooldown() internal view returns (uint256) {
    (bool ok, bytes memory ret) =
      address(stablePool).staticcall(abi.encodeWithSignature("flowCooldownSecs()"));
    return ok ? abi.decode(ret, (uint16)) : 0;
  }

  function _depositUsdt(uint256 whole) internal returns (uint256 shares) {
    uint256 amount = units(USDT, whole);
    fund(USDT, amount, address(stablePool));
    vm.prank(alice);
    IPool.DepositResult memory r = stablePool.deposit(USDT, amount);
    return r.lpAmount - r.deadLp;
  }

  function test_previewThenWithdraw() public {
    uint256 shares = _depositUsdt(10_000);

    // Wait out the anti-JIT window. Skipping this is the usual "why does my withdraw revert".
    vm.warp(block.timestamp + cooldown() + 1);

    (uint256 preview, uint256 haircut) = stablePool.previewWithdraw(USDT, shares);
    assertGt(preview, 0, "a zero preview is a failure, not a valuation");

    // The floor comes from the PREVIEW, with your own tolerance on top.
    uint256 minOut = preview * 9_990 / 10_000; // 10 bps

    uint256 before = IERC20(USDT).balanceOf(alice);
    vm.prank(alice);
    IPool.WithdrawResult memory r =
      stablePool.withdraw(USDT, shares, minOut, block.timestamp + 600);

    assertEq(r.lpBurned, shares, "the whole position should have been burned");
    assertEq(r.amountOut, IERC20(USDT).balanceOf(alice) - before, "receipt must match what arrived");
    assertGe(r.amountOut, minOut);
    assertEq(r.amountOut, preview, "preview and fill must agree on a still market");
    assertEq(stablePool.getLPBalance(alice, USDT), 0);

    emit log_named_uint("shares burned", r.lpBurned);
    emit log_named_uint("USDT out     ", r.amountOut);
    emit log_named_uint("haircut      ", haircut);
  }

  /// A partial exit. Shares are fungible within the leg, so half the shares redeem for about
  /// half the value.
  function test_partialWithdraw() public {
    uint256 shares = _depositUsdt(10_000);
    vm.warp(block.timestamp + cooldown() + 1);

    (uint256 full,) = stablePool.previewWithdraw(USDT, shares);
    (uint256 half,) = stablePool.previewWithdraw(USDT, shares / 2);
    assertApproxEqRel(half * 2, full, 0.0001e18, "shares must redeem linearly");

    vm.prank(alice);
    IPool.WithdrawResult memory r =
      stablePool.withdraw(USDT, shares / 2, half, block.timestamp + 600);

    assertEq(r.amountOut, half);
    assertEq(stablePool.getLPBalance(alice, USDT), shares - shares / 2);
  }

  /// The anti-JIT cooldown, proven rather than asserted in a comment: the same call that
  /// succeeds after the warp fails before it.
  function test_immediateWithdrawIsBlockedByCooldown() public {
    if (cooldown() == 0) return; // pool has the guard disabled; nothing to prove
    uint256 shares = _depositUsdt(1_000);

    vm.prank(alice);
    vm.expectRevert();
    stablePool.withdraw(USDT, shares, 0, block.timestamp + 600);

    vm.warp(block.timestamp + cooldown() + 1);
    vm.prank(alice);
    IPool.WithdrawResult memory r = stablePool.withdraw(USDT, shares, 0, block.timestamp + 600);
    assertGt(r.amountOut, 0);
  }

  /// `maxRedeem` is capacity, not value: how many shares the leg can honour right now, folding
  /// in liquid reserves and the anti-JIT freeze. Check it before sizing an exit.
  function test_maxRedeemBoundsTheExit() public {
    uint256 shares = _depositUsdt(1_000);
    assertEq(stablePool.maxRedeem(alice, USDT), 0, "freshly minted shares are frozen");

    vm.warp(block.timestamp + cooldown() + 1);
    assertGe(stablePool.maxRedeem(alice, USDT), shares, "cooldown elapsed, the position is redeemable");
  }

  /// Flooring from the DEPOSITED amount instead of the preview. Shown as a failing shape on
  /// purpose: it is the mistake, and it only bites on the leg that has a haircut.
  function test_flooringFromDepositRatherThanPreviewIsWrong() public {
    uint256 deposited = units(USDT, 10_000);
    fund(USDT, deposited, address(stablePool));
    vm.prank(alice);
    IPool.DepositResult memory d = stablePool.deposit(USDT, deposited);
    uint256 shares = d.lpAmount - d.deadLp;

    vm.warp(block.timestamp + cooldown() + 1);
    (uint256 preview,) = stablePool.previewWithdraw(USDT, shares);

    // The pool will pay `preview`, which is at or below what went in. Demanding the deposited
    // amount back is a floor the pool can only meet when the haircut is exactly zero.
    if (preview < deposited) {
      vm.prank(alice);
      vm.expectRevert();
      stablePool.withdraw(USDT, shares, deposited, block.timestamp + 600);
    }
    // And the correct floor always clears.
    vm.prank(alice);
    IPool.WithdrawResult memory r =
      stablePool.withdraw(USDT, shares, preview, block.timestamp + 600);
    assertGe(r.amountOut, preview);
  }

  /// An expired deadline reverts. Unlike `deposit`, `withdraw` quotes an output, so it carries one.
  function test_expiredDeadlineReverts() public {
    uint256 shares = _depositUsdt(1_000);
    vm.warp(block.timestamp + cooldown() + 1);
    uint256 past = block.timestamp - 1;
    vm.prank(alice);
    vm.expectRevert();
    stablePool.withdraw(USDT, shares, 0, past);
  }
}
