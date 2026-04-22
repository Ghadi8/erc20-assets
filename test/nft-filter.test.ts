import { describe, test, expect } from "bun:test";
import { encodeAbiParameters, type Hex } from "viem";
import { getAssets, type Address } from "../src";

function uint256Hex(n: bigint): Hex {
  return ("0x" + n.toString(16).padStart(64, "0")) as Hex;
}

function stringReturnData(s: string): Hex {
  return encodeAbiParameters([{ type: "string" }], [s]) as Hex;
}

function encodeAggregate3Output(
  rows: Array<{ success: boolean; returnData: Hex }>
): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { type: "bool", name: "success" },
          { type: "bytes", name: "returnData" },
        ],
      },
    ],
    [rows]
  ) as Hex;
}

function zeroHash(): string {
  return "0x" + "0".repeat(64);
}

describe("getAssets ERC-721 filter", () => {
  test("drops tokens that report ERC-721 via supportsInterface", async () => {
    const OWNER = "0xabc0000000000000000000000000000000000000" as Address;
    // First log → multicall token A (rows 0..4 below, the ERC-721).
    // Second log → multicall token B (rows 5..9, the ERC-20).
    const TOKEN_ERC721 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TOKEN_ERC20 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const srv = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as {
          id: number;
          method: string;
          params: unknown[];
        };

        if (body.method === "eth_getBalance") {
          return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x0" });
        }
        if (body.method === "eth_blockNumber") {
          return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x3e8" });
        }
        if (body.method === "eth_getLogs") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: [TOKEN_ERC721, TOKEN_ERC20].map((addr) => ({
              address: addr,
              topics: [],
              data: "0x",
              blockNumber: "0x1",
              transactionHash: zeroHash(),
              transactionIndex: "0x0",
              blockHash: zeroHash(),
              logIndex: "0x0",
              removed: false,
            })),
          });
        }
        if (body.method === "eth_call") {
          const params = body.params as [
            { to: string; data: string },
            string,
            Record<string, { code: string }>?
          ];
          const hasStateOverride =
            params.length >= 3 && typeof params[2] === "object" && params[2] !== null;

          if (hasStateOverride) {
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32000, message: "state override not supported" },
            });
          }

          const rows: Array<{ success: boolean; returnData: Hex }> = [
            // Token A = ERC-721 (should be filtered once detection is wired up):
            // balanceOf=3, decimals reverts, name="Bee", symbol="BEE", supportsInterface(0x80ac58cd)=true
            { success: true, returnData: uint256Hex(3n) },
            { success: false, returnData: "0x" },
            { success: true, returnData: stringReturnData("Bee") },
            { success: true, returnData: stringReturnData("BEE") },
            { success: true, returnData: uint256Hex(1n) },
            // Token B = ERC-20 (should remain):
            // balanceOf=100, decimals=6, name="Alpha", symbol="ALPHA", supportsInterface=false
            { success: true, returnData: uint256Hex(100n) },
            { success: true, returnData: uint256Hex(6n) },
            { success: true, returnData: stringReturnData("Alpha") },
            { success: true, returnData: stringReturnData("ALPHA") },
            { success: true, returnData: uint256Hex(0n) },
          ];

          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: encodeAggregate3Output(rows),
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "method not found" },
        });
      },
    });

    const entries = await getAssets(OWNER, {
      rpcUrl: `http://localhost:${srv.port}`,
      fromBlock: 0n,
      maxLogRange: 10_000,
    });

    srv.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe("erc20");
    expect(entries[0]?.address?.toLowerCase()).toBe(TOKEN_ERC20);
    expect(entries[0]?.metadata.symbol).toBe("ALPHA");
  });
});
