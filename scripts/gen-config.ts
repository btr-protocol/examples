#!/usr/bin/env bun
/**
 * Generate `config/<chainId>.json` from the dex-evm deployment records. Nothing in `config/` is
 * hand-written: re-run this after a redeploy.
 *
 * Usage:
 *   bun scripts/gen-config.ts <chainId> [path/to/dex-evm/deployments]
 *   BTR_DEPLOYMENTS=path/to/dex-evm/deployments bun scripts/gen-config.ts <chainId>
 *
 * Reads, from the deployments directory:
 *   chains.json              chainId -> slug, and the public RPC rows (`rpc`)
 *   <chainId>.deploy.json    feed ids
 *   <chainId>.pools.json     PoolFactory, Router, faucet, every pool and the legs it holds
 *   <slug>.manifest.json     tokens (address, decimals) and each asset's class
 * and `scripts/calendars.json`, the one fact no record carries: which assets follow the US cash
 * session, i.e. where a stale feed is a closed market rather than an outage.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const chainId = Number(process.argv[2]);
const dir = resolve(process.argv[3] ?? process.env.BTR_DEPLOYMENTS ?? '');
if (!Number.isInteger(chainId) || !process.argv[3] && !process.env.BTR_DEPLOYMENTS) {
  console.error('usage: bun scripts/gen-config.ts <chainId> <dex-evm/deployments dir>  (or set BTR_DEPLOYMENTS)');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => {
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
};

const chains = read(join(dir, 'chains.json'));
const slug: string | undefined = chains.slugs?.[chainId];
if (!slug) throw new Error(`chains.json has no slug for chain ${chainId}`);

const deploy = read(join(dir, `${chainId}.deploy.json`));
const pools = read(join(dir, `${chainId}.pools.json`));
const manifest = read(join(dir, `${slug}.manifest.json`));
const { usEquity } = read(join(here, 'calendars.json')) as { usEquity: string[] };

if (deploy.poolFactory !== pools.poolFactory) throw new Error('deploy.json and pools.json disagree on poolFactory');

const rows = ((chains.rpc?.[chainId] ?? []) as (string | { url: string; paid?: boolean })[])
  .map((r) => (typeof r === 'string' ? { url: r } : r))
  .filter((r) => !('paid' in r && r.paid));
if (rows.length === 0) throw new Error(`chains.json has no free rpc row for chain ${chainId}`);

const feedIdOf = (feedKey: string): string | undefined => deploy.feeds?.[feedKey]?.feedId;

const baseSymbol = Object.entries(manifest.pools as Record<string, { base?: string }>)
  .map(([, p]) => p?.base)
  .find(Boolean) as string;

const tokens: Record<string, { address: string; decimals: number; class: string }> = {};
const feeds: Record<string, string> = {};
for (const [symbol, t] of Object.entries(manifest.tokens as Record<string, { addr?: string; decimals?: number; symbol?: string }>)) {
  if (!t || typeof t !== 'object' || !t.addr) continue; // `_doc`
  const cls = manifest.assets?.[symbol]?.cls ?? 'volatile';
  tokens[symbol] = {
    address: t.addr,
    decimals: t.decimals as number,
    class: usEquity.includes(symbol) ? 'equity' : cls,
  };
  // A token's feed is keyed by its own symbol, or by `<SYMBOL>-USD` for the unit of account.
  const id = feedIdOf(symbol) ?? feedIdOf(`${t.symbol}-USD`);
  if (id) feeds[symbol] = id;
}

const poolsOut: Record<string, { address: string; assets: string[] }> = {};
for (const key of Object.keys(pools)) {
  const receipts = pools[`${key}Receipts`];
  if (!receipts) continue;
  const assets = Object.keys(receipts);
  for (const a of assets) if (!tokens[a]) throw new Error(`pool ${key} holds ${a}, which the manifest does not list`);
  poolsOut[key] = { address: pools[key], assets };
}
if (!tokens[baseSymbol]) throw new Error(`base ${baseSymbol} is not a manifest token`);

const out = {
  name: `${slug[0].toUpperCase()}${slug.slice(1)} ${manifest.chain.class}`,
  chainId,
  rpcUrls: rows.slice(0, 3).map((r) => r.url),
  nativeSymbol: manifest.chain.nativeSymbol,
  manifestHash: pools.manifestHash,
  contracts: {
    poolFactory: pools.poolFactory,
    router: pools.router,
    ...(/^0x0+$/.test(pools.faucet ?? '0x0') ? {} : { faucet: pools.faucet }),
  },
  baseToken: baseSymbol,
  tokens,
  feeds,
  calendars: { usEquity: usEquity.filter((s) => s in tokens) },
  pools: poolsOut,
};

const path = join(here, '..', 'config', `${chainId}.json`);
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${path} (${Object.keys(poolsOut).length} pools, ${Object.keys(tokens).length} tokens, ${Object.keys(feeds).length} feeds)`);
