# BTR integration examples

Working, tested integrations with a live BTR deployment. Six operations, each shown three ways:
on chain in Solidity, off chain in TypeScript through `@btr-protocol/sdk`, and off chain in
TypeScript through a plain JSON-RPC client with no BTR dependency at all.

Every example is executed against a real deployment by the test suite. Nothing here is a sketch.

Four asset classes are exercised, not one: stables, FX (EURC, JPYC), tokenised equities (NVDA,
ASML, TSLA) and crypto (WETH). They are here because they break different assumptions - EURC is a
6-decimal token, JPYC is worth a fraction of a cent, an NVDA share is worth hundreds of dollars,
and an equity feed is stale for most of the week on purpose.

| # | Operation | Solidity (Foundry) | TypeScript, SDK | TypeScript, vanilla RPC | Guide |
|---|---|---|---|---|---|
| 1 | Consume price feeds | [`OracleConsumer.sol`](foundry/src/OracleConsumer.sol) · [test](foundry/test/01_OracleConsumption.t.sol) | [`sdk/01-oracle.ts`](typescript/sdk/01-oracle.ts) | [`rpc/01-oracle.ts`](typescript/rpc/01-oracle.ts) | [Consuming Price Feeds](https://btr.markets/docs/5-1-5-consuming-price-feeds) |
| 2 | Multi-hop swap via the Router | [test](foundry/test/02_RouterSwap.t.sol) | [`sdk/02-router-swap.ts`](typescript/sdk/02-router-swap.ts) | [`rpc/02-router-swap.ts`](typescript/rpc/02-router-swap.ts) | [Composability](https://btr.markets/docs/5-1-4-composability#2-routing-through-the-router) |
| 3 | Swap directly on a pool | [test](foundry/test/03_PoolSwap.t.sol) | [`sdk/03-pool-swap.ts`](typescript/sdk/03-pool-swap.ts) | [`rpc/03-pool-swap.ts`](typescript/rpc/03-pool-swap.ts) | [Basic Operations](https://btr.markets/docs/5-1-1-basic-operations#3-swap) |
| 4 | Deposit liquidity | [test](foundry/test/04_Deposit.t.sol) | [`sdk/04-deposit.ts`](typescript/sdk/04-deposit.ts) | [`rpc/04-deposit.ts`](typescript/rpc/04-deposit.ts) | [Basic Operations](https://btr.markets/docs/5-1-1-basic-operations#4-deposit--withdraw) |
| 5 | Withdraw liquidity | [test](foundry/test/05_Withdraw.t.sol) | [`sdk/05-withdraw.ts`](typescript/sdk/05-withdraw.ts) | [`rpc/05-withdraw.ts`](typescript/rpc/05-withdraw.ts) | [Basic Operations](https://btr.markets/docs/5-1-1-basic-operations#4-deposit--withdraw) |
| 6 | Debt swap (`swapLiability`) | [test](foundry/test/06_DebtSwap.t.sol) | [`sdk/06-debt-swap.ts`](typescript/sdk/06-debt-swap.ts) | [`rpc/06-debt-swap.ts`](typescript/rpc/06-debt-swap.ts) | [Basic Operations](https://btr.markets/docs/5-1-1-basic-operations#5-swap-liability) |

## Layout

```
config/<chainId>.json   every address, feed id and calendar, in one place. Nothing is inlined.
foundry/                Solidity: minimal interfaces, one consumer contract, six fork suites.
typescript/sdk/         off chain, using @btr-protocol/sdk.
typescript/rpc/         off chain, using viem only. No BTR dependency.
typescript/test/read/   read-only tests, run against the live chain.
typescript/test/fork/   state-changing tests, run against a local anvil fork.
```

There is no hardcoded address, pool or chain id in any example file. Point everything at another
BTR deployment by adding `config/<chainId>.json` and setting `BTR_CHAIN_ID`.

## Prerequisites

- [Foundry](https://getfoundry.sh) for the Solidity half (`forge`, `anvil`)
- [Bun](https://bun.sh) for the TypeScript half

```bash
git clone --recurse-submodules https://github.com/btr-protocol/examples
cd examples/typescript && bun install
```

## Run everything

```bash
# Solidity: 58 tests, forked against the live chain, executing real swaps and LP flows.
# Point BTR_RPC_URL at your own endpoint: the suite forks from the config's `rpcUrl`, so
# `forge test --fork-url ...` does NOT change where it reads from.
cd foundry && forge test -vv

# TypeScript, read-only, against the live chain. No key, no state change.
cd typescript && bun test test/read

# TypeScript, state-changing, against a local anvil fork it boots and tears down itself.
cd typescript && bun run test:fork
```

Run one example on its own:

```bash
cd foundry    && forge test --match-path 'test/02_*' -vv
cd typescript && bun run sdk/01-oracle.ts
cd typescript && bun run rpc/02-router-swap.ts
```

## Nothing needs a funded key

The write examples DRY RUN by default: they print the calldata they would send and stop. That is
deliberate. Reading an example should not move anyone's money.

- Foundry tests use `deal` to mint balances into the fork.
- TypeScript fork tests use anvil's public development key against a local fork, and write
  balances through `anvil_setStorageAt`.

Set `BTR_PRIVATE_KEY` to arm the TypeScript examples, and point `BTR_RPC_URL` at your fork first.
See [`.env.example`](.env.example).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BTR_CHAIN_ID` | `5042002` | Which `config/<chainId>.json` to load |
| `BTR_RPC_URL` | the config's `rpcUrl` | Endpoint to use, or to fork |
| `BTR_PRIVATE_KEY` | unset | Set to SEND transactions. Unset means dry run |
| `BTR_FORK_BLOCK` | `0` (latest) | Foundry only: pin the fork for reproducible numbers |
| `ANVIL_PORT` | `8545` | TypeScript fork suite: port for the anvil it boots |
| `ANVIL_CUPS` | `100` | anvil's outbound throttle, sized for a free endpoint |

A pinned block is the reproducible mode: marks, inventories and therefore every quote are frozen.
Latest is the liveness mode: it proves the deployment is answering now. Both are supported because
they check different things.

`bun run test:fork` REFUSES a port that is already answering rather than testing against whatever
is on it. A forgotten anvil serves the contract implementations as they were when it forked, so a
day-old one turns every upgrade into a phantom contract bug. Stop it, or set `ANVIL_PORT`.

Public endpoints rate limit. A 429 is an UNKNOWN result, never a pass and never a failure: the
TypeScript examples retry it with backoff (`withRetry` in [`src/config.ts`](typescript/src/config.ts)),
and Foundry caches fork reads on disk.

## Which off-chain surface should I use

Both are complete. They are twins on purpose, so you can diff them.

**`@btr-protocol/sdk`** ships the deployed ABIs, typed structs, and the protocol's own semantics:
`observedAtSecs` is the freshness clock the contracts actually gate on, `SwapQuote` comes back with
`markPrice` and `midPrice` named rather than positional, and `quoteSwapLiability` is an off-chain
replica of the haircut maths. Pick it when you are in TypeScript and want the protocol's reading of
its own data rather than yours.

**Vanilla JSON-RPC** (viem here) proves BTR needs no SDK. Every call is an `eth_call` against a
human-readable ABI fragment, so the same shape ports to ethers, web3.py, alloy or `cast` unchanged.
Pick it when you do not want a dependency, or when TypeScript is not your stack and this is your
reference. What you give up is transcription risk: the freshness rule, the 13-field `SwapQuote`
tuple and the nested `Part[]`/`Hop[]` encoding are yours to get right.

## The seven things that bite integrators

1. **Zero is not a price.** `mark1e18 == 0` is the STALE sentinel a feed carries before its first
   accepted push. An unconfigured feed id does not return zero, it reverts `FeedNotFound`.
2. **Freshness is age against `ttlSecs`.** The pools revert `StaleData` once `now - updatedAtSecs`
   exceeds the feed's own `ttlSecs`. The oracle is the PoolFactory: `feedOf(feedId, 1)` is the
   primary tier, `feedOf(feedId, 2)` the reference tier, and both carry their own `ttlSecs`. Apply
   the same bound yourself, tighter if your risk appetite is, or you price off a mark the pools
   would refuse.
3. **The pool pulls with `transferFrom(msg.sender)`.** So an approval is mandatory, and Multicall3
   cannot swap: under Multicall3 the `msg.sender` the pool sees is the multicall contract.
4. **A withdraw floor comes from `previewWithdraw`, not from what you deposited.** The two differ
   by the coverage haircut. Freshly minted shares are also frozen for `flowCooldownSecs`, which is
   why `maxRedeem` is zero right after a deposit.
5. **A debt swap is denominated in LP SHARES on both sides**, and shares are not comparable across
   legs: each leg carries its own liquidity index. Compare VALUE through `previewWithdraw`. The
   same `flowCooldownSecs` freeze applies, because `swapLiability` moves an LP claim just as a
   withdraw does: deposit and re-denominate in one block and the call reverts `CooldownActive()`.
   And the carry is not par between two stables. What arrives is marked to the DESTINATION leg's
   coverage, so joining an under-covered leg costs you its shortfall.
6. **Decimals are not 18.** EURC is 6. `SwapQuote.markPrice` is a WHOLE-UNIT price, so a raw
   `amountOut / amountIn` ratio only matches it when both legs share a decimal count. On the
   USDCB/EURC leg the raw ratio is out by 1e12, and nothing reverts: it reads as a 99.9999% price
   impact, or as a clean zero if you floor it, and a zero passes an equality check against another
   zero. Every amount in these examples is built from the token's own `decimals()`.
7. **Stale is normal for an equity, and only for an equity.** The US cash session is about 30% of
   the week and the keeper deliberately does not heartbeat a frozen record. A stale NVDA feed at
   03:00 UTC on a Sunday is the system working; a stale WETH, EURC or JPYC feed never is. The
   oracle examples return `live` / `closed` / `incident` rather than a boolean, and the tests that
   need an open market SKIP loudly with the reason instead of failing every weekend.

## License

MIT. See [LICENSE](LICENSE).
