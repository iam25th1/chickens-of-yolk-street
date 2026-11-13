// Badges: the catalog (at least 60, unique, every icon from the art contract), and the engine, one
// category at a time: each badge earns once, at the right level, when its number reaches a threshold,
// the player hears a badgeEarned event for it, and a higher level comes later on its own.
import { afterEach, describe, expect, it } from 'vitest';
import {
  BADGES,
  BADGE_BY_ID,
  BADGE_CATEGORIES,
  BADGE_ICONS,
  BADGE_METRICS,
  BADGE_RULES,
  ECONOMY,
  badgeLevels,
  levelFor,
  nextLevel,
  topBadges,
  type GameEvent,
} from '@coys/shared';
import { evaluateBadges, loadFacts } from '../src/game/badges';
import { statBrokeDown, statDelivered } from '../src/game/profile';
import { makeGame, type TestGame } from './helpers';

let t: TestGame | null = null;
afterEach(async () => {
  await t?.db.close();
  t = null;
});

let n = 0;
const rid = () => `b${++n}`;
const nextDay = async (tg: TestGame) => {
  tg.clock.t += ECONOMY.day.lengthMs;
  await tg.game.endDay();
};

/** A game with one player, the badges they hear, and their badge rows. */
async function player(opts: { cast?: boolean } = {}) {
  t = await makeGame({ cast: opts.cast ?? false, seed: 11 });
  const tg = t;
  const { playerId, farmId } = await tg.game.ensurePlayer('dev', `device-${++n}`, 'Badger');
  const heard: Extract<GameEvent, { kind: 'badgeEarned' }>[] = [];
  tg.game.on((o) => {
    if (o.playerId === playerId && o.msg.t === 'event' && o.msg.event.kind === 'badgeEarned') heard.push(o.msg.event);
  });
  const held = async (): Promise<Record<string, string>> =>
    Object.fromEntries((await tg.db.query<{ badge: string; tier: string }>('SELECT badge, tier FROM badges WHERE farm_id = $1 AND tier IS NOT NULL', [farmId])).map((r) => [r.badge, r.tier]));
  const evaluate = () => tg.game.withCtx((ctx) => evaluateBadges(ctx, [farmId]));
  return { tg, playerId, farmId, heard, held, evaluate };
}

