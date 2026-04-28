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

type Capture = {
  methods: string[];
  logsCount: number;
  ethCallTargets: string[];
};

function makeServer(opts: {
  nativeBalance: bigint;
  multicallRows: Array<{ success: boolean; returnData: Hex }>;
}): { url: string; stop: () => void; capture: Capture } {
  const capture: Capture = { methods: [], logsCount: 0, ethCallTargets: [] };
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as {
        id: number;
        method: string;
        params: unknown[];
      };
      capture.methods.push(body.method);

      if (body.method === "eth_getBalance") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: "0x" + opts.nativeBalance.toString(16),
        });
      }
      if (body.method === "eth_blockNumber") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x3e8" });
      }
      if (body.method === "eth_getLogs") {
        capture.logsCount++;
        return Response.json({ jsonrpc: "2.0", id: body.id, result: [] });
      }
      if (body.method === "eth_call") {
        const params = body.params as [
          { to: string; data: string },
          string,
          Record<string, { code: string }>?
        ];
        capture.ethCallTargets.push(params[0].to.toLowerCase());
        const hasStateOverride =
          params.length >= 3 && typeof params[2] === "object" && params[2] !== null;
        if (hasStateOverride) {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "state override not supported" },
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: encodeAggregate3Output(opts.multicallRows),
        });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: "method not found" },
      });
    },
  });
  return { url: `http://localhost:${srv.port}`, stop: () => srv.stop(), capture };
}

const OWNER = "0xabc0000000000000000000000000000000000000" as Address;
const TOKEN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;

describe("assetTypeFilter", () => {
  test("'native' skips discovery and token reads", async () => {
    const { url, stop, capture } = makeServer({
      nativeBalance: 1_000_000_000_000_000_000n,
      multicallRows: [],
    });
    const entries = await getAssets(OWNER, {
      rpcUrl: url,
      assetTypeFilter: "native",
      fromBlock: 0n,
      maxLogRange: 10_000,
    });
    stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe("native");
    expect(capture.methods).toContain("eth_getBalance");
    expect(capture.methods).not.toContain("eth_getLogs");
    expect(capture.methods).not.toContain("eth_call");
    expect(capture.methods).not.toContain("eth_blockNumber");
  });

  test("'erc20' skips eth_getBalance and omits native from output", async () => {
    const rows = [
      { success: true, returnData: uint256Hex(100n) },
      { success: true, returnData: uint256Hex(6n) },
      { success: true, returnData: stringReturnData("Alpha") },
      { success: true, returnData: stringReturnData("ALPHA") },
      { success: true, returnData: uint256Hex(0n) },
    ];
    const { url, stop, capture } = makeServer({
      nativeBalance: 1_000_000_000_000_000_000n,
      multicallRows: rows,
    });
    const entries = await getAssets(OWNER, {
      rpcUrl: url,
      assetTypeFilter: "erc20",
      assetFilter: [TOKEN_A],
    });
    stop();

    expect(capture.methods).not.toContain("eth_getBalance");
    expect(entries.every((e) => e.type === "erc20")).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.address).toBe(TOKEN_A.toLowerCase() as Address);
  });
});

describe("assetFilter", () => {
  test("skips log discovery and reads only the given tokens", async () => {
    const rows = [
      // Token A
      { success: true, returnData: uint256Hex(100n) },
      { success: true, returnData: uint256Hex(6n) },
      { success: true, returnData: stringReturnData("Alpha") },
      { success: true, returnData: stringReturnData("ALPHA") },
      { success: true, returnData: uint256Hex(0n) },
      // Token B
      { success: true, returnData: uint256Hex(200n) },
      { success: true, returnData: uint256Hex(18n) },
      { success: true, returnData: stringReturnData("Beta") },
      { success: true, returnData: stringReturnData("BETA") },
      { success: true, returnData: uint256Hex(0n) },
    ];
    const { url, stop, capture } = makeServer({
      nativeBalance: 0n,
      multicallRows: rows,
    });
    const entries = await getAssets(OWNER, {
      rpcUrl: url,
      assetFilter: [TOKEN_A, TOKEN_B],
    });
    stop();

    expect(capture.methods).not.toContain("eth_getLogs");
    expect(capture.logsCount).toBe(0);
    expect(entries.map((e) => e.address)).toEqual([
      TOKEN_A.toLowerCase() as Address,
      TOKEN_B.toLowerCase() as Address,
    ]);
  });

  test("includes native when assetFilter is set without type filter", async () => {
    const rows = [
      { success: true, returnData: uint256Hex(100n) },
      { success: true, returnData: uint256Hex(6n) },
      { success: true, returnData: stringReturnData("Alpha") },
      { success: true, returnData: stringReturnData("ALPHA") },
      { success: true, returnData: uint256Hex(0n) },
    ];
    const { url, stop } = makeServer({
      nativeBalance: 5n,
      multicallRows: rows,
    });
    const entries = await getAssets(OWNER, {
      rpcUrl: url,
      assetFilter: [TOKEN_A],
    });
    stop();

    expect(entries[0]?.type).toBe("native");
    expect(entries[1]?.type).toBe("erc20");
    expect(entries[1]?.address).toBe(TOKEN_A.toLowerCase() as Address);
  });
});
