import { getAssets, type Address } from "../src";
import { RpcClient, RpcError, isStateOverrideUnsupported } from "../src/rpc";
import { resolveDeploymentBlock } from "../src/deployBlock";
import { SCANNER_ADDRESS, SCANNER_DEPLOYED_BYTECODE } from "../src/scanner.bytecode";

const address = process.env.GET_ASSETS_TEST_ADDRESS as Address | undefined;
const rpcUrl = process.env.RPC_URL;
const fromBlockEnv = process.env.FROM_BLOCK;
const maxLogRangeEnv = process.env.MAX_LOG_RANGE;
const discoverConcurrencyEnv = process.env.DISCOVER_CONCURRENCY;
const anchorContract = (process.env.ANCHOR_CONTRACT ??
  "0x5803c076563C85799989d42Fc00292A8aE52fa9E") as Address;

if (!address || !rpcUrl) {
  console.error("Set GET_ASSETS_TEST_ADDRESS and RPC_URL in .env");
  process.exit(1);
}

async function probeStateOverride(): Promise<boolean> {
  const rpc = new RpcClient(rpcUrl!);
  try {
    await rpc.call("eth_call", [
      { to: SCANNER_ADDRESS, data: "0x" },
      "latest",
      { [SCANNER_ADDRESS]: { code: SCANNER_DEPLOYED_BYTECODE } },
    ]);
    return true;
  } catch (e) {
    if (e instanceof RpcError && isStateOverrideUnsupported(e)) return false;
    return true;
  }
}

const scannerOk = await probeStateOverride();
console.log(`state-override (scanner path) supported: ${scannerOk}`);

let fromBlock = fromBlockEnv ? BigInt(fromBlockEnv) : undefined;
if (fromBlock === undefined) {
  const rpc = new RpcClient(rpcUrl!);
  const latest = BigInt(await rpc.call<`0x${string}`>("eth_blockNumber", []));
  const t = Date.now();
  const resolved = await resolveDeploymentBlock(rpc, anchorContract, latest);
  const ms = Date.now() - t;
  if (resolved !== null) {
    fromBlock = resolved;
    console.log(
      `resolved FROM_BLOCK=${resolved} (${resolved.toString(10)}) via anchor ${anchorContract} in ${ms}ms — set FROM_BLOCK in .env to skip this on future runs`
    );
  } else {
    console.log(`anchor ${anchorContract} has no code on this chain; FROM_BLOCK defaults to 0`);
  }
}

const cfg = {
  rpcUrl,
  anchorContract,
  ...(fromBlock !== undefined ? { fromBlock } : {}),
  ...(maxLogRangeEnv ? { maxLogRange: Number(maxLogRangeEnv) } : {}),
  ...(discoverConcurrencyEnv ? { discoverConcurrency: Number(discoverConcurrencyEnv) } : {}),
};

const t0 = Date.now();
const entries = await getAssets(address, cfg);
const elapsed = Date.now() - t0;

console.log(`elapsed: ${elapsed}ms`);
console.log(`assets: ${entries.length}`);
console.log(JSON.stringify(entries, null, 2));