describe('the badge catalog', () => {
  it('has at least 60 badges with unique ids, icons from the art contract, rising levels and one line each', () => {
    expect(BADGES.length).toBeGreaterThanOrEqual(60);
    expect(new Set(BADGES.map((b) => b.id)).size).toBe(BADGES.length);
    expect(new Set(BADGES.map((b) => b.name)).size).toBe(BADGES.length);
    const icons = new Set<string>(BADGE_ICONS);
    expect(icons.size).toBe(40);
    for (const b of BADGES) {
      expect(icons.has(b.icon), `${b.id} icon ${b.icon}`).toBe(true);
      expect(b.icon).not.toBe('mystery');
      expect((BADGE_METRICS as readonly string[]).includes(b.metric), b.id).toBe(true);
      expect([1, 3]).toContain(b.levels.length);
      for (let i = 1; i < b.levels.length; i++) expect(b.levels[i] ?? 0, b.id).toBeGreaterThan(b.levels[i - 1] ?? 0);
      expect(b.levels[0]).toBeGreaterThan(0);
      expect(b.id).toMatch(/^[a-z0-9-]+$/);
      // short enough for two lines of a badge cell
      expect(b.name.length, b.name).toBeLessThanOrEqual(18);
      expect(b.name).toBe(b.name.toUpperCase());
      for (const level of badgeLevels(b)) {
        const line = b.text(b.levels[badgeLevels(b).indexOf(level)] ?? 0);
        expect(line.length, b.id).toBeGreaterThan(8);
        expect(line).toBe(line.toUpperCase());
        expect(line).not.toContain(String.fromCharCode(0x2014));
      }
    }
    // every category has badges, a few are secret, and both kinds (with levels and plain) exist
    for (const c of BADGE_CATEGORIES) expect(BADGES.filter((b) => b.category === c).length, c).toBeGreaterThanOrEqual(5);
    expect(BADGES.filter((b) => b.secret).length).toBeGreaterThanOrEqual(5);
    expect(BADGES.filter((b) => b.levels.length === 3).length).toBeGreaterThanOrEqual(25);
    expect(BADGES.filter((b) => b.levels.length === 1).length).toBeGreaterThanOrEqual(20);
    // the brief's own badges are all there
    for (const id of ['first-egg', 'crate-filler', 'golden-egg', 'first-sale', 'into-the-glut', 'top-of-the-market', 'order-filler', 'first-haggle', 'haggler', 'worked-the-room', 'on-time', 'full-house', 'seen-them-all', 'old-bird', 'fully-automated', 'stitch-in-time', 'smooth-running', 'last-one-standing', 'podium', 'number-one', 'ticket-holder', 'golden-quill', 'good-standing', 'night-owl', 'rooster-crew']) {
      expect(BADGE_BY_ID.has(id), id).toBe(true);
    }
    expect(BADGE_BY_ID.get('crate-filler')?.levels).toEqual([100, 1000, 10000]);
    expect(BADGE_BY_ID.get('order-filler')?.levels.at(-1)).toBe(50);
    expect(BADGE_BY_ID.get('good-standing')?.levels).toEqual([7, 30, 100]);
  });

  it('levels: the highest threshold reached, the next one to earn, and the best few first', () => {
    const b = BADGE_BY_ID.get('crate-filler');
    if (!b) throw new Error('missing');
    expect(levelFor(b, 99)).toBeNull();
    expect(levelFor(b, 100)).toBe('bronze');
    expect(levelFor(b, 9999)).toBe('silver');
    expect(levelFor(b, 10000)).toBe('gold');
    expect(nextLevel(b, null)).toBe('bronze');
    expect(nextLevel(b, 'gold')).toBeNull();
    const plain = BADGE_BY_ID.get('first-egg');
    if (!plain) throw new Error('missing');
    expect(levelFor(plain, 1)).toBe('plain');
    expect(nextLevel(plain, 'plain')).toBeNull();
    expect(topBadges([{ id: 'first-egg', level: 'plain' }, { id: 'haggler', level: 'gold' }, { id: 'podium', level: 'bronze' }], 2).map((x) => x.id)).toEqual(['haggler', 'first-egg']);
  });
});

describe('eggs', () => {
  it('the first egg picked up earns FIRST EGG at once, with its moment; the counts climb to CRATE FILLER', async () => {
    const p = await player();
    const egg = (await p.tg.game.getFarmState(p.farmId)).layPlan.find((e) => !e.broken);
    if (!egg) throw new Error('no egg');
    p.tg.clock.t += egg.atMs + 1;
    expect(await p.tg.game.act(p.playerId, { t: 'collect', rid: rid(), eggId: egg.id })).toMatchObject({ ok: true });
    expect(p.heard.map((e) => e.badge)).toContain('first-egg');
    expect(p.heard.find((e) => e.badge === 'first-egg')).toMatchObject({ level: 'plain', day: 1 });
    expect((await p.held())['first-egg']).toBe('plain');
    const [s] = await p.tg.db.query('SELECT eggs_collected, eggs_picked FROM farm_stats WHERE farm_id = $1', [p.farmId]);
    expect(s).toMatchObject({ eggs_collected: 1, eggs_picked: 1 });
    // at the close every egg left on the ground goes to the crate and counts; 100 of them is CRATE FILLER
    await p.tg.db.query('UPDATE farm_stats SET eggs_collected = 99 WHERE farm_id = $1', [p.farmId]);
    await nextDay(p.tg);
    expect((await p.held())['crate-filler']).toBe('bronze');
    // nothing is earned twice
    const before = p.heard.length;
    await p.evaluate();
    expect(p.heard.length).toBe(before);
  });

  it('golden eggs, a big laying day and a packed crate', async () => {
    const p = await player();
    await p.tg.db.query('UPDATE farm_stats SET golden_collected = 10 WHERE farm_id = $1', [p.farmId]);
    await p.tg.db.query('UPDATE farms SET crate_white = 160 WHERE id = $1', [p.farmId]);
    await p.evaluate();
    const held = await p.held();
    expect(held['golden-egg']).toBe('plain');
    expect(held['golden-hoard']).toBe('bronze');
    expect(held['packed-crate']).toBe('silver');
  });
});

