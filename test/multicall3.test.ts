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
