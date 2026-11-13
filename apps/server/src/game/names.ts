// Farm names on the server: unique generated names, the player's choice (shared rules plus the
// season's uniqueness and the email-name guard), and the boot-time rename of farms named before
// farm naming existed (their names came from sign-in). A rename also rewrites the farm's name in
// recorded trades, so the old name leaves every public view.
//
// The email-name guard: at sign-in the client sends the SHA-256 of its email name (letters and
// digits, lower case) and that name's length, never the name itself. A farm name is refused when
// any run of that many letters and digits in it hashes the same.
import { createHash } from 'node:crypto';
import { RENAME_EVERY_DAYS, checkFarmName, farmNameKey, nameLetters, suggestFarmName, type FarmNameProblem } from '@coys/shared';
import type { Queryable } from '../db/db';
import { num } from '../db/db';

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The guard the server keeps for a name it must never accept: SHA-256 of its letters and digits, and their count. */
export function nameGuardOf(name: string): { sha256: string; len: number } | null {
  const letters = nameLetters(name);
  return letters.length >= 3 ? { sha256: sha256Hex(letters), len: letters.length } : null;
}

/** Whether a name contains the guarded name (some run of `len` letters and digits hashes the same). */
export function guardHit(name: string, guard: { sha256: string; len: number } | null): boolean {
  if (!guard || guard.len < 3) return false;
  const letters = nameLetters(name);
  for (let i = 0; i + guard.len <= letters.length; i++) if (sha256Hex(letters.slice(i, i + guard.len)) === guard.sha256) return true;
  return false;
}

/** Whether another farm in this season already has the name (case and spaces aside). */
export async function nameTaken(q: Queryable, name: string, exceptFarmId: string | null): Promise<boolean> {
  const rows = await q.query<{ name: string }>('SELECT name FROM farms WHERE id <> $1', [exceptFarmId ?? '']);
  const key = farmNameKey(name);
  return rows.some((r) => farmNameKey(String(r.name)) === key);
}

/** A generated name no farm has yet. */
export async function uniqueFarmName(q: Queryable, rnd: () => number = Math.random): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const n = suggestFarmName(rnd);
    if (!(await nameTaken(q, n, null))) return n;
  }
  // every pairing tried was taken: number one
  for (let k = 2; ; k++) {
    const n = `${suggestFarmName(rnd).slice(0, 20)} ${k}`;
    if (!(await nameTaken(q, n, null))) return n;
  }
}

export type NameRefusal = FarmNameProblem | 'taken' | 'wait';

/** Checks a player's chosen name for their farm: the shared rules, the email guard, the season, the weekly limit. */
export async function checkChosenName(
  q: Queryable,
  farm: { id: string; playerId: string | null; needsName: boolean; renamedDay: number | null },
  raw: string,
  day: number,
): Promise<{ ok: true; name: string } | { ok: false; problem: NameRefusal }> {
  const checked = checkFarmName(raw);
  if (!checked.ok) return checked;
  const [g] = farm.playerId ? await q.query('SELECT name_guard_sha256, name_guard_len FROM players WHERE id = $1', [farm.playerId]) : [];
  const guard = g?.name_guard_sha256 ? { sha256: String(g.name_guard_sha256), len: num(g.name_guard_len) } : null;
  if (guardHit(checked.name, guard)) return { ok: false, problem: 'email' };
  if (await nameTaken(q, checked.name, farm.id)) return { ok: false, problem: 'taken' };
  if (!farm.needsName && farm.renamedDay !== null && day - farm.renamedDay < RENAME_EVERY_DAYS) return { ok: false, problem: 'wait' };
  return { ok: true, name: checked.name };
}

/** Names a farm: the farm, its player's shown name, and its name in recorded trades. */
export async function setFarmName(
  q: Queryable,
  farmId: string,
  name: string,
  opts: { source: 'generated' | 'chosen'; needsName: boolean; renamedDay?: number | null },
): Promise<void> {
  await q.query('UPDATE farms SET name = $2, name_source = $3, needs_name = $4, renamed_day = COALESCE($5, renamed_day) WHERE id = $1', [
    farmId,
    name,
    opts.source,
    opts.needsName,
    opts.renamedDay ?? null,
  ]);
  await q.query('UPDATE players SET display_name = $2 WHERE id = (SELECT player_id FROM farms WHERE id = $1)', [farmId, name]);
  await q.query('UPDATE trades SET seller = $2 WHERE seller_farm = $1', [farmId, name]);
  await q.query('UPDATE trades SET buyer = $2 WHERE buyer_farm = $1', [farmId, name]);
}

/**
 * Farms named before farm naming took their name from sign-in (for email sign-in, the email's
 * local part). Each gets a generated name now and its owner is asked to choose one; the old name
 * is kept only as the email-name guard (its hash), never as text. Returns how many were renamed.
 */
export async function renameLegacyFarms(q: Queryable, rnd: () => number = Math.random): Promise<number> {
  const rows = await q.query<{ id: string; player_id: string | null; display_name: string | null; guard: string | null }>(
    `SELECT f.id, f.player_id, p.display_name, p.name_guard_sha256 AS guard FROM farms f LEFT JOIN players p ON p.id = f.player_id
     WHERE f.owner_kind = 'player' AND f.name_source = 'legacy' ORDER BY f.id`,
  );
  for (const r of rows) {
    if (r.player_id && !r.guard && r.display_name) {
      const g = nameGuardOf(String(r.display_name));
      if (g) await q.query('UPDATE players SET name_guard_sha256 = $2, name_guard_len = $3 WHERE id = $1', [r.player_id, g.sha256, g.len]);
    }
    await setFarmName(q, String(r.id), await uniqueFarmName(q, rnd), { source: 'generated', needsName: true });
  }
  return rows.length;
}
