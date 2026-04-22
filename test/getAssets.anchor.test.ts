import { describe, test, expect, beforeEach } from "bun:test";
import { getAssets, type Address } from "../src";
import { clearDeploymentBlockCache } from "../src/deployBlock";

type Capture = { logsFromBlocks: bigint[] };

function mockRpc(opts: {
  deployedAt: bigint;
  latest: bigint;
  chainId?: string;
}): { url: string; stop: () => void; capture: Capture } {
  const chainId = opts.chainId ?? "0x1";
  const capture: Capture = { logsFromBlocks: [] };
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { id: number; method: string; params: unknown[] };

      if (body.method === "eth_chainId") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: chainId });
      }
      if (body.method === "eth_blockNumber") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: "0x" + opts.latest.toString(16),
        });
      }
      if (body.method === "eth_getBalance") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x0" });
      }
      if (body.method === "eth_getCode") {
        const blockHex = (body.params as [string, string])[1];
        const block = BigInt(blockHex);
        const code = block >= opts.deployedAt ? "0x6080604052" : "0x";
        return Response.json({ jsonrpc: "2.0", id: body.id, result: code });
      }
      if (body.method === "eth_getLogs") {
        const p = (body.params as [{ fromBlock: string; toBlock: string }])[0];
        capture.logsFromBlocks.push(BigInt(p.fromBlock));
        return Response.json({ jsonrpc: "2.0", id: body.id, result: [] });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: "method not found" },
      });
    },
  });
  return {
    url: `http://localhost:${srv.port}`,
    stop: () => srv.stop(),
    capture,
  };
}

const OWNER = "0xabc0000000000000000000000000000000000000" as Address;
const ANCHOR = "0x5803c076563c85799989d42fc00292a8ae52fa9e" as Address;

beforeEach(() => clearDeploymentBlockCache());

describe("getAssets with anchorContract", () => {
  test("uses the anchor's deployment block as fromBlock when fromBlock is unset", async () => {
    const { url, stop, capture } = mockRpc({ deployedAt: 1_000n, latest: 10_000n });
    await getAssets(OWNER, { rpcUrl: url, anchorContract: ANCHOR, maxLogRange: 10_000 });
    expect(capture.logsFromBlocks.length).toBeGreaterThan(0);
    expect(capture.logsFromBlocks[0]).toBe(1_000n);
    stop();
  });

  test("explicit fromBlock takes precedence over the anchor", async () => {
    const { url, stop, capture } = mockRpc({ deployedAt: 1_000n, latest: 10_000n });
    await getAssets(OWNER, {
      rpcUrl: url,
      anchorContract: ANCHOR,
      fromBlock: 2_500n,
      maxLogRange: 10_000,
    });
    expect(capture.logsFromBlocks[0]).toBe(2_500n);
    stop();
  });

  test("falls back to fromBlock=0 when no anchor is given", async () => {
    const { url, stop, capture } = mockRpc({ deployedAt: 1_000n, latest: 10_000n });
    await getAssets(OWNER, { rpcUrl: url, maxLogRange: 10_000 });
    expect(capture.logsFromBlocks[0]).toBe(0n);
    stop();
  });
});
