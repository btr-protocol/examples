// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOracle} from "./interfaces/IBTR.sol";

/**
 * @title OracleConsumer
 * @notice A contract that prices collateral off a BTR feed, the safe way.
 * @dev    Guide: https://btr.markets/docs/5-1-5-consuming-price-feeds
 *         Example: https://github.com/btr-protocol/examples/blob/main/foundry/src/OracleConsumer.sol
 *
 * The oracle is the PoolFactory. `feedOf(feedId, 1)` is the primary tier and `feedOf(feedId, 2)`
 * the reference tier, both from the same contract.
 *
 * The whole point of this file is the four checks in `_check`. A read that takes `mark1e18`
 * and stops is wrong in four distinct ways, and each one has its own revert here:
 *
 *   1. ZERO IS NOT A PRICE. `mark1e18 == 0` is the stale sentinel a dark or halted lane carries.
 *      Divide by it and you brick; treat it as free money and you get drained.
 *   2. FRESHNESS IS AGE AGAINST `ttlSecs`. The pools revert once `block.timestamp - updatedAtSecs`
 *      exceeds the feed's own `ttlSecs`, so a consumer that skips the check prices off a mark the
 *      pools themselves would refuse. `sourceTsMs` is `updatedAtSecs` in ms, not a second clock.
 *   3. `flags & 1` IS A HALT, AND IT MEANS STOP. A guardian sets it when a feed is suspect.
 *      Consuming a halted mark is consuming the exact number somebody just decided not to trust.
 *   4. A MARK IS A DISTRIBUTION, NOT A NUMBER. `confidenceBps` is its one-sigma interval and
 *      `sigmaPbps` the volatility. A lender that ignores both sizes every loan as if the mark
 *      were exact.
 *
 * Two-tier reads are the fifth thing, and they are in `readAgreedMark`: the reference tier is an
 * independently pushed second opinion. Requiring the tiers to agree turns a single compromised
 * or wedged relay from a loss into a revert.
 */
contract OracleConsumer {
  /// @notice The PoolFactory, which serves both tiers.
  IOracle public immutable oracle;

  uint256 internal constant PRIMARY = 1;
  uint256 internal constant REFERENCE = 2;

  /// @notice Max accepted age in seconds. Tighter than the feed's own ttl on purpose: ttl is the
  ///         protocol's outer bound, not your risk appetite.
  uint32 public immutable maxAgeSecs;

  /// @notice Max accepted one-sigma interval, bps. A wider mark is not a mark you can lend on.
  uint16 public immutable maxConfidenceBps;

  /// @notice Max accepted disagreement between the two tiers, bps.
  uint16 public immutable maxTierDivergenceBps;

  error StaleMark(bytes32 feedId, uint256 observedAt, uint256 nowSecs);
  error PausedFeed(bytes32 feedId);
  error NoMark(bytes32 feedId);
  error ConfidenceTooWide(bytes32 feedId, uint16 confidenceBps);
  error TierDivergence(bytes32 feedId, uint256 primaryMark, uint256 referenceMark);

  constructor(
    address oracle_,
    uint32 maxAgeSecs_,
    uint16 maxConfidenceBps_,
    uint16 maxTierDivergenceBps_
  ) {
    oracle = IOracle(oracle_);
    maxAgeSecs = maxAgeSecs_;
    maxConfidenceBps = maxConfidenceBps_;
    maxTierDivergenceBps = maxTierDivergenceBps_;
  }

  /// @notice The second the mark was observed: `min(sourceTs, updatedAt)`. On the PoolFactory
  ///         `sourceTsMs` is `updatedAtSecs * 1000`, so this is `updatedAtSecs`; the form stays so
  ///         a feed carrying an earlier signed source time is aged from that time.
  function observedAt(IOracle.FeedData memory f) public pure returns (uint256) {
    if (f.sourceTsMs == 0) return f.updatedAtSecs;
    uint256 srcSecs = uint256(f.sourceTsMs) / 1000;
    return srcSecs > f.updatedAtSecs ? f.updatedAtSecs : srcSecs;
  }

  /// @notice Read the primary tier, fail closed on every unsafe condition.
  /// @return mark 1e18 WAD, quote per base.
  function readMark(bytes32 feedId) public view returns (uint256 mark) {
    return _read(feedId, PRIMARY);
  }

  /// @notice Read both tiers and require them to agree within `maxTierDivergenceBps`.
  /// @return mark The PRIMARY tier's mark. The reference tier is a check, not an average:
  ///              averaging two marks hides the disagreement that was the whole reason to read
  ///              twice.
  function readAgreedMark(bytes32 feedId) public view returns (uint256 mark) {
    mark = _read(feedId, PRIMARY);
    uint256 ref = _read(feedId, REFERENCE);
    uint256 diff = mark > ref ? mark - ref : ref - mark;
    if (diff * 10_000 > ref * maxTierDivergenceBps) revert TierDivergence(feedId, mark, ref);
  }

  /// @notice Mark a position DOWN by the feed's own confidence interval before lending against
  ///         it. `confidenceBps` is the interval; using the raw mark lends the full width of it
  ///         to whoever is on the other side.
  /// @param  feedId  Feed to price against.
  /// @param  amount  Collateral amount, in the collateral token's own units.
  /// @param  sigmas  How many confidence intervals to haircut by. 1 is the floor, not the answer.
  function conservativeValue(bytes32 feedId, uint256 amount, uint256 sigmas)
    external
    view
    returns (uint256 value1e18)
  {
    IOracle.FeedData memory f = oracle.feedOf(feedId, PRIMARY);
    uint256 mark = _check(feedId, f);
    uint256 haircutBps = uint256(f.confidenceBps) * sigmas;
    if (haircutBps >= 10_000) return 0;
    value1e18 = (amount * mark * (10_000 - haircutBps)) / 10_000;
  }

  function _read(bytes32 feedId, uint256 tier) internal view returns (uint256) {
    return _check(feedId, oracle.feedOf(feedId, tier));
  }

  function _check(bytes32 feedId, IOracle.FeedData memory f) internal view returns (uint256) {
    // (3) Halt bit first: a halted feed's other fields can look perfectly healthy.
    if (f.flags & 1 != 0) revert PausedFeed(feedId);
    // (1) Zero is the sentinel, not a price.
    if (f.mark1e18 == 0) revert NoMark(feedId);
    // (2) Freshness on the observed clock, bounded by OUR appetite and by the feed's own ttl.
    uint256 seen = observedAt(f);
    if (seen + maxAgeSecs < block.timestamp || seen + f.ttlSecs < block.timestamp) {
      revert StaleMark(feedId, seen, block.timestamp);
    }
    // (4) A mark wider than we can price is not usable, however fresh it is.
    if (f.confidenceBps > maxConfidenceBps) revert ConfidenceTooWide(feedId, f.confidenceBps);
    return f.mark1e18;
  }
}
