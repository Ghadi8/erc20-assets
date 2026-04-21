# wallet_getAssets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Alchemy-backed `wallet_getAssets` with a pure JSON-RPC implementation that discovers native + ERC-20 balances across EVM chains using only `eth_call`, `eth_getLogs`, `eth_getBalance`, and `eth_getTransactionCount`.

**Architecture:** Per chain we (1) binary-search the first active block, (2) scan `Transfer` logs to discover ERC-20s the wallet has ever received, (3) batch-read balance+metadata via a deployed-bytecode-overridden scanner contract with Multicall3 fallback, (4) union with native balance and emit the exact Alchemy response shape.

**Tech Stack:** Bun + TypeScript strict mode. `viem` only for ABI encoding, hex utilities, and keccak (no public client). `solc`/`forge` to compile `scanner.sol`. Bun's built-in test runner.

---

## File Structure

```
src/
  scanner.sol              # AssetScanner contract (Solidity 0.8.24)
  scanner.bytecode.ts      # exported DEPLOYED_BYTECODE hex (auto-generated)
  rpc.ts                   # minimal JSON-RPC client: single + batch + retry
  multicall3.ts            # MULTICALL3_ADDRESS + aggregate3 encoder/decoder
  bounds.ts                # binary-search first-active-block per (chain, owner)
  discover.ts              # chunked eth_getLogs Transfer-to-owner discovery
  readBalances.ts          # scanner path + Multicall3 fallback for balance/decimals/name/symbol
  getAssets.ts             # top-level entrypoint; output contract
  index.ts                 # public exports
compile.ts                 # compiles scanner.sol, writes src/scanner.bytecode.ts
test/
  getAssets.test.ts        # integration tests against Sepolia / Base Sepolia / Arbitrum Sepolia
```

---

## Environment Notes