describe('market', () => {
  it('a first sale, a sale into a glut and a golden egg sold at a peak (a secret)', async () => {
    const p = await player();
    await p.tg.db.query('UPDATE farms SET crate_white = 5, crate_golden = 1 WHERE id = $1', [p.farmId]);
    await p.tg.db.query('UPDATE market_days SET multiplier = $1 WHERE day = 1', [BADGE_RULES.glutAt - 0.05]);
    expect(await p.tg.game.act(p.playerId, { t: 'sell', rid: rid(), items: { white: 2 } })).toMatchObject({ ok: true });
    let held = await p.held();
    expect(held['first-sale']).toBe('plain');
    expect(held['into-the-glut']).toBe('plain');
    expect(held['top-of-the-market']).toBeUndefined();
    await p.tg.db.query('UPDATE market_days SET multiplier = $1 WHERE day = 1', [BADGE_RULES.peakAt + 0.1]);
    expect(await p.tg.game.act(p.playerId, { t: 'sell', rid: rid(), items: { golden: 1 } })).toMatchObject({ ok: true });
    held = await p.held();
    expect(held['top-of-the-market']).toBe('bronze');
    expect(held['gold-rush']).toBe('plain');
    expect(p.heard.map((e) => e.badge)).toEqual(expect.arrayContaining(['first-sale', 'into-the-glut', 'top-of-the-market', 'gold-rush']));
  });

  it('buyer orders filled from the book count toward ORDER FILLER', async () => {
    const p = await player({ cast: true });
    await p.tg.db.query('UPDATE farms SET crate_white = 30 WHERE id = $1', [p.farmId]);
    const [buyer] = await p.tg.db.query(`SELECT id FROM agents WHERE kind = 'wholesaler'`);
    await p.tg.db.query('UPDATE agents SET cash_milli = 100000 WHERE id = $1', [buyer?.id]);
    for (let i = 0; i < 10; i++) {
      await p.tg.db.query(
        `INSERT INTO orders (id, deal_id, agent_id, day, side, kind, grade, qty, price_milli, status, created_at, expires_day) VALUES ($1, $1, $2, 1, 'buy', 'limit', 'white', 1, 900, 'open', 0, 3)`,
        [`buy-${i}`, buyer?.id],
      );
      expect(await p.tg.game.act(p.playerId, { t: 'fillOrder', rid: rid(), orderId: `buy-${i}`, qty: 1 })).toMatchObject({ ok: true });
    }
    expect((await p.held())['order-filler']).toBe('silver');
    const [s] = await p.tg.db.query('SELECT orders_filled FROM farm_stats WHERE farm_id = $1', [p.farmId]);
    expect(s?.orders_filled).toBe(10);
  });
});

describe('haggling', () => {
  it('a won haggle, ten of them, and a win against every trader', async () => {
    const p = await player({ cast: true });
    await p.tg.db.query('UPDATE farms SET haggles_won = 10 WHERE id = $1', [p.farmId]);
    for (const kind of BADGE_RULES.haggleKinds.slice(0, 4)) {
      await p.tg.db.query(`INSERT INTO agent_memory (agent_id, farm_id, haggles_won) SELECT id, $1, 1 FROM agents WHERE kind = $2`, [p.farmId, kind]);
    }
    await p.evaluate();
    let held = await p.held();
    expect(held['first-haggle']).toBe('plain');
    expect(held.haggler).toBe('bronze');
    expect(held['worked-the-room']).toBeUndefined();
    await p.tg.db.query(`INSERT INTO agent_memory (agent_id, farm_id, haggles_won) SELECT id, $1, 1 FROM agents WHERE kind = $2`, [p.farmId, BADGE_RULES.haggleKinds[4]]);
    await p.evaluate();
    held = await p.held();
    expect(held['worked-the-room']).toBe('plain');
    // the secret one: ten traders walked away
    await p.tg.db.query('UPDATE farm_stats SET haggles_lost = 10 WHERE farm_id = $1', [p.farmId]);
    await p.evaluate();
    expect((await p.held())['thick-skin']).toBe('plain');
  });
});

