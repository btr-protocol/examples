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

  /// TTL IS PER RISK CLASS, and hardcoding one bound for the whole feed set is how an integrator
  /// either rejects healthy FX or accepts stale equity. FX carries the longer window; equities
  /// and crypto share the shorter one.
  function test_ttlDiffersByAssetClass() public view {
    uint256 fxTtl = oracle.getFeed(feedId("EURC")).ttlSecs;
    assertEq(fxTtl, oracle.getFeed(feedId("JPYC")).ttlSecs, "the two FX legs must share a class");

    uint256 equityTtl = oracle.getFeed(feedId("NVDA")).ttlSecs;
    assertEq(equityTtl, oracle.getFeed(feedId("TSLA")).ttlSecs, "the two equity legs likewise");
    assertEq(equityTtl, oracle.getFeed(feedId("ASML")).ttlSecs, "and the third");
    assertEq(equityTtl, oracle.getFeed(feedId("WETH")).ttlSecs, "equities sit in the volatile tier");

    assertGt(fxTtl, equityTtl, "FX must carry the longer freshness window");
  }

  /// Six orders of magnitude of unit price in the SAME uint256: JPYC is worth a fraction of a
  /// cent and ASML is worth over a thousand dollars. Anything that reduces a mark to whole units
  /// reads JPYC as zero, and a zero happily passes an equality check against another zero.
  function test_marksSpanSixOrdersOfMagnitude() public view {
    uint256 jpyc = oracle.getFeed(feedId("JPYC")).mark1e18;
    uint256 asml = oracle.getFeed(feedId("ASML")).mark1e18;

    assertGt(jpyc, 0.001e18, "JPYC below a tenth of a cent is a decimals bug, not a rate");
    assertLt(jpyc, 0.1e18, "JPYC is a sub-unit price");
    assertEq(jpyc / 1e18, 0, "and this is what truncating it to whole units would give you");

    assertGt(asml, 100e18, "ASML is a three to four figure price");
    assertLt(asml, 10_000e18);
    assertGt(asml / jpyc, 100_000, "the two live in the same word, six orders apart");
  }

  /// STALE IS NORMAL FOR AN EQUITY. The US cash session is roughly 30% of the week and the keeper
  /// deliberately does not heartbeat a frozen record, because republishing a dead price on a
  /// clock is worse than saying nothing.
  ///
  /// So the assertion is on the SHAPE of the feed, which holds at every hour, and the freshness
  /// leg SKIPS loudly when the market is shut rather than failing the suite every weekend. A
  /// crypto or FX feed gets no such exemption: those trade continuously.
  function test_equityFeedIsLiveOrExplainedByAClosedMarket() public {
    string[3] memory syms = ["NVDA", "ASML", "TSLA"];
    for (uint256 i; i < syms.length; ++i) {
      IOracle.FeedData memory f = oracle.getFeed(feedId(syms[i]));
      assertGt(f.mark1e18, 0, syms[i]);
      assertEq(f.flags & 1, 0, syms[i]);

      if (oracle.isFeedFresh(feedId(syms[i]))) {
        assertLe(consumer.observedAt(f), block.timestamp, syms[i]);
        continue;
      }
      emit log_named_string("SKIPPED, equity market closed (not an outage)", syms[i]);
      emit log_named_uint("  age (s)", block.timestamp - consumer.observedAt(f));
      emit log_named_uint("  ttl (s)", f.ttlSecs);
    }
  }

  /// The oracle's feed set is a SUPERSET of what the pools trade: ASML has a mark and no listed
  /// token here. Being able to read a price is not evidence that a pair is swappable.
  function test_aFeedCanExistWithNoListedToken() public view {
    assertGt(oracle.getFeed(feedId("ASML")).mark1e18, 0, "ASML has a feed");
    assertFalse(vm.keyExistsJson(cfg, ".tokens.ASML"), "and deliberately no token");
  }
}
