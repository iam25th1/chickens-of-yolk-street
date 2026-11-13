// Land: a farm buys the plots around its home plot, one at a time at rising prices, in any order.
// Each purchase is checked on the server (not owned yet, affordable), paid through the ledger as
// 'land', and adds the plot's coop slots, numbered after the home plot's so existing coops keep
// their plots; the farm state carries what is owned.
import { afterEach, describe, expect, it } from 'vitest';
import { ECONOMY, LAND_IDS, coopPlots, landCoopPlots, landOfCoopPlot, landPrice, parseClientMessage, toMilli, type GameEvent } from '@coys/shared';
import { loadFacts } from '../src/game/badges';
import { worthOf } from '../src/game/profile';
import { makeGame, type TestGame } from './helpers';

let t: TestGame | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

let n = 0;
const rid = () => `land-${++n}`;

async function player(cash: number) {
  t = await makeGame({ seed: 5 });
  const tg = t;
  const { playerId, farmId } = await tg.game.ensurePlayer('dev', `land-${++n}`, 'Ada');
  await tg.db.query('UPDATE farms SET cash_milli = $2 WHERE id = $1', [farmId, toMilli(cash)]);
  await tg.db.query(`INSERT INTO ledger (farm_id, day, kind, amount_milli, ref, created_at) VALUES ($1, 1, 'test', $2, 'land test', 0)`, [farmId, toMilli(cash - ECONOMY.start.cash)]);
  const heard: GameEvent[] = [];
  tg.game.on((o) => {
    if (o.playerId === playerId && o.msg.t === 'event') heard.push(o.msg.event);
  });
  return { tg, playerId, farmId, heard };
}

describe('land prices and coop slots', () => {
  it('prices rise with each plot bought, and there are four', () => {
    expect(ECONOMY.land.prices).toHaveLength(LAND_IDS.length);
    for (let i = 1; i < ECONOMY.land.prices.length; i++) expect(ECONOMY.land.prices[i]).toBeGreaterThan(ECONOMY.land.prices[i - 1] ?? 0);
    expect(landPrice(0)).toBe(ECONOMY.land.prices[0]);
    expect(landPrice(LAND_IDS.length)).toBeNull();
  });

  it('coop plots: the home plot keeps 0 to 3; each plot of land adds its own numbers, the same whatever was bought first', () => {
    expect(coopPlots([])).toEqual([0, 1, 2, 3]);
    const all = LAND_IDS.flatMap(landCoopPlots);
    expect(new Set(all).size).toBe(all.length);
    expect(Math.min(...all)).toBe(ECONOMY.coops.plots);
    for (const l of LAND_IDS) {
      expect(landCoopPlots(l)).toHaveLength(ECONOMY.land.plots[l].coopSlots);
      for (const p of landCoopPlots(l)) expect(landOfCoopPlot(p)).toBe(l);
    }
    expect(landOfCoopPlot(2)).toBeNull();
    expect(coopPlots(['south', 'east'])).toEqual([0, 1, 2, 3, ...landCoopPlots('east'), ...landCoopPlots('south')]);
  });

  it('the action is strict: a known plot only', () => {
    expect(parseClientMessage({ t: 'buyLand', rid: 'x', plot: 'east' }).ok).toBe(true);
    expect(parseClientMessage({ t: 'buyLand', rid: 'x', plot: 'moon' }).ok).toBe(false);
    expect(parseClientMessage({ t: 'buyLand', rid: 'x', plot: 'east', price: 1 }).ok).toBe(false);
  });
});