describe('contracts', () => {
  it('a hand delivery earns SIGNED AND SEALED and FIRST DELIVERY; deliveries in a row earn ON TIME, and a miss ends the streak', async () => {
    const p = await player({ cast: true });
    const [bakery] = await p.tg.db.query(`SELECT id FROM agents WHERE kind = 'bakery'`);
    await p.tg.db.query(`INSERT INTO contracts (id, farm_id, agent_id, grade, qty_per_day, price_milli, start_day, end_day) VALUES ('k1', $1, $2, 'any', 2, 1500, 1, 9)`, [p.farmId, bakery?.id]);
    await p.tg.db.query('UPDATE farms SET crate_white = 10 WHERE id = $1', [p.farmId]);
    expect(await p.tg.game.act(p.playerId, { t: 'deliverContract', rid: rid(), contractId: 'k1' })).toMatchObject({ ok: true });
    let held = await p.held();
    expect(held.signed).toBe('plain');
    expect(held['first-delivery']).toBe('plain');
    for (let i = 0; i < 4; i++) await p.tg.game.withCtx((ctx) => statDelivered(ctx.q, p.farmId));
    await p.evaluate();
    held = await p.held();
    expect(held['on-time']).toBe('bronze');
    const [s] = await p.tg.db.query('SELECT deliveries, delivery_streak, best_delivery_streak FROM farm_stats WHERE farm_id = $1', [p.farmId]);
    expect(s).toMatchObject({ deliveries: 5, delivery_streak: 5, best_delivery_streak: 5 });
    // day 1 closes with the contract delivered; on day 2 the crate is empty and there is no cart: a miss
    await nextDay(p.tg);
    await p.tg.db.query('UPDATE farms SET crate_white = 0, crate_cream = 0, crate_brown = 0, crate_golden = 0 WHERE id = $1', [p.farmId]);
    await p.tg.db.query(`UPDATE lay_events SET broken = true WHERE farm_id = $1`, [p.farmId]);
    await nextDay(p.tg);
    const [after] = await p.tg.db.query('SELECT delivery_streak, best_delivery_streak FROM farm_stats WHERE farm_id = $1', [p.farmId]);
    expect(after).toMatchObject({ delivery_streak: 0, best_delivery_streak: 5 });
  });
});

