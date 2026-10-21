// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BTRForkTest, PlainToken} from "./BTRForkTest.sol";
import {IERC20, IPool} from "../src/interfaces/IBTR.sol";

/**
 * Example 6, on chain: the DEBT SWAP, `swapLiability`.
 *
 * Guide: https://btr.markets/docs/5-1-1-basic-operations#5-swap-liability
 * Off-chain twins: ../../typescript/sdk/06-debt-swap.ts, ../../typescript/rpc/06-debt-swap.ts
 *
 * WHAT IT IS. An LP re-denominating their claim from one leg to another. An LP who is long one
 * leg's exposure through the pool and would rather be long another burns shares of the first and
 * mints shares of the second, in one call, without leaving the pool.
 *
 * WHAT IT IS NOT, AND THIS IS THE WHOLE POINT: IT IS NOT A TRADE. RESERVES DO NOT MOVE. Only the
 * liability side of two legs changes. That is why it is cheap, why it is exempt from the
 * protocol fee, and why it is gated differently:
 *
 *   - both legs need `LIABILITY_SWAP_ENABLED_BIT` (bit 5) in `getRiskFlags`
 *   - it settles at the pool-wide solvency C (`poolSolvencyWad`), the rate a deposit mints at:
 *     the FACE crosses at the two legs' mark ratio less the swap spread, and there is no per-leg
 *     haircut. What a share of a leg is WORTH on exit is `face * min(coverage(leg), C)`, so the
 *     value moves by that ratio between the legs
 *   - the amounts are in LP SHARES on both sides, not in token units. `minLpAmountOut` is a share
 *     floor. Passing a token amount there is a units bug that a passing test will not catch.
 *   - THE FLOW COOLDOWN APPLIES. A debt swap moves an LP claim, so it is gated by the same
 *     anti-flow-abuse freeze as a withdraw: shares minted less than `Pool.flowCooldownSecs()` ago
 *     cannot be re-denominated, and trying reverts `CooldownActive()`. Deposit-then-swap in one
 *     block does not work on the real chain, so it does not work here either. Every test below
 *     reads the window off the pool and waits it out.
 *
 * Run: forge test --match-path 'test/06_*' -vv
 */
