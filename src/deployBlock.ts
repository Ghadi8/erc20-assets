import type { Hex } from "viem";
import type { RpcClient } from "./rpc";

const cache = new Map<string, bigint | null>();

function cacheKey(chainId: string, contract: string): string {
  return `${chainId.toLowerCase()}|${contract.toLowerCase()}`;
}

function toBlockTag(n: bigint): string {
  return "0x" + n.toString(16);
}

function hasCode(code: Hex): boolean {
  return code !== "0x" && code !== "0x0";
}

export async function resolveDeploymentBlock(
  rpc: RpcClient,
  contract: Hex,
  latest: bigint
): Promise<bigint | null> {
  const chainId = await rpc.call<Hex>("eth_chainId", []);
  const key = cacheKey(chainId, contract);
  if (cache.has(key)) return cache.get(key)!;

  const latestCode = await rpc.call<Hex>("eth_getCode", [contract, toBlockTag(latest)]);
  if (!hasCode(latestCode)) {
    cache.set(key, null);
    return null;
  }

  let lo = 0n;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const code = await rpc.call<Hex>("eth_getCode", [contract, toBlockTag(mid)]);
    if (hasCode(code)) hi = mid;
    else lo = mid + 1n;
  }

  cache.set(key, lo);
  return lo;
}

export function clearDeploymentBlockCache(): void {
  cache.clear();
}
