import { describe, test, expect } from "bun:test";
import { discoverTokens } from "../src/discover";
import { RpcClient } from "../src/rpc";

function logServer(opts: { tokensByRange: (from: bigint, to: bigint) => string[]; maxRange?: bigint }) {
  const max = opts.maxRange ?? 10_000n;
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { id: number; method: string; params: [{ fromBlock: string; toBlock: string }] };
      const { fromBlock, toBlock } = body.params[0];
      const from = BigInt(fromBlock);
      const to = BigInt(toBlock);
      if (to - from + 1n > max) {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32005, message: "query returned too large a range" },
        });
      }
      const tokens = opts.tokensByRange(from, to);
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: tokens.map((t) => ({
          address: t,
          topics: [],
          data: "0x",
          blockNumber: "0x" + from.toString(16),
          transactionHash: "0x" + "0".repeat(64),
          transactionIndex: "0x0",
          blockHash: "0x" + "0".repeat(64),
          logIndex: "0x0",
          removed: false,
        })),
      });
    },
  });
  return { rpc: new RpcClient(`http://localhost:${srv.port}`), stop: () => srv.stop() };
}

describe("discoverTokens", () => {
  test("returns unique lowercased addresses across windows", async () => {
    const { rpc, stop } = logServer({
      tokensByRange: (from) =>
        from < 5_000n
          ? ["0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa"]
          : ["0xAAAaaaaaaaAAAAAAAAAaaaaaaAAAAAAAAAAaAAAa", "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb"],
    });
    const tokens = await discoverTokens(
      rpc,
      "0xabc0000000000000000000000000000000000000",
      0n,
      15_000n,
      { maxLogRange: 10_000 }
    );
    expect(tokens.sort()).toEqual([
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
    stop();
  });

  test("halves window and retries on range-too-large", async () => {
    const { rpc, stop } = logServer({
      maxRange: 2_500n,
      tokensByRange: () => ["0x1111111111111111111111111111111111111111"],
    });
    const tokens = await discoverTokens(
      rpc,
      "0xabc0000000000000000000000000000000000000",
      0n,
      10_000n,
      { maxLogRange: 10_000 }
    );
    expect(tokens).toEqual(["0x1111111111111111111111111111111111111111"]);
    stop();
  });

  test("returns [] when latest < fromBlock", async () => {
    const { rpc, stop } = logServer({ tokensByRange: () => [] });
    const tokens = await discoverTokens(
      rpc,
      "0xabc0000000000000000000000000000000000000",
      100n,
      10n,
      { maxLogRange: 10_000 }
    );
    expect(tokens).toEqual([]);
    stop();
  });
});
