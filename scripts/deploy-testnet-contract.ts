// Deploys a game contract wasm (the CI artifact, committed at contracts/coys-game/res/) to a NEAR
// testnet account. Testnet only: every account id must be a .testnet name or an implicit testnet
// id, the RPC must report chain testnet, and anything that looks like mainnet is refused before a
// key is touched.
//
//   npx tsx scripts/deploy-testnet-contract.ts --wasm contracts/coys-game/res/coys_game.wasm --account play.coys-game.testnet --create --fund 8
//
// Signs with NEAR_TESTNET_ACCOUNT_ID and NEAR_TESTNET_PRIVATE_KEY (environment, or the repo .env).
//   --wasm <file>      wasm to deploy; checked against <file>.sha256 when that file exists
//   --account <id>     account that receives the code (default NEAR_TESTNET_ACCOUNT_ID)
//   --create           first create <id> as a sub-account of NEAR_TESTNET_ACCOUNT_ID, with the same
//                      public key (so the same private key signs for it), funded with --fund NEAR
//   --fund <near>      NEAR sent to a created account (default 8)
//   --owner <id>       owner_id for new() on a fresh contract (default: the account itself)
//   --migrate          call migrate() after deploying, to upgrade version 1 state in place
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, nearToYocto, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { assertTestnetId, assertTestnetRpc } from './lib/testnet';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);

const fail = (message: string): never => {
  console.error(`deploy-testnet-contract: ${message}`);
  process.exit(1);
};

const { values } = parseArgs({
  options: {
    wasm: { type: 'string' },
    account: { type: 'string' },
    create: { type: 'boolean', default: false },
    fund: { type: 'string', default: '8' },
    owner: { type: 'string' },
    migrate: { type: 'boolean', default: false },
  },
});

const signerId = process.env.NEAR_TESTNET_ACCOUNT_ID ?? fail('set NEAR_TESTNET_ACCOUNT_ID (see .env.example)');
const privateKey = process.env.NEAR_TESTNET_PRIVATE_KEY ?? fail('set NEAR_TESTNET_PRIVATE_KEY (see .env.example)');
const target = values.account ?? signerId;
const owner = values.owner ?? target;
const rpcUrl = process.env.NEAR_TESTNET_RPC_URL || 'https://test.rpc.fastnear.com';
try {
  for (const id of [signerId, target, owner]) assertTestnetId(id);
  assertTestnetRpc(rpcUrl);
  if (!privateKey.startsWith('ed25519:')) throw new Error('NEAR_TESTNET_PRIVATE_KEY must be an ed25519:... key');
  if (values.create && !target.endsWith(`.${signerId}`)) throw new Error(`--create needs ${target} to be a sub-account of ${signerId}`);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const wasmPath = resolve(values.wasm ?? fail('--wasm <file> is required'));
const wasm = readFileSync(wasmPath);
const sha = createHash('sha256').update(wasm).digest('hex');
if (existsSync(`${wasmPath}.sha256`)) {
  const expected = readFileSync(`${wasmPath}.sha256`, 'utf8').trim().split(/\s+/)[0];
  if (sha !== expected) fail(`${wasmPath} has sha256 ${sha}, not the ${expected} in its .sha256 file`);
}

const provider = new JsonRpcProvider({ url: rpcUrl });
const status = await provider.viewNodeStatus();
if (status.chain_id !== 'testnet') fail(`RPC reports chain ${status.chain_id}; refusing anything but testnet`);
const signer = KeyPairSigner.fromSecretKey(privateKey as KeyPairString);
const exists = (id: string) => new Account(id, provider).getState().then(
  () => true,
  () => false,
);

if (values.create) {
  if (await exists(target)) {
    console.log(`${target} already exists; deploying to it`);
  } else {
    const parent = new Account(signerId, provider, signer);
    const publicKey = KeyPair.fromString(privateKey as KeyPairString).getPublicKey().toString();
    const created = await parent.createSubAccount({ accountOrPrefix: target, publicKey, nearToTransfer: nearToYocto(Number(values.fund)) });
    console.log(`created ${target} (testnet) with the signer's public key, funded with ${values.fund} NEAR: tx ${created.transaction_outcome.id}`);
  }
}

const account = new Account(target, provider, signer);
const initialised = await provider
  .callFunction({ contractId: target, method: 'egg_grades', args: {} })
  .then(() => true)
  .catch(() => false);
const steps = [actions.deployContract(new Uint8Array(wasm))];
if (values.migrate) steps.push(actions.functionCall('migrate', {}, teraToGas('100'), 0n));
else if (!initialised) steps.push(actions.functionCall('new', { owner_id: owner }, teraToGas('100'), 0n));
const outcome = await account.signAndSendTransaction({ receiverId: target, actions: steps });
const what = values.migrate ? 'deployed and migrated' : initialised ? 'updated' : `deployed and initialised (owner ${owner})`;
console.log(`game contract ${what} on ${target} (testnet): tx ${outcome.transaction_outcome.id}, wasm sha256 ${sha}`);
console.log(`explorer: https://testnet.nearblocks.io/txns/${outcome.transaction_outcome.id}`);