- Bun runtime. Tests run via `bun test test/getAssets.test.ts`.
- `solc 0.8.20` is installed globally AND `forge 1.5.1` is available. Use `forge build` with a minimal `foundry.toml` pinning `solc = "0.8.24"` so forge fetches the right compiler via svm. Fallback: `bunx solc@0.8.24`.
- Tests need RPC URLs — read from env vars (`SEPOLIA_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, `ARBITRUM_SEPOLIA_RPC_URL`). Skip test if missing.
- No new runtime deps. `solc` is a devDep only.

---

## Task 1: Scaffold, scanner.sol, compile pipeline

**Files:**
- Create: `src/scanner.sol`
- Create: `foundry.toml`
- Create: `compile.ts`
- Create: `src/scanner.bytecode.ts` (generated)
- Modify: `package.json` (add `scripts.compile`, `scripts.build`)

- [ ] **Step 1: Write `src/scanner.sol` exactly as specified**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract AssetScanner {
    struct Result { uint256 balance; uint8 decimals; string name; string symbol; }

    function scan(address owner, address[] calldata tokens)
        external view returns (Result[] memory out)
    {
        out = new Result[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            (bool okB, bytes memory bal) = t.staticcall(abi.encodeWithSelector(0x70a08231, owner));
            if (okB && bal.length >= 32) out[i].balance = abi.decode(bal, (uint256));

            (bool okD, bytes memory dec) = t.staticcall(abi.encodeWithSelector(0x313ce567));
            if (okD && dec.length >= 32) out[i].decimals = uint8(abi.decode(dec, (uint256)));

            (bool okN, bytes memory nm) = t.staticcall(abi.encodeWithSelector(0x06fdde03));
            if (okN) out[i].name = _decodeStringOrBytes32(nm);

            (bool okS, bytes memory sy) = t.staticcall(abi.encodeWithSelector(0x95d89b41));
            if (okS) out[i].symbol = _decodeStringOrBytes32(sy);
        }
    }

    function _decodeStringOrBytes32(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";
        if (data.length == 32) {
            uint256 len;
            while (len < 32 && data[len] != 0) ++len;
            bytes memory trimmed = new bytes(len);
            for (uint256 i; i < len; ++i) trimmed[i] = data[i];
            return string(trimmed);
        }
        if (data.length >= 64) return abi.decode(data, (string));
        return "";
    }
}
```

- [ ] **Step 2: Write `foundry.toml`**

```toml
[profile.default]
src = "src"
out = "out"
solc = "0.8.24"
optimizer = true
optimizer_runs = 200
evm_version = "paris"
```

Why `paris`: some target chains (e.g. Avalanche C-Chain) haven't enabled `PUSH0`.

- [ ] **Step 3: Write `compile.ts`**

```ts
import { $ } from "bun";
import { readFile, writeFile } from "node:fs/promises";

await $`forge build --silent`;
const artifact = JSON.parse(
  await readFile("out/scanner.sol/AssetScanner.json", "utf8")
) as { deployedBytecode: { object: string } };

const bytecode = artifact.deployedBytecode.object;
if (!bytecode || !bytecode.startsWith("0x") || bytecode.length < 4) {
  throw new Error("forge did not produce deployedBytecode");
}

await writeFile(
  "src/scanner.bytecode.ts",
  `// AUTO-GENERATED by compile.ts. Do not edit by hand.
export const SCANNER_DEPLOYED_BYTECODE = "${bytecode}" as const;
export const SCANNER_ADDRESS = "0x0000000000000000000000000000000000009999" as const;
`
);
console.log(`Wrote src/scanner.bytecode.ts (${(bytecode.length - 2) / 2} bytes)`);
```

- [ ] **Step 4: Add npm scripts**

Modify `package.json` — add inside `"scripts"` (create the block if missing):

```json
"scripts": {
  "compile": "bun compile.ts",
  "test": "bun test"
}
```

- [ ] **Step 5: Run compile and verify output**

```bash
bun run compile
```

Expected: `Wrote src/scanner.bytecode.ts (<N> bytes)` with N > 500.
Verify `src/scanner.bytecode.ts` exists, starts with `0x60`, and has `SCANNER_DEPLOYED_BYTECODE` exported.

- [ ] **Step 6: Commit**

```bash
git add src/scanner.sol foundry.toml compile.ts src/scanner.bytecode.ts package.json
git commit -m "feat: add AssetScanner contract + forge compile pipeline"
```

---

## Task 2: JSON-RPC client (`rpc.ts`)

**Files:**
- Create: `src/rpc.ts`
- Create: `test/rpc.test.ts`

Exposes:
- `class RpcClient { constructor(url: string) }`
- `call(method: string, params: unknown[]): Promise<unknown>`
- `batch(calls: { method: string; params: unknown[] }[]): Promise<BatchResult[]>`
- Throws `RpcError { code: number; message: string; data?: unknown }` for JSON-RPC errors.

Retry rules:
- Max 3 attempts total.
- Retry on: network error, HTTP 429, HTTP 5xx.
- Do NOT retry on JSON-RPC error responses (caller inspects `code` and branches).
- Backoff: 200ms, 800ms (exponential, jittered ±50%).

- [ ] **Step 1: Write failing test `test/rpc.test.ts`**

```ts
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
    expect(await c.call("eth_blockNumber", [])).toBe("0x1");
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
    expect(await c.call("eth_chainId", [])).toBe("0x42");
    expect(hits).toBe(2);
    srv.stop();
  });

  test("isStateOverrideUnsupported matches common error shapes", () => {
    expect(isStateOverrideUnsupported(new RpcError(-32000, "state override not supported"))).toBe(true);
    expect(isStateOverrideUnsupported(new RpcError(-32601, "method eth_call requires 2 params"))).toBe(false);
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
bun test test/rpc.test.ts
```

Expected: module resolution error (`src/rpc.ts` doesn't exist yet).

- [ ] **Step 3: Write `src/rpc.ts`**

```ts
export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export type BatchResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: RpcError };

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jittered = (base: number) => base * (0.5 + Math.random());

export class RpcClient {
  private nextId = 1;
  constructor(private readonly url: string) {}

  async call<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const body = { jsonrpc: "2.0", id: this.nextId++, method, params };
    const json = (await this.postWithRetry(body)) as {
      result?: T;
      error?: { code: number; message: string; data?: unknown };
    };
    if (json.error) throw new RpcError(json.error.code, json.error.message, json.error.data);
    return json.result as T;
  }

  async batch<T = unknown>(
    calls: { method: string; params: unknown[] }[]
  ): Promise<BatchResult<T>[]> {
    if (calls.length === 0) return [];
    const reqs = calls.map((c) => ({
      jsonrpc: "2.0" as const,
      id: this.nextId++,
      method: c.method,
      params: c.params,
    }));
    const raw = (await this.postWithRetry(reqs)) as {
      id: number;
      result?: T;
      error?: { code: number; message: string; data?: unknown };
    }[];
    const byId = new Map(raw.map((r) => [r.id, r]));
    return reqs.map((r): BatchResult<T> => {
      const resp = byId.get(r.id);
      if (!resp) return { ok: false, error: new RpcError(-1, "missing response for batch id") };
      if (resp.error) return { ok: false, error: new RpcError(resp.error.code, resp.error.message, resp.error.data) };
      return { ok: true, result: resp.result as T };
    });
  }

  private async postWithRetry(body: unknown): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (RETRYABLE_STATUS.has(res.status)) {
          lastErr = new Error(`HTTP ${res.status}`);
          if (attempt < MAX_ATTEMPTS) {
            await sleep(jittered(200 * 2 ** (attempt - 1)));
            continue;
          }
          throw lastErr;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        return await res.json();
      } catch (e) {
        lastErr = e;
        const isNet = e instanceof TypeError || (e as Error)?.name === "AbortError";
        if (attempt < MAX_ATTEMPTS && (isNet || (e as Error)?.message?.startsWith("HTTP "))) {
          await sleep(jittered(200 * 2 ** (attempt - 1)));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }
}

export function isRangeTooLarge(err: RpcError): boolean {
  if (err.code === -32005 || err.code === -32602 || err.code === -32600) return true;
  const m = err.message.toLowerCase();
  return (
    m.includes("range") ||
    m.includes("too large") ||
    m.includes("too many") ||
    m.includes("query timeout") ||
    m.includes("log response size exceeded") ||
    m.includes("exceed") ||
    m.includes("limit")
  );
}

export function isStateOverrideUnsupported(err: RpcError): boolean {
  const m = err.message.toLowerCase();
  return (
    m.includes("state override") ||
    m.includes("stateoverride") ||
    (err.code === -32601 && m.includes("not supported")) ||
    (err.code === -32000 && m.includes("not supported"))
  );
}

export function isHistoricalStateMissing(err: RpcError): boolean {
  const m = err.message.toLowerCase();
  return (
    m.includes("missing trie node") ||
    m.includes("historical state") ||
    m.includes("pruned") ||
    m.includes("archive") ||
    (err.code === -32000 && m.includes("state"))
  );
}
```

- [ ] **Step 4: Verify tests pass**

```bash
bun test test/rpc.test.ts
```

Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/rpc.ts test/rpc.test.ts
git commit -m "feat: minimal JSON-RPC client with batch + retry + typed error classification"
```

---

## Task 3: Multicall3 fallback module (`multicall3.ts`)

**Files:**
- Create: `src/multicall3.ts`
- Create: `test/multicall3.test.ts`

Exposes:
- `MULTICALL3_ADDRESS` constant.
- `encodeAggregate3(calls: { target: Hex; allowFailure: boolean; callData: Hex }[]): Hex`
- `decodeAggregate3Result(data: Hex): { success: boolean; returnData: Hex }[]`
- `BALANCE_OF_SELECTOR`, `DECIMALS_SELECTOR`, `NAME_SELECTOR`, `SYMBOL_SELECTOR` (4-byte hex).

- [ ] **Step 1: Write `test/multicall3.test.ts`**

```ts
import { describe, test, expect } from "bun:test";
import {
  MULTICALL3_ADDRESS,
  encodeAggregate3,
  decodeAggregate3Result,
  BALANCE_OF_SELECTOR,
} from "../src/multicall3";
import { encodeAbiParameters } from "viem";

describe("multicall3", () => {
  test("MULTICALL3_ADDRESS is the canonical lowercase address", () => {
    expect(MULTICALL3_ADDRESS).toBe("0xca11bde05977b3631167028862be2a173976ca11");
  });

  test("BALANCE_OF_SELECTOR is 0x70a08231", () => {
    expect(BALANCE_OF_SELECTOR).toBe("0x70a08231");
  });

  test("encode/decode aggregate3 roundtrips", () => {
    const encoded = encodeAggregate3([
      { target: "0x1111111111111111111111111111111111111111", allowFailure: true, callData: "0xdeadbeef" },
      { target: "0x2222222222222222222222222222222222222222", allowFailure: true, callData: "0xcafebabe" },
    ]);
    expect(encoded.startsWith("0x82ad56cb")).toBe(true);

    // A plausible return: two successful 32-byte results
    const ret = encodeAbiParameters(
      [{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }],
      [[
        [true, `0x${"00".repeat(31)}05`],
        [true, `0x${"00".repeat(31)}07`],
      ]]
    );
    const decoded = decodeAggregate3Result(ret);
    expect(decoded.length).toBe(2);
    expect(decoded[0]!.success).toBe(true);
    expect(decoded[0]!.returnData.endsWith("05")).toBe(true);
    expect(decoded[1]!.returnData.endsWith("07")).toBe(true);
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
bun test test/multicall3.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Write `src/multicall3.ts`**

```ts
import { encodeAbiParameters, decodeAbiParameters, type Hex, concat } from "viem";

export const MULTICALL3_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11" as const;

// aggregate3((address,bool,bytes)[]) — selector 0x82ad56cb
const AGGREGATE3_SELECTOR = "0x82ad56cb" as const;

export const BALANCE_OF_SELECTOR = "0x70a08231" as const; // balanceOf(address)
export const DECIMALS_SELECTOR = "0x313ce567" as const;   // decimals()
export const NAME_SELECTOR = "0x06fdde03" as const;       // name()
export const SYMBOL_SELECTOR = "0x95d89b41" as const;     // symbol()

const AGGREGATE3_INPUT = [
  {
    type: "tuple[]",
    components: [
      { type: "address", name: "target" },
      { type: "bool", name: "allowFailure" },
      { type: "bytes", name: "callData" },
    ],
  },
] as const;

const AGGREGATE3_OUTPUT = [
  {
    type: "tuple[]",
    components: [
      { type: "bool", name: "success" },
      { type: "bytes", name: "returnData" },
    ],
  },
] as const;

export type Call3 = { target: Hex; allowFailure: boolean; callData: Hex };

export function encodeAggregate3(calls: Call3[]): Hex {
  const encoded = encodeAbiParameters(AGGREGATE3_INPUT, [
    calls.map((c) => ({
      target: c.target,
      allowFailure: c.allowFailure,
      callData: c.callData,
    })),
  ]);
  return concat([AGGREGATE3_SELECTOR, encoded]);
}

export function decodeAggregate3Result(data: Hex): { success: boolean; returnData: Hex }[] {
  const [rows] = decodeAbiParameters(AGGREGATE3_OUTPUT, data);
  return (rows as { success: boolean; returnData: Hex }[]).map((r) => ({
    success: r.success,
    returnData: r.returnData,
  }));
}
```

- [ ] **Step 4: Verify tests pass**

```bash
bun test test/multicall3.test.ts
```

Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/multicall3.ts test/multicall3.test.ts
git commit -m "feat: multicall3 aggregate3 encoder/decoder + ERC20 selectors"
```

---

## Task 4: Bounds — first-active-block binary search (`bounds.ts`)

**Files:**
- Create: `src/bounds.ts`
- Create: `test/bounds.test.ts`

Exposes:
- `type Bounds = { fromBlock: bigint; latest: bigint; hasHistory: boolean }`
- `findFirstActiveBlock(rpc: RpcClient, address: Hex, opts?: { safeLookback?: bigint }): Promise<Bounds>`

Algorithm: exponential probe down from `latest` to find the highest block where the address is *inactive* (both `getTransactionCount == 0` and `getBalance == 0`). Then binary-search between that block and the first active probe to find the lowest active block. Fall back to `latest - safeLookback` if historical state is rejected.

Cache keyed by `(chainId, address)` — but we operate at the `RpcClient` layer, which is already per-chain. Caller is responsible for reuse. We expose a `boundsCache: Map<string, Promise<Bounds>>` factory for external use.

- [ ] **Step 1: Write `test/bounds.test.ts`**

```ts
import { describe, test, expect } from "bun:test";
import { findFirstActiveBlock } from "../src/bounds";
import { RpcClient } from "../src/rpc";

// Helper: spin up a fake RPC that simulates "first active at block X"
function fakeRpc(opts: { latest: bigint; firstActive: bigint | null; rejectHistorical?: boolean }) {
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { id: number; method: string; params: unknown[] };
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
      const isBalance = body.method === "eth_getBalance";
      const isTxCount = body.method === "eth_getTransactionCount";
      const isBlockNum = body.method === "eth_blockNumber";
      if (isBlockNum) return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x" + opts.latest.toString(16) });
      const val = active ? (isBalance ? "0x1" : "0x1") : "0x0";
      return Response.json({ jsonrpc: "2.0", id: body.id, result: val });
    },
  });
  return {
    rpc: new RpcClient(`http://localhost:${srv.port}`),
    stop: () => srv.stop(),
  };
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
```

- [ ] **Step 2: Verify test fails**

```bash
bun test test/bounds.test.ts
```

- [ ] **Step 3: Write `src/bounds.ts`**

```ts
import type { Hex } from "viem";
import { RpcClient, RpcError, isHistoricalStateMissing } from "./rpc";

export type Bounds = { fromBlock: bigint; latest: bigint; hasHistory: boolean };

type Opts = { safeLookback?: bigint };
const DEFAULT_SAFE_LOOKBACK = 2_000_000n;

async function isActiveAt(rpc: RpcClient, address: Hex, block: bigint | "latest"): Promise<boolean> {
  const tag = block === "latest" ? "latest" : "0x" + block.toString(16);
  const [nonce, balance] = await Promise.all([
    rpc.call<Hex>("eth_getTransactionCount", [address, tag]),
    rpc.call<Hex>("eth_getBalance", [address, tag]),
  ]);
  return BigInt(nonce) > 0n || BigInt(balance) > 0n;
}

export async function findFirstActiveBlock(
  rpc: RpcClient,
  address: Hex,
  opts: Opts = {}
): Promise<Bounds> {
  const safeLookback = opts.safeLookback ?? DEFAULT_SAFE_LOOKBACK;
  const latestHex = await rpc.call<Hex>("eth_blockNumber", []);
  const latest = BigInt(latestHex);

  const activeAtLatest = await isActiveAt(rpc, address, "latest");
  if (!activeAtLatest) return { fromBlock: latest, latest, hasHistory: false };

  try {
    // Exponential probe: find a block where inactive, or give up at 0.
    let hi = latest;
    let lo = 0n;
    let step = 1n;
    let probe = latest;
    let foundInactive = false;

    while (probe > 0n) {
      probe = latest > step ? latest - step : 0n;
      const active = await isActiveAt(rpc, address, probe);
      if (!active) {
        lo = probe;
        foundInactive = true;
        break;
      }
      hi = probe;
      if (probe === 0n) break;
      step *= 2n;
    }

    if (!foundInactive) {
      // Active at block 0 — impossible for sends but possible for receive-at-genesis. Still return 0.
      return { fromBlock: 0n, latest, hasHistory: true };
    }

    // Binary search in (lo, hi]
    while (hi - lo > 1n) {
      const mid = lo + (hi - lo) / 2n;
      const active = await isActiveAt(rpc, address, mid);
      if (active) hi = mid;
      else lo = mid;
    }
    return { fromBlock: hi, latest, hasHistory: true };
  } catch (e) {
    if (e instanceof RpcError && isHistoricalStateMissing(e)) {
      const from = latest > safeLookback ? latest - safeLookback : 0n;
      return { fromBlock: from, latest, hasHistory: true };
    }
    throw e;
  }
}
```

- [ ] **Step 4: Verify tests pass**

```bash
bun test test/bounds.test.ts
```

Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/bounds.ts test/bounds.test.ts
git commit -m "feat: binary-search first-active-block with archive fallback"
```

---

## Task 5: Discover ERC-20s via `eth_getLogs` (`discover.ts`)

**Files:**
- Create: `src/discover.ts`
- Create: `test/discover.test.ts`

Exposes:
- `discoverTokens(rpc: RpcClient, address: Hex, bounds: Bounds, opts: { maxLogRange: number }): Promise<Hex[]>` — returns unique lowercase token addresses.

Behavior:
- `topic0 = keccak256("Transfer(address,address,uint256)")`. Hardcode the well-known constant.
- `topic2 = padded "to" = address`.
- Chunk `[fromBlock, latest]` into windows of `maxLogRange`.
- Concurrency cap: 5 in flight per chain.
- On range-too-large, halve the window and recurse.
- Return unique log addresses lowercased.

- [ ] **Step 1: Write `test/discover.test.ts`**

```ts
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
      { fromBlock: 0n, latest: 15_000n, hasHistory: true },
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
      { fromBlock: 0n, latest: 10_000n, hasHistory: true },
      { maxLogRange: 10_000 }
    );
    expect(tokens).toEqual(["0x1111111111111111111111111111111111111111"]);
    stop();
  });

  test("returns [] when bounds.hasHistory is false", async () => {
    const { rpc, stop } = logServer({ tokensByRange: () => [] });
    const tokens = await discoverTokens(
      rpc,
      "0xabc0000000000000000000000000000000000000",
      { fromBlock: 10n, latest: 10n, hasHistory: false },
      { maxLogRange: 10_000 }
    );
    expect(tokens).toEqual([]);
    stop();
  });
});
```

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Write `src/discover.ts`**

```ts
import type { Hex } from "viem";
import { pad } from "viem";
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

  // Build initial window list
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

  // Concurrency pool
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
```

- [ ] **Step 4: Verify**

```bash
bun test test/discover.test.ts
```

Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/discover.ts test/discover.test.ts
git commit -m "feat: chunked eth_getLogs Transfer discovery with range-halving retry"
```

---

## Task 6: Balance + metadata reader with scanner + multicall3 fallback (`readBalances.ts`)

**Files:**
- Create: `src/readBalances.ts`
- Create: `test/readBalances.test.ts`

Exposes:
- `type TokenData = { address: Hex; balance: bigint; decimals: number; name: string; symbol: string }`
- `readTokenData(rpc: RpcClient, owner: Hex, tokens: Hex[], opts?: { startBatch?: number; concurrency?: number }): Promise<TokenData[]>`
- Internally detects state-override support once per RpcClient and caches. Falls back to Multicall3.
- Batch size: start at 500 for scanner path, 250 for multicall3 (4 calls per token × 250 = 1000 sub-calls). Halve on oversize/gas errors.
- Concurrency: 3 batches in flight.

The scanner path returns a single ABI-encoded `Result[]`. The multicall3 path returns 4 sub-call results per token and we decode each.

- [ ] **Step 1: Write `test/readBalances.test.ts`**

Writing a realistic integration test here is heavy — we'll rely on integration tests in Task 8. For this task, write a unit test that exercises the multicall3 fallback using a fake RPC that rejects state override:

```ts
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
        const [callObj, , overrides] = body.params as [{ to: string; data: string }, string, unknown?];
        if (overrides) {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "state override not supported" },
          });
        }
        // Expect a call to multicall3 with 4 sub-calls for 1 token
        const ret = encodeAbiParameters(
          [{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }],
          [[
            [true, padHex("0x64", { size: 32 })], // balance = 100
            [true, padHex("0x06", { size: 32 })], // decimals = 6
            [true, encodeAbiParameters([{ type: "string" }], ["USD Coin"])],
            [true, encodeAbiParameters([{ type: "string" }], ["USDC"])],
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
        // name = "MKR" as bytes32 (right-padded with zeros)
        const asciiMkr = stringToHex("MKR");
        const padded = `${asciiMkr}${"00".repeat(29)}`;
        const ret = encodeAbiParameters(
          [{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }],
          [[
            [true, padHex("0x0a", { size: 32 })],
            [true, padHex("0x12", { size: 32 })],
            [true, padded as `0x${string}`],
            [true, padded as `0x${string}`],
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
```

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Write `src/readBalances.ts`**

```ts
import {
  encodeAbiParameters,
  decodeAbiParameters,
  encodeFunctionData,
  hexToString,
  concat,
  type Hex,
} from "viem";
import { RpcClient, RpcError, isStateOverrideUnsupported } from "./rpc";
import { SCANNER_DEPLOYED_BYTECODE, SCANNER_ADDRESS } from "./scanner.bytecode";
import {
  MULTICALL3_ADDRESS,
  encodeAggregate3,
  decodeAggregate3Result,
  BALANCE_OF_SELECTOR,
  DECIMALS_SELECTOR,
  NAME_SELECTOR,
  SYMBOL_SELECTOR,
} from "./multicall3";

export type TokenData = {
  address: Hex;
  balance: bigint;
  decimals: number;
  name: string;
  symbol: string;
};

type Opts = { startBatch?: number; concurrency?: number };

// scan(address,address[]) — selector
const SCAN_SELECTOR = "0xea1f7a20" as const; // keccak256("scan(address,address[])")[:4]

// Result[] ABI
const SCAN_OUTPUT = [
  {
    type: "tuple[]",
    components: [
      { type: "uint256", name: "balance" },
      { type: "uint8", name: "decimals" },
      { type: "string", name: "name" },
      { type: "string", name: "symbol" },
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

function decodeString(data: Hex): string {
  if (data === "0x" || data.length < 4) return "";
  const raw = data.slice(2);
  if (raw.length === 64) {
    // bytes32: trim trailing zeros, strip non-printable
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
    const typed = rows as { balance: bigint; decimals: number; name: string; symbol: string }[];
    return typed.map((r, i) => ({
      address: tokens[i]!,
      balance: r.balance,
      decimals: r.decimals === 0 ? 18 : r.decimals,
      name: r.name ?? "",
      symbol: r.symbol ?? "",
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
    abi: [{ type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }],
    args: [owner],
  });

  const calls = tokens.flatMap((t) => [
    { target: t, allowFailure: true, callData: balanceOfData },
    { target: t, allowFailure: true, callData: DECIMALS_SELECTOR as Hex },
    { target: t, allowFailure: true, callData: NAME_SELECTOR as Hex },
    { target: t, allowFailure: true, callData: SYMBOL_SELECTOR as Hex },
  ]);

  const aggregate = encodeAggregate3(calls);
  const result = await rpc.call<Hex>("eth_call", [
    { to: MULTICALL3_ADDRESS, data: aggregate },
    "latest",
  ]);
  const decoded = decodeAggregate3Result(result);

  const out: TokenData[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const [b, d, n, s] = [decoded[i * 4]!, decoded[i * 4 + 1]!, decoded[i * 4 + 2]!, decoded[i * 4 + 3]!];
    let balance = 0n;
    if (b.success && b.returnData.length >= 66) {
      try { balance = BigInt(b.returnData.slice(0, 66)); } catch {}
    }
    let decimals = 18;
    if (d.success && d.returnData.length >= 66) {
      try { decimals = Number(BigInt(d.returnData.slice(0, 66))); } catch {}
    }
    const name = n.success ? decodeString(n.returnData) : "";
    const symbol = s.success ? decodeString(s.returnData) : "";
    out.push({ address: tokens[i]!, balance, decimals, name, symbol });
  }
  return out;
}

const supportsScannerByUrl = new Map<string, boolean>();

function isOversizeError(e: unknown): boolean {
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

export async function readTokenData(
  rpc: RpcClient,
  owner: Hex,
  tokens: Hex[],
  opts: Opts = {}
): Promise<TokenData[]> {
  if (tokens.length === 0) return [];
  const concurrency = opts.concurrency ?? 3;

  // Detect scanner support once per rpc URL
  const url = (rpc as unknown as { url: string }).url;
  let useScanner = supportsScannerByUrl.get(url);
  if (useScanner === undefined) {
    const probe = await tryScannerPath(rpc, owner, tokens.slice(0, Math.min(1, tokens.length)));
    if (probe === "unsupported") {
      useScanner = false;
    } else {
      useScanner = true;
      // cache the probe result but don't trust it for the full batch — simpler to re-run on full batches
    }
    supportsScannerByUrl.set(url, useScanner);
  }

  const startBatch = opts.startBatch ?? (useScanner ? 500 : 250);

  // Chunk + dynamic halving on oversize errors
  async function runBatch(chunk: Hex[], batchSize: number): Promise<TokenData[]> {
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
          runBatch(chunk.slice(0, mid), Math.max(1, Math.floor(batchSize / 2))),
          runBatch(chunk.slice(mid), Math.max(1, Math.floor(batchSize / 2))),
        ]);
        return [...a, ...b];
      }
      throw e;
    }
  }

  // Split into top-level chunks of startBatch
  const chunks: Hex[][] = [];
  for (let i = 0; i < tokens.length; i += startBatch) {
    chunks.push(tokens.slice(i, i + startBatch));
  }

  const results: TokenData[] = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
    while (idx < chunks.length) {
      const my = idx++;
      const got = await runBatch(chunks[my]!, startBatch);
      results.push(...got);
    }
  });
  await Promise.all(workers);
  return results;
}

// Exported for tests
export const _internal = { decodeString, encodeScan };
```

Note on `SCAN_SELECTOR`: verify by computing `keccak256("scan(address,address[])")[:4]`. If it differs, update the constant. The plan will validate this in Step 4.

- [ ] **Step 4: Verify the SCAN_SELECTOR is correct**

```bash
bun -e 'import("viem").then(({toFunctionSelector})=>console.log(toFunctionSelector("scan(address,address[])")))'
```

If output != `0xea1f7a20`, update `SCAN_SELECTOR` in `src/readBalances.ts` to the printed value.

- [ ] **Step 5: Run unit tests**

```bash
bun test test/readBalances.test.ts
```

Expected: 2 pass.

- [ ] **Step 6: Commit**

```bash
git add src/readBalances.ts test/readBalances.test.ts
git commit -m "feat: scanner-override balance reader with multicall3 fallback"
```

---

## Task 7: Assembly — `getAssets.ts`

**Files:**
- Create: `src/getAssets.ts`
- Create: `src/index.ts`

Exposes:
- `type Address = ` 0x${string}`
- `type ChainConfig = { rpcUrl: string; maxLogRange?: number }`
- `type ChainId = ` 0x${string}`
- `type AssetEntry = { address: Address | null; balance: Hex; metadata: { decimals: number; name: string; symbol: string }; type: "native" | "erc20" }`
- `type Output = Record<ChainId, AssetEntry[]>`
- `async function getAssets(address: Address, chains: Record<ChainId, ChainConfig>): Promise<Output>`

- [ ] **Step 1: Write `src/getAssets.ts`**

```ts
import type { Hex } from "viem";
import { RpcClient } from "./rpc";
import { findFirstActiveBlock } from "./bounds";
import { discoverTokens } from "./discover";
import { readTokenData } from "./readBalances";

export type Address = `0x${string}`;
export type ChainId = `0x${string}`;

export type ChainConfig = { rpcUrl: string; maxLogRange?: number };

export type AssetEntry = {
  address: Address | null;
  balance: Hex;
  metadata: { decimals: number; name: string; symbol: string };
  type: "native" | "erc20";
};

export type Output = Record<ChainId, AssetEntry[]>;

function toPaddedHex(v: bigint): Hex {
  const h = v.toString(16);
  return ("0x" + h.padStart(64, "0")) as Hex;
}

async function getAssetsForChain(
  owner: Address,
  cfg: ChainConfig
): Promise<AssetEntry[]> {
  const rpc = new RpcClient(cfg.rpcUrl);
  const maxLogRange = cfg.maxLogRange ?? 10_000;

  const [nativeBalanceHex, bounds] = await Promise.all([
    rpc.call<Hex>("eth_getBalance", [owner, "latest"]),
    findFirstActiveBlock(rpc, owner),
  ]);

  const entries: AssetEntry[] = [];

  const nativeBalance = BigInt(nativeBalanceHex);
  if (nativeBalance > 0n) {
    entries.push({
      address: null,
      balance: toPaddedHex(nativeBalance),
      metadata: { decimals: 18, name: "", symbol: "" },
      type: "native",
    });
  }

  if (!bounds.hasHistory) return entries;

  const candidates = await discoverTokens(rpc, owner, bounds, { maxLogRange });
  if (candidates.length === 0) return entries;

  const tokens = await readTokenData(rpc, owner, candidates);
  const nonZero = tokens
    .filter((t) => t.balance > 0n)
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

  for (const t of nonZero) {
    entries.push({
      address: t.address.toLowerCase() as Address,
      balance: toPaddedHex(t.balance),
      metadata: {
        decimals: t.decimals,
        name: t.name,
        symbol: t.symbol,
      },
      type: "erc20",
    });
  }
  return entries;
}

export async function getAssets(
  address: Address,
  chains: Record<ChainId, ChainConfig>
): Promise<Output> {
  const chainIds = Object.keys(chains) as ChainId[];
  const results = await Promise.all(
    chainIds.map(async (id) => [id, await getAssetsForChain(address, chains[id]!)] as const)
  );
  const out: Output = {} as Output;
  for (const [id, entries] of results) out[id] = entries;
  return out;
}
```

- [ ] **Step 2: Write `src/index.ts`**

```ts
export { getAssets } from "./getAssets";
export type { Address, ChainId, ChainConfig, AssetEntry, Output } from "./getAssets";
```

- [ ] **Step 3: Type-check**

```bash
bunx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/getAssets.ts src/index.ts
git commit -m "feat: getAssets orchestration — native + erc20 per chain with stable shape"
```

---

## Task 8: Integration tests

**Files:**
- Create: `test/getAssets.test.ts`
- Modify: `.env.example` (add placeholders)

- [ ] **Step 1: Update `.env.example`**

```
SEPOLIA_RPC_URL=
BASE_SEPOLIA_RPC_URL=
ARBITRUM_SEPOLIA_RPC_URL=
GET_ASSETS_TEST_ADDRESS=
```

- [ ] **Step 2: Write `test/getAssets.test.ts`**

```ts
import { describe, test, expect } from "bun:test";
import { getAssets, type ChainId, type Address } from "../src";

const TEST_ADDRESS = process.env.GET_ASSETS_TEST_ADDRESS as Address | undefined;
const chains: Record<ChainId, { rpcUrl: string }> = {} as Record<ChainId, { rpcUrl: string }>;
if (process.env.SEPOLIA_RPC_URL)         chains["0xaa36a7"]  = { rpcUrl: process.env.SEPOLIA_RPC_URL };
if (process.env.BASE_SEPOLIA_RPC_URL)    chains["0x14a34"]   = { rpcUrl: process.env.BASE_SEPOLIA_RPC_URL };
if (process.env.ARBITRUM_SEPOLIA_RPC_URL) chains["0x66eee"]  = { rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL };

const hasEnv = TEST_ADDRESS && Object.keys(chains).length > 0;

describe.skipIf(!hasEnv)("getAssets integration", () => {
  test("returns one key per input chain and matches shape", async () => {
    const result = await getAssets(TEST_ADDRESS!, chains);

    for (const id of Object.keys(chains) as ChainId[]) {
      expect(result).toHaveProperty(id);
      expect(Array.isArray(result[id])).toBe(true);
    }

    for (const entries of Object.values(result)) {
      for (const e of entries) {
        expect(e.balance.startsWith("0x")).toBe(true);
        expect(e.balance.length).toBe(66);
        expect(BigInt(e.balance) > 0n).toBe(true);
        if (e.type === "native") {
          expect(e.address).toBe(null);
          expect(e.metadata).toEqual({ decimals: 18, name: "", symbol: "" });
        } else {
          expect(e.type).toBe("erc20");
          expect(typeof e.address).toBe("string");
          expect(e.address).toBe((e.address as string).toLowerCase());
          expect(typeof e.metadata.decimals).toBe("number");
          expect(typeof e.metadata.name).toBe("string");
          expect(typeof e.metadata.symbol).toBe("string");
        }
      }
    }
  }, 120_000);

  test("erc20 entries are sorted by address ascending", async () => {
    const result = await getAssets(TEST_ADDRESS!, chains);
    for (const entries of Object.values(result)) {
      const erc20 = entries.filter((e) => e.type === "erc20");
      const sorted = [...erc20].sort((a, b) =>
        (a.address as string) < (b.address as string) ? -1 : 1
      );
      expect(erc20).toEqual(sorted);
    }
  }, 120_000);
});
```

- [ ] **Step 3: Run tests**

```bash
bun test
```

Expected: all unit tests pass; integration tests either pass (if env set) or are skipped.

- [ ] **Step 4: Commit**

```bash
git add test/getAssets.test.ts .env.example
git commit -m "test: getAssets integration tests with env-gated skip"
```

---

## Task 9: Self-validation pass

- [ ] **Step 1: Run whole test suite**

```bash
bun test
```

Expected: 100% pass.

- [ ] **Step 2: Type-check entire project**

```bash
bunx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Verify output shape against a live wallet**

Run a quick REPL script against any chain where the user already has RPC URLs:

```bash
bun -e 'import("./src").then(async({getAssets})=>{
  const out = await getAssets(process.env.GET_ASSETS_TEST_ADDRESS, {
    "0xaa36a7": { rpcUrl: process.env.SEPOLIA_RPC_URL }
  });
  console.log(JSON.stringify(out, null, 2));
})'
```

Verify:
- Top-level key is exactly `"0xaa36a7"`.
- Each balance is 66 chars (`0x` + 64 hex).
- ERC-20 addresses are lowercased.
- Zero-balance entries do not appear.
- Native (if present) has `address: null` and metadata `{ decimals: 18, name: "", symbol: "" }`.

- [ ] **Step 4: Final commit (if any pending)**

---

## Self-review checklist

- **Spec coverage:** Every step in the spec's "Algorithm" section maps to a task:
  - Step 1 (bounds) → Task 4.
  - Step 2 (log discovery) → Task 5.
  - Step 3 (scanner state override) → Task 1 + 6.
  - Step 4 (multicall3 fallback) → Task 3 + 6.
  - Step 5 (native balance) → Task 7.
  - Step 6 (assembly + sort + format) → Task 7.
- **No placeholders:** All code blocks contain runnable code. No "TODO" or "implement later" tokens.
- **Type consistency:** `ChainId`, `Address`, `TokenData`, `Bounds`, `AssetEntry`, `Output` are defined once and imported consistently.
- **Contract exactness:** Output shape enforced in `getAssets.ts` and re-verified in integration tests.
- **Non-compliant token handling:** `decodeString` handles bytes32; `decimals` defaults to 18; `balanceOf` revert → balance 0 → filtered out.
- **Edge cases:** Inactive address short-circuits after bounds check; empty candidate set short-circuits before read batch; all chains run in parallel.
