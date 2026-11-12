// The goal chain that teaches the game in order: collect your first eggs, sell a crate, fill your
// coop, win a haggle, buy your first machine, outlast a rival. Collecting, selling and haggling set
// a done flag when they happen; the rest are read from the farm. A goal pays its coins once, when
// the player claims it, and only after every goal before it.
import { coopCapacity, GOAL_IDS, GOAL_REWARDS, toMilli, type CoopKind, type GoalId, type GoalView } from '@coys/shared';
import { num, type Queryable } from '../db/db';
import { ActionError, moveCash, type Ctx, type Farm } from './ctx';
import { emit } from './market';

interface GoalRecord {
  done: GoalId[];
  claimed: GoalId[];
  /** The tour's practice offer has been sent (once per farm). */
  practice?: boolean;
  /** The player finished or skipped the how-to-play tour (so it shows once per player, on any browser). */
  toured?: boolean;
}

async function read(q: Queryable, farmId: string): Promise<{ goals: GoalRecord; createdDay: number }> {
  const [row] = await q.query('SELECT goals, created_day FROM farms WHERE id = $1', [farmId]);
  let goals: GoalRecord = { done: [], claimed: [] };
  try {
    const parsed = JSON.parse(String(row?.goals ?? '{}')) as Partial<GoalRecord>;
    goals = {
      done: (parsed.done ?? []).filter((g) => GOAL_IDS.includes(g)),
      claimed: (parsed.claimed ?? []).filter((g) => GOAL_IDS.includes(g)),
      ...(parsed.practice ? { practice: true } : {}),
      ...(parsed.toured ? { toured: true } : {}),
    };
  } catch {
    // a bad value reads as a fresh chain
  }
  return { goals, createdDay: num(row?.created_day) };
}

async function write(q: Queryable, farmId: string, goals: GoalRecord): Promise<void> {
  await q.query('UPDATE farms SET goals = $2 WHERE id = $1', [farmId, JSON.stringify(goals)]);
}

/** Marks the how-to-play tour as done for the farm's player. */
export async function markToured(q: Queryable, farmId: string): Promise<void> {
  const { goals } = await read(q, farmId);
  if (!goals.toured) await write(q, farmId, { ...goals, toured: true });
}

/** Whether the farm's player has done the tour. */
export async function toured(q: Queryable, farmId: string): Promise<boolean> {
  return (await read(q, farmId)).goals.toured === true;
}

/** Marks the tour's practice offer as sent; false when it already was. */
export async function takePractice(q: Queryable, farmId: string): Promise<boolean> {
  const { goals } = await read(q, farmId);
  if (goals.practice) return false;
  await write(q, farmId, { ...goals, practice: true });
  return true;
}

/** Records that something the chain asks for has happened (collect, sell, haggle). */
export async function markGoal(q: Queryable, farmId: string, goal: GoalId): Promise<void> {
  const { goals } = await read(q, farmId);
  if (goals.done.includes(goal)) return;
  goals.done.push(goal);
  await write(q, farmId, goals);
}

async function met(q: Queryable, farmId: string, goal: GoalId, goals: GoalRecord, createdDay: number): Promise<boolean> {
  if (goals.done.includes(goal)) return true;
  switch (goal) {
    case 'coop': {
      const [h] = await q.query(`SELECT count(*) AS n FROM hens WHERE farm_id = $1 AND status = 'alive'`, [farmId]);
      const coops = await q.query('SELECT kind FROM coops WHERE farm_id = $1', [farmId]);
      const capacity = coopCapacity(coops.map((c) => c.kind as CoopKind));
      return capacity > 0 && num(h?.n) >= capacity;
    }
    case 'machine': {
      const [u] = await q.query('SELECT count(*) AS n FROM unlocks WHERE farm_id = $1', [farmId]);
      return num(u?.n) > 0;
    }
    case 'rival': {
      const [r] = await q.query(`SELECT count(*) AS n FROM agents WHERE role = 'rival' AND status = 'bust' AND bust_day >= $1`, [createdDay]);
      return num(r?.n) > 0;
    }
    default:
      return false;
  }
}

export async function goalViews(q: Queryable, farmId: string): Promise<GoalView[]> {
  const { goals, createdDay } = await read(q, farmId);
  const out: GoalView[] = [];
  let open = false;
  for (const id of GOAL_IDS) {
    const rewardMilli = toMilli(GOAL_REWARDS[id]);
    if (goals.claimed.includes(id)) out.push({ id, state: 'claimed', rewardMilli });
    else if (!open && (await met(q, farmId, id, goals, createdDay))) {
      out.push({ id, state: 'ready', rewardMilli });
      open = true;
    } else {
      out.push({ id, state: 'open', rewardMilli });
      open = true;
    }
  }
  return out;
}

export async function claimGoal(ctx: Ctx, farm: Farm, goal: GoalId): Promise<void> {
  const { goals, createdDay } = await read(ctx.q, farm.id);
  if (goals.claimed.includes(goal)) throw new ActionError('invalid_action', 'goal already claimed');
  const first = GOAL_IDS.find((g) => !goals.claimed.includes(g));
  if (first !== goal) throw new ActionError('invalid_action', 'claim the goals in order');
  if (!(await met(ctx.q, farm.id, goal, goals, createdDay))) throw new ActionError('invalid_action', 'goal not reached yet');
  goals.claimed.push(goal);
  await write(ctx.q, farm.id, goals);
  const reward = toMilli(GOAL_REWARDS[goal]);
  await moveCash(ctx, farm.id, 'goal', reward, goal);
  farm.cashMilli += reward;
  emit(ctx, farm, { kind: 'goalClaimed', goal, rewardMilli: reward });
}

