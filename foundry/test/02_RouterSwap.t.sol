// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BTRForkTest} from "./BTRForkTest.sol";
import {IERC20, IPool, IRouter} from "../src/interfaces/IBTR.sol";

/**
 * Example 2, on chain: a multi-hop, multi-part route through the Router.
 *
 * Guide: https://btr.markets/docs/5-1-4-composability#2-routing-through-the-router
 * Off-chain twins: ../../typescript/sdk/02-router-swap.ts, ../../typescript/rpc/02-router-swap.ts
 *
 * WHAT THE ROUTER IS. An executor, not a route finder. You bring the path; it runs the whole
 * thing atomically and enforces one end-to-end promise. Without it a multi-hop is N approvals,
 * N signatures and N transactions, and a revert on leg 2 strands you holding an intermediate
 * asset you never asked for.
 *
 * THE THREE RULES THAT TRIP PEOPLE UP:
 *   1. Floors are END TO END, keyed by OUTPUT TOKEN, checked ONCE after every part has run. There
 *      is no per-hop floor, deliberately: a per-hop floor makes each hop spend the previous hop's
 *      floor instead of its actual output, so tolerances compound and a two-hop route rejects
 *      itself on a market that has not moved.
 *   2. Parts run IN ORDER but do NOT feed each other. `parts` is a list of independent paths, for
 *      splitting one input across routes, spending two different inputs, or both.
 *   3. EVERY part's terminal token needs a floor entry, and each token may appear ONCE. An
 *      unclaimed output reverts `UnclaimedOutput`; a duplicated one reverts `DuplicateFloor`.
 *
 * Run: forge test --match-path 'test/02_*' -vv
 */
