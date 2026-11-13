// Standing contracts (delivered daily, by hand or by the delivery cart) and feed credit.
import { ECONOMY, type ContractView, type DebtView, type EggGrade } from '@coys/shared';
import { num } from '../db/db';
import { sellToAgent } from './cards';
import { ActionError, AGENT_COLUMNS, loadFarm, moveAgentCash, moveCash, remember, toAgent, type Ctx, type Farm } from './ctx';
import { logMachine, wearMachine } from './machines';
import { emit } from './market';
import { statDelivered, statMissed } from './profile';

interface ContractRow {
  id: string;
  farmId: string;
  agentId: string;
  grade: EggGrade | 'any';
  qtyPerDay: number;
  priceMilli: number;
  startDay: number;
  endDay: number;
  lastDeliveredDay: number;
  misses: number;
}

const toContract = (r: Record<string, unknown>): ContractRow => ({
  id: String(r.id),
  farmId: String(r.farm_id),
  agentId: String(r.agent_id),
  grade: r.grade as EggGrade | 'any',
  qtyPerDay: num(r.qty_per_day),
  priceMilli: num(r.price_milli),
  startDay: num(r.start_day),
  endDay: num(r.end_day),
  lastDeliveredDay: num(r.last_delivered_day),
  misses: num(r.misses),
});

const crateFor = (farm: Farm, grade: EggGrade | 'any'): number =>
  grade === 'any' ? farm.crate.white + farm.crate.cream + farm.crate.brown + farm.crate.golden : farm.crate[grade];

async function deliver(ctx: Ctx, farm: Farm, c: ContractRow, auto: boolean): Promise<boolean> {
  if (crateFor(farm, c.grade) < c.qtyPerDay) return false;
  const [a] = await ctx.q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1 AND status = 'open'`, [c.agentId]);
  if (!a) return false;
  const total = await sellToAgent(ctx, farm, toAgent(a), c.grade, c.qtyPerDay, c.priceMilli, 'contract');
  await ctx.q.query('UPDATE contracts SET last_delivered_day = $2 WHERE id = $1', [c.id, ctx.day]);
  await statDelivered(ctx.q, farm.id);
  emit(ctx, farm, { kind: 'contractDelivered', contractId: c.id, qty: c.qtyPerDay, totalMilli: total, auto });
  return true;
}

/** A player delivers today's contract eggs by hand. */
export async function deliverContract(ctx: Ctx, farm: Farm, contractId: string): Promise<void> {
  const [r] = await ctx.q.query(`SELECT * FROM contracts WHERE id = $1 AND farm_id = $2 AND status = 'active'`, [contractId, farm.id]);
  if (!r) throw new ActionError('not_found', 'contract not found');
  const c = toContract(r);
  if (ctx.day < c.startDay || ctx.day > c.endDay) throw new ActionError('invalid_action', 'nothing due today');
  if (c.lastDeliveredDay === ctx.day) throw new ActionError('invalid_action', 'already delivered today');
  if (!(await deliver(ctx, farm, c, false))) throw new ActionError('insufficient_stock', `need ${c.qtyPerDay} eggs in the crate`);
}

/**
 * Day close: the delivery cart fills any contract not yet delivered; a miss costs a penalty and
 * angers the buyer, and enough misses cancel the contract and start a sulk.
 */
export async function closeContracts(ctx: Ctx): Promise<Map<string, { delivered: number; missed: number }>> {
  const tally = new Map<string, { delivered: number; missed: number }>();
  const rows = await ctx.q.query(`SELECT * FROM contracts WHERE status = 'active' AND start_day <= $1`, [ctx.day]);
  for (const c of rows.map(toContract)) {
    const t = tally.get(c.farmId) ?? { delivered: 0, missed: 0 };
    tally.set(c.farmId, t);
    const farm = await loadFarm(ctx.q, c.farmId);
    if (c.lastDeliveredDay === ctx.day) t.delivered++;
    else {
      // the cart delivers unless it has broken down; each delivery wears it
      const [cart] = await ctx.q.query(`SELECT 1 FROM unlocks WHERE farm_id = $1 AND unlock_id = 'cart' AND NOT broken`, [farm.id]);
      const ok = cart ? await deliver(ctx, farm, c, true).catch(() => false) : false;
      if (ok) {
        t.delivered++;
        await logMachine(ctx.q, farm.id, ctx.day, 'cart', { units: c.qtyPerDay, milli: c.qtyPerDay * c.priceMilli });
        await wearMachine(ctx.q, farm.id, 'cart', ECONOMY.unlocks.cart.wear);
      }
      else {
        t.missed++;
        const penalty = Math.min(farm.cashMilli, Math.round(ECONOMY.buyers.bakery.missPenaltyShare * c.qtyPerDay * c.priceMilli));
        if (penalty > 0) {
          await moveCash(ctx, farm.id, 'penalty', -penalty, c.id);
          const [a] = await ctx.q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`, [c.agentId]);
          if (a) await moveAgentCash(ctx, toAgent(a), penalty, 'penalty', farm.id);
        }
        const misses = c.misses + 1;
        const cancel = misses >= ECONOMY.buyers.bakery.cancelAfterMisses;
        await ctx.q.query(`UPDATE contracts SET misses = $2, status = CASE WHEN $3 THEN 'cancelled' ELSE status END WHERE id = $1`, [c.id, misses, cancel]);
        await ctx.q.query('UPDATE farms SET last_missed_day = $2 WHERE id = $1', [farm.id, ctx.day]);
        await statMissed(ctx.q, farm.id);
        await remember(ctx, c.agentId, farm.id, { misses: 1 }, cancel ? ctx.day + ECONOMY.buyers.bakery.sulkDays : undefined);
        emit(ctx, farm, { kind: 'contractMissed', contractId: c.id, penaltyMilli: penalty });
      }
    }
    if (ctx.day >= c.endDay) await ctx.q.query(`UPDATE contracts SET status = 'done' WHERE id = $1 AND status = 'active'`, [c.id]);
    ctx.touched.add(farm.id);
  }
  return tally;
}

