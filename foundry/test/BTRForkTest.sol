// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20, IOracle, IPool, IRouter} from "../src/interfaces/IBTR.sol";

/**
 * @title BTRForkTest
 * @notice Base class for every example test. It forks a live BTR chain and loads addresses from
 *         `config/<chainId>.json`, so nothing below this file hardcodes a deployment, a pool or
 *         a token symbol.
 *
 * Environment:
 *   BTR_CHAIN_ID     which config file to load        (REQUIRED, no default)
 *   BTR_RPC_URL      endpoint to fork                 (default: first of `rpcUrls` that answers)
 *   BTR_FORK_BLOCK   pin the fork for reproducibility (default 0 = latest)
 *
 * A pinned block is the reproducible mode: the oracle marks, pool inventories and therefore every
 * quote are frozen, so a run today and a run next month assert the same numbers. Latest is the
 * liveness mode: it proves the deployment is answering right now. Both are supported because they
 * check different things, and neither substitutes for the other.
 *
 * WHAT A TEST RUNS ON. The config declares the pools, the legs each holds and every token's
 * class (`stable`, `fx`, `volatile`, `equity`). Tests ask for a leg or a pair by class
 * (`firstLeg`, `pairIn`, `crossPair`) and call `skipUnless` when the chain has none, so a chain
 * with no FX pool, no equities, or only one pool SKIPS those tests with the reason shown.
 */
