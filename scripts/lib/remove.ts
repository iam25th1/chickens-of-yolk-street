// Removing a player and their farm entirely (see scripts/remove-player.ts).
import type { Db } from '../../apps/server/src/db/db';

export const FARM_TABLES = ['agent_memory', 'cards', 'contracts', 'debts', 'orders', 'coops', 'unlocks', 'lay_events', 'ledger', 'machine_days', 'milestone_rolls', 'feather_tickets', 'hens'] as const;

export interface RemovalPlan {
  player: { id: string; name: string };
  farms: { id: string; name: string }[];
  /** Rows per table that go with the farm. */
  rows: Record<string, number>;
}

/** What removing a player would take away. Throws for an unknown player or a non-player farm. */
export async function planRemoval(db: Db, playerId: string): Promise<RemovalPlan> {
  const [player] = await db.query<{ id: string; display_name: string }>('SELECT id, display_name FROM players WHERE id = $1', [playerId]);
  if (!player) throw new Error(`no player ${playerId}`);
  const farms = await db.query<{ id: string; name: string; owner_kind: string }>('SELECT id, name, owner_kind FROM farms WHERE player_id = $1', [player.id]);
  if (farms.some((f) => f.owner_kind !== 'player')) throw new Error('refusing: that farm is not a player farm');
  const rows: Record<string, number> = {};
  for (const f of farms) {
    for (const t of FARM_TABLES) {
      const [r] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${t} WHERE farm_id = $1`, [f.id]);
      rows[t] = (rows[t] ?? 0) + Number(r?.n ?? 0);
    }
    const [tr] = await db.query<{ n: string }>('SELECT count(*) AS n FROM trades WHERE buyer_farm = $1 OR seller_farm = $1', [f.id]);
    rows.trades = (rows.trades ?? 0) + Number(tr?.n ?? 0);
  }
  return { player: { id: player.id, name: player.display_name }, farms: farms.map((f) => ({ id: f.id, name: f.name })), rows };
}

/** Removes the player, their farm and every row the farm owned, in one transaction. */
export async function removePlayer(db: Db, playerId: string): Promise<RemovalPlan> {
  const plan = await planRemoval(db, playerId);
  await db.tx(async (q) => {
    for (const f of plan.farms) {
      await q.query('DELETE FROM trades WHERE buyer_farm = $1 OR seller_farm = $1', [f.id]);
      for (const t of FARM_TABLES) await q.query(`DELETE FROM ${t} WHERE farm_id = $1`, [f.id]);
      await q.query('DELETE FROM farms WHERE id = $1', [f.id]);
    }
    await q.query('DELETE FROM players WHERE id = $1', [plan.player.id]);
  });
  return plan;
}
