// The Feathers beta: good standing, milestones, the auditable roll and its odds, Feather Tickets
// and the 777 cap, the management score and grades, redemption with its coin fee, minting at the
// day close to the player's wallet, the compact settlement digest, and the conversion of a
// Founding Hen won but never minted into a ticket. Ordinary hens are never minted.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ECONOMY, FEATHER_GRADES, MILESTONE_IDS, UNLOCK_IDS, type GameEvent } from '@coys/shared';
import { MIGRATIONS } from '../src/db/migrations';
import { featherCount, gradeFor, managementScore, rarityEstimates, reached, redeemTicket, rollFor, rollMilestones, standing } from '../src/game/feathers';
import { drawFeatherNumber, featherSeed } from '../src/chain/mint';
import { RecordingChain, makeGame, type TestGame } from './helpers';

const F = ECONOMY.feathers;

async function player(t: TestGame, name = 'Ada'): Promise<{ playerId: string; farmId: string }> {
  return t.game.ensurePlayer('dev', `device-${name.toLowerCase()}-0001`, name);
}

describe('the auditable roll', () => {
  it('is the same for the same inputs and changes with any of them', () => {
    const a = rollFor('s1', 4, 'farm-a', 'full-coop', 'TxAnchor');
    expect(rollFor('s1', 4, 'farm-a', 'full-coop', 'TxAnchor')).toEqual(a);
    expect(a.seed).toBe(createHash('sha256').update('coys-feather|s1|4|farm-a|full-coop|TxAnchor').digest('hex'));
    expect(a.roll).toBe(parseInt(a.seed.slice(0, 13), 16) / 2 ** 52);
    for (const other of [
      rollFor('s2', 4, 'farm-a', 'full-coop', 'TxAnchor'),
      rollFor('s1', 5, 'farm-a', 'full-coop', 'TxAnchor'),
      rollFor('s1', 4, 'farm-b', 'full-coop', 'TxAnchor'),
      rollFor('s1', 4, 'farm-a', 'eggs-sold', 'TxAnchor'),
      rollFor('s1', 4, 'farm-a', 'full-coop', 'TxOther'),
    ]) {
      expect(other.seed).not.toBe(a.seed);
    }
  });

  it(`wins about ${Math.round(F.odds * 100)}% of the time at the configured odds`, () => {
    const n = 20_000;
    let wins = 0;
    for (let i = 0; i < n; i++) if (rollFor('s1', 1 + (i % 50), `farm-${i}`, MILESTONE_IDS[i % MILESTONE_IDS.length] ?? 'full-coop', 'anchor').roll < F.odds) wins++;
    expect(Math.abs(wins / n - F.odds)).toBeLessThan(0.015);
  });
});

describe('good standing', () => {
  it('a new farm is in good standing; a missed delivery or unpaid credit loses it for a few days; bust loses it', async () => {
    const t = await makeGame({ cast: true });
    const { farmId } = await player(t);
    const day = t.game.getClock().day;
    expect(await standing(t.db, farmId, day)).toEqual({ good: true, reasons: [] });

    await t.db.query('UPDATE farms SET last_missed_day = $2 WHERE id = $1', [farmId, day]);
    expect((await standing(t.db, farmId, day)).reasons).toEqual(['missed a contract delivery']);
    expect((await standing(t.db, farmId, day + F.missWindowDays - 1)).good).toBe(false);
    expect((await standing(t.db, farmId, day + F.missWindowDays)).good).toBe(true);
    await t.db.query('UPDATE farms SET last_missed_day = NULL WHERE id = $1', [farmId]);

    const [agent] = await t.db.query(`SELECT id FROM agents WHERE role = 'supplier' LIMIT 1`);
    await t.db.query(`INSERT INTO debts (id, farm_id, agent_id, principal_milli, due_milli, due_day, status) VALUES ('d1', $1, $2, 1000, 1100, $3, 'defaulted')`, [farmId, agent?.id, day]);
    expect((await standing(t.db, farmId, day)).reasons).toEqual(['feed credit unpaid past its due day']);
    expect((await standing(t.db, farmId, day + F.missWindowDays)).good).toBe(true);
    await t.db.query(`UPDATE debts SET status = 'open', due_day = $1 WHERE id = 'd1'`, [day - 1]);
    expect((await standing(t.db, farmId, day)).good).toBe(false);
    await t.db.query(`UPDATE debts SET status = 'paid' WHERE id = 'd1'`);
    expect((await standing(t.db, farmId, day)).good).toBe(true);

    await t.db.query('UPDATE farms SET bust_day = $2 WHERE id = $1', [farmId, day]);
    expect((await standing(t.db, farmId, day + 30)).reasons).toEqual(['went bust this season']);
    await t.db.close();
  });
});

