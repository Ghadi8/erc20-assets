import { describe, test, expect } from "bun:test";
import { readTokenData } from "../src/readBalances";
import { RpcClient } from "../src/rpc";
import { encodeAbiParameters, stringToHex, padHex } from "viem";

describe("readTokenData (multicall3 fallback)", () => {
  test("decodes balance/decimals/name/symbol via aggregate3 when state override is rejected", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { id: number; method: string; params: unknown[] };
        if (body.method !== "eth_call") {
          return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not supported" } });
        }
        const [, , overrides] = body.params as [unknown, string, unknown?];
        if (overrides) {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "state override not supported" },
          });
        }
        const ret = encodeAbiParameters(
          [{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }],
          [[
            [true, padHex("0x64", { size: 32 })],
            [true, padHex("0x06", { size: 32 })],
            [true, encodeAbiParameters([{ type: "string" }], ["USD Coin"])],
            [true, encodeAbiParameters([{ type: "string" }], ["USDC"])],
            [true, padHex("0x00", { size: 32 })],
          ]]
        );
        return Response.json({ jsonrpc: "2.0", id: body.id, result: ret });
      },
    });
    const rpc = new RpcClient(`http://localhost:${srv.port}`);
    const tokens = await readTokenData(
      rpc,
      "0xabc0000000000000000000000000000000000000",
      ["0x1111111111111111111111111111111111111111"]
    );
    expect(tokens).toEqual([
      {
        address: "0x1111111111111111111111111111111111111111",
        balance: 100n,
        decimals: 6,
        name: "USD Coin",
        symbol: "USDC",
        isNonFungible: false,
      },
    ]);
    srv.stop();
  });

  test("decodes bytes32 legacy name/symbol (MKR-style)", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { id: number; method: string; params: unknown[] };
        const [, , overrides] = body.params as [unknown, string, unknown?];
        if (overrides) {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "state override not supported" },
          });
        }
        const asciiMkr = stringToHex("MKR");
        const padded = `${asciiMkr}${"00".repeat(29)}`;
        const ret = encodeAbiParameters(
          [{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }],
          [[
            [true, padHex("0x0a", { size: 32 })],
            [true, padHex("0x12", { size: 32 })],
            [true, padded as `0x${string}`],
            [true, padded as `0x${string}`],
            [true, padHex("0x00", { size: 32 })],
          ]]
        );
        return Response.json({ jsonrpc: "2.0", id: body.id, result: ret });
      },
    });
    const rpc = new RpcClient(`http://localhost:${srv.port}`);
    const tokens = await readTokenData(rpc, "0xabc0000000000000000000000000000000000000", ["0x1111111111111111111111111111111111111111"]);
    expect(tokens[0]!.name).toBe("MKR");
    expect(tokens[0]!.symbol).toBe("MKR");
    expect(tokens[0]!.decimals).toBe(18);
    expect(tokens[0]!.balance).toBe(10n);
  });
});
