import { describe, test, expect } from "bun:test";
import { getAssets, type Address } from "../src";

const TEST_ADDRESS = process.env.GET_ASSETS_TEST_ADDRESS as Address | undefined;
const RPC_URL = process.env.RPC_URL;

const hasEnv = Boolean(TEST_ADDRESS) && Boolean(RPC_URL);

describe.skipIf(!hasEnv)("getAssets integration", () => {
  test("returns an array of assets with correct shape", async () => {
    const entries = await getAssets(TEST_ADDRESS!, { rpcUrl: RPC_URL! });

    expect(Array.isArray(entries)).toBe(true);

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
  }, 120_000);

  test("erc20 entries are sorted by address ascending", async () => {
    const entries = await getAssets(TEST_ADDRESS!, { rpcUrl: RPC_URL! });
    const erc20 = entries.filter((e) => e.type === "erc20");
    const sorted = [...erc20].sort((a, b) =>
      (a.address as string) < (b.address as string) ? -1 : 1
    );
    expect(erc20).toEqual(sorted);
  }, 120_000);
});
