// The league: profit at book values over a week and a season, farms made mid-window, guest farms
// carried into an account, player-to-player trades taken out both ways, ties, busts frozen, closes on
// the clock (once, through a restart), rewards for players only, the grade boost, the season's hash
// on chain (and its retry at boot), the arrows' day-close ranks, a retired farm's ticket, and the API.
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ECONOMY, LEAGUE_WEEK_MS, canonicalStandings, toMilli, type GameEvent, type LeaderboardView, type LeagueBoard } from '@coys/shared';
import { createSessionSigner } from '../src/auth/session';
import { bustIfBroke } from '../src/game/cast-runtime';
import { AGENT_COLUMNS, moveCash, toAgent } from '../src/game/ctx';
import { redeemTicket, stepGrade } from '../src/game/feathers';
import { DEFAULT_GUEST_LIMITS } from '../src/game/guests';
import { farmWorth } from '../src/game/league';
import { createGameServer } from '../src/net/server';
import { RecordingChain, makeGame, type TestGame } from './helpers';

const DAY = 24 * 60 * 60 * 1000;
/** A Monday: the test clock (Wednesday 2026-11-11) is in league week 1 and season 1. */
const START = Date.UTC(2026, 10, 9);
const league = { start: START, seasonDays: 14 };

const player = (t: TestGame, name: string) => t.game.ensurePlayer('dev', `dev-${name}`, name);
const give = (t: TestGame, farmId: string, coins: number) => t.game.withCtx((ctx) => moveCash(ctx, farmId, 'goal', toMilli(coins), 'test'));
async function board(t: TestGame, which: LeagueBoard = 'week', id: string | null = null): Promise<LeaderboardView> {
  const v = await t.game.getLeaderboard(which, id);
  if (!v) throw new Error(`no ${which} board ${id ?? ''}`);
  return v;
}
const entry = (v: LeaderboardView, farmId: string) => v.entries.find((e) => e.farmId === farmId);
const count = async (t: TestGame, sql: string, args: unknown[] = []) => Number((await t.db.query(sql, args))[0]?.n ?? 0);

