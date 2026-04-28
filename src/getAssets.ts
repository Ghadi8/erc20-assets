import type { Hex } from "viem";
import { RpcClient } from "./rpc";
import { discoverTokens } from "./discover";
import { readTokenData } from "./readBalances";
import { resolveDeploymentBlock } from "./deployBlock";

export type Address = `0x${string}`;

export type ChainConfig = {
  rpcUrl: string;
  maxLogRange?: number;
  fromBlock?: bigint;
  anchorContract?: Address;
  discoverConcurrency?: number;
  assetTypeFilter?: "native" | "erc20";
  assetFilter?: Address[];
};

export type AssetEntry = {
  address: Address | null;
  balance: Hex;
  metadata: { decimals: number; name: string; symbol: string };
  type: "native" | "erc20";
};

function toPaddedHex(v: bigint): Hex {
  const h = v.toString(16);
  return ("0x" + h.padStart(64, "0")) as Hex;
}

export async function getAssets(owner: Address, cfg: ChainConfig): Promise<AssetEntry[]> {
  const rpc = new RpcClient(cfg.rpcUrl);
  const maxLogRange = cfg.maxLogRange ?? 10_000;

  const skipNative = cfg.assetTypeFilter === "erc20";
  const skipErc20 = cfg.assetTypeFilter === "native";
  const explicitTokens =
    cfg.assetFilter && cfg.assetFilter.length > 0 ? cfg.assetFilter : null;
  const needsDiscovery = !skipErc20 && !explicitTokens;

  const nativePromise = skipNative
    ? Promise.resolve("0x0" as Hex)
    : rpc.call<Hex>("eth_getBalance", [owner, "latest"]);
  const latestPromise = needsDiscovery
    ? rpc.call<Hex>("eth_blockNumber", [])
    : Promise.resolve("0x0" as Hex);
  const [nativeBalanceHex, latestHex] = await Promise.all([nativePromise, latestPromise]);

  const entries: AssetEntry[] = [];

  if (!skipNative) {
    const nativeBalance = BigInt(nativeBalanceHex);
    if (nativeBalance > 0n) {
      entries.push({
        address: null,
        balance: toPaddedHex(nativeBalance),
        metadata: { decimals: 18, name: "", symbol: "" },
        type: "native",
      });
    }
  }

  if (skipErc20) return entries;

  let candidates: Hex[];
  if (explicitTokens) {
    candidates = explicitTokens.map((a) => a.toLowerCase()) as Hex[];
  } else {
    const latest = BigInt(latestHex);
    let fromBlock = cfg.fromBlock;
    if (fromBlock === undefined && cfg.anchorContract) {
      const deployBlock = await resolveDeploymentBlock(rpc, cfg.anchorContract, latest);
      if (deployBlock !== null) fromBlock = deployBlock;
    }
    if (fromBlock === undefined) fromBlock = 0n;
    candidates = await discoverTokens(rpc, owner, fromBlock, latest, {
      maxLogRange,
      ...(cfg.discoverConcurrency ? { concurrency: cfg.discoverConcurrency } : {}),
    });
  }
  if (candidates.length === 0) return entries;

  const tokens = await readTokenData(rpc, owner, candidates);
  const nonZero = tokens
    .filter((t) => !t.isNonFungible && t.balance > 0n)
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

  for (const t of nonZero) {
    entries.push({
      address: t.address.toLowerCase() as Address,
      balance: toPaddedHex(t.balance),
      metadata: {
        decimals: t.decimals,
        name: t.name,
        symbol: t.symbol,
      },
      type: "erc20",
    });
  }
  return entries;
}
