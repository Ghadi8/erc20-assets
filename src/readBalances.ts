import {
  encodeAbiParameters,
  decodeAbiParameters,
  encodeFunctionData,
  concat,
  type Hex,
} from "viem";
import { RpcClient, RpcError, isStateOverrideUnsupported } from "./rpc";
import { SCANNER_DEPLOYED_BYTECODE, SCANNER_ADDRESS } from "./scanner.bytecode";
import {
  MULTICALL3_ADDRESS,
  encodeAggregate3,
  decodeAggregate3Result,
  DECIMALS_SELECTOR,
  NAME_SELECTOR,
  SYMBOL_SELECTOR,
  SUPPORTS_INTERFACE_ERC721_CALLDATA,
} from "./multicall3";

export type TokenData = {
  address: Hex;
  balance: bigint;
  decimals: number;
  name: string;
  symbol: string;
  isNonFungible: boolean;
};

// Verified via: bun -e 'import("viem").then(({toFunctionSelector})=>console.log(toFunctionSelector("scan(address,address[])")))'
// Result: 0xac8f1a09
const SCAN_SELECTOR: Hex = "0xac8f1a09";

const SCAN_OUTPUT = [
  {
    type: "tuple[]",
    components: [
      { type: "uint256", name: "balance" },
      { type: "uint8", name: "decimals" },
      { type: "string", name: "name" },
      { type: "string", name: "symbol" },
      { type: "bool", name: "isNonFungible" },
    ],
  },
] as const;

function encodeScan(owner: Hex, tokens: Hex[]): Hex {
  const encoded = encodeAbiParameters(
    [{ type: "address" }, { type: "address[]" }],
    [owner, tokens]
  );
  return concat([SCAN_SELECTOR, encoded]);
}

export function decodeString(data: Hex): string {
  if (data === "0x" || data.length < 4) return "";
  const raw = data.slice(2);
  if (raw.length === 64) {
    // bytes32 legacy (e.g. MKR)
    const bytes: number[] = [];
    for (let i = 0; i < 32; i++) {
      const b = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
      if (b === 0) break;
      bytes.push(b);
    }
    return Buffer.from(bytes).toString("utf8");
  }
  if (raw.length >= 128) {
    try {
      const [s] = decodeAbiParameters([{ type: "string" }], data);
      return s as string;
    } catch {
      return "";
    }
  }
  return "";
}

async function tryScannerPath(
  rpc: RpcClient,
  owner: Hex,
  tokens: Hex[]
): Promise<TokenData[] | "unsupported"> {
  try {
    const callData = encodeScan(owner, tokens);
    const result = await rpc.call<Hex>("eth_call", [
      { to: SCANNER_ADDRESS, data: callData },
      "latest",
      { [SCANNER_ADDRESS]: { code: SCANNER_DEPLOYED_BYTECODE } },
    ]);
    const [rows] = decodeAbiParameters(SCAN_OUTPUT, result);
    const typed = rows as readonly {
      balance: bigint;
      decimals: number;
      name: string;
      symbol: string;
      isNonFungible: boolean;
    }[];
    return typed.map((r, i) => ({
      address: tokens[i]!,
      balance: r.balance,
      decimals: r.decimals === 0 ? 18 : r.decimals,
      name: r.name ?? "",
      symbol: r.symbol ?? "",
      isNonFungible: r.isNonFungible === true,
    }));
  } catch (e) {
    if (e instanceof RpcError && isStateOverrideUnsupported(e)) return "unsupported";
    throw e;
  }
}