describe('flock', () => {
  it('full coops, a top hat, an old hen, every look and a bigger farm', async () => {
    const p = await player();
    const cap = ECONOMY.coops.kinds.starter.capacity - ECONOMY.start.hens;
    await p.tg.db.query('UPDATE farms SET cash_milli = 1000000 WHERE id = $1', [p.farmId]);
    expect(await p.tg.game.act(p.playerId, { t: 'buyHens', rid: rid(), count: cap })).toMatchObject({ ok: true });
    let held = await p.held();
    expect(held['full-house']).toBe('plain');
    expect(await p.tg.game.act(p.playerId, { t: 'buildCoop', rid: rid(), kind: 'deluxe' })).toMatchObject({ ok: true });
    held = await p.held();
    expect(held.builder).toBe('bronze');
    expect(held['deluxe-living']).toBe('plain');
    // a hen in a top hat, one 30 days old, and every look once
    const hens = await p.tg.db.query<{ id: string }>(`SELECT id FROM hens WHERE farm_id = $1 ORDER BY id`, [p.farmId]);
    const looks = [
      ['cream', 'default', 'default', 'tophat'],
      ['brown', 'sleepy', 'spiky', 'bowtie'],
      ['black', 'wild', 'mohawk', 'shades'],
      ['cream', 'default', 'nub', 'none'],
    ];
    for (const [i, [body, eyes, comb, accessory]] of looks.entries()) {
      await p.tg.db.query('UPDATE hens SET body = $2, eyes = $3, comb = $4, accessory = $5, born_day = $6 WHERE id = $1', [hens[i]?.id, body, eyes, comb, accessory, i === 0 ? -29 : 1]);
    }
    await p.tg.game.withCtx((ctx) => evaluateBadges(ctx, [p.farmId], { categories: ['flock'] }));
    held = await p.held();
    expect(held.dapper).toBe('plain');
    expect(held['old-bird']).toBe('bronze');
    expect(held['seen-them-all']).toBe('plain');
    // a look kept through a close is remembered: it still counts once the hen is gone
    await nextDay(p.tg);
    await p.tg.db.query(`UPDATE hens SET accessory = 'none' WHERE id = $1`, [hens[0]?.id]);
    await nextDay(p.tg);
    const facts = (await loadFacts(p.tg.db, [p.farmId], 3, ['traitsSeen'])).get(p.farmId);
    expect(facts?.traitsSeen).toBe(BADGE_RULES.traits.length);
  });

  it('hens bought at auction count toward AUCTION FIND', async () => {
    const p = await player();
    await p.tg.db.query(`UPDATE hens SET status = 'auction' WHERE status = 'forsale'`);
    const [hen] = await p.tg.db.query<{ id: string }>(`SELECT id FROM hens WHERE status = 'auction' LIMIT 1`);
    expect(await p.tg.game.act(p.playerId, { t: 'buyHen', rid: rid(), henId: String(hen?.id) })).toMatchObject({ ok: true });
    expect((await p.held())['auction-find']).toBe('bronze');
  });
});

describe('machines', () => {
  it('each machine, all five, repairs before any breakdown, and a breakdown (a secret) that ends the streak', async () => {
    const p = await player();
    await p.tg.db.query('UPDATE farms SET cash_milli = 1000000 WHERE id = $1', [p.farmId]);
    for (const u of ['conveyor', 'grader', 'cart', 'hopper'] as const) expect(await p.tg.game.act(p.playerId, { t: 'buyUnlock', rid: rid(), unlock: u })).toMatchObject({ ok: true });
    let held = await p.held();
    expect([held['on-the-belt'], held.graded, held['on-the-road'], held['hopper-happy']]).toEqual(['plain', 'plain', 'plain', 'plain']);
    expect(held['fully-automated']).toBeUndefined();
    expect(await p.tg.game.act(p.playerId, { t: 'buyUnlock', rid: rid(), unlock: 'clerk' })).toMatchObject({ ok: true });
    held = await p.held();
    expect(held['front-desk']).toBe('plain');
    expect(held['fully-automated']).toBe('plain');
    // three repairs of worn (not broken) machines in a row
    for (const u of ['conveyor', 'grader', 'cart'] as const) {
      await p.tg.db.query('UPDATE unlocks SET condition = 0.5 WHERE farm_id = $1 AND unlock_id = $2', [p.farmId, u]);
      expect(await p.tg.game.act(p.playerId, { t: 'repairMachine', rid: rid(), unlock: u })).toMatchObject({ ok: true });
    }
    held = await p.held();
    expect(held.handy).toBe('bronze');
    expect(held['stitch-in-time']).toBe('bronze');
    // a breakdown: counted, the streak ends, and the secret badge comes at the close
    await p.tg.game.withCtx((ctx) => statBrokeDown(ctx.q, p.farmId, 1));
    await nextDay(p.tg);
    held = await p.held();
    expect(held['spare-parts']).toBe('plain');
    const [s] = await p.tg.db.query('SELECT repairs, repair_streak, best_repair_streak, breakdowns FROM farm_stats WHERE farm_id = $1', [p.farmId]);
    expect(s).toMatchObject({ repairs: 3, repair_streak: 0, best_repair_streak: 3, breakdowns: 1 });
    // a broken machine repaired does not add to the streak
    await p.tg.db.query(`UPDATE unlocks SET condition = 0.1, broken = true WHERE farm_id = $1 AND unlock_id = 'hopper'`, [p.farmId]);
    expect(await p.tg.game.act(p.playerId, { t: 'repairMachine', rid: rid(), unlock: 'hopper' })).toMatchObject({ ok: true });
    const [s2] = await p.tg.db.query('SELECT repairs, repair_streak FROM farm_stats WHERE farm_id = $1', [p.farmId]);
    expect(s2).toMatchObject({ repairs: 4, repair_streak: 0 });
  });

  it('ten days of machines without a breakdown', async () => {
    const p = await player();
    await p.tg.db.query(`INSERT INTO unlocks (farm_id, unlock_id, bought_day) VALUES ($1, 'cart', 1)`, [p.farmId]);
    for (let d = 0; d < 10; d++) await nextDay(p.tg);
    expect((await p.held())['smooth-running']).toBe('bronze');
  });
});