abstract contract BTRForkTest is Test {
  /// @dev The PoolFactory: it serves both feed tiers (`feedOf(feedId, 1|2)`).
  IOracle internal oracle;
  IRouter internal router;

  /// @dev The token every pool prices against.
  address internal base;
  string internal baseSym;

  /// @dev One non-base asset of one pool.
  struct Leg {
    IPool pool;
    string poolName;
    string sym;
    address token;
  }

  /// @dev Bits of `getRiskFlags`: a leg with either set needs an allowlisted caller.
  uint16 internal constant DEPOSIT_GATED_BIT = 1 << 9;
  uint16 internal constant SWAP_GATED_BIT = 1 << 10;

  /// @dev Fresh EOA. Nothing here needs a funded key: `deal` mints balances into the fork.
  address internal alice = makeAddr("alice");

  string internal cfg;
  string[] internal poolNames;

  function setUp() public virtual {
    uint256 chainId = vm.envOr("BTR_CHAIN_ID", uint256(0));
    require(chainId != 0, "BTR_CHAIN_ID is required: set it to a file name in config/");
    cfg = vm.readFile(string.concat("../config/", vm.toString(chainId), ".json"));

    // BTR_RPC_URL wins. Otherwise try the config's public endpoints in order: forge cannot read
    // an endpoint that compresses unconditionally, and one dead host must not fail the suite.
    string[] memory urls = vm.parseJsonStringArray(cfg, ".rpcUrls");
    string memory override_ = vm.envOr("BTR_RPC_URL", string(""));
    if (bytes(override_).length != 0) {
      urls = new string[](1);
      urls[0] = override_;
    }
    uint256 forkBlock = vm.envOr("BTR_FORK_BLOCK", uint256(0));
    bool forked;
    for (uint256 i; i < urls.length && !forked; ++i) {
      if (forkBlock == 0) {
        try vm.createSelectFork(urls[i]) returns (uint256) {
          forked = true;
        } catch {}
      } else {
        try vm.createSelectFork(urls[i], forkBlock) returns (uint256) {
          forked = true;
        } catch {}
      }
    }
    require(forked, "no rpc endpoint in config/<chainId>.json answered; set BTR_RPC_URL");

    require(block.chainid == chainId, "forked the wrong chain");

    oracle = IOracle(addr(".contracts.poolFactory"));
    router = IRouter(addr(".contracts.router"));

    baseSym = vm.parseJsonString(cfg, ".baseToken");
    base = token(baseSym);
    poolNames = vm.parseJsonKeys(cfg, ".pools");

    vm.deal(alice, 10 ether);
  }

  function addr(string memory key) internal view returns (address) {
    return vm.parseJsonAddress(cfg, key);
  }

  function token(string memory sym) internal view returns (address) {
    return addr(string.concat(".tokens.", sym, ".address"));
  }

  function classOf(string memory sym) internal view returns (string memory) {
    return vm.parseJsonString(cfg, string.concat(".tokens.", sym, ".class"));
  }

  function feedId(string memory sym) internal view returns (bytes32) {
    return vm.parseJsonBytes32(cfg, string.concat(".feeds.", sym));
  }

  function eq(string memory a, string memory b) internal pure returns (bool) {
    return keccak256(bytes(a)) == keccak256(bytes(b));
  }

  /// @dev Skip the calling test, with `why` shown in the report, unless `ok`.
  function skipUnless(bool ok, string memory why) internal {
    if (!ok) vm.skip(true, why);
  }

  // ─── what the config declares ───

  /// @dev The non-base legs of class `cls` ("" = any class) held by pool `poolIdx`, or by every
  ///      pool when `poolIdx == type(uint256).max`.
  function legsIn(uint256 poolIdx, string memory cls) internal view returns (Leg[] memory out) {
    uint256 n;
    for (uint256 pass; pass < 2; ++pass) {
      if (pass == 1) out = new Leg[](n);
      n = 0;
      for (uint256 i; i < poolNames.length; ++i) {
        if (poolIdx != type(uint256).max && poolIdx != i) continue;
        string memory pk = string.concat(".pools.", poolNames[i]);
        string[] memory assets = vm.parseJsonStringArray(cfg, string.concat(pk, ".assets"));
        for (uint256 j; j < assets.length; ++j) {
          if (eq(assets[j], baseSym)) continue;
          if (bytes(cls).length != 0 && !eq(classOf(assets[j]), cls)) continue;
          if (pass == 1) {
            out[n] = Leg({
              pool: IPool(addr(string.concat(pk, ".address"))),
              poolName: poolNames[i],
              sym: assets[j],
              token: token(assets[j])
            });
          }
          ++n;
        }
      }
    }
  }

  /// @dev Every non-base leg of class `cls` ("" = any), across all pools.
  function legsOf(string memory cls) internal view returns (Leg[] memory) {
    return legsIn(type(uint256).max, cls);
  }

  /// @dev The first non-base leg of class `cls`, or `ok == false` when the chain has none.
  function firstLeg(string memory cls) internal view returns (Leg memory l, bool ok) {
    Leg[] memory ls = legsOf(cls);
    if (ls.length == 0) return (l, false);
    return (ls[0], true);
  }

  /// @dev The leg the single-leg examples run on: a stable when the chain has one.
  function demoLeg() internal view returns (Leg memory l, bool ok) {
    (l, ok) = firstLeg("stable");
    if (!ok) (l, ok) = firstLeg("");
  }

  /// @dev Two different non-base legs of ONE pool, of class `cls` ("" = any).
  function pairIn(string memory cls) internal view returns (Leg memory a, Leg memory b, bool ok) {
    for (uint256 i; i < poolNames.length; ++i) {
      Leg[] memory ls = legsIn(i, cls);
      if (ls.length >= 2) return (ls[0], ls[1], true);
    }
  }

  /// @dev The pair the spoke-to-spoke and debt-swap examples run on: stables when available.
  function demoPair() internal view returns (Leg memory a, Leg memory b, bool ok) {
    (a, b, ok) = pairIn("stable");
    if (!ok) (a, b, ok) = pairIn("");
  }

  /// @dev Legs in two DIFFERENT pools, the only shape a multi-pool route can take. Prefers a
  ///      stable in the first and a volatile in the second.
  function crossPair() internal view returns (Leg memory a, Leg memory b, bool ok) {
    (a, b, ok) = _cross(legsOf("stable"), legsOf("volatile"));
    if (!ok) (a, b, ok) = _cross(legsOf(""), legsOf(""));
  }

  function _cross(Leg[] memory xs, Leg[] memory ys)
    private
    pure
    returns (Leg memory a, Leg memory b, bool ok)
  {
    for (uint256 i; i < xs.length; ++i) {
      for (uint256 j; j < ys.length; ++j) {
        if (xs[i].pool != ys[j].pool) return (xs[i], ys[j], true);
      }
    }
  }

  /// @dev What the router examples need: `a` and `a2` in one pool, `b` in another.
  function routeSet() internal view returns (Leg memory a, Leg memory a2, Leg memory b, bool ok) {
    (a, b, ok) = crossPair();
    if (!ok) return (a, a2, b, false);
    Leg[] memory same = legsOf("");
    for (uint256 i; i < same.length; ++i) {
      if (same[i].pool == a.pool && same[i].token != a.token) return (a, same[i], b, true);
    }
    return (a, a2, b, false);
  }

  /// @dev Whether `bit` is set on `t`'s leg of `p`: gated legs need an allowlisted caller, which
  ///      the throwaway `alice` is not.
  function gated(IPool p, address t, uint16 bit) internal view returns (bool) {
    return p.getRiskFlags(t) & bit != 0;
  }

  /// @dev Skip unless an unlisted caller can swap `base` <-> `l.token` on `l.pool`.
  function skipIfSwapGated(Leg memory l) internal {
    skipUnless(
      !gated(l.pool, base, SWAP_GATED_BIT) && !gated(l.pool, l.token, SWAP_GATED_BIT),
      string.concat("swaps on ", l.sym, " in ", l.poolName, " need an allowlisted caller")
    );
  }

  /// @dev Skip unless an unlisted caller can deposit into `l`.
  function skipIfDepositGated(Leg memory l) internal {
    skipUnless(
      !gated(l.pool, l.token, DEPOSIT_GATED_BIT),
      string.concat("deposits to ", l.sym, " in ", l.poolName, " need an allowlisted caller")
    );
  }

  /// @dev Raw units of `sym` worth `usd` dollars at the oracle's live mark (USD per whole token).
  ///      Sizes a position by VALUE, so one number serves a stable, a token at a fraction of a
  ///      cent and a share worth hundreds of dollars.
  function unitsWorth(string memory sym, uint256 usd) internal view returns (uint256) {
    uint256 mark = oracle.getFeed(feedId(sym)).mark1e18;
    return usd * (10 ** IERC20(token(sym)).decimals()) * 1e18 / mark;
  }

  /// @dev Mint `amount` of `t` to `alice` and approve `spender`. `deal` writes the balance slot
  ///      directly, which is why none of these tests needs a funded private key.
  function fund(address t, uint256 amount, address spender) internal {
    deal(t, alice, amount, true);
    vm.prank(alice);
    IERC20(t).approve(spender, type(uint256).max);
  }

  /// @dev Whole units of `t`, in `t`'s OWN decimals. Decimals differ across a deployment (6 for
  ///      USDC or XAUT0, 8 for BTC wrappers, 18 for most), so a literal `1_000e18` is wrong for
  ///      some of its tokens and wrong QUIETLY: it overfunds by orders of magnitude rather than
  ///      reverting.
  function units(address t, uint256 whole) internal view returns (uint256) {
    return whole * (10 ** IERC20(t).decimals());
  }

  /// @dev Whole-unit price of `tokenOut` per `tokenIn`, WAD, from a RAW in/out pair.
  ///
  ///      `SwapQuote.markPrice` is quoted in whole units, so a raw ratio only lines up with it
  ///      once both decimals are divided out. Across an 18-decimal and a 6-decimal leg the raw ratio
  ///      is out by 1e12 and nothing reverts: it reads as a 99.9999% price impact, or as a clean
  ///      zero if it is floored, and a zero compares equal to another zero all day.
  function impliedWad(address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut)
    internal
    view
    returns (uint256)
  {
    return amountOut * (10 ** (18 + uint256(IERC20(tokenIn).decimals())))
      / (amountIn * (10 ** uint256(IERC20(tokenOut).decimals())));
  }

  /// @dev The pool's anti-flow-abuse window, seconds. READ FROM THE CONTRACT, never hardcoded:
  ///      it is an admin-settable `uint16`, so a literal is a latent break the day it is retuned.
  function cooldownOf(IPool p) internal view returns (uint256) {
    return p.flowCooldownSecs();
  }

  /// @dev Move the clock past the pool's flow cooldown.
  ///
  ///      Freshly minted LP shares are frozen for `flowCooldownSecs`, and the freeze gates BOTH
  ///      `withdraw` AND `swapLiability`: either one in the same block as the deposit reverts
  ///      `CooldownActive()`. That is the guard that stops a deposit-flip-exit sandwich from
  ///      harvesting an index or coverage move it never carried any risk for. An integrator
  ///      cannot opt out of it, so an example that quietly deposited and swapped in one block
  ///      would be teaching a call that reverts on the real chain.
  function warpPastCooldown(IPool p) internal {
    vm.warp(block.timestamp + cooldownOf(p) + 1);
  }

  /// @dev |a - b| in bps of `b`.
  function diffBps(uint256 a, uint256 b) internal pure returns (uint256) {
    return (a > b ? a - b : b - a) * 10_000 / b;
  }
}

/// @dev A bare ERC-20 that no pool lists. For the tests that need a token a pool must refuse.
contract PlainToken {
  uint8 public constant decimals = 18;
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  function mint(address to, uint256 amount) external {
    balanceOf[to] += amount;
  }

  function approve(address spender, uint256 amount) external returns (bool) {
    allowance[msg.sender][spender] = amount;
    return true;
  }

  function transfer(address to, uint256 amount) external returns (bool) {
    balanceOf[msg.sender] -= amount;
    balanceOf[to] += amount;
    return true;
  }

  function transferFrom(address from, address to, uint256 amount) external returns (bool) {
    allowance[from][msg.sender] -= amount;
    balanceOf[from] -= amount;
    balanceOf[to] += amount;
    return true;
  }
}
