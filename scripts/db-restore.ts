// Restores a db-backup.ts dump into a Postgres database with pg_restore, replacing what is there.
//
//   npx tsx scripts/db-restore.ts --file backups/coys-<time>.dump --url-env RESTORE_DATABASE_URL --yes
//
// The target URL comes from the named environment variable (default DATABASE_URL; the repo .env is
// loaded when present) and reaches pg_restore as libpq variables. The restore runs in one
// transaction and stops at the first error, so a failed restore changes nothing. Without --yes it
// only says what it would do. Needs pg_restore on PATH (or PG_BIN) at the dump's major version or
// newer. Stop the game server on the target first.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pgTarget } from './lib/pg';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);

const { values } = parseArgs({
  options: { file: { type: 'string' }, 'url-env': { type: 'string', default: 'DATABASE_URL' }, yes: { type: 'boolean', default: false } },
});
const file = values.file ? resolve(values.file) : null;
if (!file || !existsSync(file)) {
  console.error('db-restore: --file <dump> is required and must exist');
  process.exit(1);
}
const urlEnv = values['url-env'];
const url = process.env[urlEnv];
if (!url || !/^postgres(ql)?:\/\//.test(url)) {
  console.error(`db-restore: ${urlEnv} must be a postgres:// URL`);
  process.exit(1);
}
const target = pgTarget(url);
console.log(`db-restore: ${file} into ${target.label}, replacing its tables`);
if (!values.yes) {
  console.log('db-restore: nothing done; add --yes to restore');
  process.exit(0);
}
const bin = process.env.PG_BIN ? join(process.env.PG_BIN, 'pg_restore') : 'pg_restore';
const run = spawnSync(
  bin,
  ['--clean', '--if-exists', '--no-owner', '--no-acl', '--single-transaction', '--exit-on-error', `--dbname=${target.database}`, file],
  { env: { ...process.env, ...target.env }, stdio: 'inherit' },
);
if (run.error || run.status !== 0) {
  console.error(`db-restore: pg_restore failed${run.error ? ` (${run.error.message})` : ` with exit code ${run.status}`}; nothing was changed`);
  process.exit(1);
}
console.log('db-restore: done');
