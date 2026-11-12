// Commits the SHA-256 of founders.json to the game contract, once (commit_provenance). Testnet
// only: the same checks as deploy-testnet-contract.ts run before any key is used.
//
//   npm run commit-provenance -- --account play.coys-game.testnet
//
// Signs with NEAR_TESTNET_ACCOUNT_ID and NEAR_TESTNET_PRIVATE_KEY (environment, or the repo .env).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Account, JsonRpcProvider, KeyPairSigner, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { foundersJson, generateFounders, sha256Hex } from './lib/founders';
import { assertTestnetId, assertTestnetRpc } from './lib/testnet';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
const fail = (message: string): never => {
  console.error(`commit-provenance: ${message}`);
  process.exit(1);
};
const { values } = parseArgs({ options: { account: { type: 'string' } } });
const signerId = process.env.NEAR_TESTNET_ACCOUNT_ID ?? fail('set NEAR_TESTNET_ACCOUNT_ID');
const privateKey = process.env.NEAR_TESTNET_PRIVATE_KEY ?? fail('set NEAR_TESTNET_PRIVATE_KEY');
const target = values.account ?? signerId;
const rpcUrl = process.env.NEAR_TESTNET_RPC_URL || 'https://test.rpc.fastnear.com';
try {
  for (const id of [signerId, target]) assertTestnetId(id);
  assertTestnetRpc(rpcUrl);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
const text = readFileSync(`${root}apps/server/data/founders.json`, 'utf8');
const file = JSON.parse(text) as { seed: string };
if (text !== foundersJson(generateFounders(file.seed))) fail('founders.json is not what its seed makes; regenerate it first');
const sha = sha256Hex(text);
const recorded = readFileSync(`${root}apps/server/data/founders.json.sha256`, 'utf8').split(/\s+/)[0];
if (sha !== recorded) fail(`founders.json hashes to ${sha}, not the ${recorded} recorded beside it`);
const provider = new JsonRpcProvider({ url: rpcUrl });
const status = await provider.viewNodeStatus();
if (status.chain_id !== 'testnet') fail(`RPC reports chain ${status.chain_id}; refusing anything but testnet`);
const supply = await provider.callFunction<{ provenance: string | null }>({ contractId: target, method: 'feather_supply', args: {} });
if (supply?.provenance) fail(`${target} already holds provenance ${supply.provenance}`);
const account = new Account(target, provider, KeyPairSigner.fromSecretKey(privateKey as KeyPairString));
const outcome = await account.callFunctionRaw({ contractId: target, methodName: 'commit_provenance', args: { sha256: sha }, gas: teraToGas('30'), deposit: 0n });
console.log(`provenance ${sha} committed on ${target} (testnet): tx ${outcome.transaction_outcome.id}`);
console.log(`explorer: https://testnet.nearblocks.io/txns/${outcome.transaction_outcome.id}`);
