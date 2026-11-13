// Seeds the demo farms in a LOCAL COPY of the game's database (never the live one), for recording the
// demo video. Everything goes through the game's own actions and rules: nothing on screen is a
// hand-edited number.
//
//   DATABASE_URL=postgres:///coys_demo npx tsx scripts/demo-video/seed.ts [--farm "<name>"]
//
// - The late-game farm: the copy's player farm with the most hens (it has real history, so its ledger
//   shows real testnet receipts), renamed Golden Yolk Acres in the copy, its coops filled with hens
//   bought in the shop, and the east field bought.
// - Clucky Ranch, the fresh farm, is made by the demo session (/?demo=new) in the recording itself and
//   named there; this script only checks the name is free.
// Refuses any database whose name does not contain "demo", and any host that is not this machine.
import { InferenceBudget } from '../../apps/server/src/agents/brain';
import { ProviderChain } from '../../apps/server/src/ai/chain';
import { NoopChain } from '../../apps/server/src/chain/chain';
import { openDb } from '../../apps/server/src/db/db';
import { Game } from '../../apps/server/src/game/game';
import { uniqueFarmName } from '../../apps/server/src/game/names';
import { coopCapacity, ECONOMY, feedGramsPerHenDay, type CoopKind } from '@coys/shared';

import { FRESH_FARM, LATE_FARM } from './names';

const url = process.env.DATABASE_URL ?? '';
const m = /^postgres(?:ql)?:\/\/(?:[^@/]*@)?([^/:]*)(?::\d+)?\/([^?]+)/.exec(url);
const host = m?.[1] ?? 'unknown';
const dbName = m?.[2] ?? '';
if (!/demo/.test(dbName) || !['', 'localhost', '127.0.0.1'].includes(host)) {
  console.error('seed: refusing: DATABASE_URL must be a local database whose name contains "demo"');
  process.exit(1);
}
const args = process.argv.slice(2);
const farmArg = args.includes('--farm') ? args[args.indexOf('--farm') + 1] : null;

const db = await openDb(url);
const log = (line: string) => {
  if (/\[(shop|land|names)\]/.test(line)) console.log(line);
};
const budget = new InferenceBudget(db, 0);
const game = new Game({ db, chain: new NoopChain('local demo copy', log), log, brain: { chain: new ProviderChain([], {}), budget, pricing: new Map() } });
await game.init();

const [late] = farmArg
  ? await db.query<{ id: string; player_id: string; name: string }>(`SELECT id, player_id, name FROM farms WHERE owner_kind = 'player' AND name = $1`, [farmArg])
  : await db.query<{ id: string; player_id: string; name: string }>(
      `SELECT f.id, f.player_id, f.name FROM farms f WHERE f.owner_kind = 'player' AND f.bust_day IS NULL
       ORDER BY (SELECT count(*) FROM hens h WHERE h.farm_id = f.id AND h.status = 'alive') DESC LIMIT 1`,
    );
if (!late) throw new Error('no player farm to seed');
const act = async (a: Record<string, unknown>) => {
  const r = await game.act(late.player_id, { rid: `seed-${Math.random().toString(36).slice(2, 10)}`, ...a } as never);
  if (!r.ok) console.log(`seed: ${String(a.t)} refused: ${r.message ?? r.code}`);
  return r.ok;
};

// its name in the copy, so the recording never shows the real farm's name
if (late.name !== LATE_FARM) await act({ t: 'setFarmName', name: LATE_FARM });

// full coops: hens bought in the shop until the hens fill every coop
let farm = await game.getFarmState(late.id);
const capacity = coopCapacity(farm.coops.map((c) => c.kind as CoopKind));
let want = capacity - farm.hens.length;
while (want > 0) {
  const n = Math.min(want, ECONOMY.limits.maxHensPerPurchase);
  if (!(await act({ t: 'buyHens', count: n }))) break;
  farm = await game.getFarmState(late.id);
  want = capacity - farm.hens.length;
}

// a plot of land
if (!(farm.land ?? []).includes('east')) await act({ t: 'buyLand', plot: 'east' });

// the crate sold at today's price, and the trough filled for a few days (the hens are fed on screen)
farm = await game.getFarmState(late.id);
const crate = farm.crate;
if (crate.white + crate.cream + crate.brown + crate.golden > 0) await act({ t: 'sell', items: { white: crate.white, cream: crate.cream, brown: crate.brown, golden: crate.golden } });
farm = await game.getFarmState(late.id);
const feed = farm.feedGrams.cheap + farm.feedGrams.standard + farm.feedGrams.premium;
const perDay = farm.hens.length * feedGramsPerHenDay();
const bagGrams = ECONOMY.feed.bagKg * 1000;
const bags = Math.min(ECONOMY.limits.maxBagsPerPurchase, Math.max(0, Math.ceil((perDay * 4 - feed) / bagGrams)));
if (bags > 0) await act({ t: 'buyFeed', tier: 'standard', bags });

// Clucky Ranch is the name the recording gives its fresh farm: a farm of the copy that happens to carry
// it (a generated name) gets another generated name, in the copy only
const [holder] = await db.query<{ player_id: string }>(`SELECT player_id FROM farms WHERE name = $1 AND player_id IS NOT NULL`, [FRESH_FARM]);
if (holder) {
  const fresh = await uniqueFarmName(db);
  const r = await game.act(holder.player_id, { rid: 'seed-free-name', t: 'setFarmName', name: fresh } as never);
  if (!r.ok) console.log(`seed: could not free ${FRESH_FARM}: ${r.message ?? r.code}`);
}

farm = await game.getFarmState(late.id);
const machines = await db.query<{ unlock_id: string; condition: number }>('SELECT unlock_id, condition FROM unlocks WHERE farm_id = $1 ORDER BY unlock_id', [late.id]);
const [taken] = await db.query(`SELECT count(*)::int AS n FROM farms WHERE name = $1`, [FRESH_FARM]);
console.log(
  JSON.stringify({
    late: {
      name: farm.name,
      hens: farm.hens.length,
      capacity: coopCapacity(farm.coops.map((c) => c.kind as CoopKind)),
      coins: farm.cashMilli / 1000,
      land: farm.land,
      machines: machines.map((m) => `${m.unlock_id} ${Math.round(Number(m.condition) * 100)}%`),
    },
    freshNameFree: Number(taken?.n ?? 0) === 0,
  }),
);
await db.close();
process.exit(0);