describe('rivals', () => {
  it('a day closed at the top of the street, and a rival outlasted', async () => {
    const p = await player({ cast: true });
    await p.tg.db.query('UPDATE farms SET cash_milli = 100000000 WHERE id = $1', [p.farmId]);
    await p.tg.db.query(`INSERT INTO ledger (farm_id, day, kind, amount_milli, ref, created_at) VALUES ($1, 1, 'start', 99950000, 'test', 0)`, [p.farmId]);
    await nextDay(p.tg);
    let held = await p.held();
    expect(held['number-one']).toBe('bronze');
    expect(held.podium).toBe('bronze');
    expect(held['top-half']).toBe('bronze');
    const [row] = await p.tg.db.query('SELECT rank, open_farms FROM farm_days WHERE farm_id = $1 AND day = 1', [p.farmId]);
    expect(row?.rank).toBe(1);
    expect(Number(row?.open_farms)).toBeGreaterThan(2);
    await p.tg.db.query(`UPDATE agents SET status = 'bust', bust_day = 2 WHERE kind = 'upstart'`);
    await p.evaluate();
    held = await p.held();
    expect(held['last-one-standing']).toBe('bronze');
  });
});

describe('feathers and days', () => {
  it('tickets, minted grades and milestones; the first close, good standing and fed days', async () => {
    const p = await player();
    for (const [i, g] of ['fluff', 'golden-quill'].entries()) {
      await p.tg.db.query(`INSERT INTO feather_tickets (id, farm_id, milestone, season, day, status, grade, created_at) VALUES ($1, $2, 'full-coop', 'x', 1, 'minted', $3, 0)`, [
        `tk${i}`,
        p.farmId,
        g,
      ]);
    }
    await p.tg.db.query(`INSERT INTO milestone_rolls (farm_id, milestone, season, day, anchor, seed, roll, odds, won) VALUES ($1, 'full-coop', 'x', 1, 'a', 's', 0.1, 0.3, true), ($1, 'good-week', 'x', 1, 'a', 's', 0.9, 0.3, false)`, [p.farmId]);
    await p.evaluate();
    let held = await p.held();
    expect(held['ticket-holder']).toBe('plain');
    expect(held.lucky).toBe('bronze');
    expect(held.fluff).toBe('plain');
    expect(held['golden-quill']).toBe('plain');
    expect(held.plume).toBeUndefined();
    expect(held['milestone-hunter']).toBe('bronze');
    await p.tg.db.query('UPDATE farms SET good_days = 6 WHERE id = $1', [p.farmId]);
    await nextDay(p.tg);
    held = await p.held();
    expect(held['opening-day']).toBe('plain');
    expect(held['good-standing']).toBe('bronze');
  });
});

