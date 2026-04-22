import { describe, test, expect, beforeEach } from "bun:test";
import { resolveDeploymentBlock, clearDeploymentBlockCache } from "../src/deployBlock";
import { RpcClient } from "../src/rpc";

type Server = { rpc: RpcClient; stop: () => void };

function codeServer(opts: {
  chainId?: string;
  deployedAt: bigint | null;
  onRequest?: (method: string) => void;
}): Server {
  const chainId = opts.chainId ?? "0x1";
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { id: number; method: string; params: unknown[] };
      opts.onRequest?.(body.method);

      if (body.method === "eth_chainId") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: chainId });
      }
      if (body.method === "eth_getCode") {
        const blockHex = (body.params as [string, string])[1];
        const block = BigInt(blockHex);
        if (opts.deployedAt === null) {
          return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x" });
        }
        const code = block >= opts.deployedAt ? "0x6080604052" : "0x";
        return Response.json({ jsonrpc: "2.0", id: body.id, result: code });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: "method not found" },
      });
    },
  });
  return { rpc: new RpcClient(`http://localhost:${srv.port}`), stop: () => srv.stop() };
}

beforeEach(() => clearDeploymentBlockCache());

describe("resolveDeploymentBlock", () => {
  test("returns the earliest block where code becomes non-empty", async () => {
    const { rpc, stop } = codeServer({ deployedAt: 1234n });
    const result = await resolveDeploymentBlock(
      rpc,
      "0xcafecafecafecafecafecafecafecafecafecafe",
      10_000n
    );
    expect(result).toBe(1234n);
    stop();
  });

  test("returns null when contract is not deployed at latest", async () => {
    const { rpc, stop } = codeServer({ deployedAt: null });
    const result = await resolveDeploymentBlock(
      rpc,
      "0xcafecafecafecafecafecafecafecafecafecafe",
      10_000n
    );
    expect(result).toBe(null);
    stop();
  });

  test("returns 0 when contract existed at genesis", async () => {
    const { rpc, stop } = codeServer({ deployedAt: 0n });
    const result = await resolveDeploymentBlock(
      rpc,
      "0xcafecafecafecafecafecafecafecafecafecafe",
      10_000n
    );
    expect(result).toBe(0n);
    stop();
  });

  test("caches per (chainId, contract) across calls", async () => {
    let getCodeCalls = 0;
    const { rpc, stop } = codeServer({
      deployedAt: 500n,
      onRequest: (m) => {
        if (m === "eth_getCode") getCodeCalls++;
      },
    });
    const addr = "0xcafecafecafecafecafecafecafecafecafecafe";
    await resolveDeploymentBlock(rpc, addr, 10_000n);
    const firstRun = getCodeCalls;
    await resolveDeploymentBlock(rpc, addr, 10_000n);
    expect(getCodeCalls).toBe(firstRun);
    stop();
  });

  test("uses O(log N) RPC calls for the binary search", async () => {
    let getCodeCalls = 0;
    const { rpc, stop } = codeServer({
      deployedAt: 1_000_000n,
      onRequest: (m) => {
        if (m === "eth_getCode") getCodeCalls++;
      },
    });
    const result = await resolveDeploymentBlock(
      rpc,
      "0xcafecafecafecafecafecafecafecafecafecafe",
      25_000_000n
    );
    expect(result).toBe(1_000_000n);
    // log2(25M) ≈ 25, plus 1 sanity check at latest = ~26. Allow generous upper bound.
    expect(getCodeCalls).toBeLessThanOrEqual(30);
    stop();
  });
});
