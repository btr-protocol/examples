/**
 * Fork-only helpers. NOTHING here belongs in an integration: this is how a TEST gets tokens
 * without a funded key.
 *
 * `deal` writes the ERC-20 balance slot directly through `anvil_setStorageAt`. The slot is not
 * known up front, so it is discovered the way forge's `deal` cheatcode does it: try each of the
 * first few storage slots as the balances mapping, write a probe value, and see whether
 * `balanceOf` changes. Generic over any standard Solidity ERC-20, so no token address or slot
 * number is hardcoded anywhere in this repository.
 */
import { encodeFunctionData, toHex } from 'viem';
import { withRetry, type Address } from '../../src/config.ts';
import { publicClient, ERC20_ABI, walletClient } from '../../src/viem-client.ts';

/**
 * Every call here is a READ or an anvil cheat against a LOCAL fork, and both are idempotent, so
 * both are safe to retry. They still need it: anvil serves a cache miss by asking the upstream
 * endpoint, and a public endpoint answers 429. A 429 that reaches a test reads as "the token has
 * no code" or "the pool returned nothing", which is a failed read wearing an empty read's
 * clothes. Retrying is the only answer that does not certify a lie.
 */
const rpc = (method: string, params: unknown[]) =>
  withRetry(async () => {
    const r = await fetch(publicClient.transport.url as string, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = (await r.json()) as { error?: { message: string }; result?: unknown };
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  });

/** Deliberately NOT retried: the probe below expects this to fail on the wrong slot. */
const balanceOf = (token: Address, owner: Address) =>
  publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });

const cache = new Map<string, `0x${string}`>();

/**
 * Find the storage slot holding `owner`'s balance, WITHOUT guessing the mapping's position.
 *
 * `eth_createAccessList` reports every slot a call touches, so simulating `balanceOf(owner)` and
 * reading back the access list names the slot directly. Guessing `keccak256(owner . i)` for small
 * `i` is the usual trick and it fails on any token with a namespaced layout (ERC-7201 and friends),
 * which is most modern ones. This works on all of them.
 */
async function findBalanceSlot(token: Address, owner: Address): Promise<`0x${string}`> {
  const hit = cache.get(`${token}:${owner}`.toLowerCase());
  if (hit) return hit;

  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
  const list = (await rpc('eth_createAccessList', [{ to: token, data }, 'latest'])) as {
    accessList: { address: Address; storageKeys: `0x${string}`[] }[];
  };
  const keys = list.accessList
    .filter((e) => e.address.toLowerCase() === token.toLowerCase())
    .flatMap((e) => e.storageKeys);
  if (keys.length === 0) throw new Error(`balanceOf(${owner}) on ${token} touched no storage`);

  const probe = 0x1234_5678n;
  for (const key of keys) {
    const before = (await rpc('eth_getStorageAt', [token, key, 'latest'])) as string;
    await rpc('anvil_setStorageAt', [token, key, toHex(probe, { size: 32 })]);
    // `balanceOf` can FAIL rather than return here, and that is a hit on a slot we should skip,
    // not an error. Most of these tokens are proxies, so the access list also names the ERC-1967
    // implementation pointer; overwriting it makes the delegatecall land on an empty address and
    // `balanceOf` comes back as `0x`. The write is undone on the next line either way, so the
    // only correct response is to move on to the next candidate. Not catching this is why the
    // 6-decimal FX leg could not be funded at all.
    let changed = false;
    try {
      changed = (await balanceOf(token, owner)) === probe;
    } catch {
      changed = false;
    }
    await rpc('anvil_setStorageAt', [token, key, before]);
    if (changed) {
      cache.set(`${token}:${owner}`.toLowerCase(), key);
      return key;
    }
  }
  throw new Error(`could not locate the balance slot for ${token}`);
}

export async function deal(token: Address, owner: Address, amount: bigint) {
  const key = await findBalanceSlot(token, owner);
  await rpc('anvil_setStorageAt', [token, key, toHex(amount, { size: 32 })]);
}

export async function approve(token: Address, spender: Address, amount: bigint) {
  if (!walletClient) throw new Error('fork tests need BTR_PRIVATE_KEY; run them via bun run test:fork');
  const hash = await walletClient.writeContract({
    address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

/** Advance the fork clock. Needed for the anti-JIT withdraw cooldown. */
export async function warp(seconds: number) {
  await rpc('evm_increaseTime', [seconds]);
  await rpc('evm_mine', []);
}

export const snapshot = () => rpc('evm_snapshot', []) as Promise<string>;
export const revert = (id: string) => rpc('evm_revert', [id]);
