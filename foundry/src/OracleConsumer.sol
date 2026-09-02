// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOracle} from "./interfaces/IBTR.sol";

/**
 * @title OracleConsumer
 * @notice A contract that prices collateral off a BTR feed, the safe way.
 * @dev    Guide: https://btr.markets/docs/5-1-5-consuming-price-feeds
 *         Example: https://github.com/btr-protocol/examples/blob/main/foundry/src/OracleConsumer.sol
 *
 * The whole point of this file is the four checks in `readMark`. A read that takes `mark1e18`
 * and stops is wrong in four distinct ways, and each one has its own revert here:
 *
 *   1. ZERO IS NOT A PRICE. `mark1e18 == 0` is the stale sentinel a feed carries before its
 *      first accepted push, or after a rebias invalidates it. Divide by it and you brick; treat
 *      it as free money and you get drained.
 *   2. FRESHNESS IS NOT `updatedAtSecs`. The contract gates on `min(sourceTs, updatedAt)`. Age
 *      measured off `updatedAtSecs` alone understates it by the relay lag, which is how a feed
 *      reads fresh off chain and still reverts on chain.
 *   3. `flags & 1` IS A PAUSE, AND IT MEANS STOP. A guardian sets it when a feed is suspect.
 *      Consuming a paused mark is consuming the exact number somebody just decided not to trust.
 *   4. A MARK IS A DISTRIBUTION, NOT A NUMBER. `confidenceBps` is its one-sigma interval and
 *      `sigmaPbps` the signed volatility. A lender that ignores both sizes every loan as if the
 *      mark were exact.
 *
 * Two-tier reads are the fifth thing, and they are in `readAgreedMark`: the refOracle tier is an
 * independently pushed second opinion. Requiring the tiers to agree turns a single compromised
 * or wedged relay from a loss into a revert.
 */
contract OracleConsumer {
  IOracle public immutable primary;
  IOracle public immutable refOracle;

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
    address primary_,
    address refOracle_,
    uint32 maxAgeSecs_,
    uint16 maxConfidenceBps_,
    uint16 maxTierDivergenceBps_
  ) {
    primary = IOracle(primary_);
    refOracle = IOracle(refOracle_);
    maxAgeSecs = maxAgeSecs_;
    maxConfidenceBps = maxConfidenceBps_;
    maxTierDivergenceBps = maxTierDivergenceBps_;
  }

  /// @notice The freshness clock the protocol itself gates on: `min(sourceTs, updatedAt)`, with a
  ///         fallback to `updatedAt` when the feed carries no signed source time.
  function observedAt(IOracle.FeedData memory f) public pure returns (uint256) {
    if (f.sourceTsMs == 0) return f.updatedAtSecs;
    uint256 srcSecs = uint256(f.sourceTsMs) / 1000;
    return srcSecs > f.updatedAtSecs ? f.updatedAtSecs : srcSecs;
  }

  /// @notice Read one tier, fail closed on every unsafe condition.
  /// @return mark 1e18 WAD, quote per base.
  function readMark(bytes32 feedId) public view returns (uint256 mark) {
    return _read(primary, feedId);
  }

  /// @notice Read both tiers and require them to agree within `maxTierDivergenceBps`.
  /// @return mark The PRIMARY tier's mark. The refOracle is a check, not an average: averaging
  ///              two marks hides the disagreement that was the whole reason to read twice.
  function readAgreedMark(bytes32 feedId) public view returns (uint256 mark) {
    mark = _read(primary, feedId);
    uint256 ref = _read(refOracle, feedId);
    uint256 diff = mark > ref ? mark - ref : ref - mark;
    if (diff * 10_000 > ref * maxTierDivergenceBps) revert TierDivergence(feedId, mark, ref);
  }

  /// @notice Mark a position DOWN by one sigma of the feed's own confidence interval before
  ///         lending against it. `confidenceBps` is the interval; using the raw mark lends the
  ///         full width of it to whoever is on the other side.
  /// @param  feedId  Feed to price against.
  /// @param  amount  Collateral amount, in the collateral token's own units.
  /// @param  sigmas  How many confidence intervals to haircut by. 1 is the floor, not the answer.
  function conservativeValue(bytes32 feedId, uint256 amount, uint256 sigmas)
    external
    view
    returns (uint256 value1e18)
  {
    IOracle.FeedData memory f = primary.getFeed(feedId);
    uint256 mark = _check(primary, feedId, f);
    uint256 haircutBps = uint256(f.confidenceBps) * sigmas;
    if (haircutBps >= 10_000) return 0;
    value1e18 = (amount * mark * (10_000 - haircutBps)) / 10_000;
  }

  function _read(IOracle tier, bytes32 feedId) internal view returns (uint256) {
    IOracle.FeedData memory f = tier.getFeed(feedId);
    return _check(tier, feedId, f);
  }

  function _check(IOracle tier, bytes32 feedId, IOracle.FeedData memory f)
    internal
    view
    returns (uint256)
  {
    // (3) Pause bit first: a paused feed's other fields can look perfectly healthy.
    if (f.flags & 1 != 0) revert PausedFeed(feedId);
    // (1) Zero is the sentinel, not a price.
    if (f.mark1e18 == 0) revert NoMark(feedId);
    // (2) Freshness on the observed clock, bounded by OUR appetite and by the oracle's own view.
    uint256 seen = observedAt(f);
    if (seen + maxAgeSecs < block.timestamp) revert StaleMark(feedId, seen, block.timestamp);
    if (!tier.isFeedFresh(feedId, maxAgeSecs)) revert StaleMark(feedId, seen, block.timestamp);
    // (4) A mark wider than we can price is not usable, however fresh it is.
    if (f.confidenceBps > maxConfidenceBps) revert ConfidenceTooWide(feedId, f.confidenceBps);
    return f.mark1e18;
  }
}
