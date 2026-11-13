// Records closed days of a season whose day close failed to settle (a refused RPC call, say) on the
// game contract, late: each day's full settlement is rebuilt from the game database (supply,
// multiplier, every farm's net from the ledger; no egg moves, since the next settled day already
// brought every balance up to date), and its SHA-256 goes to settle_late_days (contract version 5)
// in one call. The server does the same at each day close; this is the owner's tool for a backlog.
// Testnet only.
//
//   npx tsx scripts/settle-late-days.ts --season s1 --dry-run     # list the days and their digests
//   npx tsx scripts/settle-late-days.ts --season s1               # record them, then mark them settled
//   npx tsx scripts/settle-late-days.ts --season s1 --days 509,510
//
// Signs with NEAR_TESTNET_ACCOUNT_ID and NEAR_TESTNET_PRIVATE_KEY; reads DATABASE_URL.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildLateSettlement, digestOf } from '../apps/server/src/chain/batch';
import { createChainWriter, missedDays, storeLateDays } from '../apps/server/src/chain/chain';
import { FeatherRenderer } from '../apps/server/src/chain/feather-image';
import { openDb } from '../apps/server/src/db/db';
import { assertTestnetId, assertTestnetRpc } from './lib/testnet';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
const fail = (message: string): never => {
  console.error(`settle-late-days: ${message}`);
  process.exit(1);
};
const { values } = parseArgs({ options: { season: { type: 'string' }, days: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
const season = values.season ?? fail('--season is required');
const databaseUrl = process.env.DATABASE_URL ?? fail('set DATABASE_URL (the game database)');
const dry = values['dry-run'];
if (!dry) {
  try {
    assertTestnetId(process.env.NEAR_TESTNET_ACCOUNT_ID ?? fail('set NEAR_TESTNET_ACCOUNT_ID'));
    if (!process.env.NEAR_TESTNET_PRIVATE_KEY) fail('set NEAR_TESTNET_PRIVATE_KEY');
    assertTestnetRpc(process.env.NEAR_TESTNET_RPC_URL || 'https://test.rpc.fastnear.com');
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

const db = await openDb(databaseUrl);
try {
  const days = values.days ? values.days.split(',').map((d) => Number(d.trim())) : await missedDays(db, season, 2 ** 31 - 1);
  if (days.some((d) => !Number.isInteger(d) || d < 1)) fail(`--days must be day numbers, not ${values.days}`);
  if (!days.length) {
    console.log(`season ${season}: no missed days`);
  } else {
    for (const day of days) {
      const [row] = await db.query('SELECT settlement_status FROM market_days WHERE season = $1 AND day = $2', [season, day]);
      const s = await buildLateSettlement(db, season, day);
      console.log(
        `season ${season} day ${day} (${String(row?.settlement_status ?? 'no such day')}): supply ${s.supply}, multiplier ${s.multiplier_milli / 1000}, ` +
          `farms with a net: ${s.farms.filter((f) => f.net_milli !== '0').length}, digest ${digestOf(s)}`,
      );
    }
    if (!dry) {
      const chain = createChainWriter(process.env, new FeatherRenderer(join(root, 'apps/client/public/assets')), (line) => console.log(line));
      const settle = chain.mode === 'near-testnet' ? chain.settleLateDays?.bind(chain) : undefined;
      if (!settle) fail('no NEAR testnet chain writer (credentials missing)');
      // the writer reads the balance and the Feathers once at start: let those finish before the next call
      await new Promise((r) => setTimeout(r, 3000));
      const late = await (settle as NonNullable<typeof settle>)(db, season, days);
      if (late.status !== 'sent') fail(`nothing recorded: ${late.error ?? late.status}`);
      await storeLateDays(db, season, late);
      console.log(`recorded late: days ${late.days.map((d) => d.day).join(', ')}, tx ${late.txHash}`);
      console.log(`explorer: https://testnet.nearblocks.io/txns/${late.txHash}`);
    }
  }
} finally {
  await db.close();
}
