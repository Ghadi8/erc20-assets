import { describe, test, expect } from "bun:test";
import { findFirstActiveBlock } from "../src/bounds";
import { RpcClient } from "../src/rpc";

function fakeRpc(opts: { latest: bigint; firstActive: bigint | null; rejectHistorical?: boolean }) {
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { id: number; method: string; params: unknown[] };
      if (body.method === "eth_blockNumber") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x" + opts.latest.toString(16) });
      }
      const [, blockHex] = body.params as [string, string];
      const block = blockHex === "latest" ? opts.latest : BigInt(blockHex);
      if (opts.rejectHistorical && block < opts.latest) {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32000, message: "missing trie node — historical state pruned" },
        });
      }
      const active = opts.firstActive !== null && block >= opts.firstActive;
      return Response.json({ jsonrpc: "2.0", id: body.id, result: active ? "0x1" : "0x0" });
    },
  });
  return { rpc: new RpcClient(`http://localhost:${srv.port}`), stop: () => srv.stop() };
}

describe("findFirstActiveBlock", () => {
  test("returns hasHistory=false when address is inactive at latest", async () => {
    const { rpc, stop } = fakeRpc({ latest: 10_000n, firstActive: null });
    const b = await findFirstActiveBlock(rpc, "0xabc0000000000000000000000000000000000000");
    expect(b.hasHistory).toBe(false);
    stop();
  });

  test("finds first-active block via binary search", async () => {
    const { rpc, stop } = fakeRpc({ latest: 10_000n, firstActive: 4_321n });
    const b = await findFirstActiveBlock(rpc, "0xabc0000000000000000000000000000000000000");
    expect(b.hasHistory).toBe(true);
    expect(b.fromBlock).toBe(4_321n);
    stop();
  });

  test("falls back to latest - safeLookback when historical state unavailable", async () => {
    const { rpc, stop } = fakeRpc({ latest: 10_000_000n, firstActive: 1n, rejectHistorical: true });
    const b = await findFirstActiveBlock(rpc, "0xabc0000000000000000000000000000000000000", {
      safeLookback: 2_000_000n,
    });
    expect(b.hasHistory).toBe(true);
    expect(b.fromBlock).toBe(8_000_000n);
    stop();
  });
});