describe('milestones', () => {
  it('each is reached from the farm, its counters and the board', async () => {
    const t = await makeGame({ cast: true });
    const { farmId } = await player(t);
    const day = t.game.getClock().day;
    const is = (m: (typeof MILESTONE_IDS)[number], d = day) => reached(t.db, farmId, m, d);

    await t.db.query('UPDATE farms SET eggs_sold = $2, haggles_won = $3 WHERE id = $1', [farmId, F.eggsSold - 1, F.hagglesWon - 1]);
    expect([await is('eggs-sold'), await is('haggles-won')]).toEqual([false, false]);
    await t.db.query('UPDATE farms SET eggs_sold = $2, haggles_won = $3 WHERE id = $1', [farmId, F.eggsSold, F.hagglesWon]);
    expect([await is('eggs-sold'), await is('haggles-won')]).toEqual([true, true]);

    expect(await is('all-machines')).toBe(false);
    for (const u of UNLOCK_IDS) await t.db.query('INSERT INTO unlocks (farm_id, unlock_id, bought_day) VALUES ($1, $2, 1)', [farmId, u]);
    expect(await is('all-machines')).toBe(true);

    await t.db.query('UPDATE farms SET good_since_day = $2 WHERE id = $1', [farmId, day]);
    expect(await is('good-week', day + F.goodDays - 2)).toBe(false);
    expect(await is('good-week', day + F.goodDays - 1)).toBe(true);

    expect(await is('outlast-rival')).toBe(false);
    await t.db.query(`UPDATE agents SET status = 'bust', bust_day = $1 WHERE id = (SELECT id FROM agents WHERE role = 'rival' LIMIT 1)`, [day]);
    expect(await is('outlast-rival')).toBe(true);

    for (const n of ['Bo', 'Cy']) await t.db.query('UPDATE farms SET cash_milli = 99999999 WHERE id = $1', [(await player(t, n)).farmId]);
    await t.db.query('UPDATE farms SET cash_milli = 0 WHERE id = $1', [farmId]);
    expect(await is('top-three')).toBe(false);
    await t.db.query('UPDATE farms SET cash_milli = 999999999 WHERE id = $1', [farmId]);
    expect(await is('top-three')).toBe(true);

    await t.db.query(`DELETE FROM hens WHERE farm_id = $1`, [farmId]);
    expect(await is('full-coop')).toBe(false);
    await t.db.close();
  });

  it('every reached milestone gets one roll, once, logged with its seed; a win is a Feather Ticket, never a hen', async () => {
    const t = await makeGame({ cast: true });
    const { farmId } = await player(t);
    await t.db.query('UPDATE farms SET eggs_sold = $2, haggles_won = $3, cash_milli = 999999999 WHERE id = $1', [farmId, F.eggsSold, F.hagglesWon]);
    const [before] = await t.db.query('SELECT count(*) AS n FROM hens WHERE farm_id = $1', [farmId]);

    const first = await t.game.withCtx((ctx) => rollMilestones(ctx, 0, 1));
    const ids = first.map((r) => r.milestone);
    expect(ids).toEqual(expect.arrayContaining(['eggs-sold', 'haggles-won', 'top-three']));
    expect(first.every((r) => r.won && r.ticketId)).toBe(true);
    const tickets = await t.db.query(`SELECT milestone, status, grade FROM feather_tickets WHERE farm_id = $1 ORDER BY milestone`, [farmId]);
    expect(tickets.map((x) => x.milestone)).toEqual([...ids].sort());
    expect(tickets.every((x) => x.status === 'held' && x.grade === null)).toBe(true);
    const [after] = await t.db.query('SELECT count(*) AS n FROM hens WHERE farm_id = $1', [farmId]);
    expect(Number(after?.n)).toBe(Number(before?.n));
    const rows = await t.db.query('SELECT milestone, seed, roll, anchor, won, ticket_id FROM milestone_rolls WHERE farm_id = $1', [farmId]);
    expect(rows).toHaveLength(ids.length);
    for (const r of rows) expect(rollFor(t.game.season, t.game.getClock().day, farmId, String(r.milestone), String(r.anchor))).toEqual({ seed: r.seed, roll: r.roll });
    expect(t.logs.filter((l) => l.startsWith('[feathers]') && /seed [0-9a-f]{64} roll .* WON ticket/.test(l))).toHaveLength(ids.length);

    // never again for the same milestone
    expect(await t.game.withCtx((ctx) => rollMilestones(ctx, 0, 1))).toEqual([]);
    const [farm] = await t.db.query('SELECT good_days FROM farms WHERE id = $1', [farmId]);
    expect(Number(farm?.good_days)).toBe(2);
    await t.db.close();
  });

  it('a missed roll is final; a farm out of good standing does not roll and its good-week count starts again', async () => {
    const t = await makeGame({ cast: true });
    const a = await player(t, 'Ada');
    const b = await player(t, 'Bo');
    for (const f of [a, b]) await t.db.query('UPDATE farms SET eggs_sold = $2, good_since_day = 1 WHERE id = $1', [f.farmId, F.eggsSold]);
    await t.db.query('UPDATE farms SET last_missed_day = $2 WHERE id = $1', [b.farmId, t.game.getClock().day]);
    const out = await t.game.withCtx((ctx) => rollMilestones(ctx, 0, 0));
    expect(out.filter((r) => r.farmId === b.farmId)).toEqual([]);
    expect(out.find((r) => r.farmId === a.farmId && r.milestone === 'eggs-sold')).toMatchObject({ won: false, ticketId: null });
    expect(Number((await t.db.query('SELECT count(*) AS n FROM feather_tickets'))[0]?.n)).toBe(0);
    const [farmB] = await t.db.query('SELECT good_since_day, good_days FROM farms WHERE id = $1', [b.farmId]);
    expect([farmB?.good_since_day, Number(farmB?.good_days)]).toEqual([null, 0]);
    await t.db.close();
  });

  it('tickets stop at 777: Feathers minted plus tickets out never pass the cap', async () => {
    const t = await makeGame({ cast: true });
    const { farmId } = await player(t);
    await t.db.query('UPDATE farms SET eggs_sold = $2, haggles_won = $3 WHERE id = $1', [farmId, F.eggsSold, F.hagglesWon]);
    expect(await t.game.withCtx((ctx) => rollMilestones(ctx, F.maxSupply, 1))).toEqual([]);
    const one = await t.game.withCtx((ctx) => rollMilestones(ctx, F.maxSupply - 1, 1));
    expect(one).toHaveLength(1);
    expect(await featherCount(t.db, F.maxSupply - 1)).toEqual({ max: 777, minted: 776, left: 1, tickets: 1, issuable: 0 });
    await t.db.close();
  });
});