describe('league scores', () => {
  it('scores profit over the window at book values: coins as they are, eggs at 0.4 of their price, hens at the auction price', async () => {
    const t = await makeGame({ league });
    const a = await player(t, 'Ada');
    let v = await board(t);
    expect(v.window).toEqual({ id: 'w-2026-11-09', seq: 1, startsAt: START, endsAt: START + LEAGUE_WEEK_MS, warmup: false, status: 'open', standingsSha256: null, chainTx: null });
    expect(v.next).toEqual({ weekEndsAt: START + LEAGUE_WEEK_MS, seasonStartsAt: START, seasonEndsAt: START + 14 * DAY });
    expect(entry(v, a.farmId)).toMatchObject({ rank: 1, scoreMilli: 0, kind: 'player', guest: false, bust: false, busts: 0, prevRank: null });
    await give(t, a.farmId, 5);
    await t.db.query('UPDATE farms SET crate_brown = crate_brown + 10 WHERE id = $1', [a.farmId]);
    const hen = (await t.game.getFarmState(a.farmId)).shop.find((h) => h.source === 'breeder');
    if (!hen) throw new Error('no hen in the shop');
    expect((await t.game.act(a.playerId, { t: 'buyHen', rid: 'h1', henId: hen.id })).ok).toBe(true);
    // +5 coins, +10 brown at 0.6, -8 coins for a hen worth 4
    v = await board(t);
    expect(entry(v, a.farmId)?.scoreMilli).toBe(5000 + 6000 - 8000 + 4000);
    const s = await board(t, 'season');
    expect(s.window).toMatchObject({ id: 's-1', seq: 1, startsAt: START, endsAt: START + 14 * DAY });
    expect(entry(s, a.farmId)?.scoreMilli).toBe(7000);
    await t.db.close();
  });

  it('a farm made mid-window starts at zero; a guest farm carried into an account keeps its score', async () => {
    const t = await makeGame({ league });
    const a = await player(t, 'Ada');
    await give(t, a.farmId, 3);
    t.clock.t += 3_600_000;
    const b = await player(t, 'Bo');
    const g = await t.game.startGuest('ip-league', DEFAULT_GUEST_LIMITS);
    if (!g.ok) throw new Error('refused');
    await give(t, g.farmId, 2);
    let v = await board(t);
    expect(entry(v, a.farmId)?.scoreMilli).toBe(3000);
    expect(entry(v, b.farmId)?.scoreMilli).toBe(0);
    expect(entry(v, g.farmId)).toMatchObject({ guest: true, scoreMilli: 2000 });
    const [made] = await t.db.query(`SELECT start_at FROM league_entries WHERE window_id = 'w-2026-11-09' AND farm_id = $1`, [b.farmId]);
    expect(Number(made?.start_at)).toBe(t.clock.t);
    expect(await count(t, 'SELECT count(*) AS n FROM league_entries WHERE farm_id = $1', [b.farmId])).toBe(2);
    const done = await t.game.claimGuest(g.playerId, 'dev', 'dev-claims-the-guest', null, null);
    expect(done).toMatchObject({ status: 'done', kept: 'guest', farmId: g.farmId });
    v = await board(t);
    expect(entry(v, g.farmId)).toMatchObject({ guest: false, scoreMilli: 2000, bust: false });
    await t.db.close();
  });

  it('takes player-to-player trades out of both farms: a silly price pumps neither', async () => {
    const t = await makeGame({ league });
    const a = await player(t, 'Ada');
    const b = await player(t, 'Bo');
    await t.db.query('UPDATE farms SET crate_brown = 10 WHERE id = $1', [a.farmId]);
    const before = await board(t);
    expect(entry(before, a.farmId)?.scoreMilli).toBe(6000);
    expect((await t.game.act(a.playerId, { t: 'placeOrder', rid: 'o1', grade: 'brown', qty: 10, price: 7 })).ok).toBe(true);
    const order = (await t.game.getFarmState(a.farmId)).orders[0];
    if (!order) throw new Error('no order');
    expect((await t.game.act(b.playerId, { t: 'fillOrder', rid: 'f1', orderId: order.id, qty: 10 })).ok).toBe(true);
    // Bo could pay for 7 at 7 coins: 49 coins moved for eggs worth 4.20 at book
    const [trade] = await t.db.query(`SELECT qty, total_milli, via FROM trades WHERE seller_farm = $1 AND buyer_farm = $2`, [a.farmId, b.farmId]);
    expect(trade).toMatchObject({ via: 'player' });
    expect([Number(trade?.qty), Number(trade?.total_milli)]).toEqual([7, 49_000]);
    expect((await t.game.getFarmState(a.farmId)).cashMilli).toBe(toMilli(ECONOMY.start.cash) + 49_000);
    const after = await board(t);
    expect(entry(after, a.farmId)?.scoreMilli).toBe(6000);
    expect(entry(after, b.farmId)?.scoreMilli).toBe(0);
    await t.db.close();
  });

  it('breaks ties by management score, then the earlier start', async () => {
    const t = await makeGame({ league });
    const a = await player(t, 'Ada');
    t.clock.t += 1000;
    const b = await player(t, 'Bo');
    t.clock.t += 1000;
    const c = await player(t, 'Cy');
    await t.db.query('UPDATE farms SET good_days = 30 WHERE id = $1', [c.farmId]);
    const v = await board(t);
    expect(v.entries.map((e) => [e.farmId, e.rank, e.scoreMilli])).toEqual([
      [c.farmId, 1, 0],
      [a.farmId, 2, 0],
      [b.farmId, 3, 0],
    ]);
    await t.db.close();
  });

  it('freezes a bust farm: an AI rival that went broke and a retired guest farm keep the score they had, tagged bust, and enter no later window', async () => {
    const t = await makeGame({ league, cast: true });
    const [row] = await t.db.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE kind = 'upstart' AND status = 'open'`);
    if (!row) throw new Error('no upstart');
    const agent = toAgent(row);
    const aiFarm = agent.farmId as string;
    await t.db.query('UPDATE farms SET cash_milli = -2000 WHERE id = $1', [aiFarm]);
    const worth = await farmWorth(t.db, aiFarm);
    const [start] = await t.db.query(`SELECT start_worth_milli FROM league_entries WHERE window_id = 'w-2026-11-09' AND farm_id = $1`, [aiFarm]);
    expect(await t.game.withCtx((ctx) => bustIfBroke(ctx, agent))).toBe(true);
    // its hens went to auction after the freeze: worth now is lower, its score is not
    expect(await farmWorth(t.db, aiFarm)).toBeLessThan(worth);
    let v = await board(t);
    expect(entry(v, aiFarm)).toMatchObject({ kind: 'upstart', bust: true, busts: 1, scoreMilli: worth - Number(start?.start_worth_milli) });
    expect((await t.game.getMarketState()).ranking.find((r) => r.farmId === aiFarm)).toMatchObject({ bust: true, busts: 1 });

    const kay = await player(t, 'Kay');
    const g = await t.game.startGuest('ip-retire', DEFAULT_GUEST_LIMITS);
    if (!g.ok) throw new Error('refused');
    await give(t, g.farmId, 2);
    expect(await t.game.claimGuest(g.playerId, 'dev', 'dev-Kay', null, 'account')).toMatchObject({ status: 'done', kept: 'account', farmId: kay.farmId });
    v = await board(t);
    expect(entry(v, g.farmId)).toMatchObject({ guest: true, bust: true, busts: 1, scoreMilli: 2000 });
    expect((await t.game.getPublicProfile(g.farmId))?.busts).toBe(1);

    // the next week has neither
    t.clock.t = START + LEAGUE_WEEK_MS + 1000;
    await t.game.leagueCatchUp();
    v = await board(t);
    expect(v.window?.id).toBe('w-2026-11-16');
    expect(entry(v, aiFarm)).toBeUndefined();
    expect(entry(v, g.farmId)).toBeUndefined();
    expect(entry(v, kay.farmId)).toBeDefined();
    await t.db.close();
  });

  it('a day close keeps every rank for the arrows; a player climbing into the top ten hears it once', async () => {
    const t = await makeGame({ league });
    const a = await player(t, 'Ada');
    const heard: GameEvent[] = [];
    t.game.on((o) => {
      if (o.playerId === a.playerId && o.msg.t === 'event') heard.push(o.msg.event);
    });
    t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
    await t.game.endDay();
    expect(heard.filter((e) => e.kind === 'leagueRank')).toEqual([{ kind: 'leagueRank', board: 'week', rank: 1 }]);
    expect(entry(await board(t), a.farmId)?.prevRank).toBe(1);
    t.clock.t += ECONOMY.day.lengthMs;
    await t.game.endDay();
    expect(heard.filter((e) => e.kind === 'leagueRank')).toHaveLength(1);
    await t.db.close();
  });
});

describe('league closes and rewards', () => {
  it('before LEAGUE_START the week is a warm-up: scored and shown, no rewards; the tick closes it and opens the first league week and season', async () => {
    const t = await makeGame();
    const a = await player(t, 'Ada');
    await give(t, a.farmId, 10);
    const v = await board(t);
    expect(v.window).toMatchObject({ id: 'w-2026-11-09', seq: 0, warmup: true });
    expect(entry(v, a.farmId)?.scoreMilli).toBe(10_000);
    const s = await board(t, 'season');
    expect(s.window).toBeNull();
    expect(s.entries).toEqual([]);
    expect(s.next).toEqual({ weekEndsAt: Date.UTC(2026, 10, 16), seasonStartsAt: Date.UTC(2026, 10, 16), seasonEndsAt: Date.UTC(2026, 10, 30) });
    t.clock.t = Date.UTC(2026, 10, 16) + 500;
    await t.game.tick();
    expect((await board(t, 'week', 'w-2026-11-09')).window).toMatchObject({ status: 'closed', warmup: true });
    expect(await count(t, 'SELECT count(*) AS n FROM league_rewards')).toBe(0);
    expect(await count(t, 'SELECT count(*) AS n FROM feather_tickets')).toBe(0);
    expect((await board(t)).window).toMatchObject({ id: 'w-2026-11-16', seq: 1, warmup: false, status: 'open' });
    expect((await board(t, 'season')).window).toMatchObject({ id: 's-1', seq: 1, startsAt: Date.UTC(2026, 10, 16), status: 'open' });
    expect((await board(t)).past[0]).toMatchObject({ id: 'w-2026-11-09', winner: { name: (await t.game.getFarmState(a.farmId)).name, kind: 'player' }, chainTx: null, explorerUrl: null });
    await t.db.close();
  });

  it("closes the week once, through a restart at the boundary: the top three players win a ticket each and a farm back from a bust the comeback badge; an AI farm ranks first but takes nothing", async () => {
    const chain = new RecordingChain('game.testnet');
    const t = await makeGame({ league, cast: true, chain, season: 'lg' });
    const ps = [];
    for (const [i, name] of ['Ada', 'Bo', 'Cy', 'Di'].entries()) {
      const p = await player(t, name);
      await give(t, p.farmId, 40 - i * 10);
      ps.push(p);
    }
    const [ada, bo, cy, di] = ps as [(typeof ps)[0], (typeof ps)[0], (typeof ps)[0], (typeof ps)[0]];
    // Di went bust once before (a Fresh Start, say) and is back
    await t.db.query('UPDATE farms SET busts = 1 WHERE id = $1', [di.farmId]);
    const [ai] = await t.db.query<{ farm_id: string }>(`SELECT farm_id FROM agents WHERE role = 'rival' AND status = 'open' ORDER BY kind LIMIT 1`);
    if (!ai) throw new Error('no AI farm');
    await give(t, ai.farm_id, 100);

    // the week ends; a second server boots on the same database at the boundary and closes it
    t.clock.t = START + LEAGUE_WEEK_MS + 1000;
    const t2 = await makeGame({ db: t.db, clock: t.clock, league, cast: true, chain, season: 'lg' });
    const closed = await board(t, 'week', 'w-2026-11-09');
    expect(closed.window).toMatchObject({ status: 'closed', standingsSha256: null });
    expect(closed.entries[0]).toMatchObject({ farmId: ai.farm_id, rank: 1, kind: expect.not.stringMatching(/^player$/) });
    expect(closed.entries.filter((e) => e.kind === 'player').map((e) => e.farmId)).toEqual([ada.farmId, bo.farmId, cy.farmId, di.farmId]);
    // the first server's tick and a third boot change nothing
    await t.game.leagueCatchUp();
    const t3 = await makeGame({ db: t.db, clock: t.clock, league, cast: true, chain, season: 'lg' });
    await t3.game.leagueCatchUp();
    await t2.game.leagueCatchUp();
    const tickets = await t.db.query<{ farm_id: string; status: string }>(`SELECT farm_id, status FROM feather_tickets WHERE milestone = 'league-week' ORDER BY farm_id`);
    expect(tickets.map((r) => r.farm_id)).toEqual([ada.farmId, bo.farmId, cy.farmId].sort());
    expect(tickets.every((r) => r.status === 'held')).toBe(true);
    const rewards = await t.db.query<{ reward: string; farm_id: string }>('SELECT reward, farm_id FROM league_rewards ORDER BY reward, farm_id');
    expect(rewards.map((r) => [r.reward, r.farm_id])).toEqual([['comeback', di.farmId], ...[ada.farmId, bo.farmId, cy.farmId].sort().map((id) => ['ticket', id])]);
    expect((await t.game.getFarmState(ada.farmId)).tickets).toEqual([expect.objectContaining({ milestone: 'league-week', status: 'held' })]);
    expect((await t.game.getFarmState(di.farmId)).tickets).toEqual([]);
    expect((await t.game.getProfile(di.farmId)).badges.find((b) => b.id === 'comeback')?.level).toBe('plain');
    expect((await t.game.getProfile(ada.farmId)).league).toEqual({ bestWeek: 2, bestSeason: null });
    // the next week is open, every open farm in it from its worth now
    const next = await board(t);
    expect(next.window).toMatchObject({ id: 'w-2026-11-16', seq: 2, status: 'open' });
    expect(entry(next, ada.farmId)?.scoreMilli).toBe(0);
    expect(next.past[0]).toMatchObject({ id: 'w-2026-11-09', seq: 1, winner: { kind: expect.not.stringMatching(/^player$/) } });
    await t.db.close();
  });

  it('closes a season: its top ten players step up a grade, every seller gets the season badge, and the canonical standings hash goes on chain once', async () => {
    const chain = new RecordingChain('game.testnet');
    const t = await makeGame({ league, chain, season: 'lg' });
    const a = await player(t, 'Ada');
    const b = await player(t, 'Bo');
    const c = await player(t, 'Cy');
    await t.db.query('UPDATE farms SET crate_brown = 10 WHERE id = $1', [a.farmId]);
    expect((await t.game.act(a.playerId, { t: 'sell', rid: 's1', items: { brown: 10 } })).ok).toBe(true);
    await t.db.query('UPDATE farms SET crate_white = 5 WHERE id = $1', [b.farmId]);
    expect((await t.game.act(b.playerId, { t: 'sell', rid: 's2', items: { white: 5 } })).ok).toBe(true);
    t.clock.t = START + 14 * DAY + 1000;
    await t.game.leagueCatchUp();
    await t.game.leagueIdle();
    const s = await board(t, 'season', 's-1');
    const w = s.window;
    if (!w) throw new Error('no season');
    expect(w).toMatchObject({ status: 'closed', standingsSha256: expect.stringMatching(/^[0-9a-f]{64}$/), chainTx: 'standings-league-1' });
    expect(s.entries.map((e) => e.farmId)).toEqual([a.farmId, b.farmId, c.farmId]);
    // anyone can rebuild the canonical string from the API and get the same hash
    const canonical = canonicalStandings(w, s.entries);
    expect(JSON.parse(canonical)).toMatchObject({ board: 'season', id: 's-1', seq: 1, entries: [[a.farmId, 15_000, 1, 0], [b.farmId, 5000, 2, 0], [c.farmId, 0, 3, 0]] });
    const sha = createHash('sha256').update(canonical).digest('hex');
    expect(sha).toBe(w.standingsSha256);
    expect(chain.standings.map((x) => [x.seq, x.digest, x.result.status])).toEqual([[1, sha, 'sent']]);
    // rewards: a grade step for each of the top ten players; badges by place for the farms that sold
    for (const f of [a, b, c]) expect(Number((await t.db.query('SELECT grade_boost FROM farms WHERE id = $1', [f.farmId]))[0]?.grade_boost)).toBe(1);
    const badges = await t.db.query<{ farm_id: string; tier: string }>(`SELECT farm_id, tier FROM badges WHERE badge = 'season-1'`);
    expect(Object.fromEntries(badges.map((r) => [r.farm_id, r.tier]))).toEqual({ [a.farmId]: 'gold', [b.farmId]: 'silver' });
    expect((await t.game.getPublicProfile(a.farmId))?.badges).toContainEqual({ id: 'season-1', level: 'gold' });
    expect((await t.game.getProfile(b.farmId)).badges.find((x) => x.id === 'season-1')).toMatchObject({ level: 'silver', progress: 2 });
    expect((await t.game.getProfile(a.farmId)).league).toEqual({ bestWeek: 1, bestSeason: 1 });
    expect((await board(t, 'season')).past[0]).toMatchObject({
      id: 's-1',
      standingsSha256: sha,
      chainTx: 'standings-league-1',
      explorerUrl: 'https://testnet.nearblocks.io/txns/standings-league-1',
      winner: { name: (await t.game.getFarmState(a.farmId)).name, kind: 'player' },
    });
    // the season after is open; nothing is stored twice, even after a boot
    expect((await board(t, 'season')).window).toMatchObject({ id: 's-2', status: 'open' });
    await t.game.leagueCatchUp();
    const t2 = await makeGame({ db: t.db, clock: t.clock, league, chain, season: 'lg' });
    await t2.game.leagueIdle();
    expect(chain.standings).toHaveLength(1);
    expect(await count(t, `SELECT count(*) AS n FROM league_rewards WHERE window_id = 's-1'`)).toBe(5);
    await t.db.close();
  });

  it('a season hash the chain refused is stored as failed and sent again at the next boot', async () => {
    const chain = new RecordingChain('game.testnet');
    chain.standingsScript = ['fail'];
    const t = await makeGame({ league, chain, season: 'lg' });
    await player(t, 'Ada');
    t.clock.t = START + 14 * DAY + 1000;
    await t.game.leagueCatchUp();
    await t.game.leagueIdle();
    expect(await t.db.query(`SELECT chain_status, chain_tx FROM league_windows WHERE id = 's-1'`)).toEqual([{ chain_status: 'failed', chain_tx: null }]);
    const t2 = await makeGame({ db: t.db, clock: t.clock, league, chain, season: 'lg' });
    await t2.game.leagueIdle();
    expect(chain.standings.map((x) => [x.seq, x.result.status])).toEqual([
      [1, 'failed'],
      [1, 'sent'],
    ]);
    expect(chain.standings[0]?.digest).toBe(chain.standings[1]?.digest);
    expect(await t.db.query(`SELECT chain_status, chain_tx FROM league_windows WHERE id = 's-1'`)).toEqual([{ chain_status: 'sent', chain_tx: 'standings-league-1' }]);
    await t.db.close();
  });

  it('a grade boost steps the next redemption up one grade, at most to golden-quill, then is used up', async () => {
    expect([stepGrade('fluff', 1), stepGrade('plume', 1), stepGrade('quill', 1), stepGrade('golden-quill', 1), stepGrade('fluff', 0)]).toEqual(['plume', 'quill', 'golden-quill', 'golden-quill', 'fluff']);
    const t = await makeGame({ league });
    const a = await player(t, 'Ada');
    for (const id of ['t1', 't2', 't3']) await t.db.query(`INSERT INTO feather_tickets (id, farm_id, milestone, season, day, created_at) VALUES ($1, $2, 'league-week', $3, 1, 0)`, [id, a.farmId, t.game.season]);
    await t.db.query('UPDATE farms SET grade_boost = 1 WHERE id = $1', [a.farmId]);
    expect((await t.game.getFarmState(a.farmId)).score.grade).toBe('fluff');
    expect(await t.game.withCtx((ctx) => redeemTicket(ctx, a.farmId, 't1'))).toMatchObject({ grade: 'plume' });
    expect(Number((await t.db.query('SELECT grade_boost FROM farms WHERE id = $1', [a.farmId]))[0]?.grade_boost)).toBe(0);
    expect(await t.game.withCtx((ctx) => redeemTicket(ctx, a.farmId, 't2'))).toMatchObject({ grade: 'fluff' });
    // a farm already at golden-quill stays there
    await give(t, a.farmId, 2000);
    await t.db.query('UPDATE farms SET good_days = 30, haggles_won = 20, grade_boost = 1 WHERE id = $1', [a.farmId]);
    expect((await t.game.getFarmState(a.farmId)).score.grade).toBe('golden-quill');
    expect(await t.game.withCtx((ctx) => redeemTicket(ctx, a.farmId, 't3'))).toMatchObject({ grade: 'golden-quill' });
    expect(Number((await t.db.query('SELECT grade_boost FROM farms WHERE id = $1', [a.farmId]))[0]?.grade_boost)).toBe(0);
    await t.db.close();
  });

  it("a ticket queued on a farm its player chose not to keep still mints, to the account's wallet", async () => {
    const chain = new RecordingChain('game.testnet');
    const t = await makeGame({ chain, season: 'fx' });
    const acct = await player(t, 'Acct');
    expect((await t.game.act(acct.playerId, { t: 'linkWallet', rid: 'w1', accountId: 'acct.testnet' })).ok).toBe(true);
    await t.db.query(`INSERT INTO feather_tickets (id, farm_id, milestone, season, day, created_at) VALUES ('kept', $1, 'league-week', 'fx', 1, 0)`, [acct.farmId]);
    chain.script = ['wait'];
    expect((await t.game.act(acct.playerId, { t: 'redeemTicket', rid: 'r1', ticketId: 'kept' })).ok).toBe(true);
    await t.game.mintsIdle();
    expect((await t.db.query(`SELECT status FROM feather_tickets WHERE id = 'kept'`))[0]?.status).toBe('queued');
    // signing in from a guest farm, the player keeps the guest farm: the old farm goes to a retired holder
    const g = await t.game.startGuest('ip-kept', DEFAULT_GUEST_LIMITS);
    if (!g.ok) throw new Error('refused');
    expect(await t.game.claimGuest(g.playerId, 'dev', 'dev-Acct', null, 'guest')).toMatchObject({ status: 'done', kept: 'guest', playerId: acct.playerId });
    const [holder] = await t.db.query<{ auth_provider: string; retired_from: string }>('SELECT p.auth_provider, p.retired_from FROM farms f JOIN players p ON p.id = f.player_id WHERE f.id = $1', [acct.farmId]);
    expect(holder).toEqual({ auth_provider: 'retired', retired_from: acct.playerId });
    const heard: GameEvent[] = [];
    t.game.on((o) => {
      if (o.playerId === acct.playerId && o.msg.t === 'event') heard.push(o.msg.event);
    });
    t.game.kickMints();
    await t.game.mintsIdle();
    expect(chain.mints.at(-1)).toMatchObject({ owner: 'acct.testnet', milestone: 'league-week', season: 'fx' });
    expect((await t.db.query(`SELECT status, owner_account FROM feather_tickets WHERE id = 'kept'`))[0]).toEqual({ status: 'minted', owner_account: 'acct.testnet' });
    expect(heard.map((e) => e.kind)).toContain('featherMinted');
    await t.db.close();
  });
});

describe('GET /api/leaderboard', () => {
  it('answers public fields only; a bad board is refused and an unknown window is not found', async () => {
    const t = await makeGame({ league });
    const a = await player(t, 'Ada');
    await give(t, a.farmId, 1);
    const server: Server = createGameServer({
      game: t.game,
      sessions: createSessionSigner('test-secret'),
      privy: null,
      privyAppId: null,
      devLogin: true,
      clientDist: null,
      settlementMode: 'noop',
      dbKind: t.db.kind,
      log: () => undefined,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/api/leaderboard`);
      expect(res.status).toBe(200);
      const text = await res.text();
      const v = JSON.parse(text) as LeaderboardView;
      expect(Object.keys(v).sort()).toEqual(['board', 'entries', 'next', 'past', 'window']);
      expect(v.board).toBe('week');
      expect(Object.keys(v.entries[0] ?? {}).sort()).toEqual(['bust', 'busts', 'farmId', 'guest', 'kind', 'name', 'prevRank', 'rank', 'scoreMilli']);
      expect(v.entries[0]).toMatchObject({ farmId: a.farmId, scoreMilli: 1000 });
      expect(text).not.toContain(a.playerId);
      expect(text).not.toMatch(/cash|wallet|account|player_?id|subject/i);
      expect(((await (await fetch(`${base}/api/leaderboard?board=season`)).json()) as LeaderboardView).window?.id).toBe('s-1');
      expect(((await (await fetch(`${base}/api/leaderboard?board=week&id=w-2026-11-09`)).json()) as LeaderboardView).window?.id).toBe('w-2026-11-09');
      expect((await fetch(`${base}/api/leaderboard?board=month`)).status).toBe(400);
      expect((await fetch(`${base}/api/leaderboard?board=week&id=w-2020-01-06`)).status).toBe(404);
      expect((await fetch(`${base}/api/leaderboard?board=season&id=w-2026-11-09`)).status).toBe(404);
      expect((await fetch(`${base}/api/leaderboard?board=week&id=..%2F..%2Fetc`)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await t.db.close();
    }
  });
});
