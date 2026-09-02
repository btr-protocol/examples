// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BTRForkTest} from "./BTRForkTest.sol";
import {IOracle} from "../src/interfaces/IBTR.sol";
import {OracleConsumer} from "../src/OracleConsumer.sol";

/**
 * Example 1, on chain: consuming BTR price feeds from a contract.
 *
 * Guide:    https://btr.markets/docs/5-1-5-consuming-price-feeds
 * Contract: ../src/OracleConsumer.sol
 * Off-chain twins: ../../typescript/sdk/01-oracle.ts, ../../typescript/rpc/01-oracle.ts
 *
 * Run: forge test --match-path 'test/01_*' -vv
 */
contract OracleConsumptionTest is BTRForkTest {
  OracleConsumer internal consumer;

  function setUp() public override {
    super.setUp();
    // 600s max age, 100bps max confidence interval, 100bps max disagreement between tiers.
    //
    // 600s is the shortest ttl in the live feed set, i.e. the PROTOCOL's own bound. A real
    // integration should pick something tighter than the protocol bound, because ttl is the
    // outer limit rather than your risk appetite. It is deliberately not tightened here: pushes
    // are edge triggered, so a 120s bound makes this test fail on a quiet market rather than on
    // a bug, and a test that red-flags a healthy chain teaches you to ignore it.
    consumer = new OracleConsumer(address(oracle), address(refOracle), 600, 100, 100);
  }

  /// The raw surface, so you can see what actually comes back before anything is done with it.
  function test_readRawFeed() public {
    IOracle.FeedData memory f = oracle.getFeed(feedId("WETH"));

    assertGt(f.mark1e18, 0, "zero mark is the STALE sentinel, not a price");
    assertGt(f.ttlSecs, 0, "unconfigured feed");
    assertEq(f.flags & 1, 0, "feed is paused");
    assertLe(consumer.observedAt(f), block.timestamp, "feed observed in the future");

    emit log_named_decimal_uint("WETH mark (USD)", f.mark1e18, 18);
    emit log_named_uint("sigmaPbps", f.sigmaPbps);
    emit log_named_uint("confidenceBps", f.confidenceBps);
    emit log_named_uint("age (s)", block.timestamp - consumer.observedAt(f));
  }

  /// The gated read. Everything a consumer should actually call.
  function test_gatedRead() public {
    uint256 mark = consumer.readMark(feedId("WETH"));
    assertGt(mark, 0);
    // Sanity band, not a price assertion: this test must not fail because ETH moved.
    assertGt(mark, 100e18, "implausibly low, decimals are wrong somewhere");
    assertLt(mark, 1_000_000e18, "implausibly high, decimals are wrong somewhere");
    emit log_named_decimal_uint("gated WETH mark", mark, 18);
  }

  /// Both tiers, required to agree. The reference tier is an independent second push.
  function test_twoTierAgreement() public {
    bytes32 id = feedId("WETH");
    uint256 agreed = consumer.readAgreedMark(id);
    uint256 p = oracle.getFeed(id).mark1e18;
    uint256 r = refOracle.getFeed(id).mark1e18;
    assertEq(agreed, p, "readAgreedMark returns the primary, never an average");
    emit log_named_decimal_uint("primary  ", p, 18);
    emit log_named_decimal_uint("reference", r, 18);
    emit log_named_uint("divergence (bps)", (p > r ? p - r : r - p) * 10_000 / r);
  }

  /// Freshness must fail closed. Warping past the bound is the only honest way to prove it: a
  /// consumer that never sees a stale feed in test has never had its gate exercised.
  function test_staleFeedReverts() public {
    bytes32 id = feedId("WETH");
    consumer.readMark(id); // fresh now
    vm.warp(block.timestamp + 1 hours);
    vm.expectRevert();
    consumer.readMark(id);
  }

  /// `flags & 1` is a guardian pause. Faked here with a storage-free override so the assertion
  /// does not depend on a feed happening to be paused on the live chain.
  function test_pausedFeedReverts() public {
    bytes32 id = feedId("WETH");
    IOracle.FeedData memory f = oracle.getFeed(id);
    f.flags = f.flags | 1;
    vm.mockCall(
      address(oracle), abi.encodeWithSelector(IOracle.getFeed.selector, id), abi.encode(f)
    );
    vm.expectRevert(abi.encodeWithSelector(OracleConsumer.PausedFeed.selector, id));
    consumer.readMark(id);
  }

  /// Two different "no price" cases, and they do NOT surface the same way.
  ///
  ///  - An id the oracle has never heard of reverts `FeedNotFound(bytes32)`. Verified here rather
  ///    than assumed: an earlier draft of this test asserted it returned zero, and it does not.
  ///  - A REGISTERED feed awaiting its first accepted push returns `mark1e18 == 0`. That is the
  ///    one a naive read turns into a division by zero, and the one `NoMark` catches.
  function test_unknownFeedReverts() public {
    bytes32 unknown = keccak256("no such feed");
    vm.expectRevert(abi.encodeWithSelector(IOracle.FeedNotFound.selector, unknown));
    oracle.getFeed(unknown);
  }

  function test_zeroMarkSentinelReverts() public {
    bytes32 id = feedId("WETH");
    IOracle.FeedData memory f = oracle.getFeed(id);
    f.mark1e18 = 0; // the sentinel a registered-but-unpushed feed carries
    vm.mockCall(
      address(oracle), abi.encodeWithSelector(IOracle.getFeed.selector, id), abi.encode(f)
    );
    vm.expectRevert(abi.encodeWithSelector(OracleConsumer.NoMark.selector, id));
    consumer.readMark(id);
  }

  /// Sizing off the confidence interval instead of the bare mark.
  function test_conservativeValueIsBelowRawValue() public {
    bytes32 id = feedId("WETH");
    uint256 amount = 1e18; // 1 WETH
    uint256 mark = consumer.readMark(id);
    uint256 conservative = consumer.conservativeValue(id, amount, 2);
    assertLe(conservative, amount * mark, "haircut must never inflate a position");
    emit log_named_decimal_uint("raw value  ", amount * mark / 1e18, 18);
    emit log_named_decimal_uint("2-sigma haircut value", conservative / 1e18, 18);
  }

  /// Stables and FX carry their own feeds too. Loops the configured set and asserts the whole
  /// surface is coherent, which is the check worth running against a live deployment.
  function test_everyPoolFeedIsSane() public {
    string[5] memory syms = ["USDT", "USDS", "EURC", "WETH", "WBTC"];
    for (uint256 i; i < syms.length; ++i) {
      IOracle.FeedData memory f = oracle.getFeed(feedId(syms[i]));
      assertGt(f.mark1e18, 0, syms[i]);
      assertEq(f.flags & 1, 0, syms[i]);
      assertTrue(oracle.isFeedFresh(feedId(syms[i])), syms[i]);
    }
  }
}