describe('the management score and grades', () => {
  it('bands set the grade: Fluff, Plume, Quill, Golden Quill', () => {
    expect(gradeFor(0)).toBe('fluff');
    expect(gradeFor(F.bands.plume - 0.01)).toBe('fluff');
    expect(gradeFor(F.bands.plume)).toBe('plume');
    expect(gradeFor(F.bands.quill)).toBe('quill');
    expect(gradeFor(F.bands['golden-quill'])).toBe('golden-quill');
    expect(gradeFor(1)).toBe('golden-quill');
  });

  it('weighs days in good standing, the delivery record, haggles won and profit', async () => {
    const t = await makeGame({ cast: true });
    const { farmId } = await player(t);
    const fresh = await managementScore(t.db, farmId);
    expect(fresh.parts).toEqual({ goodDays: 0, delivery: F.score.noContracts, haggles: 0, profit: 0 });
    expect(fresh.score).toBeCloseTo(F.score.weights.delivery * F.score.noContracts, 6);
    expect(fresh.grade).toBe('fluff');

    // a long, clean, haggling, profitable farm
    await t.db.query('UPDATE farms SET good_days = $2, haggles_won = $3, cash_milli = $4 WHERE id = $1', [
      farmId,
      F.score.full.goodDays,
      F.score.full.haggles,
      (ECONOMY.start.cash + F.score.full.profit) * 1000,
    ]);
    const top = await managementScore(t.db, farmId);
    expect(top.parts).toEqual({ goodDays: 1, delivery: F.score.noContracts, haggles: 1, profit: 1 });
    expect(top.grade).toBe(gradeFor(top.score));
    expect(FEATHER_GRADES.indexOf(top.grade)).toBeGreaterThanOrEqual(FEATHER_GRADES.indexOf('quill'));

    // missed deliveries pull the delivery record down
    const [agent] = await t.db.query(`SELECT id FROM agents WHERE kind = 'bakery' LIMIT 1`);
    await t.db.query(
      `INSERT INTO contracts (id, farm_id, agent_id, grade, qty_per_day, price_milli, start_day, end_day, misses) VALUES ('c1', $1, $2, 'white', 2, 2000, 1, 9, 3)`,
      [farmId, agent?.id],
    );
    expect((await managementScore(t.db, farmId)).parts.delivery).toBe(0);
    await t.db.close();
  });
});

