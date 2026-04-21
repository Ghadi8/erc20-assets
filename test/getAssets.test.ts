import { describe, test, expect } from "bun:test";
import { getAssets, type ChainId, type Address } from "../src";

const TEST_ADDRESS = process.env.GET_ASSETS_TEST_ADDRESS as Address | undefined;
const chains: Record<ChainId, { rpcUrl: string }> = {} as Record<ChainId, { rpcUrl: string }>;
if (process.env.SEPOLIA_RPC_URL)          chains["0xaa36a7"] = { rpcUrl: process.env.SEPOLIA_RPC_URL };
if (process.env.BASE_SEPOLIA_RPC_URL)     chains["0x14a34"]  = { rpcUrl: process.env.BASE_SEPOLIA_RPC_URL };
if (process.env.ARBITRUM_SEPOLIA_RPC_URL) chains["0x66eee"]  = { rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL };

const hasEnv = Boolean(TEST_ADDRESS) && Object.keys(chains).length > 0;

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
          expect(e.address).toBe((e.address as string).toLowerCase() as `0x${string}`);
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
