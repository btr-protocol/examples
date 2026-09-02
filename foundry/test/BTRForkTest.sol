// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20, IOracle, IPool, IRouter} from "../src/interfaces/IBTR.sol";

/**
 * @title BTRForkTest
 * @notice Base class for every example test. It forks a live BTR chain and loads addresses from
 *         `config/<chainId>.json`, so nothing below this file hardcodes a deployment.
 *
 * Environment:
 *   BTR_CHAIN_ID     which config file to load        (default 5042002, Arc testnet)
 *   BTR_RPC_URL      endpoint to fork                 (default: `rpcUrl` from the config file)
 *   BTR_FORK_BLOCK   pin the fork for reproducibility (default 0 = latest)
 *
 * A pinned block is the reproducible mode: the oracle marks, pool inventories and therefore every
 * quote are frozen, so a run today and a run next month assert the same numbers. Latest is the
 * liveness mode: it proves the deployment is answering right now. Both are supported because they
 * check different things, and neither substitutes for the other.
 */
abstract contract BTRForkTest is Test {
  IOracle internal oracle;
  IOracle internal refOracle;
  IRouter internal router;

  IPool internal stablePool;
  IPool internal fxPool;
  IPool internal cryptoPool;
  IPool internal stocksPool;

  address internal USDCB;
  address internal USDT;
  address internal USDS;
  address internal WETH;
  address internal EURC;
  address internal JPYC;
  address internal NVDA;
  address internal TSLA;

  /// @dev Fresh EOA. Nothing here needs a funded key: `deal` mints balances into the fork.
  address internal alice = makeAddr("alice");

  string internal cfg;

  function setUp() public virtual {
    uint256 chainId = vm.envOr("BTR_CHAIN_ID", uint256(5042002));
    cfg = vm.readFile(string.concat("../config/", vm.toString(chainId), ".json"));

    string memory rpc = vm.envOr("BTR_RPC_URL", vm.parseJsonString(cfg, ".rpcUrl"));
    uint256 forkBlock = vm.envOr("BTR_FORK_BLOCK", uint256(0));
    if (forkBlock == 0) vm.createSelectFork(rpc);
    else vm.createSelectFork(rpc, forkBlock);

    require(block.chainid == chainId, "forked the wrong chain");

    oracle = IOracle(addr(".contracts.oracle"));
    refOracle = IOracle(addr(".contracts.refOracle"));
    router = IRouter(addr(".contracts.router"));

    stablePool = IPool(addr(".pools.stablePool"));
    fxPool = IPool(addr(".pools.fxPool"));
    cryptoPool = IPool(addr(".pools.cryptoPool"));
    stocksPool = IPool(addr(".pools.stocksPool"));

    USDCB = token("USDCB");
    USDT = token("USDT");
    USDS = token("USDS");
    WETH = token("WETH");
    EURC = token("EURC");
    JPYC = token("JPYC");
    NVDA = token("NVDA");
    TSLA = token("TSLA");

    vm.deal(alice, 10 ether);
  }

  function addr(string memory key) internal view returns (address) {
    return vm.parseJsonAddress(cfg, key);
  }

  function token(string memory sym) internal view returns (address) {
    return addr(string.concat(".tokens.", sym));
  }

  function feedId(string memory sym) internal view returns (bytes32) {
    return vm.parseJsonBytes32(cfg, string.concat(".feeds.", sym));
  }

  /// @dev Mint `amount` of `t` to `alice` and approve `spender`. `deal` writes the balance slot
  ///      directly, which is why none of these tests needs a funded private key.
  function fund(address t, uint256 amount, address spender) internal {
    deal(t, alice, amount, true);
    vm.prank(alice);
    IERC20(t).approve(spender, type(uint256).max);
  }

  /// @dev Whole units of `t`, in `t`'s OWN decimals. EURC is 6 and WETH is 18 on this
  ///      deployment, so a literal `1_000e18` is wrong for half the tokens here and wrong
  ///      QUIETLY: it overfunds by 1e12 rather than reverting.
  function units(address t, uint256 whole) internal view returns (uint256) {
    return whole * (10 ** IERC20(t).decimals());
  }

  /// @dev Whole-unit price of `tokenOut` per `tokenIn`, WAD, from a RAW in/out pair.
  ///
  ///      `SwapQuote.markPrice` is quoted in whole units, so a raw ratio only lines up with it
  ///      once both decimals are divided out. On the USDCB/EURC leg (18 against 6) the raw ratio
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

  /// @dev |a - b| in bps of `b`.
  function diffBps(uint256 a, uint256 b) internal pure returns (uint256) {
    return (a > b ? a - b : b - a) * 10_000 / b;
  }
}