contract RouterSwapTest is BTRForkTest {
  uint256 constant SLIPPAGE_BPS = 100;
  string constant NO_ROUTE = "needs two pools sharing a base, one with two non-base legs";

  /// @dev Legs for the multi-pool routes: `a` and `a2` in one pool, `b` in another. Skips when the
  ///      chain has no such shape, or when a leg is gated to an allowlist `alice` is not on (the
  ///      reverts below would then pass for the wrong reason).
  function _route() internal returns (Leg memory a, Leg memory a2, Leg memory b) {
    bool ok;
    (a, a2, b, ok) = routeSet();
    skipUnless(ok, NO_ROUTE);
    skipIfSwapGated(a);
    skipIfSwapGated(a2);
    skipIfSwapGated(b);
  }

  /// @dev One leg for the single-pool routes.
  function _leg() internal returns (Leg memory l) {
    bool ok;
    (l, ok) = demoLeg();
    skipUnless(ok, "no pool holds a non-base leg");
    skipIfSwapGated(l);
  }

  function test_routerIsWiredToTheOfficialFactory() public view {
    assertEq(router.factory(), addr(".contracts.poolFactory"), "router points at a foreign factory");
  }

  /// TWO HOPS ACROSS TWO POOLS: a -> (pool 1) -> base -> (pool 2) -> b.
  ///
  /// Neither pool holds both ends. The base is shared, so the route is only expressible as a
  /// chain, and doing it by hand would be two approvals and two signatures with an unhedged
  /// base position in between.
  function test_twoHopAcrossTwoPools() public {
    (Leg memory a,, Leg memory b) = _route();
    uint256 amountIn = unitsWorth(a.sym, 2_000);
    fund(a.token, amountIn, address(router));

    // Quote each leg off chain (here: off contract) and chain them. This is exactly what a route
    // finder produces, and why route selection does not belong on chain: it is a search.
    uint256 mid = a.pool.getSwapQuote(a.token, base, amountIn).amountOut;
    uint256 expected = b.pool.getSwapQuote(base, b.token, mid).amountOut;
    assertGt(expected, 0, "a zero quote is a failure, not a price");

    IRouter.Hop[] memory hops = new IRouter.Hop[](2);
    hops[0] = IRouter.Hop({pool: address(a.pool), tokenOut: base});
    hops[1] = IRouter.Hop({pool: address(b.pool), tokenOut: b.token});

    IRouter.Part[] memory parts = new IRouter.Part[](1);
    parts[0] = IRouter.Part({tokenIn: a.token, amountIn: amountIn, hops: hops});

    IRouter.Floor[] memory floors = new IRouter.Floor[](1);
    floors[0] =
      IRouter.Floor({token: b.token, minOut: expected * (10_000 - SLIPPAGE_BPS) / 10_000});

    vm.prank(alice);
    uint256[] memory received = router.swap(parts, floors, alice, block.timestamp + 600);

    assertEq(received.length, 1);
    assertEq(received[0], IERC20(b.token).balanceOf(alice), "receipt must match what arrived");
    assertGe(received[0], floors[0].minOut);
    assertEq(IERC20(base).balanceOf(alice), 0, "the intermediate must never reach the recipient");
    assertEq(IERC20(base).balanceOf(address(router)), 0, "router must not retain the middle leg");

    emit log_named_uint(string.concat(a.sym, " in      "), amountIn);
    emit log_named_uint(string.concat(baseSym, " (mid)"), mid);
    emit log_named_uint(string.concat(b.sym, " out     "), received[0]);
  }

  /// TWO PARTS, TWO INPUTS, TWO OUTPUT TOKENS, ONE SIGNATURE.
  /// Part A: a  -> base -> b   (2 hops, 2 pools)
  /// Part B: a2 -> base        (1 hop)
  /// Note the floor set: b is part A's terminal, the base is part B's. The base that part A
  /// produced is NOT claimable, because part A consumed it in its second hop.
  function test_multiPartSplitWithTwoOutputTokens() public {
    (Leg memory a, Leg memory a2, Leg memory b) = _route();
    uint256 inA = unitsWorth(a.sym, 1_000);
    uint256 inB = unitsWorth(a2.sym, 1_000);
    fund(a.token, inA, address(router));
    fund(a2.token, inB, address(router));

    uint256 midA = a.pool.getSwapQuote(a.token, base, inA).amountOut;
    uint256 expectFar = b.pool.getSwapQuote(base, b.token, midA).amountOut;
    uint256 expectBase = a.pool.getSwapQuote(a2.token, base, inB).amountOut;

    IRouter.Hop[] memory hopsA = new IRouter.Hop[](2);
    hopsA[0] = IRouter.Hop({pool: address(a.pool), tokenOut: base});
    hopsA[1] = IRouter.Hop({pool: address(b.pool), tokenOut: b.token});

    IRouter.Hop[] memory hopsB = new IRouter.Hop[](1);
    hopsB[0] = IRouter.Hop({pool: address(a.pool), tokenOut: base});

    IRouter.Part[] memory parts = new IRouter.Part[](2);
    parts[0] = IRouter.Part({tokenIn: a.token, amountIn: inA, hops: hopsA});
    parts[1] = IRouter.Part({tokenIn: a2.token, amountIn: inB, hops: hopsB});

    IRouter.Floor[] memory floors = new IRouter.Floor[](2);
    floors[0] = IRouter.Floor({token: b.token, minOut: expectFar * 99 / 100});
    floors[1] = IRouter.Floor({token: base, minOut: expectBase * 99 / 100});

    vm.prank(alice);
    uint256[] memory received = router.swap(parts, floors, alice, block.timestamp + 600);

    assertGe(received[0], floors[0].minOut, "far leg short");
    assertGe(received[1], floors[1].minOut, "base short");
    assertEq(IERC20(b.token).balanceOf(alice), received[0]);
    assertEq(IERC20(base).balanceOf(alice), received[1]);

    emit log_named_uint("part A: far leg out", received[0]);
    emit log_named_uint("part B: base out   ", received[1]);
  }

  /// A part whose terminal token has no floor entry reverts. The proceeds would otherwise sit in
  /// the router with nobody entitled to them: a silent loss that looks like a successful swap.
  function test_unclaimedOutputReverts() public {
    Leg memory l = _leg();
    uint256 amountIn = unitsWorth(l.sym, 100);
    fund(l.token, amountIn, address(router));

    IRouter.Hop[] memory hops = new IRouter.Hop[](1);
    hops[0] = IRouter.Hop({pool: address(l.pool), tokenOut: base});
    IRouter.Part[] memory parts = new IRouter.Part[](1);
    parts[0] = IRouter.Part({tokenIn: l.token, amountIn: amountIn, hops: hops});
    IRouter.Floor[] memory floors = new IRouter.Floor[](1);
    floors[0] = IRouter.Floor({token: l.token, minOut: 0}); // wrong token

    vm.prank(alice);
    vm.expectRevert();
    router.swap(parts, floors, alice, block.timestamp + 600);
  }

  /// One entry per output token. Splitting a single promise over two entries reads a gain of
  /// zero on the second and rejects a route that filled perfectly, so it is refused up front.
  function test_duplicateFloorReverts() public {
    Leg memory l = _leg();
    uint256 amountIn = unitsWorth(l.sym, 100);
    fund(l.token, amountIn, address(router));

    IRouter.Hop[] memory hops = new IRouter.Hop[](1);
    hops[0] = IRouter.Hop({pool: address(l.pool), tokenOut: base});
    IRouter.Part[] memory parts = new IRouter.Part[](1);
    parts[0] = IRouter.Part({tokenIn: l.token, amountIn: amountIn, hops: hops});
    IRouter.Floor[] memory floors = new IRouter.Floor[](2);
    floors[0] = IRouter.Floor({token: base, minOut: 0});
    floors[1] = IRouter.Floor({token: base, minOut: 0});

    vm.prank(alice);
    vm.expectRevert();
    router.swap(parts, floors, alice, block.timestamp + 600);
  }

  /// The floor is the whole protection. An unreachable one must revert the entire route, not
  /// deliver part of it.
  function test_floorBitesAcrossTheWholePath() public {
    (Leg memory a,, Leg memory b) = _route();
    uint256 amountIn = unitsWorth(a.sym, 1_000);
    fund(a.token, amountIn, address(router));

    uint256 mid = a.pool.getSwapQuote(a.token, base, amountIn).amountOut;
    uint256 expected = b.pool.getSwapQuote(base, b.token, mid).amountOut;

    IRouter.Hop[] memory hops = new IRouter.Hop[](2);
    hops[0] = IRouter.Hop({pool: address(a.pool), tokenOut: base});
    hops[1] = IRouter.Hop({pool: address(b.pool), tokenOut: b.token});
    IRouter.Part[] memory parts = new IRouter.Part[](1);
    parts[0] = IRouter.Part({tokenIn: a.token, amountIn: amountIn, hops: hops});
    IRouter.Floor[] memory floors = new IRouter.Floor[](1);
    floors[0] = IRouter.Floor({token: b.token, minOut: expected * 2});

    vm.prank(alice);
    vm.expectRevert();
    router.swap(parts, floors, alice, block.timestamp + 600);

    assertEq(IERC20(a.token).balanceOf(alice), amountIn, "a reverted route must leave the input intact");
  }

  /// Pools are checked against the factory registry. The router approves whatever address it is
  /// handed, so an arbitrary one could take the allowance and keep it.
  function test_unknownPoolReverts() public {
    Leg memory l = _leg();
    uint256 amountIn = unitsWorth(l.sym, 100);
    fund(l.token, amountIn, address(router));

    IRouter.Hop[] memory hops = new IRouter.Hop[](1);
    hops[0] = IRouter.Hop({pool: makeAddr("not a pool"), tokenOut: base});
    IRouter.Part[] memory parts = new IRouter.Part[](1);
    parts[0] = IRouter.Part({tokenIn: l.token, amountIn: amountIn, hops: hops});
    IRouter.Floor[] memory floors = new IRouter.Floor[](1);
    floors[0] = IRouter.Floor({token: base, minOut: 0});

    vm.prank(alice);
    vm.expectRevert();
    router.swap(parts, floors, alice, block.timestamp + 600);
  }

  /// Routing a single hop through the Router costs more gas than calling the pool. Measured, not
  /// asserted as a rule: the Router earns its keep on 2+ hops and on splits.
  function test_singleHopIsCheaperDirect() public {
    Leg memory l = _leg();
    uint256 amountIn = unitsWorth(l.sym, 500);

    fund(l.token, amountIn, address(router));
    IRouter.Hop[] memory hops = new IRouter.Hop[](1);
    hops[0] = IRouter.Hop({pool: address(l.pool), tokenOut: base});
    IRouter.Part[] memory parts = new IRouter.Part[](1);
    parts[0] = IRouter.Part({tokenIn: l.token, amountIn: amountIn, hops: hops});
    IRouter.Floor[] memory floors = new IRouter.Floor[](1);
    floors[0] = IRouter.Floor({token: base, minOut: 0});

    uint256 snap = vm.snapshotState();
    vm.prank(alice);
    uint256 g0 = gasleft();
    router.swap(parts, floors, alice, block.timestamp + 600);
    uint256 viaRouter = g0 - gasleft();

    vm.revertToState(snap);
    vm.prank(alice);
    IERC20(l.token).approve(address(l.pool), type(uint256).max);
    vm.prank(alice);
    g0 = gasleft();
    l.pool.swap_qe(l.token, base, amountIn, 0, alice, block.timestamp + 600);
    uint256 direct = g0 - gasleft();

    emit log_named_uint("gas via router", viaRouter);
    emit log_named_uint("gas direct    ", direct);
    assertGt(viaRouter, direct, "a single hop through the router should cost more, not less");
  }
}
