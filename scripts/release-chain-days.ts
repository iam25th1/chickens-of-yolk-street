// Releases the per-day records version 2 of the game contract stored, so their storage comes back
// to the game account, while the history stays verifiable from the database plus hashes:
//
// 1. Each record still on chain is read exactly as day_record returns it and copied into the
//    game database (chain_archive) and a JSON backup file.
// 2. prune_days releases them in order, in chunks; the contract folds each released record into
//    the season's archive hash: archive = sha256("{archive}|{day}|{record text}").
// 3. After every chunk the archive hash the contract returns is checked against the same fold
//    over the copied records. Any difference stops the run.
//
//   npm run release-chain-days -- --account play.coys-game.testnet --season s1 --backup <file> [--chunk 200]
//
// Testnet only. Signs with NEAR_TESTNET_ACCOUNT_ID and NEAR_TESTNET_PRIVATE_KEY; writes to the
// database at DATABASE_URL (environment, or the repo .env).
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Account, JsonRpcProvider, KeyPairSigner, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { openDb } from '../apps/server/src/db/db';
import { assertTestnetId, assertTestnetRpc } from './lib/testnet';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
const fail = (message: string): never => {
  console.error(`release-chain-days: ${message}`);
  process.exit(1);
};
const { values } = parseArgs({
  options: { account: { type: 'string' }, season: { type: 'string' }, backup: { type: 'string' }, chunk: { type: 'string', default: '200' } },
});
const signerId = process.env.NEAR_TESTNET_ACCOUNT_ID ?? fail('set NEAR_TESTNET_ACCOUNT_ID');
const privateKey = process.env.NEAR_TESTNET_PRIVATE_KEY ?? fail('set NEAR_TESTNET_PRIVATE_KEY');
const databaseUrl = process.env.DATABASE_URL ?? fail('set DATABASE_URL (the game database that keeps chain_archive)');
const target = values.account ?? signerId;
const season = values.season ?? fail('--season is required');
const backup = values.backup ?? fail('--backup <file> is required');
const chunk = Math.max(1, Math.min(400, Number(values.chunk)));
const rpcUrl = process.env.NEAR_TESTNET_RPC_URL || 'https://test.rpc.fastnear.com';
try {
  for (const id of [signerId, target]) assertTestnetId(id);
  assertTestnetRpc(rpcUrl);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

interface Head {
  last_day: number;
  v2_through: number;
  pruned_through: number;
  archive: string;
}
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const provider = new JsonRpcProvider({ url: rpcUrl });
const status = await provider.viewNodeStatus();
if (status.chain_id !== 'testnet') fail(`RPC reports chain ${status.chain_id}; refusing anything but testnet`);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A view call, paced and retried: public RPCs answer 429 to a burst of reads. */
const view = async (method: string, args: object): Promise<string> => {
  for (let attempt = 0; ; attempt++) {
    try {
      await pause(120);
      const r = await provider.query<{ result: number[] }>({
        request_type: 'call_function',
        account_id: target,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
        finality: 'final',
      });
      return Buffer.from(r.result).toString('utf8');
    } catch (err) {
      if (attempt >= 6) throw err;
      await pause(1000 * 2 ** attempt);
    }
  }
};
const head = JSON.parse(await view('season_head', { season })) as Head;
console.log(`${target} season ${season}: version 2 recorded days 1 to ${head.v2_through}, released through ${head.pruned_through}`);
if (head.pruned_through >= head.v2_through) {
  console.log('nothing left to release');
  process.exit(0);
}

// 1. copy every record still on chain
const records: { day: number; text: string }[] = [];
for (let day = head.pruned_through + 1; day <= head.v2_through; day++) {
  const text = await view('day_record', { season, day });
  if (text !== 'null') records.push({ day, text });
}
writeFileSync(backup, `${JSON.stringify({ contract: target, season, head, records }, null, 1)}\n`);
console.log(`copied ${records.length} records to ${backup}`);
const db = await openDb(databaseUrl);
const now = Date.now();
for (const r of records) {
  await db.query('INSERT INTO chain_archive (season, day, record, released_at) VALUES ($1, $2, $3, $4) ON CONFLICT (season, day) DO NOTHING', [season, r.day, r.text, now]);
  const [kept] = await db.query('SELECT record FROM chain_archive WHERE season = $1 AND day = $2', [season, r.day]);
  if (kept?.record !== r.text) fail(`chain_archive holds a different record for ${season} day ${r.day}`);
}
console.log(`kept ${records.length} records in chain_archive`);

// 2 and 3. release in chunks, checking the archive hash each time
const account = new Account(target, provider, KeyPairSigner.fromSecretKey(privateKey as KeyPairString));
let archive = head.archive;
let through = head.pruned_through;
const byDay = new Map(records.map((r) => [r.day, r.text]));
const before = (await account.getState()).storageUsage;
while (through < head.v2_through) {
  const upTo = Math.min(head.v2_through, through + chunk);
  for (let d = through + 1; d <= upTo; d++) {
    const text = byDay.get(d);
    if (text !== undefined) archive = sha(`${archive}|${d}|${text}`);
  }
  const out = await account.callFunctionRaw({ contractId: target, methodName: 'prune_days', args: { season, through: upTo, limit: chunk }, gas: teraToGas('300'), deposit: 0n });
  // the head prune_days returns (a view right after can still show the block before)
  const status = out.status as { SuccessValue?: string; Failure?: unknown };
  if (status.SuccessValue === undefined) fail(`prune_days failed: ${JSON.stringify(status.Failure ?? status).slice(0, 300)} (tx ${out.transaction_outcome.id})`);
  const after = JSON.parse(Buffer.from(status.SuccessValue ?? '', 'base64').toString('utf8')) as Head;
  if (after.pruned_through !== upTo) fail(`released through ${after.pruned_through}, expected ${upTo} (tx ${out.transaction_outcome.id})`);
  if (after.archive !== archive) fail(`archive hash ${after.archive} on chain, ${archive} from the copied records (tx ${out.transaction_outcome.id})`);
  console.log(`released days ${through + 1} to ${upTo}: tx ${out.transaction_outcome.id}, archive ${archive}`);
  through = upTo;
}
const after = (await account.getState()).storageUsage;
console.log(`done: ${before - after} bytes released (${((before - after) / 1e5).toFixed(4)} NEAR back to ${target}); archive ${archive}`);
await db.close();