/**
 * Day close: feed credit falling due is taken from cash; what a player cannot pay is a default.
 * An agent's farm pays in full even into the red, which is how an over-borrowed rival goes bust.
 */
export async function closeDebts(ctx: Ctx): Promise<void> {
  const rows = await ctx.q.query(`SELECT * FROM debts WHERE status = 'open' AND due_day <= $1`, [ctx.day]);
  for (const d of rows) {
    const farm = await loadFarm(ctx.q, String(d.farm_id));
    const owed = num(d.due_milli) - num(d.paid_milli);
    const pay = farm.ownerKind === 'agent' ? owed : Math.min(owed, Math.max(0, farm.cashMilli));
    if (pay > 0) await moveCash(ctx, farm.id, 'credit repaid', -pay, String(d.id));
    const [a] = await ctx.q.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`, [d.agent_id]);
    if (a && pay > 0) await moveAgentCash(ctx, toAgent(a), pay, 'credit repaid', farm.id);
    const defaulted = pay < owed;
    await ctx.q.query('UPDATE debts SET paid_milli = paid_milli + $2, status = $3 WHERE id = $1', [d.id, pay, defaulted ? 'defaulted' : 'paid']);
    if (defaulted) await remember(ctx, String(d.agent_id), farm.id, { misses: 1 });
    emit(ctx, farm, { kind: 'debtCharged', debtId: String(d.id), paidMilli: pay, defaulted });
    ctx.touched.add(farm.id);
  }
}

export async function contractViews(ctx: Ctx, farmId: string): Promise<ContractView[]> {
  const rows = await ctx.q.query(
    `SELECT c.*, a.name AS agent_name FROM contracts c JOIN agents a ON a.id = c.agent_id
     WHERE c.farm_id = $1 AND c.status = 'active' ORDER BY c.end_day`,
    [farmId],
  );
  return rows.map((r) => {
    const c = toContract(r);
    return {
      id: c.id,
      agentName: String(r.agent_name),
      grade: c.grade,
      qtyPerDay: c.qtyPerDay,
      priceMilli: c.priceMilli,
      daysLeft: Math.max(0, c.endDay - ctx.day + 1),
      deliveredToday: c.lastDeliveredDay === ctx.day,
      misses: c.misses,
    };
  });
}

export async function debtViews(ctx: Ctx, farmId: string): Promise<DebtView[]> {
  const rows = await ctx.q.query(
    `SELECT d.*, a.name AS agent_name FROM debts d JOIN agents a ON a.id = d.agent_id
     WHERE d.farm_id = $1 AND (d.status = 'open' OR d.due_day >= $2) ORDER BY d.due_day DESC LIMIT 8`,
    [farmId, ctx.day - 3],
  );
  return rows.map((r) => ({
    id: String(r.id),
    agentName: String(r.agent_name),
    dueDay: num(r.due_day),
    dueMilli: num(r.due_milli) - num(r.paid_milli),
    status: r.status as DebtView['status'],
  }));
}
