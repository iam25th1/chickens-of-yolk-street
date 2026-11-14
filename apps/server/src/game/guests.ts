// Guest play: PLAY starts a farm at once, with no sign-in. A guest player has a random, unguessable
// subject and never a wallet, so nothing goes on chain under it; its farm trades in the shared market
// and its days settle like any farm's (with no account). Signing in moves the guest farm, with every
// row it owns, to the account in one transaction; when the account already has a farm the player
// chooses which to keep and the other is retired through the bust flow. A guest farm left idle for
// seven real days goes bust the same way.
import { randomBytes } from 'node:crypto';
import { num, type Queryable } from '../db/db';
import type { Ctx } from './ctx';
import { guardHit, setFarmName, uniqueFarmName } from './names';

/** A guest farm idle this long (real time) goes bust at the next day close. */
export const GUEST_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

export interface GuestLimits {
  /** New guest farms one address may start in 24 hours. */
  perIpPerDay: number;
  /** New guest farms the whole street may start in an hour. */
  perHour: number;
}

export const DEFAULT_GUEST_LIMITS: GuestLimits = { perIpPerDay: 3, perHour: 60 };

/** A random guest subject: 128 bits, hex. */
export const guestSubject = (): string => randomBytes(16).toString('hex');

/** Which limit a new guest farm would break now, or null when it may start. Old rows are dropped first. */
export async function guestLimitHit(q: Queryable, ipHash: string, now: number, limits: GuestLimits): Promise<'ip' | 'hour' | null> {
  await q.query('DELETE FROM guest_starts WHERE started_at < $1', [now - 2 * 24 * 60 * 60 * 1000]);
  const [ip] = await q.query('SELECT count(*) AS n FROM guest_starts WHERE ip_hash = $1 AND started_at >= $2', [ipHash, now - 24 * 60 * 60 * 1000]);
  if (num(ip?.n) >= limits.perIpPerDay) return 'ip';
  const [hour] = await q.query('SELECT count(*) AS n FROM guest_starts WHERE started_at >= $1', [now - 60 * 60 * 1000]);
  if (num(hour?.n) >= limits.perHour) return 'hour';
  return null;
}

/**
 * Retires a player's farm through the bust flow (as an AI farm goes bust): its hens go to the
 * auction, its open orders, contracts and cards close, its unpaid credit is written off as
 * defaulted, and the farm is marked bust today. Its records (ledger, trades, badges, tickets) stay.
 */
export async function retireFarm(ctx: Ctx, farmId: string): Promise<number> {
  const hens = (await ctx.q.query(`UPDATE hens SET status = 'auction', farm_id = NULL WHERE farm_id = $1 AND status = 'alive' RETURNING id`, [farmId])).length;
  await ctx.q.query('UPDATE farms SET bust_day = $2 WHERE id = $1 AND bust_day IS NULL', [farmId, ctx.day]);
  await ctx.q.query(`UPDATE orders SET status = 'cancelled' WHERE farm_id = $1 AND status = 'open'`, [farmId]);
  await ctx.q.query(`UPDATE contracts SET status = 'cancelled' WHERE farm_id = $1 AND status = 'active'`, [farmId]);
  await ctx.q.query(`UPDATE cards SET status = 'expired' WHERE farm_id = $1 AND status = 'open'`, [farmId]);
  await ctx.q.query(`UPDATE debts SET status = 'defaulted' WHERE farm_id = $1 AND status = 'open'`, [farmId]);
  ctx.marketChanged = true;
  return hens;
}

/** Guest farms not seen for GUEST_IDLE_MS: each is retired through the bust flow. Returns their ids. */
export async function bustIdleGuests(ctx: Ctx): Promise<string[]> {
  const idle = await ctx.q.query<{ id: string }>(
    `SELECT f.id FROM farms f JOIN players p ON p.id = f.player_id
     WHERE p.auth_provider = 'guest' AND f.bust_day IS NULL AND COALESCE(p.last_seen_at, p.created_at) < $1 ORDER BY f.id`,
    [ctx.now - GUEST_IDLE_MS],
  );
  for (const f of idle) {
    const hens = await retireFarm(ctx, f.id);
    ctx.log(`[guest] an idle guest farm went bust on day ${ctx.day}${hens ? `; ${hens} hens go to auction` : ''}`);
  }
  return idle.map((f) => String(f.id));
}

/** What the choose-a-farm card shows of each farm (the player's own farms only). */
export interface FarmChoice {
  name: string;
  cashMilli: number;
  hens: number;
  land: number;
  badges: number;
  tickets: number;
  days: number;
}

export async function farmChoice(q: Queryable, farmId: string, day: number): Promise<FarmChoice> {
  const [f] = await q.query(
    `SELECT f.name, f.cash_milli, f.created_day,
            (SELECT count(*) FROM hens h WHERE h.farm_id = f.id AND h.status = 'alive') AS hens,
            (SELECT count(*) FROM farm_land l WHERE l.farm_id = f.id) AS land,
            (SELECT count(*) FROM badges b WHERE b.farm_id = f.id AND b.tier IS NOT NULL) AS badges,
            (SELECT count(*) FROM feather_tickets t WHERE t.farm_id = f.id AND t.status <> 'minted') AS tickets
     FROM farms f WHERE f.id = $1`,
    [farmId],
  );
  return {
    name: String(f?.name ?? ''),
    cashMilli: num(f?.cash_milli),
    hens: num(f?.hens),
    land: num(f?.land),
    badges: num(f?.badges),
    tickets: num(f?.tickets),
    days: Math.max(1, day - num(f?.created_day) + 1),
  };
}

/**
 * After a farm moves to a signed-in account: a name that contains the account's email name (by its
 * guard) is replaced by a generated one, and the player is asked to name the farm, free (KEEP keeps
 * the name). The usual name rules and the email check apply to what they choose.
 */
export async function afterMove(q: Queryable, farmId: string, guard: { sha256: string; len: number } | null, rnd: () => number): Promise<void> {
  const [f] = await q.query<{ name: string }>('SELECT name FROM farms WHERE id = $1', [farmId]);
  if (f && guardHit(String(f.name), guard)) await setFarmName(q, farmId, await uniqueFarmName(q, rnd), { source: 'generated', needsName: true });
  else await q.query('UPDATE farms SET needs_name = true, renamed_day = NULL WHERE id = $1', [farmId]);
}