describe('fun and secret', () => {
  it('business at night, the rooster crow three dawns in a row, a rename, a shoestring day and a big street sale', async () => {
    const p = await player();
    const dayMs = ECONOMY.day.lengthMs;
    // dawn on day 1 (the game starts at dawn), day 2 and day 3
    await p.tg.db.query('UPDATE farms SET crate_white = 300, cash_milli = 500 WHERE id = $1', [p.farmId]);
    await p.tg.db.query(`UPDATE ledger SET amount_milli = 500 WHERE farm_id = $1 AND kind = 'start'`, [p.farmId]);
    expect(await p.tg.game.act(p.playerId, { t: 'setFeedTier', rid: rid(), tier: 'cheap' })).toMatchObject({ ok: true });
    // a settings change is not business: no crow yet
    let [s] = await p.tg.db.query('SELECT crow_streak FROM farm_stats WHERE farm_id = $1', [p.farmId]);
    expect(s?.crow_streak).toBe(0);
    // a shoestring day: the close with under one coin
    await nextDay(p.tg);
    expect((await p.held()).shoestring).toBe('plain');
    for (let d = 0; d < 3; d++) {
      expect(await p.tg.game.act(p.playerId, { t: 'sell', rid: rid(), items: { white: d === 0 ? 200 : 1 } })).toMatchObject({ ok: true });
      if (d < 2) await nextDay(p.tg);
    }
    [s] = await p.tg.db.query('SELECT crow_streak, best_crow_streak FROM farm_stats WHERE farm_id = $1', [p.farmId]);
    expect(s).toMatchObject({ crow_streak: 3, best_crow_streak: 3 });
    let held = await p.held();
    expect(held['rooster-crew']).toBe('bronze');
    expect(held['clear-the-crate']).toBe('plain');
    expect(held['night-owl']).toBeUndefined();
    // after dark
    p.tg.clock.t += Math.ceil(dayMs * (ECONOMY.day.nightStart + 0.05));
    expect(await p.tg.game.act(p.playerId, { t: 'sell', rid: rid(), items: { white: 1 } })).toMatchObject({ ok: true });
    held = await p.held();
    expect(held['night-owl']).toBe('plain');
    // a rename in Settings (the first choice is free; this farm kept a typed name, so this is a rename)
    expect(await p.tg.game.act(p.playerId, { t: 'setFarmName', rid: rid(), name: 'Shiny New Acres' })).toMatchObject({ ok: true });
    expect((await p.held())['new-sign']).toBe('plain');
    // a day missed breaks the crow streak: day 4 closes at its end, day 5 passes without business
    p.tg.clock.t = p.tg.game.getClock().dayStartedAt + dayMs;
    await p.tg.game.endDay();
    await nextDay(p.tg);
    expect(await p.tg.game.act(p.playerId, { t: 'sell', rid: rid(), items: { white: 1 } })).toMatchObject({ ok: true });
    [s] = await p.tg.db.query('SELECT crow_streak, best_crow_streak FROM farm_stats WHERE farm_id = $1', [p.farmId]);
    expect(s).toMatchObject({ crow_streak: 1, best_crow_streak: 3 });
  });

  it('a higher level comes on its own later, with its own moment', async () => {
    const p = await player();
    await p.tg.db.query('UPDATE farm_stats SET eggs_broken = 99 WHERE farm_id = $1', [p.farmId]);
    await p.evaluate();
    expect((await p.held()).omelette).toBeUndefined();
    await p.tg.db.query('UPDATE farm_stats SET eggs_broken = 100, eggs_collected = 100 WHERE farm_id = $1', [p.farmId]);
    await p.evaluate();
    expect((await p.held()).omelette).toBe('plain');
    expect((await p.held())['crate-filler']).toBe('bronze');
    await p.tg.db.query('UPDATE farm_stats SET eggs_collected = 1000 WHERE farm_id = $1', [p.farmId]);
    await p.evaluate();
    expect((await p.held())['crate-filler']).toBe('silver');
    expect(p.heard.filter((e) => e.badge === 'crate-filler').map((e) => e.level)).toEqual(['bronze', 'silver']);
    // a progress row is kept for locked badges too
    const [row] = await p.tg.db.query(`SELECT tier, progress FROM badges WHERE farm_id = $1 AND badge = 'market-stall'`, [p.farmId]);
    expect(row).toMatchObject({ tier: null });
  });
});
