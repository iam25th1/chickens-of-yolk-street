// Deploys the game contract (built by CI with cargo near, committed at
// contracts/coys-game/res/coys_game.wasm) to the game's testnet account and initialises it.
// Usage: npm run deploy-contract -w @coys/server   (reads the repo-root .env)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { assertTestnetConfig } from './chain';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);

const accountId = process.env.NEAR_TESTNET_ACCOUNT_ID;
const privateKey = process.env.NEAR_TESTNET_PRIVATE_KEY;
if (!accountId || !privateKey) {
  console.error('Set NEAR_TESTNET_ACCOUNT_ID and NEAR_TESTNET_PRIVATE_KEY first (see .env.example).');
  process.exit(1);
}
const contractId = process.env.NEAR_GAME_CONTRACT_ID || accountId;
if (contractId !== accountId) {
  console.error(`Deploy signs as ${accountId} and deploys to it; NEAR_GAME_CONTRACT_ID is ${contractId}.`);
  process.exit(1);
}
const rpcUrl = process.env.NEAR_TESTNET_RPC_URL || 'https://test.rpc.fastnear.com';
assertTestnetConfig({ accountId, privateKey, rpcUrl, contractId });

const wasmPath = `${root}contracts/coys-game/res/coys_game.wasm`;
const wasm = readFileSync(wasmPath);
const sha = createHash('sha256').update(wasm).digest('hex');
const expected = readFileSync(`${wasmPath}.sha256`, 'utf8').trim().split(/\s+/)[0];
if (sha !== expected) {
  console.error(`coys_game.wasm sha256 ${sha} does not match coys_game.wasm.sha256 (${expected}); refusing to deploy.`);
  process.exit(1);
}

const provider = new JsonRpcProvider({ url: rpcUrl });
const status = await provider.viewNodeStatus();
if (status.chain_id !== 'testnet') {
  console.error(`RPC reports chain ${status.chain_id}; refusing to deploy anywhere but testnet.`);
  process.exit(1);
}
const account = new Account(accountId, provider, KeyPairSigner.fromSecretKey(privateKey as KeyPairString));
const initialised = await provider
  .callFunction({ contractId, method: 'last_settled_day', args: {} })
  .then(() => true)
  .catch(() => false);
const outcome = await account.signAndSendTransaction({
  receiverId: contractId,
  actions: initialised
    ? [actions.deployContract(new Uint8Array(wasm))]
    : [actions.deployContract(new Uint8Array(wasm)), actions.functionCall('new', { owner_id: accountId }, teraToGas('100'), 0n)],
});
console.log(`game contract ${initialised ? 'updated' : 'deployed and initialised'} on ${contractId} (testnet): tx ${outcome.transaction_outcome.id}, wasm sha256 ${sha}`);
