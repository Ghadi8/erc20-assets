# wallet-get-assets

A dependency-light, chain-agnostic way to list every asset a wallet holds —
native balance plus every ERC-20 with a non-zero balance — using only standard
JSON-RPC methods (`eth_getBalance`, `eth_blockNumber`, `eth_chainId`,
`eth_getCode`, `eth_getLogs`, `eth_call`). No indexer, no vendor SDK, no
per-chain configuration beyond an RPC URL.

The goal is to replace reliance on proprietary endpoints with a portable, self-contained implementation that works
against any EVM JSON-RPC endpoint.

---

## Quick start

```bash
bun install
```

```ts
import { getAssets } from "wallet-get-assets";

const entries = await getAssets("0xabc...", {
  rpcUrl: process.env.RPC_URL!,
  anchorContract: "0x5803c076563C85799989d42Fc00292A8aE52fa9E", // optional
  maxLogRange: 100_000, // optional; see Performance
});
```

Or run the bundled script against an address in `.env`:

```bash
cp .env.example .env
# fill in RPC_URL and GET_ASSETS_TEST_ADDRESS
bun run run:getAssets
```

---

## Output shape

```ts
type AssetEntry = {
  address: `0x${string}` | null; // null for native
  balance: `0x${string}`; // 32-byte left-padded hex
  metadata: { decimals: number; name: string; symbol: string };
  type: "native" | "erc20";
};
```

Balances are 32-byte-left-padded hex (not decimal). The native entry, when
present, is always first. ERC-20 entries are sorted by `address` ascending.
Zero-balance ERC-20s are filtered out.

---

## How it works

```
1. eth_getBalance(owner) + eth_blockNumber    → native balance & latest block
2. resolveDeploymentBlock(anchorContract)     → default fromBlock (optional)
3. eth_getLogs [Transfer, *, owner] in windows → candidate token addresses
4. eth_call with state override (scanner)     → balance + decimals + name + symbol
   (fallback) eth_call Multicall3 aggregate3  → same four fields per token
5. filter balance > 0, sort by address, emit
```

Each step has its own module:

| Module                   | Responsibility                                                |
| ------------------------ | ------------------------------------------------------------- |
| `rpc.ts`                 | `fetch`-based JSON-RPC client; retry on 429/5xx + network     |
| `deployBlock.ts`         | Binary search `eth_getCode` to find a contract's deploy block |
| `discover.ts`            | Chunked `eth_getLogs` Transfer-to-owner scan                  |
| `scanner.sol` / bytecode | `AssetScanner` contract used via `eth_call` state override    |
| `multicall3.ts`          | Encode/decode Multicall3 `aggregate3` for the fallback path   |
| `readBalances.ts`        | Scanner path + Multicall3 fallback + oversize batch splitting |
| `getAssets.ts`           | Top-level entrypoint and output shape                         |

### Discovery

Transfer events with the owner as the third indexed topic (`to`) are pulled in
fixed-size windows from `fromBlock` up to `latest`. Every unique contract
address that ever sent the owner a `Transfer` becomes a candidate. The scan
runs with concurrency 5 and recursively halves a window if the provider rejects
it as too large.

### Balance + metadata reads

Two paths, tried in order and cached per RPC URL:

**Scanner path** — a single `eth_call` with an `eth_call` **state override**
that injects `AssetScanner`'s deployed bytecode at a fixed address. The
contract loops over the token list and returns
`(balance, decimals, name, symbol)` for each in one round-trip. Default batch
size: 500 tokens.

**Multicall3 fallback** — standard `aggregate3` with `allowFailure: true`, four
calls per token (`balanceOf`, `decimals`, `name`, `symbol`). Default batch
size: 250 tokens. Used when the RPC doesn't support state overrides on
`eth_call`.

Both paths automatically halve the batch and retry if the provider rejects the
response as too large.

### The `anchorContract` optimization

Scanning `Transfer` events from genesis is the slowest part of the pipeline.
On mainnet-sized chains a full scan is thousands of `eth_getLogs` windows.

If the wallets you query are all deployed by a known factory, no wallet can
exist before that factory was deployed. `getAssets` accepts an `anchorContract`
address; when `fromBlock` is not set, it binary-searches `eth_getCode` to find
the block the anchor was deployed in and uses that as the effective
`fromBlock`. The result is cached in-memory per `(chainId, address)` for the
process lifetime.

If the anchor isn't deployed at the latest block on the chain, the resolver
returns `null` and `getAssets` falls back to `fromBlock=0`.

---

## Performance

The log scan (`eth_getLogs`) dominates end-to-end cost. The single biggest
lever is **`maxLogRange`**, the per-window block cap.

Measured on Arbitrum Sepolia via dRPC, fresh-process cold start:

| `MAX_LOG_RANGE` | Windows | Discover | Total |
| --------------: | ------: | -------: | ----: |
|        `10_000` |   1,782 |    37.7s |   41s |
|       `100_000` |     179 |     4.3s |  7.7s |
|     `1_000_000` |      18 |     0.5s |  5.3s |

In a long-running service the `anchorContract` binary search runs once per
`(chainId, factory)` and is cached for the process lifetime, so steady-state
cost is just head + discover + read (~1.5s in the 1M-range configuration
above).

Other tunables (all with safe defaults):

