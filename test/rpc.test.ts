import { describe, test, expect } from "bun:test";
import { RpcClient, RpcError, isRangeTooLarge, isStateOverrideUnsupported } from "../src/rpc";

describe("RpcClient", () => {
  test("call returns result on success", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { id: number; method: string };
        return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x1" });
      },
    });
    const c = new RpcClient(`http://localhost:${srv.port}`);
    expect(await c.call<string>("eth_blockNumber", [])).toBe("0x1");
    srv.stop();
  });

  test("call throws RpcError on error response", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { id: number };
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32005, message: "query returned more than 10000 results" },
        });
      },
    });
    const c = new RpcClient(`http://localhost:${srv.port}`);
    let err: unknown;
    try { await c.call("eth_getLogs", [{}]); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(-32005);
    expect(isRangeTooLarge(err as RpcError)).toBe(true);
    srv.stop();
  });

  test("batch returns per-call results in input order", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const reqs = (await req.json()) as { id: number; method: string }[];
        return Response.json(
          reqs.map((r) => ({ jsonrpc: "2.0", id: r.id, result: r.method }))
        );
      },
    });
    const c = new RpcClient(`http://localhost:${srv.port}`);
    const results = await c.batch([
      { method: "a", params: [] },
      { method: "b", params: [] },
    ]);
    expect(results).toEqual([
      { ok: true, result: "a" },
      { ok: true, result: "b" },
    ]);
    srv.stop();
  });

  test("call retries on 500 then succeeds", async () => {
    let hits = 0;
    const srv = Bun.serve({
      port: 0,
      fetch: async (req) => {
        hits++;
        if (hits === 1) return new Response("bad", { status: 500 });
        const body = (await req.json()) as { id: number };
        return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x42" });
      },
    });
    const c = new RpcClient(`http://localhost:${srv.port}`);
    expect(await c.call<string>("eth_chainId", [])).toBe("0x42");
    expect(hits).toBe(2);
    srv.stop();
  });

  test("isStateOverrideUnsupported matches common error shapes", () => {
    expect(isStateOverrideUnsupported(new RpcError(-32000, "state override not supported"))).toBe(true);
    expect(isStateOverrideUnsupported(new RpcError(-32601, "method eth_call requires 2 params"))).toBe(false);
  });

  test("persistent HTTP 5xx error includes method and params in message", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: () => new Response("boom", { status: 500 }),
    });
    const c = new RpcClient(`http://localhost:${srv.port}`);
    let err: unknown;
    try {
      await c.call("eth_getCode", ["0xcafecafecafecafecafecafecafecafecafecafe", "0x2faf080"]);
    } catch (e) {
      err = e;
    }
    const msg = (err as Error).message;
    expect(msg).toContain("eth_getCode");
    expect(msg).toContain("0x2faf080");
    expect(msg).toContain("500");
    srv.stop();
  });

  test("persistent HTTP 5xx error for batch includes batch methods in message", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: () => new Response("boom", { status: 503 }),
    });
    const c = new RpcClient(`http://localhost:${srv.port}`);
    let err: unknown;
    try {
      await c.batch([
        { method: "eth_call", params: [] },
        { method: "eth_getBalance", params: [] },
      ]);
    } catch (e) {
      err = e;
    }
    const msg = (err as Error).message;
    expect(msg).toContain("batch");
    expect(msg).toContain("eth_call");
    expect(msg).toContain("eth_getBalance");
    expect(msg).toContain("503");
    srv.stop();
  });
});