describe('redemption', () => {
  it('pays the coin fee, sets the grade from the score now, and queues the Feather once', async () => {
    const t = await makeGame({ cast: true });
    const { playerId, farmId } = await player(t);
    const b = await player(t, 'Bo');
    await t.db.query('UPDATE farms SET eggs_sold = $2 WHERE id = $1', [farmId, F.eggsSold]);
    await t.game.withCtx((ctx) => rollMilestones(ctx, 0, 1));
    const [ticket] = await t.db.query(`SELECT id FROM feather_tickets WHERE farm_id = $1 AND milestone = 'eggs-sold'`, [farmId]);
    const id = String(ticket?.id);
    const cash = (await t.game.getFarmState(farmId)).cashMilli;

    const events: GameEvent[] = [];
    t.game.on((o) => {
      if (o.playerId === playerId && o.msg.t === 'event') events.push(o.msg.event);
    });
    const r = await t.game.act(playerId, { t: 'redeemTicket', rid: 'r1', ticketId: id });
    expect(r.ok).toBe(true);
    expect(events.find((e) => e.kind === 'ticketRedeemed')).toMatchObject({ ticketId: id, feeMilli: F.redeemFee * 1000 });
    const farm = await t.game.getFarmState(farmId);
    expect(farm.cashMilli).toBe(cash - F.redeemFee * 1000);
    expect(await t.game.ledgerTotal(farmId)).toBe(farm.cashMilli);
    const view = farm.tickets.find((x) => x.id === id);
    expect(view).toMatchObject({ status: 'queued', grade: farm.score.grade });
    // its number is drawn at once, from the seed kept with the ticket
    expect(view?.number).toBeGreaterThanOrEqual(1);
    expect(view?.number).toBeLessThanOrEqual(777);
    const [kept] = await t.db.query('SELECT number_seed, number_anchor, token_id FROM feather_tickets WHERE id = $1', [id]);
    expect(kept?.number_seed).toBe(featherSeed(t.game.season, id, String(kept?.number_anchor)));
    expect(kept?.token_id).toBe(String(view?.number).padStart(3, '0'));
    // no chain here: the mint waits, the ticket is not lost
    await t.game.mintsIdle();
    expect((await t.game.getFarmState(farmId)).tickets.find((x) => x.id === id)?.mint).toEqual({ state: 'waiting', note: 'this server has no chain to mint on' });

    const twice = await t.game.act(playerId, { t: 'redeemTicket', rid: 'r2', ticketId: id });
    expect(twice).toMatchObject({ ok: false, code: 'invalid_action' });
    const stranger = await t.game.act(b.playerId, { t: 'redeemTicket', rid: 'r3', ticketId: id });
    expect(stranger).toMatchObject({ ok: false, code: 'not_found' });
    await t.db.close();
  });

  it('refuses without the coins for the fee', async () => {
    const t = await makeGame({ cast: true });
    const { farmId } = await player(t);
    await t.db.query(`INSERT INTO feather_tickets (id, farm_id, milestone, season, day, created_at) VALUES ('t1', $1, 'full-coop', 's', 1, 0)`, [farmId]);
    await t.db.query('UPDATE farms SET cash_milli = 1000 WHERE id = $1', [farmId]);
    await expect(t.game.withCtx((ctx) => redeemTicket(ctx, farmId, 't1'))).rejects.toThrow(/costs 25\.00/);
    await t.db.close();
  });
});