async function multicallPath(
  rpc: RpcClient,
  owner: Hex,
  tokens: Hex[]
): Promise<TokenData[]> {
  const balanceOfData = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "balanceOf",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint256" }],
        stateMutability: "view",
      },
    ],
    args: [owner],
  });

  const calls = tokens.flatMap((t) => [
    { target: t, allowFailure: true, callData: balanceOfData },
    { target: t, allowFailure: true, callData: DECIMALS_SELECTOR as Hex },
    { target: t, allowFailure: true, callData: NAME_SELECTOR as Hex },
    { target: t, allowFailure: true, callData: SYMBOL_SELECTOR as Hex },
    { target: t, allowFailure: true, callData: SUPPORTS_INTERFACE_ERC721_CALLDATA as Hex },
  ]);

  const aggregate = encodeAggregate3(calls);
  const result = await rpc.call<Hex>("eth_call", [
    { to: MULTICALL3_ADDRESS, data: aggregate },
    "latest",
  ]);
  const decoded = decodeAggregate3Result(result);

  const out: TokenData[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const b = decoded[i * 5]!;
    const d = decoded[i * 5 + 1]!;
    const n = decoded[i * 5 + 2]!;
    const s = decoded[i * 5 + 3]!;
    const sup = decoded[i * 5 + 4]!;

    let balance = 0n;
    if (b.success && b.returnData.length >= 66) {
      try {
        balance = BigInt(b.returnData.slice(0, 66));
      } catch {
        // keep default 0n
      }
    }

    let decimals = 18;
    if (d.success && d.returnData.length >= 66) {
      try {
        const parsed = Number(BigInt(d.returnData.slice(0, 66)));
        if (parsed !== 0) decimals = parsed;
      } catch {
        // keep default 18
      }
    }

    const name = n.success ? decodeString(n.returnData) : "";
    const symbol = s.success ? decodeString(s.returnData) : "";

    let isNonFungible = false;
    if (sup.success && sup.returnData.length >= 66) {
      try {
        isNonFungible = BigInt(sup.returnData.slice(0, 66)) !== 0n;
      } catch {
        // keep default false
      }
    }

    out.push({ address: tokens[i]!, balance, decimals, name, symbol, isNonFungible });
  }
  return out;
}

export function isOversizeError(e: unknown): boolean {
  if (!(e instanceof RpcError)) return false;
  const m = e.message.toLowerCase();
  return (
    m.includes("out of gas") ||
    m.includes("gas required exceeds") ||
    m.includes("response size") ||
    m.includes("too large") ||
    m.includes("request entity too large")
  );
}

const supportsScannerByUrl = new Map<string, boolean>();

export async function readTokenData(
  rpc: RpcClient,
  owner: Hex,
  tokens: Hex[],
  opts: { startBatch?: number; concurrency?: number } = {}
): Promise<TokenData[]> {
  if (tokens.length === 0) return [];

  const concurrency = opts.concurrency ?? 3;
  const url = rpc.url;

  let useScanner = supportsScannerByUrl.get(url);
  if (useScanner === undefined) {
    const probe = await tryScannerPath(rpc, owner, tokens.slice(0, 1));
    useScanner = probe !== "unsupported";
    supportsScannerByUrl.set(url, useScanner);
  }

  const startBatch = opts.startBatch ?? (useScanner ? 500 : 250);

  async function runBatch(chunk: Hex[]): Promise<TokenData[]> {
    try {
      if (useScanner) {
        const r = await tryScannerPath(rpc, owner, chunk);
        if (r === "unsupported") {
          supportsScannerByUrl.set(url, false);
          useScanner = false;
          return multicallPath(rpc, owner, chunk);
        }
        return r;
      }
      return await multicallPath(rpc, owner, chunk);
    } catch (e) {
      if (isOversizeError(e) && chunk.length > 1) {
        const mid = Math.floor(chunk.length / 2);
        const [a, b] = await Promise.all([
          runBatch(chunk.slice(0, mid)),
          runBatch(chunk.slice(mid)),
        ]);
        return [...a, ...b];
      }
      throw e;
    }
  }

  const chunks: Hex[][] = [];
  for (let i = 0; i < tokens.length; i += startBatch) {
    chunks.push(tokens.slice(i, i + startBatch));
  }

  const results: TokenData[] = [];
  let idx = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, chunks.length) },
    async () => {
      while (idx < chunks.length) {
        const my = idx++;
        const got = await runBatch(chunks[my]!);
        results.push(...got);
      }
    }
  );
  await Promise.all(workers);
  return results;
}
