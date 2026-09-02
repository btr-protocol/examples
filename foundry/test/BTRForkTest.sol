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

  address internal USDCB;
  address internal USDT;
  address internal USDS;
  address internal WETH;
  address internal EURC;

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

    USDCB = token("USDCB");
    USDT = token("USDT");
    USDS = token("USDS");
    WETH = token("WETH");
    EURC = token("EURC");

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

  function units(address t, uint256 whole) internal view returns (uint256) {
    return whole * (10 ** IERC20(t).decimals());
  }
}