describe('minting at once', () => {
  async function setup(chain: RecordingChain, season = 'fx') {
    const t = await makeGame({ cast: true, chain, season, seed: 5 });
    const ada = await player(t);
    const bo = await player(t, 'Bo');
    await t.game.act(ada.playerId, { t: 'linkWallet', rid: 'w1', accountId: 'ada.testnet' });
    for (const [f, ids] of [
      [ada.farmId, ['a1', 'a2']],
      [bo.farmId, ['b1']],
    ] as const) {
      for (const id of ids) await t.db.query(`INSERT INTO feather_tickets (id, farm_id, milestone, season, day, created_at) VALUES ($1, $2, 'full-coop', $3, 1, 0)`, [id, f, season]);
    }
    const heard = new Map<string, GameEvent[]>();
    t.game.on((o) => {
      if (o.playerId && o.msg.t === 'event') heard.set(o.playerId, [...(heard.get(o.playerId) ?? []), o.msg.event]);
    });
    return { t, ada, bo, heard };
  }

  it('redeeming mints at once, game-paid, with a random number from a logged seed; sent then confirmed; nothing mints in a day settlement', async () => {
    const chain = new RecordingChain('game.testnet');
    const { t, ada, heard } = await setup(chain);
    await t.game.act(ada.playerId, { t: 'redeemTicket', rid: 'r1', ticketId: 'a2' });
    await t.game.act(ada.playerId, { t: 'redeemTicket', rid: 'r2', ticketId: 'a1' });
    await t.game.mintsIdle();
    // in redemption order, to the player's wallet, each with the number drawn for it
    const rows = await t.db.query(`SELECT id, number, token_id, status, mint_tx, number_seed, number_anchor FROM feather_tickets WHERE farm_id = $1 ORDER BY redeemed_seq`, [ada.farmId]);
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ['a2', 'minted'],
      ['a1', 'minted'],
    ]);
    expect(chain.mints.map((m) => [m.owner, m.season, m.number])).toEqual(rows.map((r) => ['ada.testnet', 'fx', Number(r.number)]));
    for (const r of rows) {
      const n = Number(r.number);
      expect(r.token_id).toBe(String(n).padStart(3, '0'));
      expect(r.mint_tx).toBe(`minted-${String(r.token_id)}`);
      // anyone can replay the draw from the ticket, the season and the anchor transaction
      expect(drawFeatherNumber(featherSeed('fx', String(r.id), String(r.number_anchor)), new Set(rows.filter((o) => o.id !== r.id && o.id === 'a2').map((o) => Number(o.number))))).toBe(n);
      expect(t.logs.some((l) => l.includes(`ticket ${String(r.id)} drew Feather ${String(r.token_id)}`) && l.includes(`seed ${String(r.number_seed)}`))).toBe(true);
    }
    // random, not in mint order: the two numbers are not 1 and 2
    expect(rows.map((r) => Number(r.number))).not.toEqual([1, 2]);
    const kinds = (heard.get(ada.playerId) ?? []).map((e) => e.kind).filter((k) => k === 'ticketRedeemed' || k === 'mintSent' || k === 'featherMinted');
    expect(kinds).toEqual(['ticketRedeemed', 'ticketRedeemed', 'mintSent', 'featherMinted', 'mintSent', 'featherMinted']);
    const page = await t.game.getMintPage();
    expect(page.slots.map((s) => s.number).sort((a, b) => a - b)).toEqual(rows.map((r) => Number(r.number)).sort((a, b) => a - b));
    expect(page.minted).toBe(2);
    // the day's settlement is unchanged and mints nothing
    t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
    await t.game.endDay();
    expect(chain.batches.at(-1)?.feather_mints).toEqual([]);
    expect(chain.batches.at(-1)?.hen_mints).toEqual([]);
    await t.db.close();
  });

  it('a player without a wallet waits; linking one mints it; a waiting chain is caught up at the day close', async () => {
    const chain = new RecordingChain('game.testnet');
    const { t, bo, heard } = await setup(chain);
    await t.game.act(bo.playerId, { t: 'redeemTicket', rid: 'r3', ticketId: 'b1' });
    await t.game.mintsIdle();
    expect(chain.mints).toEqual([]);
    expect((heard.get(bo.playerId) ?? []).find((e) => e.kind === 'mintWaiting')).toMatchObject({ ticketId: 'b1', note: expect.stringMatching(/link your NEAR wallet/) });
    chain.script = ['wait'];
    await t.game.act(bo.playerId, { t: 'linkWallet', rid: 'w2', accountId: 'bo.testnet' });
    await t.game.mintsIdle();
    expect(chain.mints).toHaveLength(1);
    expect((await t.game.getFarmState(bo.farmId)).tickets[0]).toMatchObject({ status: 'queued', mint: { state: 'waiting', note: 'the game account is low on testnet NEAR' } });
    t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
    await t.game.endDay();
    await t.game.mintsIdle();
    expect((await t.game.getFarmState(bo.farmId)).tickets[0]).toMatchObject({ status: 'minted', owner: 'bo.testnet', mint: null });
    await t.db.close();
  });

  it('a mint refused by the RPC after its retries holds the ticket again and refunds its fee; trying again draws the same number', async () => {
    const chain = new RecordingChain('game.testnet');
    const { t, ada, heard } = await setup(chain);
    const cash = (await t.game.getFarmState(ada.farmId)).cashMilli;
    chain.script = ['refuse'];
    await t.game.act(ada.playerId, { t: 'redeemTicket', rid: 'r1', ticketId: 'a1' });
    await t.game.mintsIdle();
    const farm = await t.game.getFarmState(ada.farmId);
    expect(farm.tickets.find((x) => x.id === 'a1')).toMatchObject({ status: 'held', grade: null, number: null, mint: null });
    expect(farm.cashMilli).toBe(cash);
    expect(await t.game.ledgerTotal(ada.farmId)).toBe(farm.cashMilli);
    expect((heard.get(ada.playerId) ?? []).find((e) => e.kind === 'mintFailed')).toEqual({
      kind: 'mintFailed',
      ticketId: 'a1',
      note: 'NEAR testnet refused the call, even after a few tries',
      refundMilli: F.redeemFee * 1000,
    });
    const first = chain.mints[0]?.number;
    await t.game.act(ada.playerId, { t: 'redeemTicket', rid: 'r2', ticketId: 'a1' });
    await t.game.mintsIdle();
    expect(chain.mints.map((m) => m.number)).toEqual([first, first]);
    expect((await t.game.getFarmState(ada.farmId)).tickets.find((x) => x.id === 'a1')).toMatchObject({ status: 'minted', number: first });
    await t.db.close();
  });

  it('a number the contract holds already is replaced by the next free one in the same seed stream', async () => {
    const chain = new RecordingChain('game.testnet');
    const { t, ada } = await setup(chain);
    chain.script = ['taken'];
    await t.game.act(ada.playerId, { t: 'redeemTicket', rid: 'r1', ticketId: 'a1' });
    await t.game.mintsIdle();
    const [a, b] = chain.mints.map((m) => m.number);
    expect(a).not.toBe(b);
    const [row] = await t.db.query(`SELECT number, number_seed, status FROM feather_tickets WHERE id = 'a1'`);
    expect(row?.status).toBe('minted');
    expect(Number(row?.number)).toBe(b);
    expect(drawFeatherNumber(String(row?.number_seed), new Set([a ?? 0]))).toBe(b);
    await t.db.close();
  });

  it('a test season mints into its own collection, never one of the 777', async () => {
    const chain = new RecordingChain('game.testnet');
    chain.liveSeason = 's1';
    const { t, ada } = await setup(chain, 'verify-mint-1');
    await t.game.act(ada.playerId, { t: 'redeemTicket', rid: 'r1', ticketId: 'a1' });
    await t.game.mintsIdle();
    const [row] = await t.db.query(`SELECT number, token_id, status FROM feather_tickets WHERE id = 'a1'`);
    expect(row?.status).toBe('minted');
    expect(row?.token_id).toBe(`test-verify-mint-1-${String(row?.number).padStart(3, '0')}`);
    expect(chain.featherMinted).toBe(0);
    const page = await t.game.getMintPage();
    expect(page.minted).toBe(0);
    expect(page.slots).toEqual([]);
    await t.db.close();
  });

  it('draws: the same seed and taken set give the same number; numbers spread over 1 to 777; a taken number is skipped', () => {
    const seed = featherSeed('s1', 'ticket-1', 'TxAnchor');
    expect(seed).toBe(createHash('sha256').update('coys-mint|s1|ticket-1|TxAnchor').digest('hex'));
    const n = drawFeatherNumber(seed, new Set());
    expect(n).toBe(1 + (createHash('sha256').update(`${seed}|0`).digest().readUInt32BE(0) % 777));
    expect(drawFeatherNumber(seed, new Set())).toBe(n);
    expect(drawFeatherNumber(seed, new Set([n]))).not.toBe(n);
    const counts = new Array<number>(778).fill(0);
    for (let i = 0; i < 77_700; i++) {
      const k = drawFeatherNumber(featherSeed('s1', `t${i}`, 'a'), new Set());
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const used = counts.slice(1);
    expect(Math.min(...used)).toBeGreaterThan(50);
    expect(Math.max(...used)).toBeLessThan(160);
    // the last free number is always found
    const all = new Set(Array.from({ length: 777 }, (_, i) => i + 1));
    all.delete(500);
    expect(drawFeatherNumber(seed, all)).toBe(500);
    all.add(500);
    expect(() => drawFeatherNumber(seed, all)).toThrow(/every Feather number is taken/);
  });
});

