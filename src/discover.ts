import { pad, type Hex } from "viem";
import { RpcClient, RpcError, isRangeTooLarge } from "./rpc";
import type { Bounds } from "./bounds";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

type Log = { address: Hex };
type Opts = { maxLogRange: number; concurrency?: number };

export async function discoverTokens(
  rpc: RpcClient,
  address: Hex,
  bounds: Bounds,
  opts: Opts
): Promise<Hex[]> {
  if (!bounds.hasHistory) return [];
  const concurrency = opts.concurrency ?? 5;
  const topic2 = pad(address.toLowerCase() as Hex, { size: 32 });

  const windows: Array<[bigint, bigint]> = [];
  const max = BigInt(opts.maxLogRange);
  let cursor = bounds.fromBlock;
  while (cursor <= bounds.latest) {
    const end = cursor + max - 1n > bounds.latest ? bounds.latest : cursor + max - 1n;
    windows.push([cursor, end]);
    cursor = end + 1n;
  }

  const found = new Set<string>();

  async function scan(from: bigint, to: bigint): Promise<void> {
    try {
      const logs = await rpc.call<Log[]>("eth_getLogs", [
        {
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
          topics: [TRANSFER_TOPIC, null, topic2],
        },
      ]);
      for (const l of logs) found.add(l.address.toLowerCase());
    } catch (e) {
      if (e instanceof RpcError && isRangeTooLarge(e) && to > from) {
        const mid = from + (to - from) / 2n;
        await scan(from, mid);
        await scan(mid + 1n, to);
        return;
      }
      throw e;
    }
  }

  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, windows.length) }, async () => {
    while (idx < windows.length) {
      const my = idx++;
      const [from, to] = windows[my]!;
      await scan(from, to);
    }
  });
  await Promise.all(workers);

  return Array.from(found) as Hex[];
}
