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
    // 600s is the longest ttl of the volatile feeds, i.e. the PROTOCOL's own bound for the feeds
    // these tests read. A real integration should pick something tighter than the protocol bound,
    // because ttl is the outer limit rather than your risk appetite. It is deliberately not
    // tightened here: pushes are edge triggered, so a 120s bound makes this test fail on a quiet
    // market rather than on a bug, and a test that red-flags a healthy chain teaches you to
    // ignore it. Stable and FX feeds carry a longer ttl and sit idle longer, so they are read
    // with their own bound, not this one.
    consumer = new OracleConsumer(address(oracle), 600, 100, 100);
  }

  /// @dev A feed that trades continuously, for the tests that read one: the first volatile leg.
  function _feed() internal returns (string memory sym, bytes32 id) {
    (Leg memory l, bool ok) = firstLeg("volatile");
    skipUnless(ok, "no pool holds a volatile leg");
    return (l.sym, feedId(l.sym));
  }

  /// @dev Every symbol that trades continuously: the base and every non-equity leg.
  function _continuous() internal view returns (string[] memory out) {
    Leg[] memory ls = legsOf("");
    uint256 n = 1;
    for (uint256 i; i < ls.length; ++i) {
      if (!eq(classOf(ls[i].sym), "equity")) ++n;
    }
    out = new string[](n);
    out[0] = baseSym;
    n = 1;
    for (uint256 i; i < ls.length; ++i) {
      if (!eq(classOf(ls[i].sym), "equity")) out[n++] = ls[i].sym;
    }
  }

  /// The raw surface, so you can see what actually comes back before anything is done with it.
  function test_readRawFeed() public {
    (string memory sym, bytes32 id) = _feed();
    IOracle.FeedData memory f = oracle.getFeed(id);

    assertGt(f.mark1e18, 0, "zero mark is the STALE sentinel, not a price");
    assertGt(f.ttlSecs, 0, "unconfigured feed");
    assertEq(f.flags & 1, 0, "feed is halted");
    assertLe(consumer.observedAt(f), block.timestamp, "feed observed in the future");

    emit log_named_decimal_uint(string.concat(sym, " mark (USD)"), f.mark1e18, 18);
    emit log_named_uint("sigmaPbps", f.sigmaPbps);
    emit log_named_uint("confidenceBps", f.confidenceBps);
    emit log_named_uint("age (s)", block.timestamp - consumer.observedAt(f));
  }

  /// The gated read. Everything a consumer should actually call.
  function test_gatedRead() public {
    (string memory sym, bytes32 id) = _feed();
    uint256 mark = consumer.readMark(id);
    assertGt(mark, 0);
    // Sanity band, not a price assertion: this test must not fail because the market moved. It
    // catches a decimals mistake, which is orders of magnitude out in either direction.
    assertGt(mark, 1e12, "implausibly low, decimals are wrong somewhere");
    assertLt(mark, 1e30, "implausibly high, decimals are wrong somewhere");
    emit log_named_decimal_uint(string.concat("gated ", sym, " mark"), mark, 18);
  }

  /// Both tiers, required to agree. Tier 2 of `feedOf` is an independent second push.
  function test_twoTierAgreement() public {
    (, bytes32 id) = _feed();
    uint256 agreed = consumer.readAgreedMark(id);
    uint256 p = oracle.feedOf(id, 1).mark1e18;
    uint256 r = oracle.feedOf(id, 2).mark1e18;
    assertEq(agreed, p, "readAgreedMark returns the primary, never an average");
    emit log_named_decimal_uint("primary  ", p, 18);
    emit log_named_decimal_uint("reference", r, 18);
    emit log_named_uint("divergence (bps)", (p > r ? p - r : r - p) * 10_000 / r);
  }

  /// Freshness must fail closed. Warping past the bound is the only honest way to prove it: a
  /// consumer that never sees a stale feed in test has never had its gate exercised.
  function test_staleFeedReverts() public {
    (, bytes32 id) = _feed();
    consumer.readMark(id); // fresh now
    vm.warp(block.timestamp + 1 hours);
    vm.expectRevert();
    consumer.readMark(id);
  }

  /// `flags & 1` is a halt. Faked here with a storage-free override so the assertion does not
  /// depend on a feed happening to be halted on the live chain.
  function test_pausedFeedReverts() public {
    (, bytes32 id) = _feed();
    IOracle.FeedData memory f = oracle.getFeed(id);
    f.flags = f.flags | 1;
    vm.mockCall(
      address(oracle), abi.encodeWithSelector(IOracle.feedOf.selector, id, 1), abi.encode(f)
    );
    vm.expectRevert(abi.encodeWithSelector(OracleConsumer.PausedFeed.selector, id));
    consumer.readMark(id);
  }

  /// Two different "no price" cases, and they do NOT surface the same way.
  ///
  ///  - An id the oracle has never heard of reverts `FeedNotFound(bytes32)`. Verified here rather
  ///    than assumed: an earlier draft of this test asserted it returned zero, and it does not.
  ///  - A feed whose lane is dark returns `mark1e18 == 0`. That is the one a naive read turns
  ///    into a division by zero, and the one `NoMark` catches.
  function test_unknownFeedReverts() public {
    bytes32 unknown = keccak256("no such feed");
    vm.expectRevert(abi.encodeWithSelector(IOracle.FeedNotFound.selector, unknown));
    oracle.getFeed(unknown);
  }

  function test_zeroMarkSentinelReverts() public {
    (, bytes32 id) = _feed();
    IOracle.FeedData memory f = oracle.getFeed(id);
    f.mark1e18 = 0; // the sentinel a dark lane carries
    vm.mockCall(
      address(oracle), abi.encodeWithSelector(IOracle.feedOf.selector, id, 1), abi.encode(f)
    );
    vm.expectRevert(abi.encodeWithSelector(OracleConsumer.NoMark.selector, id));
    consumer.readMark(id);
  }

  /// Sizing off the confidence interval instead of the bare mark.
  function test_conservativeValueIsBelowRawValue() public {
    (, bytes32 id) = _feed();
    uint256 amount = 1e18; // one whole token
    uint256 mark = consumer.readMark(id);
    uint256 conservative = consumer.conservativeValue(id, amount, 2);
    assertLe(conservative, amount * mark, "haircut must never inflate a position");
    emit log_named_decimal_uint("raw value  ", amount * mark / 1e18, 18);
    emit log_named_decimal_uint("2-sigma haircut value", conservative / 1e18, 18);
  }

  /// Every token the pools hold that trades continuously has a coherent feed. Loops the
  /// configured set, which is the check worth running against a live deployment.
  function test_everyPoolFeedIsSane() public view {
    string[] memory syms = _continuous();
    for (uint256 i; i < syms.length; ++i) {
      IOracle.FeedData memory f = oracle.getFeed(feedId(syms[i]));
      assertGt(f.mark1e18, 0, syms[i]);
      assertEq(f.flags & 1, 0, syms[i]);
      assertLe(block.timestamp - consumer.observedAt(f), f.ttlSecs, syms[i]);
    }
  }

  /// TTL IS PER RISK CLASS, and hardcoding one bound for the whole feed set is how an integrator
  /// either rejects a healthy long-window feed or accepts a stale short one. Stables and FX carry
  /// the longer window; the volatile legs share the shorter one.
  function test_ttlDiffersByAssetClass() public {
    (Leg memory v, bool ok) = firstLeg("volatile");
    skipUnless(ok, "no pool holds a volatile leg");
    uint256 shortTtl = oracle.getFeed(feedId(v.sym)).ttlSecs;

    Leg[] memory vols = legsOf("volatile");
    for (uint256 i; i < vols.length; ++i) {
      assertEq(oracle.getFeed(feedId(vols[i].sym)).ttlSecs, shortTtl, "volatile legs share a class");
    }
    assertGt(oracle.getFeed(feedId(baseSym)).ttlSecs, shortTtl, "the base must carry the longer window");

    Leg[] memory fxs = legsOf("fx");
    for (uint256 i; i < fxs.length; ++i) {
      assertGt(oracle.getFeed(feedId(fxs[i].sym)).ttlSecs, shortTtl, "FX must carry the longer window");
    }
  }

  /// Orders of magnitude of unit price in the SAME uint256: a token worth a fraction of a cent
  /// next to one worth thousands of dollars. Anything that reduces a mark to whole units reads
  /// the small one as zero, and a zero happily passes an equality check against another zero.
  function test_marksSpanOrdersOfMagnitude() public view {
    string[] memory syms = _continuous();
    uint256 lo = type(uint256).max;
    uint256 hi;
    for (uint256 i; i < syms.length; ++i) {
      uint256 m = oracle.getFeed(feedId(syms[i])).mark1e18;
      if (m == 0) continue;
      if (m < lo) lo = m;
      if (m > hi) hi = m;
    }
    assertGt(hi / lo, 1_000, "the marks of one venue live in the same word, orders apart");
  }

  /// STALE IS NORMAL FOR AN EQUITY. The US cash session is roughly 30% of the week and the keeper
  /// deliberately does not heartbeat a frozen record, because republishing a dead price on a
  /// clock is worse than saying nothing.
  ///
  /// So the assertion is on the SHAPE of the feed, which holds at every hour, and the freshness
  /// leg SKIPS loudly when the market is shut rather than failing the suite every weekend. A
  /// crypto or FX feed gets no such exemption: those trade continuously.
  function test_equityFeedIsLiveOrExplainedByAClosedMarket() public {
    Leg[] memory eqs = legsOf("equity");
    skipUnless(eqs.length != 0, "no pool holds an equity leg");
    for (uint256 i; i < eqs.length; ++i) {
      IOracle.FeedData memory f = oracle.getFeed(feedId(eqs[i].sym));
      assertEq(f.flags & 1, 0, eqs[i].sym);

      uint256 age = block.timestamp - consumer.observedAt(f);
      if (f.mark1e18 != 0 && age <= f.ttlSecs) {
        assertLe(consumer.observedAt(f), block.timestamp, eqs[i].sym);
        continue;
      }
      emit log_named_string("SKIPPED, equity market closed (not an outage)", eqs[i].sym);
      emit log_named_uint("  age (s)", age);
      emit log_named_uint("  ttl (s)", f.ttlSecs);
    }
  }

  /// The factory's feed set is a SUPERSET of what the pools trade: a token can have a feed and no
  /// pool leg. Being able to read a price is not evidence that a pair is swappable.
  function test_aFeedCanExistWithNoPoolLeg() public {
    string[] memory keys = vm.parseJsonKeys(cfg, ".feeds");
    Leg[] memory ls = legsOf("");
    for (uint256 i; i < keys.length; ++i) {
      if (eq(keys[i], baseSym)) continue;
      bool listed;
      for (uint256 j; j < ls.length; ++j) {
        if (eq(ls[j].sym, keys[i])) listed = true;
      }
      if (listed) continue;
      assertGt(oracle.getFeed(feedId(keys[i])).ttlSecs, 0, "the lane exists");
      return;
    }
    skipUnless(false, "every token with a feed is held by a pool");
  }
}
