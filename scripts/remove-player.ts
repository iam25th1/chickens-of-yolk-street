// Removes a player and their farm from the game entirely: not marked bust but gone, so the farm
// leaves the market, the rankings, the demand count and the ticker, with every row it owned (hens,
// coops, machines, cards, orders, trades, contracts, debts, lay plan, ledger). One transaction.
// Stop the server first (a day close running at the same time could write to the farm).
//
//   npx tsx scripts/remove-player.ts --player <player id> [--yes] [--url-env DATABASE_URL]
//
// Without --yes it only prints what it would remove.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDb } from '../apps/server/src/db/db';
import { planRemoval, removePlayer } from './lib/remove';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
const { values } = parseArgs({ options: { player: { type: 'string' }, yes: { type: 'boolean', default: false }, 'url-env': { type: 'string', default: 'DATABASE_URL' } } });
const url = process.env[values['url-env']];
if (!values.player || !url) {
  console.error('remove-player: --player <id> and a database URL are required');
  process.exit(1);
}

const db = await openDb(url);
try {
  const plan = values.yes ? await removePlayer(db, values.player) : await planRemoval(db, values.player);
  const rows = Object.entries(plan.rows).map(([t, n]) => `${t} ${n}`).join(', ');
  console.log(`remove-player: ${plan.player.name} (${plan.player.id}), farms ${plan.farms.map((f) => `${f.name} ${f.id}`).join(', ') || 'none'}; ${rows}`);
  console.log(values.yes ? 'remove-player: removed' : 'remove-player: dry run; pass --yes to remove');
} finally {
  await db.close();
}
