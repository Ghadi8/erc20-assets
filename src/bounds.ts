import type { Hex } from "viem";
import { RpcClient, RpcError, isHistoricalStateMissing } from "./rpc";

export type Bounds = { fromBlock: bigint; latest: bigint; hasHistory: boolean };

type Opts = { safeLookback?: bigint };
const DEFAULT_SAFE_LOOKBACK = 2_000_000n;

async function isActiveAt(rpc: RpcClient, address: Hex, block: bigint | "latest"): Promise<boolean> {
  const tag = block === "latest" ? "latest" : "0x" + block.toString(16);
  const [nonce, balance] = await Promise.all([
    rpc.call<Hex>("eth_getTransactionCount", [address, tag]),
    rpc.call<Hex>("eth_getBalance", [address, tag]),
  ]);
  return BigInt(nonce) > 0n || BigInt(balance) > 0n;
}

export async function findFirstActiveBlock(
  rpc: RpcClient,
  address: Hex,
  opts: Opts = {}
): Promise<Bounds> {
  const safeLookback = opts.safeLookback ?? DEFAULT_SAFE_LOOKBACK;
  const latestHex = await rpc.call<Hex>("eth_blockNumber", []);
  const latest = BigInt(latestHex);

  const activeAtLatest = await isActiveAt(rpc, address, "latest");
  if (!activeAtLatest) return { fromBlock: latest, latest, hasHistory: false };

  try {
    let hi = latest;
    let lo = 0n;
    let step = 1n;
    let foundInactive = false;

    while (true) {
      const probe = latest > step ? latest - step : 0n;
      const active = await isActiveAt(rpc, address, probe);
      if (!active) {
        lo = probe;
        foundInactive = true;
        break;
      }
      hi = probe;
      if (probe === 0n) break;
      step *= 2n;
    }

    if (!foundInactive) return { fromBlock: 0n, latest, hasHistory: true };

    while (hi - lo > 1n) {
      const mid = lo + (hi - lo) / 2n;
      const active = await isActiveAt(rpc, address, mid);
      if (active) hi = mid;
      else lo = mid;
    }
    return { fromBlock: hi, latest, hasHistory: true };
  } catch (e) {
    if (e instanceof RpcError && isHistoricalStateMissing(e)) {
      const from = latest > safeLookback ? latest - safeLookback : 0n;
      return { fromBlock: from, latest, hasHistory: true };
    }
    throw e;
  }
}
