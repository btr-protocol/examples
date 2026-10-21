#!/usr/bin/env bun
/**
 * Boot an anvil fork of the configured chain, run the state-changing test suite against it, tear
 * it down.
 *
 * WHY A FORK. The write examples move tokens. Running them against the live chain needs a funded
 * key, is not reproducible, and leaves state behind for the next reader. A fork gives real
 * contracts, real oracle marks, real pool inventories, a prefunded account, and a clean slate
 * every run.
 *
 * Usage: bun run test:fork
 */
import { loadConfig } from '../src/config.ts';

const cfg = loadConfig();
const port = Number(process.env.ANVIL_PORT ?? 8545);
// BTR_FORK_URL wins; otherwise the config's public endpoints are tried in order, because anvil
// cannot read an endpoint that compresses unconditionally and one dead host must not fail the run.
const forkUrls = process.env.BTR_FORK_URL ? [process.env.BTR_FORK_URL] : cfg.rpcUrls;
const rpc = `http://127.0.0.1:${port}`;

/** anvil's first well-known development key. Public, worthless, and the point: no real key is
 *  needed to exercise any of this. NEVER reuse it anywhere that holds value. */
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/**
 * PACE THE UPSTREAM. Every cache miss inside the fork is a request to a public endpoint, and a
 * public endpoint answers 429. A 429 is an UNKNOWN result, never a pass and never a failure, so
 * the fork must retry it rather than surface it as a reverted swap.
 *
 * `--compute-units-per-second` is anvil's own outbound throttle: it is what keeps the suite under
 * the limit instead of discovering it. `--retries` and `--fork-retry-backoff` handle the ones
 * that get through anyway. Raise `ANVIL_CUPS` for a paid endpoint; the default is sized for a
 * free one.
 */
const cups = process.env.ANVIL_CUPS ?? '100';

/**
 * REFUSE A PORT SOMEONE ELSE IS ON. A second anvil cannot bind an occupied port, so without this
 * the spawn below fails, the readiness probe answers from whatever is ALREADY listening, and the
 * whole suite runs against a stranger's node. That is not hypothetical: a day-old fork left on
 * 8545 still serves the pre-upgrade contract implementations, so every write test asserts against
 * yesterday's chain and reports it as a contract bug. An occupied port is an unknown node, and an
 * unknown node is not a fork of anything you chose.
 */
const occupied = await fetch(rpc, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
})
  .then((r) => r.ok)
  .catch(() => false);
if (occupied) {
  console.error(`${rpc} is already serving. Stop it, or set ANVIL_PORT to a free port.`);
  console.error('Refusing to test against a node this script did not start.');
  process.exit(1);
}

async function ready(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      });
      if (r.ok) return;
    } catch {
      // anvil not listening yet
    }
    await Bun.sleep(250);
  }
  throw new Error('anvil did not come up');
}

const spawnAnvil = (forkUrl: string) =>
  Bun.spawn(
    [
      'anvil', '--fork-url', forkUrl, '--port', String(port), '--silent',
      '--chain-id', String(cfg.chainId),
      '--compute-units-per-second', cups,
      '--retries', '10',
      '--fork-retry-backoff', '2',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );

let anvil: ReturnType<typeof spawnAnvil> | undefined;
let forkUrl = '';
for (const url of forkUrls) {
  const candidate = spawnAnvil(url);
  // anvil exits at once on an endpoint it cannot read; a good one stays up and answers.
  const up = await Promise.race([ready().then(() => true, () => false), candidate.exited.then(() => false)]);
  if (up) {
    anvil = candidate;
    forkUrl = url;
    break;
  }
  candidate.kill();
  console.error(`anvil could not fork ${url}, trying the next endpoint`);
}
if (!anvil) {
  console.error('no endpoint in the config answered; set BTR_FORK_URL');
  process.exit(1);
}

// `process.exit` skips `finally`, which left a fork running on the port after every green run and
// made the next run refuse it. Exit only once anvil is down.
let code = 1;
try {
  console.log(`anvil forking ${forkUrl} at ${rpc}\n`);
  const test = Bun.spawn(['bun', 'test', 'test/fork', ...Bun.argv.slice(2)], {
    env: { ...process.env, BTR_RPC_URL: rpc, BTR_PRIVATE_KEY: ANVIL_KEY },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  code = await test.exited;
} finally {
  anvil.kill();
}
process.exit(code);
