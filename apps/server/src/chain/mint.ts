// Feather numbers: random, drawn by the server from a seed anyone can check. The seed is the SHA-256
// of the season, the ticket and the last settled day's transaction (public, fixed before the ticket
// is redeemed, and not the server's to choose); the number is the first of the seed's stream that
// is not taken yet. Both are logged and kept with the ticket, so a draw can be replayed:
//   candidate i = 1 + (first 4 bytes of SHA256(seed | i), big-endian) mod 777
import { createHash } from 'node:crypto';
import { num, type Queryable } from '../db/db';

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

export function featherSeed(season: string, ticketId: string, anchorTx: string): string {
  return sha(`coys-mint|${season}|${ticketId}|${anchorTx}`).toString('hex');
}

/** The first number in the seed's stream that is not taken (1 to max). Throws when all are. */
export function drawFeatherNumber(seed: string, taken: ReadonlySet<number>, max = 777): number {
  if (taken.size >= max) throw new Error('every Feather number is taken');
  for (let i = 0; ; i++) {
    const n = 1 + (sha(`${seed}|${i}`).readUInt32BE(0) % max);
    if (!taken.has(n)) return n;
  }
}

/** Which collection a season's Feathers go into: the 777 (the contract's live season) or that season's test collection. */
export type Collection = 'live' | 'test';

/** A test Feather's token id, as the contract makes it: never one of the 777. */
export const testFeatherToken = (season: string, n: number): string => `test-${season}-${String(n).padStart(3, '0')}`;
/** The token id a Feather of this number gets in this collection. */
export const tokenFor = (collection: Collection, season: string, n: number): string => (collection === 'live' ? String(n).padStart(3, '0') : testFeatherToken(season, n));

/** The numbers a collection has given out here: minted, or drawn for a ticket on its way. */
export async function takenNumbers(q: Queryable, collection: Collection, season: string): Promise<Set<number>> {
  const prefix = `test-${season}-`;
  const rows =
    collection === 'live'
      ? await q.query<{ number: number }>(`SELECT number FROM feather_tickets WHERE token_id IS NOT NULL AND left(token_id, 5) <> 'test-'`)
      : await q.query<{ number: number }>('SELECT number FROM feather_tickets WHERE left(token_id, $2) = $1', [prefix, prefix.length]);
  return new Set(rows.map((r) => num(r.number)));
}

/** The draw's anchor: the season's most recent settlement transaction, or "none" before the first. */
export async function anchorTx(q: Queryable, season: string): Promise<string> {
  const [r] = await q.query<{ settlement_tx: string }>(
    'SELECT settlement_tx FROM market_days WHERE season = $1 AND settlement_tx IS NOT NULL ORDER BY day DESC LIMIT 1',
    [season],
  );
  return r?.settlement_tx ?? 'none';
}

export interface Drawn {
  number: number;
  token: string;
  seed: string;
  anchor: string;
}

/**
 * Draws a ticket's Feather number and keeps it (with its seed and anchor) on the ticket. A ticket
 * that already has a seed keeps it, so a number refused by the contract as taken is replaced by the
 * next free one in the same stream. `alsoTaken`: numbers the contract holds that this database does not.
 */
export async function drawForTicket(
  q: Queryable,
  ticketId: string,
  season: string,
  collection: Collection,
  log: (line: string) => void,
  alsoTaken: Iterable<number> = [],
): Promise<Drawn> {
  const [t] = await q.query<{ number_seed: string | null; number_anchor: string | null }>('SELECT number_seed, number_anchor FROM feather_tickets WHERE id = $1', [ticketId]);
  const anchor = t?.number_anchor ?? (await anchorTx(q, season));
  const seed = t?.number_seed ?? featherSeed(season, ticketId, anchor);
  const taken = await takenNumbers(q, collection, season);
  for (const n of alsoTaken) taken.add(n);
  const number = drawFeatherNumber(seed, taken);
  const token = tokenFor(collection, season, number);
  await q.query('UPDATE feather_tickets SET number = $2, token_id = $3, number_seed = $4, number_anchor = $5 WHERE id = $1', [ticketId, number, token, seed, anchor]);
  log(`[feathers] ticket ${ticketId} drew Feather ${token} (${collection}): anchor ${anchor} seed ${seed} number ${number} of ${taken.size} taken`);
  return { number, token, seed, anchor };
}