| Knob                     | Default           | Location                            |
| ------------------------ | ----------------- | ----------------------------------- |
| `maxLogRange`            | 10_000            | `ChainConfig`                       |
| discover concurrency     | 5                 | `discover.ts`                       |
| readBalances concurrency | 3                 | `readBalances.ts`                   |
| scanner batch size       | 500               | auto-halves on error                |
| multicall batch size     | 250               | auto-halves on error                |
| RPC retry                | 3, jitter backoff | on 429, 500, 502, 503, 504, network |

---

## Configuration

### `ChainConfig` (library)

| Field             | Type                   | Required | Purpose                                                        |
| ----------------- | ---------------------- | -------- | -------------------------------------------------------------- |
| `rpcUrl`          | `string`               | yes      | JSON-RPC endpoint                                              |
| `anchorContract`  | `Address`              | no       | Narrows `fromBlock` to this contract's deploy block            |
| `fromBlock`       | `bigint`               | no       | Explicit lower bound; wins over `anchorContract`               |
| `maxLogRange`     | `number`               | no       | `eth_getLogs` per-window cap (default 10,000)                  |
| `assetTypeFilter` | `"native" \| "erc20"`  | no       | Restrict output to one type; skips the other path's RPC calls  |
| `assetFilter`     | `Address[]`            | no       | Skip log discovery and read balances for these tokens directly |

### Environment variables (`scripts/run.ts`)

| Var                       | Required | Purpose                                                                         |
| ------------------------- | -------- | ------------------------------------------------------------------------------- |
| `RPC_URL`                 | yes      | JSON-RPC endpoint                                                               |
| `GET_ASSETS_TEST_ADDRESS` | yes      | Owner to query                                                                  |
| `ANCHOR_CONTRACT`         | no       | Factory address; default is baked into `run.ts`                                 |
| `FROM_BLOCK`              | no       | Override; takes precedence over `ANCHOR_CONTRACT`                               |
| `MAX_LOG_RANGE`           | no       | Per-window `eth_getLogs` block cap                                              |
| `ASSET_TYPE_FILTER`       | no       | `native` or `erc20` — restricts output to that type                             |
| `ASSET_FILTER`            | no       | Comma-separated token addresses; skips log discovery and reads these directly   |

---

## Caveats and known limitations

**Discovery is receive-only.** A token only ends up in the candidate set if the
owner received at least one standard
`Transfer(address,address,uint256)` event within the scan range. Tokens the
owner only ever sent, tokens that don't emit a standard `Transfer`, and
balance changes from rebases / airdrops / yield that don't emit a `Transfer`
to the owner are invisible.

**NFTs are detected and excluded.** The read path calls ERC-165
`supportsInterface(0x80ac58cd)` on every candidate; contracts that report
ERC-721 are dropped from the response. ERC-1155 contracts aren't discovered
in the first place — their transfer events use different topic hashes — so
they never reach the read path. Non-ERC-165 tokens (`supportsInterface`
reverts) are treated as fungible, which is the correct default for old
ERC-20s that predate ERC-165.

**Anchor assumes a single factory.** The `anchorContract` optimization
assumes every wallet in scope is deployed by (or after) that contract. If any
users can hold tokens through an EOA that predates the anchor, or a wallet
deployed by a different factory, those holdings are missed. Use the earliest
common anchor, or omit `anchorContract` and accept the full-history scan for
those users.

**Multicall3 address is hardcoded.** The canonical
`0xcA11bde05977b3631167028862bE2a173976CA11` is assumed on every chain. If
you're targeting a chain without it, you need to deploy it first or override.

**Provider error strings are matched as strings.** `rpc.ts` and
`readBalances.ts` detect retry-worthy conditions (range too large, state
override unsupported, response too large) by matching substrings of provider
error messages. If you hit a provider that phrases these differently, the
pipeline may hard-fail where it should fall back. Add the new phrasing to the
matcher.

**Balances are hex, not decimals.** `balance` is 32-byte left-padded hex
(`0x00...2faf080`). Convert client-side with `BigInt(balance)` or a formatter.

**Fallbacks are silent.** Missing or broken token metadata defaults to
`decimals = 18`, empty `name` / `symbol`. The response doesn't indicate that
a fallback happened.

---

## Requirements for a target RPC

- Serves `eth_getLogs` with `[topic0, null, topic2]` filters.
- Serves historical `eth_getCode` at arbitrary block numbers (needed only if
  you use `anchorContract`). Most providers do; some free/public endpoints
  don't and may 500 or return a `-32000` error.
- Either supports state overrides on `eth_call` **or** has Multicall3 deployed
  at the canonical address.
- Returns standard JSON-RPC errors for rate limits / oversized ranges /
  unsupported methods — or at least error strings close enough to the
  existing matchers.

---

## Development

```bash
bun test            # unit tests + integration (integration auto-skipped without env)
bun run typecheck   # tsc --noEmit
bun run compile     # regenerate src/scanner.bytecode.ts (requires forge)
bun run run:getAssets  # one-shot CLI run against the address in .env
```

Unit tests stand up mock JSON-RPC servers via `Bun.serve` — no network,
deterministic. Integration tests in `test/getAssets.test.ts` run only when
`RPC_URL` and `GET_ASSETS_TEST_ADDRESS` are set and hit the real provider.

---

## License

MIT License