describe('day settlements', () => {
  it('the batch carries the full settlement digest; the database keeps the settlement it hashes', async () => {
    const chain = new RecordingChain('game.testnet', 0);
    const t = await makeGame({ cast: true, chain, season: 'cs', seed: 7 });
    const { playerId } = await player(t);
    await t.game.act(playerId, { t: 'linkWallet', rid: 'w1', accountId: 'ada.testnet' });
    for (let d = 0; d < 3; d++) {
      t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
      await t.game.endDay();
    }
    for (const b of chain.batches) {
      const [md] = await t.db.query('SELECT settlement_json, settlement_digest FROM market_days WHERE season = $1 AND day = $2', ['cs', b.day]);
      const payload = String(md?.settlement_json);
      expect(md?.settlement_digest).toBe(b.digest);
      expect(createHash('sha256').update(payload).digest('hex')).toBe(b.digest);
      // only farms whose eggs move ride in the call; every farm is in the settlement
      const settlement = JSON.parse(payload) as { farms: { account: string | null }[] };
      const moving = new Set(b.eggs.flatMap((m) => [m.from, m.to]));
      expect(b.farms.every((f) => f.account !== null && moving.has(f.account))).toBe(true);
      expect(settlement.farms.length).toBeGreaterThanOrEqual(b.farms.length);
    }
    await t.db.close();
  });
});

