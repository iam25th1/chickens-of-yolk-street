// One-off: deploys the settlement log contract to NEAR_SETTLEMENT_CONTRACT_ID on testnet.
// Usage: npm run deploy-settlement-log -w @coys/server  (reads the repo-root .env)
// The contract account must be the signing account (DeployContract targets the signer).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider, KeyPairSigner } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { assertTestnetConfig } from './settlement';
import { settlementLogWasm } from './settlement-log-wasm';

const envPath = fileURLToPath(new URL('../../../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

const accountId = process.env.NEAR_TESTNET_ACCOUNT_ID;
const privateKey = process.env.NEAR_TESTNET_PRIVATE_KEY;
if (!accountId || !privateKey) {
  console.error('Set NEAR_TESTNET_ACCOUNT_ID and NEAR_TESTNET_PRIVATE_KEY first (see .env.example).');
  process.exit(1);
}
const contractId = process.env.NEAR_SETTLEMENT_CONTRACT_ID || accountId;
if (contractId !== accountId) {
  console.error(`Deploy signs as ${accountId} and can only deploy to it; NEAR_SETTLEMENT_CONTRACT_ID is ${contractId}.`);
  process.exit(1);
}
const rpcUrl = process.env.NEAR_TESTNET_RPC_URL || 'https://test.rpc.fastnear.com';
assertTestnetConfig({ accountId, privateKey, rpcUrl, contractId });

const provider = new JsonRpcProvider({ url: rpcUrl });
const status = await provider.viewNodeStatus();
if (status.chain_id !== 'testnet') {
  console.error(`RPC reports chain ${status.chain_id}; refusing to deploy anywhere but testnet.`);
  process.exit(1);
}
const account = new Account(accountId, provider, KeyPairSigner.fromSecretKey(privateKey as KeyPairString));
const outcome = await account.deployContract(settlementLogWasm());
console.log(`settlement log deployed to ${accountId} on testnet: tx ${outcome.transaction_outcome.id}`);