describe('buying land', () => {
  it('a new farm owns no land; buying a plot pays the first price as land in the ledger, and the state carries it', async () => {
    const p = await player(5000);
    expect((await p.tg.game.getFarmState(p.farmId)).land).toEqual([]);
    expect(await p.tg.game.act(p.playerId, { t: 'buyLand', rid: rid(), plot: 'north' })).toMatchObject({ ok: true });
    const farm = await p.tg.game.getFarmState(p.farmId);
    expect(farm.land).toEqual(['north']);
    expect(farm.cashMilli).toBe(toMilli(5000 - (landPrice(0) ?? 0)));
    const [row] = await p.tg.db.query(`SELECT kind, amount_milli, ref FROM ledger WHERE farm_id = $1 AND kind = 'land'`, [p.farmId]);
    expect(row).toMatchObject({ kind: 'land', ref: 'north pasture' });
    expect(Number(row?.amount_milli)).toBe(-toMilli(landPrice(0) ?? 0));
    expect(await p.tg.game.ledgerTotal(p.farmId)).toBe(farm.cashMilli);
    expect(p.heard).toContainEqual({ kind: 'landBought', plot: 'north', costMilli: toMilli(landPrice(0) ?? 0) });
  });

  it('the price rises with each plot, whichever is bought; a plot is bought once; all four, then no more', async () => {
    const p = await player(20_000);
    let spent = 0;
    for (const [i, plot] of (['south', 'east', 'west', 'north'] as const).entries()) {
      expect(await p.tg.game.act(p.playerId, { t: 'buyLand', rid: rid(), plot })).toMatchObject({ ok: true });
      spent += ECONOMY.land.prices[i] ?? 0;
      expect((await p.tg.game.getFarmState(p.farmId)).cashMilli).toBe(toMilli(20_000 - spent));
      expect(await p.tg.game.act(p.playerId, { t: 'buyLand', rid: rid(), plot })).toMatchObject({ ok: false, code: 'invalid_action' });
    }
    expect((await p.tg.game.getFarmState(p.farmId)).land).toEqual(['east', 'west', 'north', 'south']);
    const [bought] = await p.tg.db.query<{ n: string }>('SELECT count(*) AS n FROM farm_land WHERE farm_id = $1', [p.farmId]);
    expect(Number(bought?.n)).toBe(4);
    expect(await p.tg.game.ledgerTotal(p.farmId)).toBe((await p.tg.game.getFarmState(p.farmId)).cashMilli);
  });

  it('a farm that cannot pay is refused and keeps its coins', async () => {
    const p = await player((landPrice(0) ?? 0) - 1);
    expect(await p.tg.game.act(p.playerId, { t: 'buyLand', rid: rid(), plot: 'east' })).toMatchObject({ ok: false, code: 'insufficient_funds' });
    const farm = await p.tg.game.getFarmState(p.farmId);
    expect(farm.land).toEqual([]);
    expect(farm.cashMilli).toBe(toMilli((landPrice(0) ?? 0) - 1));
  });

  it('coops: the home plot fills first, then the new land; without land the fifth coop is refused', async () => {
    const p = await player(20_000);
    for (let i = 0; i < ECONOMY.coops.plots - 1; i++) expect(await p.tg.game.act(p.playerId, { t: 'buildCoop', rid: rid(), kind: 'red' })).toMatchObject({ ok: true });
    expect(await p.tg.game.act(p.playerId, { t: 'buildCoop', rid: rid(), kind: 'red' })).toMatchObject({ ok: false, code: 'invalid_action' });
    expect(await p.tg.game.act(p.playerId, { t: 'buyLand', rid: rid(), plot: 'west' })).toMatchObject({ ok: true });
    for (const plot of landCoopPlots('west')) {
      expect(await p.tg.game.act(p.playerId, { t: 'buildCoop', rid: rid(), kind: 'deluxe' })).toMatchObject({ ok: true });
      expect((await p.tg.game.getFarmState(p.farmId)).coops.map((c) => c.plot)).toContain(plot);
    }
    expect(await p.tg.game.act(p.playerId, { t: 'buildCoop', rid: rid(), kind: 'red' })).toMatchObject({ ok: false, code: 'invalid_action' });
    const farm = await p.tg.game.getFarmState(p.farmId);
    // the starter coop and the three red ones keep plots 0 to 3; the new ones stand on the west meadow
    expect(farm.coops.map((c) => c.plot).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, ...landCoopPlots('west')]);
    expect(p.heard.filter((e) => e.kind === 'coopBuilt').map((e) => (e.kind === 'coopBuilt' ? e.plot : -1))).toEqual([1, 2, 3, ...landCoopPlots('west')]);
  });
});

describe('land badges', () => {
  it('NEW GROUND for the first plot, ROOM TO ROOST for a coop on it, FOUR CORNERS for all four; land counts in net worth', async () => {
    const p = await player(20_000);
    const badges = () => p.heard.flatMap((e) => (e.kind === 'badgeEarned' ? [e.badge] : []));
    expect(await p.tg.game.act(p.playerId, { t: 'buyLand', rid: rid(), plot: 'east' })).toMatchObject({ ok: true });
    expect(badges()).toContain('new-ground');
    expect(badges()).not.toContain('four-corners');
    // the home plot's coops first: no coop on new land yet
    for (let i = 0; i < ECONOMY.coops.plots - 1; i++) await p.tg.game.act(p.playerId, { t: 'buildCoop', rid: rid(), kind: 'red' });
    expect(badges()).not.toContain('room-to-roost');
    expect(await p.tg.game.act(p.playerId, { t: 'buildCoop', rid: rid(), kind: 'red' })).toMatchObject({ ok: true });
    expect(badges()).toContain('room-to-roost');
    for (const plot of ['west', 'north', 'south'] as const) expect(await p.tg.game.act(p.playerId, { t: 'buyLand', rid: rid(), plot })).toMatchObject({ ok: true });
    expect(badges()).toContain('four-corners');
    const facts = (await loadFacts(p.tg.db, [p.farmId], 1, ['netWorth', 'landPlots', 'landCoops'])).get(p.farmId);
    expect(facts).toMatchObject({ landPlots: 4, landCoops: 1 });
    const farm = await p.tg.game.getFarmState(p.farmId);
    const paid = ECONOMY.land.prices.reduce((a, b) => a + b, 0);
    expect(facts?.netWorth).toBe(
      Math.floor(
        worthOf(
          farm.cashMilli,
          farm.hens.length,
          farm.coops.map((c) => c.kind),
          [],
          toMilli(paid),
        ).totalMilli / 1000,
      ),
    );
  });
});
