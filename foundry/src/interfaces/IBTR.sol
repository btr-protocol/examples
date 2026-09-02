// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Minimal BTR integration interfaces
 * @notice Everything an external contract needs to talk to a BTR deployment: the oracle read
 *         surface, the pool entry points, and the router. Declared here rather than imported so
 *         these examples compile from a bare clone with no BTR source in the tree, which is also
 *         how your own integration should do it: copy the four declarations you actually call.
 *
 * Docs:
 *   Oracle  https://btr.markets/docs/5-1-5-consuming-price-feeds
 *   Pool    https://btr.markets/docs/5-1-1-basic-operations
 *   Router  https://btr.markets/docs/5-1-4-composability
 */

interface IERC20 {
  function balanceOf(address account) external view returns (uint256);
  function allowance(address owner, address spender) external view returns (uint256);
  function approve(address spender, uint256 amount) external returns (bool);
  function transfer(address to, uint256 amount) external returns (bool);
  function transferFrom(address from, address to, uint256 amount) external returns (bool);
  function decimals() external view returns (uint8);
  function symbol() external view returns (string memory);
}

interface IOracle {
  /// @notice One feed as the oracle stores it. Field names matter: an ABI decoder keys the tuple
  ///         by name, so a renamed field silently reads zero rather than throwing.
  struct FeedData {
    /// @dev Fresh mark, 1e18 WAD. ZERO IS THE STALE SENTINEL, never a price.
    uint256 mark1e18;
    /// @dev Signed volatility estimate, PBPS (1e6 = 100%).
    uint32 sigmaPbps;
    /// @dev Chain clock of the last accepted push, seconds.
    uint32 updatedAtSecs;
    /// @dev Staleness bound, seconds.
    uint16 ttlSecs;
    /// @dev One-sigma confidence interval around the mark, bps.
    uint16 confidenceBps;
    /// @dev Feed bits. Bit 0 = paused.
    uint16 flags;
    /// @dev Single-push deviation bound, bps.
    uint16 maxDeviationBps;
    /// @dev Signer-attested source time, milliseconds. 0 when the feed is unsigned.
    uint48 sourceTsMs;
  }

  /// @dev An id the oracle has never been configured with REVERTS with this. It does not return
  ///      a zero struct, so `getFeed` on an unknown id is not a soft miss you can branch on.
  error FeedNotFound(bytes32 feedId);

  function getFeed(bytes32 feedId) external view returns (FeedData memory);
  function isFeedFresh(bytes32 feedId) external view returns (bool);
  function isFeedFresh(bytes32 feedId, uint32 maxAge) external view returns (bool);
}

interface IPool {
  /// @notice What `getSwapQuote` returns. `amountOut` is net of fee and coverage toll.
  struct SwapQuote {
    uint256 amountOut;
    uint256 amountIn;
    /// @dev Half-spread charged, PBPS (1e6 = 100%). The realised fee is spreadPbps / 2.
    uint16 spreadPbps;
    uint256 protoFee;
    uint256 lpFee;
    int8 skewIn;
    int8 skewOut;
    /// @dev Oracle fair value, WAD, tokenOut per tokenIn, chained over every leg.
    uint256 markPrice;
    /// @dev Inventory-skewed centre the book quotes around, WAD. (exec - mid) is the only
    ///      genuinely extractable part of a fill.
    uint256 midPrice;
    /// @dev Coverage toll withheld from the gross output before the fee, tokenOut units.
    uint256 covToll;
    address[] routeHops;
    uint256[] hopAmounts;
    uint256[] hopPrices;
  }

  struct DepositResult {
    uint256 lpAmount;
    uint256 actualDeposit;
    /// @dev Shares carved out of `lpAmount` and sunk to address(0) if this deposit OPENED the leg.
    ///      The first depositor into an empty leg does not receive all of what they minted.
    uint256 deadLp;
  }

  struct WithdrawResult {
    uint256 amountOut;
    uint256 lpBurned;
  }

  function swap(
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    uint256 minAmountOut,
    address recipient,
    uint256 deadline
  ) external payable returns (uint256 out);

  function deposit(address token, uint256 amount) external payable returns (DepositResult memory);

  function withdraw(address token, uint256 lpAmount, uint256 minAmountOut, uint256 deadline)
    external
    returns (WithdrawResult memory);

  /// @notice The debt swap. Moves an LP claim from one leg to another WITHOUT moving reserves:
  ///         it re-denominates a liability, it does not trade.
  function swapLiability(
    address tokenIn,
    address tokenOut,
    uint256 lpAmountIn,
    uint256 minLpAmountOut,
    uint256 deadline
  ) external returns (uint256 lpAmountOut);

  function getSwapQuote(address tokenIn, address tokenOut, uint256 amountIn)
    external
    view
    returns (SwapQuote memory);

  /// @return amount   Underlying returned for `lp` shares, after any coverage haircut.
  /// @return haircut  The haircut applied, same units as `amount`.
  function previewWithdraw(address tk, uint256 lp) external view returns (uint256 amount, uint256 haircut);

  /// @dev Raised when an LP claim is moved inside the flow cooldown window.
  error CooldownActive();

  /// @notice Seconds a freshly minted LP share stays frozen. Admin-settable, so READ it.
  /// @dev It gates BOTH `withdraw` and `swapLiability`: either one inside the window reverts
  ///      `CooldownActive()`. See `BTRForkTest.warpPastCooldown`.
  function flowCooldownSecs() external view returns (uint16);

  function getLPBalance(address user, address tk) external view returns (uint256);
  function lpToken(address tk) external view returns (address);
  function maxRedeem(address owner, address tk) external view returns (uint256);
  function baseToken() external view returns (address);
  function getCoverageRatio(address tk) external view returns (uint256);
  function getRiskFlags(address tk) external view returns (uint16);
}

interface IRouter {
  /// @notice One hop. `tokenIn` is implicit: the part's input for the first hop, the previous
  ///         hop's `tokenOut` after that.
  struct Hop {
    address pool;
    address tokenOut;
  }

  /// @notice One independent path. Parts run in order but do NOT feed each other.
  struct Part {
    address tokenIn;
    uint256 amountIn;
    Hop[] hops;
  }

  /// @notice The end-to-end promise: `minOut` of `token` must reach the recipient. Floors are
  ///         keyed by OUTPUT TOKEN across the whole call, never per hop.
  struct Floor {
    address token;
    uint256 minOut;
  }

  function swap(Part[] calldata parts, Floor[] calldata floors, address recipient, uint256 deadline)
    external
    returns (uint256[] memory received);

  function factory() external view returns (address);
}
