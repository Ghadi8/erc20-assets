import { encodeAbiParameters, decodeAbiParameters, concat, type Hex } from "viem";

export const MULTICALL3_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11" as const;

const AGGREGATE3_SELECTOR = "0x82ad56cb" as const;

export const BALANCE_OF_SELECTOR = "0x70a08231" as const;
export const DECIMALS_SELECTOR = "0x313ce567" as const;
export const NAME_SELECTOR = "0x06fdde03" as const;
export const SYMBOL_SELECTOR = "0x95d89b41" as const;

// supportsInterface(bytes4) selector + ERC-721 interface id, right-padded.
export const SUPPORTS_INTERFACE_ERC721_CALLDATA =
  "0x01ffc9a780ac58cd00000000000000000000000000000000000000000000000000000000" as const;

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
  return (rows as readonly { success: boolean; returnData: Hex }[]).map((r) => ({
    success: r.success,
    returnData: r.returnData,
  }));
}
