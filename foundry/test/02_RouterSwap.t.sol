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

  function test_routerIsWiredToTheOfficialFactory() public view {
    assertEq(router.factory(), addr(".contracts.poolFactory"), "router points at a foreign factory");
  }

  /// TWO HOPS ACROSS TWO POOLS: USDT -> (stable pool) -> USDCB -> (crypto pool) -> WETH.
  ///
  /// Neither pool holds both ends. USDCB is the shared base, so the route is only expressible as
  /// a chain, and doing it by hand would be two approvals and two signatures with an unhedged
  /// USDCB position in between.
  function test_twoHopAcrossTwoPools() public {
    uint256 amountIn = units(USDT, 2_000);
    fund(USDT, amountIn, address(router));

    // Quote each leg off chain (here: off contract) and chain them. This is exactly what a route
    // finder produces, and why route selection does not belong on chain: it is a search.
    uint256 mid = stablePool.getSwapQuote(USDT, USDCB, amountIn).amountOut;
    uint256 expected = cryptoPool.getSwapQuote(USDCB, WETH, mid).amountOut;
    assertGt(expected, 0, "a zero quote is a failure, not a price");

    IRouter.Hop[] memory hops = new IRouter.Hop[](2);
    hops[0] = IRouter.Hop({pool: address(stablePool), tokenOut: USDCB});
    hops[1] = IRouter.Hop({pool: address(cryptoPool), tokenOut: WETH});

    IRouter.Part[] memory parts = new IRouter.Part[](1);
    parts[0] = IRouter.Part({tokenIn: USDT, amountIn: amountIn, hops: hops});

    IRouter.Floor[] memory floors = new IRouter.Floor[](1);
    floors[0] =
      IRouter.Floor({token: WETH, minOut: expected * (10_000 - SLIPPAGE_BPS) / 10_000});

    vm.prank(alice);
    uint256[] memory received = router.swap(parts, floors, alice, block.timestamp + 600);

    assertEq(received.length, 1);
    assertEq(received[0], IERC20(WETH).balanceOf(alice), "receipt must match what arrived");
    assertGe(received[0], floors[0].minOut);
    assertEq(IERC20(USDCB).balanceOf(alice), 0, "the intermediate must never reach the recipient");
    assertEq(IERC20(USDCB).balanceOf(address(router)), 0, "router must not retain the middle leg");

    emit log_named_uint("USDT in      ", amountIn);
    emit log_named_uint("USDCB (mid)  ", mid);
    emit log_named_uint("WETH out     ", received[0]);
  }

  /// TWO PARTS, TWO INPUTS, TWO OUTPUT TOKENS, ONE SIGNATURE.
  /// Part A: USDT -> USDCB -> WETH   (2 hops, 2 pools)
  /// Part B: USDS -> USDCB           (1 hop)
  /// Note the floor set: WETH is part A's terminal, USDCB is part B's. The USDCB that part A
  /// produced is NOT claimable, because part A consumed it in its second hop.
  function test_multiPartSplitWithTwoOutputTokens() public {
    uint256 inA = units(USDT, 1_000);
    uint256 inB = units(USDS, 1_000);
    fund(USDT, inA, address(router));
    fund(USDS, inB, address(router));

    uint256 midA = stablePool.getSwapQuote(USDT, USDCB, inA).amountOut;
    uint256 expectWeth = cryptoPool.getSwapQuote(USDCB, WETH, midA).amountOut;
    uint256 expectUsdcb = stablePool.getSwapQuote(USDS, USDCB, inB).amountOut;

    IRouter.Hop[] memory hopsA = new IRouter.Hop[](2);
    hopsA[0] = IRouter.Hop({pool: address(stablePool), tokenOut: USDCB});
    hopsA[1] = IRouter.Hop({pool: address(cryptoPool), tokenOut: WETH});

    IRouter.Hop[] memory hopsB = new IRouter.Hop[](1);
    hopsB[0] = IRouter.Hop({pool: address(stablePool), tokenOut: USDCB});

    IRouter.Part[] memory parts = new IRouter.Part[](2);
    parts[0] = IRouter.Part({tokenIn: USDT, amountIn: inA, hops: hopsA});
    parts[1] = IRouter.Part({tokenIn: USDS, amountIn: inB, hops: hopsB});

    IRouter.Floor[] memory floors = new IRouter.Floor[](2);
    floors[0] = IRouter.Floor({token: WETH, minOut: expectWeth * 99 / 100});
    floors[1] = IRouter.Floor({token: USDCB, minOut: expectUsdcb * 99 / 100});

    vm.prank(alice);
    uint256[] memory received = router.swap(parts, floors, alice, block.timestamp + 600);

    assertGe(received[0], floors[0].minOut, "WETH short");
    assertGe(received[1], floors[1].minOut, "USDCB short");
    assertEq(IERC20(WETH).balanceOf(alice), received[0]);
    assertEq(IERC20(USDCB).balanceOf(alice), received[1]);

    emit log_named_uint("part A: WETH out ", received[0]);
    emit log_named_uint("part B: USDCB out", received[1]);
  }

  /// A part whose terminal token has no floor entry reverts. The proceeds would otherwise sit in
  /// the router with nobody entitled to them: a silent loss that looks like a successful swap.
  function test_unclaimedOutputReverts() public {
    uint256 amountIn = units(USDT, 100);
    fund(USDT, amountIn, address(router));

    IRouter.Hop[] memory hops = new IRouter.Hop[](1);
    hops[0] = IRouter.Hop({pool: address(stablePool), tokenOut: USDCB});
    IRouter.Part[] memory parts = new IRouter.Part[](1);
    parts[0] = IRouter.Part({tokenIn: USDT, amountIn: amountIn, hops: hops});
    IRouter.Floor[] memory floors = new IRouter.Floor[](1);
    floors[0] = IRouter.Floor({token: WETH, minOut: 0}); // wrong token

    vm.prank(alice);
    vm.expectRevert();
    router.swap(parts, floors, alice, block.timestamp + 600);
  }

  /// One entry per output token. Splitting a single promise over two entries reads a gain of
  /// zero on the second and rejects a route that filled perfectly, so it is refused up front.
  function test_duplicateFloorReverts() public {
    uint256 amountIn = units(USDT, 100);
    fund(USDT, amountIn, address(router));

    IRouter.Hop[] memory hops = new IRouter.Hop[](1);
    hops[0] = IRouter.Hop({pool: address(stablePool), tokenOut: USDCB});
    IRouter.Part[] memory parts = new IRouter.Part[](1);
    parts[0] = IRouter.Part({tokenIn: USDT, amountIn: amountIn, hops: hops});
    IRouter.Floor[] memory floors = new IRouter.Floor[](2);
    floors[0] = IRouter.Floor({token: USDCB, minOut: 0});
    floors[1] = IRouter.Floor({token: USDCB, minOut: 0});

    vm.prank(alice);
    vm.expectRevert();
    router.swap(parts, floors, alice, block.timestamp + 600);
  }

  /// The floor is the whole protection. An unreachable one must revert the entire route, not
  /// deliver part of it.
  function test_floorBitesAcrossTheWholePath() public {
    uint256 amountIn = units(USDT, 1_000);
    fund(USDT, amountIn, address(router));

    uint256 mid = stablePool.getSwapQuote(USDT, USDCB, amountIn).amountOut;
    uint256 expected = cryptoPool.getSwapQuote(USDCB, WETH, mid).amountOut;

    IRouter.Hop[] memory hops = new IRouter.Hop[](2);
    hops[0] = IRouter.Hop({pool: address(stablePool), tokenOut: USDCB});
    hops[1] = IRouter.Hop({pool: address(cryptoPool), tokenOut: WETH});
    IRouter.Part[] memory parts = new IRouter.Part[](1);
    parts[0] = IRouter.Part({tokenIn: USDT, amountIn: amountIn, hops: hops});
    IRouter.Floor[] memory floors = new IRouter.Floor[](1);
    floors[0] = IRouter.Floor({token: WETH, minOut: expected * 2});

    vm.prank(alice);
    vm.expectRevert();
    router.swap(parts, floors, alice, block.timestamp + 600);

    assertEq(IERC20(USDT).balanceOf(alice), amountIn, "a reverted route must leave the input intact");
  }

  /// Pools are checked against the factory registry. The router approves whatever address it is
  /// handed, so an arbitrary one could take the allowance and keep it.
  function test_unknownPoolReverts() public {
    uint256 amountIn = units(USDT, 100);
    fund(USDT, amountIn, address(router));

    IRouter.Hop[] memory hops = new IRouter.Hop[](1);
    hops[0] = IRouter.Hop({pool: makeAddr("not a pool"), tokenOut: USDCB});
    IRouter.Part[] memory parts = new IRouter.Part[](1);
    parts[0] = IRouter.Part({tokenIn: USDT, amountIn: amountIn, hops: hops});
    IRouter.Floor[] memory floors = new IRouter.Floor[](1);
    floors[0] = IRouter.Floor({token: USDCB, minOut: 0});

    vm.prank(alice);
    vm.expectRevert();
    router.swap(parts, floors, alice, block.timestamp + 600);
  }

  /// Routing a single hop through the Router costs more gas than calling the pool. Measured, not
  /// asserted as a rule: the Router earns its keep on 2+ hops and on splits.
  function test_singleHopIsCheaperDirect() public {
    uint256 amountIn = units(USDT, 500);

    fund(USDT, amountIn, address(router));
    IRouter.Hop[] memory hops = new IRouter.Hop[](1);
    hops[0] = IRouter.Hop({pool: address(stablePool), tokenOut: USDCB});
    IRouter.Part[] memory parts = new IRouter.Part[](1);
    parts[0] = IRouter.Part({tokenIn: USDT, amountIn: amountIn, hops: hops});
    IRouter.Floor[] memory floors = new IRouter.Floor[](1);
    floors[0] = IRouter.Floor({token: USDCB, minOut: 0});

    uint256 snap = vm.snapshotState();
    vm.prank(alice);
    uint256 g0 = gasleft();
    router.swap(parts, floors, alice, block.timestamp + 600);
    uint256 viaRouter = g0 - gasleft();

    vm.revertToState(snap);
    vm.prank(alice);
    IERC20(USDT).approve(address(stablePool), type(uint256).max);
    vm.prank(alice);
    g0 = gasleft();
    stablePool.swap_qe(USDT, USDCB, amountIn, 0, alice, block.timestamp + 600);
    uint256 direct = g0 - gasleft();

    emit log_named_uint("gas via router", viaRouter);
    emit log_named_uint("gas direct    ", direct);
    assertGt(viaRouter, direct, "a single hop through the router should cost more, not less");
  }
}