describe('estimates on the mint page', () => {
  it('each grade sums to 1, higher grades lean to higher rarities, and the 777 expect exactly 7/70/200/500', () => {
    const byGrade = { fluff: 120, plume: 60, quill: 25, 'golden-quill': 5 };
    const est = rarityEstimates(byGrade);
    for (const g of FEATHER_GRADES) expect(Object.values(est[g]).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
    expect(est['golden-quill'].legendary).toBeGreaterThan(est.quill.legendary);
    expect(est.quill.legendary).toBeGreaterThan(est.plume.legendary);
    expect(est.plume.legendary).toBeGreaterThan(est.fluff.legendary);
    const n = { ...byGrade, fluff: byGrade.fluff + (777 - 210) };
    const total = (r: 'legendary' | 'epic' | 'rare' | 'common') => FEATHER_GRADES.reduce((s, g) => s + n[g] * est[g][r], 0);
    expect(total('legendary')).toBeCloseTo(7, 6);
    expect(total('epic')).toBeCloseTo(70, 6);
    expect(total('rare')).toBeCloseTo(200, 6);
    expect(total('common')).toBeCloseTo(500, 6);
    // with nothing minted every Feather is alike
    const none = rarityEstimates({ fluff: 0, plume: 0, quill: 0, 'golden-quill': 0 });
    expect(none.fluff.legendary).toBeCloseTo(7 / 777, 9);
  });
});

describe('the Feathers migration', () => {
  it('turns a Founding Hen won but never minted into a Feather Ticket; she stays on the farm as an ordinary hen', async () => {
    const t = await makeGame({ cast: true, season: 'mg' });
    const { farmId } = await player(t);
    const [hen] = await t.db.query('SELECT id FROM hens WHERE farm_id = $1 LIMIT 1', [farmId]);
    const henId = String(hen?.id);
    // back to the state before migration 9, with a hen won at good-week on day 409
    await t.db.exec(`DROP TABLE feather_tickets; DROP TABLE chain_archive; ALTER TABLE milestone_rolls DROP COLUMN ticket_id;
      ALTER TABLE farms DROP COLUMN good_days; ALTER TABLE market_days DROP COLUMN settlement_json; ALTER TABLE market_days DROP COLUMN settlement_digest; DELETE FROM schema_migrations WHERE id = 9;`);
    await t.db.query(`UPDATE hens SET founding_milestone = 'good-week', founding_day = 409 WHERE id = $1`, [henId]);
    await t.db.query(
      `INSERT INTO milestone_rolls (farm_id, milestone, season, day, anchor, seed, roll, odds, won, hen_id) VALUES ($1, 'good-week', 'mg', 409, 'a', 's', 0.003145, 0.3, true, $2)`,
      [farmId, henId],
    );
    const m9 = MIGRATIONS.find((m) => m.id === 9);
    await t.db.exec(m9?.sql ?? '');
    const tickets = await t.db.query('SELECT id, farm_id, milestone, season, day, status FROM feather_tickets');
    expect(tickets).toEqual([{ id: `ticket-${henId}`, farm_id: farmId, milestone: 'good-week', season: 'mg', day: 409, status: 'held' }]);
    const [roll] = await t.db.query('SELECT ticket_id FROM milestone_rolls WHERE farm_id = $1', [farmId]);
    expect(roll?.ticket_id).toBe(`ticket-${henId}`);
    const [h] = await t.db.query('SELECT status, founding_milestone FROM hens WHERE id = $1', [henId]);
    expect(h).toEqual({ status: 'alive', founding_milestone: null });
    expect(await featherCount(t.db, 0)).toEqual({ max: 777, minted: 0, left: 777, tickets: 1, issuable: 776 });
    await t.db.close();
  });
});

describe('the mint page', () => {
  it('shows every Feather on the contract, this season with its details and a test season by name', async () => {
    class ChainWithTokens extends RecordingChain {
      async featherTokens() {
        return [
          { number: 1, grade: 'fluff' as const, milestone: 'full-coop' as const, season: 'verify-feathers-1', day: 1, owner: 'game.testnet' },
          { number: 2, grade: 'quill' as const, milestone: 'eggs-sold' as const, season: 'verify-feathers-1', day: 1, owner: 'game.testnet' },
        ];
      }
    }
    const chain = new ChainWithTokens('game.testnet');
    chain.featherMinted = 2;
    const t = await makeGame({ cast: true, chain, season: 'mp' });
    const { playerId, farmId } = await player(t);
    await t.game.act(playerId, { t: 'linkWallet', rid: 'w1', accountId: 'ada.testnet' });
    await t.db.query(`INSERT INTO feather_tickets (id, farm_id, milestone, season, day, created_at) VALUES ('m1', $1, 'good-week', 'mp', 1, 0)`, [farmId]);
    await t.game.act(playerId, { t: 'redeemTicket', rid: 'r1', ticketId: 'm1' });
    await t.game.mintsIdle();
    const [m1] = await t.db.query(`SELECT number FROM feather_tickets WHERE id = 'm1'`);
    const n = Number(m1?.number);
    const page = await t.game.getMintPage();
    expect(page.slots.map((s) => [s.number, s.farm])).toEqual(
      [
        [1, 'TEST SEASON VERIFY-FEATHERS-1'],
        [2, 'TEST SEASON VERIFY-FEATHERS-1'],
        [n, 'Ada'],
      ].sort((a, b) => Number(a[0]) - Number(b[0])),
    );
    expect(page.minted).toBe(3);
    expect(page.left).toBe(774);
    expect(page.byGrade.fluff + page.byGrade.quill + page.byGrade.plume + page.byGrade['golden-quill']).toBe(3);
    // the most recent mint first, whatever its number
    expect(page.recent.map((s) => s.number)).toEqual([n, 2, 1]);
    await t.db.close();
  });
});