contract DebtSwapTest is BTRForkTest {
  /// @dev PoolConstantsLib.LIABILITY_SWAP_ENABLED_BIT, bit 5 of `getRiskFlags`.
  uint16 constant LIABILITY_SWAP_ENABLED_BIT = 1 << 5;

  /// @dev The pair of legs the tests re-denominate between, or skip. Depositing is how a test gets
  ///      shares, so a deposit-gated source leg skips too.
  function _pair() internal returns (Leg memory a, Leg memory b) {
    bool ok;
    (a, b, ok) = demoPair();
    skipUnless(ok, "no pool holds two non-base legs");
    skipIfDepositGated(a);
  }

  /// @dev Deposit `whole` dollars of leg `a` and hand back shares that are actually swappable.
  ///
  ///      The `warpPastCooldown` is the part an integrator has to copy. Freshly minted shares are
  ///      frozen for `flowCooldownSecs`, so a deposit and a `swapLiability` in the same block
  ///      revert `CooldownActive()`. That freeze is what stops a deposit-flip-exit sandwich from
  ///      harvesting an index or coverage move it carried no risk for. The window is read off the
  ///      pool (see `BTRForkTest.warpPastCooldown`): it is an admin-settable `uint16`, so a
  ///      hardcoded literal here would pass today and break silently the day it is retuned.
  function _lp(Leg memory a, uint256 whole) internal returns (uint256 shares) {
    uint256 amount = unitsWorth(a.sym, whole);
    fund(a.token, amount, address(a.pool));
    vm.prank(alice);
    IPool.DepositResult memory r = a.pool.deposit(a.token, amount);
    warpPastCooldown(a.pool);
    return r.lpAmount - r.deadLp;
  }

  /// Check the gate BEFORE building the call. A leg with the bit clear reverts, and the revert
  /// does not tell you which of the two legs was the problem.
  function test_bothLegsAreEnabled() public {
    (Leg memory a, Leg memory b, bool ok) = demoPair();
    skipUnless(ok, "no pool holds two non-base legs");
    assertTrue(a.pool.getRiskFlags(a.token) & LIABILITY_SWAP_ENABLED_BIT != 0, string.concat(a.sym, " leg not enabled"));
    assertTrue(a.pool.getRiskFlags(b.token) & LIABILITY_SWAP_ENABLED_BIT != 0, string.concat(b.sym, " leg not enabled"));
  }

  function test_swapLiabilityMovesTheClaimNotTheReserves() public {
    (Leg memory a, Leg memory b) = _pair();
    uint256 shares = _lp(a, 10_000);

    uint256 aBalBefore = IERC20(a.token).balanceOf(address(a.pool));
    uint256 bBalBefore = IERC20(b.token).balanceOf(address(a.pool));
    uint256 aliceA = IERC20(a.token).balanceOf(alice);

    vm.prank(alice);
    uint256 outShares = a.pool.swapLiability(a.token, b.token, shares, 0, block.timestamp + 600);

    assertGt(outShares, 0, "a zero mint is a failure, not a debt swap");
    assertEq(a.pool.getLPBalance(alice, a.token), 0, "input shares must be burned in full");
    assertEq(a.pool.getLPBalance(alice, b.token), outShares, "output shares must be credited");

    // THE ASSERTION THAT MATTERS. No token moved anywhere: not into the pool, not out of it, not
    // to the caller. This is what separates a debt swap from a swap.
    assertEq(IERC20(a.token).balanceOf(address(a.pool)), aBalBefore, "source reserves moved");
    assertEq(IERC20(b.token).balanceOf(address(a.pool)), bBalBefore, "destination reserves moved");
    assertEq(IERC20(a.token).balanceOf(alice), aliceA, "caller received tokens");
    assertEq(IERC20(b.token).balanceOf(alice), 0, "caller received tokens");

    emit log_named_uint(string.concat(a.sym, " shares in "), shares);
    emit log_named_uint(string.concat(b.sym, " shares out"), outShares);
  }

  /// The FACE crosses; the number of SHARES does not: the two legs have different liquidity
  /// indexes, so shares are not comparable across legs. Compare FACE (`shares * index / 1e18`, in
  /// the leg's own token units) priced at the oracle mark, or you will "lose" liquidity that is
  /// still there.
  ///
  /// THERE IS NO PER-LEG HAIRCUT. The swap settles at the pool-wide solvency C and re-credits the
  /// destination at the same face, so the face crosses at the two legs' mark ratio less the swap
  /// spread. What a share is WORTH on exit is `face * min(coverage(leg), C)`, and the swap itself
  /// moves the destination leg's coverage, so a `previewWithdraw` taken afterwards is a different
  /// number by design: the invariant is on the face, not on the exit preview.
  function test_faceCrossesAtTheMarkRatio() public {
    (Leg memory a, Leg memory b) = _pair();
    uint256 shares = _lp(a, 10_000);
    uint256 faceIn = shares * a.pool.getAsset(a.token).liquidityIndexWad / 1e18;

    vm.prank(alice);
    uint256 outShares = a.pool.swapLiability(a.token, b.token, shares, 0, block.timestamp + 600);
    uint256 faceOut = outShares * a.pool.getAsset(b.token).liquidityIndexWad / 1e18;

    uint256 usdIn = faceIn * oracle.getFeed(feedId(a.sym)).mark1e18 / (10 ** IERC20(a.token).decimals());
    uint256 usdOut = faceOut * oracle.getFeed(feedId(b.sym)).mark1e18 / (10 ** IERC20(b.token).decimals());

    emit log_named_uint("shares in  ", shares);
    emit log_named_uint("shares out ", outShares);
    emit log_named_decimal_uint("face in (USD) ", usdIn, 18);
    emit log_named_decimal_uint("face out (USD)", usdOut, 18);

    assertLt(diffBps(usdOut, usdIn), 100, "the face must cross at the mark ratio, less the spread");
  }

  /// `minLpAmountOut` is a SHARE floor and it must bite. Quote it first with a zero-floor call on
  /// a snapshot, then re-run with the real floor: there is no `previewSwapLiability`.
  function test_shareFloorBites() public {
    (Leg memory a, Leg memory b) = _pair();
    uint256 shares = _lp(a, 5_000);

    uint256 snap = vm.snapshotState();
    vm.prank(alice);
    uint256 quoted = a.pool.swapLiability(a.token, b.token, shares, 0, block.timestamp + 600);
    vm.revertToState(snap);

    // Asking for more shares than the pool will mint has to revert.
    vm.prank(alice);
    vm.expectRevert();
    a.pool.swapLiability(a.token, b.token, shares, quoted * 2, block.timestamp + 600);

    // The honest floor clears.
    vm.prank(alice);
    uint256 got = a.pool.swapLiability(a.token, b.token, shares, quoted, block.timestamp + 600);
    assertGe(got, quoted);
  }

  /// A debt swap is round-trippable, minus whatever haircut the legs' coverage imposes each way.
  /// Round-tripping is not free, and a strategy that flips legs on every signal pays for it.
  ///
  /// Most of the printed cost below is NOT a fee. A position this size moves the destination
  /// leg's coverage, and the return trip then re-crosses a leg it has itself made worse. Size
  /// relative to the leg is the dominant term; read the number as impact, not as a tariff.
  function test_roundTripCostsTheHaircut() public {
    (Leg memory a, Leg memory b) = _pair();
    uint256 shares = _lp(a, 10_000);
    (uint256 valueStart,) = a.pool.previewWithdraw(a.token, shares);

    vm.prank(alice);
    uint256 mid = a.pool.swapLiability(a.token, b.token, shares, 0, block.timestamp + 600);

    // The shares the first leg just MINTED are themselves fresh, so the return trip is frozen for
    // another `flowCooldownSecs`. A flip-on-every-signal strategy pays the cooldown as well as the
    // haircut, and it cannot round-trip inside one block at all.
    warpPastCooldown(a.pool);

    vm.prank(alice);
    uint256 back = a.pool.swapLiability(b.token, a.token, mid, 0, block.timestamp + 600);

    (uint256 valueEnd,) = a.pool.previewWithdraw(a.token, back);
    assertLe(valueEnd, valueStart + 1, "a round trip must never create value");

    emit log_named_uint("value start", valueStart);
    emit log_named_uint("value end  ", valueEnd);
    emit log_named_uint("round-trip cost", valueStart > valueEnd ? valueStart - valueEnd : 0);
  }

  /// The cooldown, proven rather than left as a comment. A deposit and a debt swap in the same
  /// block revert, and the SAME call one window later goes through. This is the guard against
  /// deposit-flip-exit flow abuse, and it is the single most likely reason a first integration of
  /// `swapLiability` reverts on a pool that is otherwise perfectly healthy.
  function test_cooldownBlocksASameBlockDebtSwap() public {
    (Leg memory a, Leg memory b) = _pair();
    skipUnless(cooldownOf(a.pool) != 0, "the pool has the cooldown disabled");

    uint256 amount = unitsWorth(a.sym, 1_000);
    fund(a.token, amount, address(a.pool));
    vm.prank(alice);
    IPool.DepositResult memory r = a.pool.deposit(a.token, amount);
    uint256 shares = r.lpAmount - r.deadLp;

    vm.prank(alice);
    vm.expectRevert(IPool.CooldownActive.selector);
    a.pool.swapLiability(a.token, b.token, shares, 0, block.timestamp + 600);

    warpPastCooldown(a.pool);
    vm.prank(alice);
    uint256 out = a.pool.swapLiability(a.token, b.token, shares, 0, block.timestamp + 600);
    assertGt(out, 0, "the same call must clear once the window has elapsed");
  }

  /// Same leg in and out is not a debt swap. Rejected rather than treated as a no-op.
  function test_sameLegReverts() public {
    (Leg memory a,) = _pair();
    uint256 shares = _lp(a, 1_000);
    vm.prank(alice);
    vm.expectRevert();
    a.pool.swapLiability(a.token, a.token, shares, 0, block.timestamp + 600);
  }

  /// A leg the pool does not list has to revert.
  function test_unlistedLegReverts() public {
    (Leg memory a,) = _pair();
    uint256 shares = _lp(a, 1_000);
    address stray = address(new PlainToken());
    vm.prank(alice);
    vm.expectRevert();
    a.pool.swapLiability(a.token, stray, shares, 0, block.timestamp + 600);
  }

  /// An expired deadline reverts.
  function test_expiredDeadlineReverts() public {
    (Leg memory a, Leg memory b) = _pair();
    uint256 shares = _lp(a, 1_000);
    uint256 past = block.timestamp - 1;
    vm.prank(alice);
    vm.expectRevert();
    a.pool.swapLiability(a.token, b.token, shares, 0, past);
  }
}
