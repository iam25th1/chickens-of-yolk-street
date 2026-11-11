// Backs up the game's Postgres database with pg_dump (custom format) to a timestamped file.
//
//   npx tsx scripts/db-backup.ts [--out backups] [--url-env DATABASE_URL]
//
// Reads the database URL from the named environment variable (default DATABASE_URL; the repo .env
// is loaded when present) and passes it to pg_dump as libpq variables, so the password never shows
// on a command line. Needs pg_dump on PATH (or PG_BIN pointing at its folder) at the same major
// version as the server or newer.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { backupName, pgTarget } from './lib/pg';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);

const { values } = parseArgs({ options: { out: { type: 'string', default: 'backups' }, 'url-env': { type: 'string', default: 'DATABASE_URL' } } });
const urlEnv = values['url-env'];
const url = process.env[urlEnv];
if (!url || !/^postgres(ql)?:\/\//.test(url)) {
  console.error(`db-backup: ${urlEnv} must be a postgres:// URL (PGlite databases are folders: copy the folder instead)`);
  process.exit(1);
}
const target = pgTarget(url);
const outDir = resolve(values.out);
mkdirSync(outDir, { recursive: true });
const file = join(outDir, backupName(new Date()));
const bin = process.env.PG_BIN ? join(process.env.PG_BIN, 'pg_dump') : 'pg_dump';

console.log(`db-backup: dumping ${target.label} to ${file}`);
const run = spawnSync(bin, ['--format=custom', '--no-owner', '--no-acl', `--file=${file}`, `--dbname=${target.database}`], {
  env: { ...process.env, ...target.env },
  stdio: 'inherit',
});
if (run.error || run.status !== 0) {
  console.error(`db-backup: pg_dump failed${run.error ? ` (${run.error.message})` : ` with exit code ${run.status}`}`);
  process.exit(1);
}
console.log(`db-backup: done, ${(statSync(file).size / 1024).toFixed(1)} KB`);
