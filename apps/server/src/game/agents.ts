// Rival farms run by agents. An agent sees the same market a player sees and acts only through the
// same validated farm actions, once per in-game day, paying the inference cost for each decision.
// Prices move only because of what players and agents sell; nothing here sets a price.
import { z } from 'zod';
import {
  COOP_KINDS,
  ECONOMY,
  EGG_GRADES,
  FEED_TIERS,
  UNLOCK_IDS,
  henDailyMargin,
  type CoopKind,
  type EggStock,
  type FeedStock,
  type FeedTier,
  type MarketDay,
  type UnlockId,
} from '@coys/shared';
import type { NearAiClient } from '../ai/nearai';

export type AgentAction =
  | { t: 'sell'; items: Partial<EggStock> }
  | { t: 'buyHens'; count: number }
  | { t: 'buyFeed'; tier: FeedTier; bags: number }
  | { t: 'setFeedTier'; tier: FeedTier }
  | { t: 'buildCoop'; kind: Exclude<CoopKind, 'starter'> }
  | { t: 'buyUnlock'; unlock: UnlockId };

export interface HeuristicStyle {
  /** Coins kept back when buying hens or machines. */
  reserve: number;
  tier: FeedTier;
  /** Target hens as a share of coop capacity (above 1 accepts crowding). */
  fill: number;
  /** Hold eggs back while the live multiplier is below this. */
  holdBelow: number;
  /** Days of feed to keep in the trough. */
  feedDays: number;
  unlockOrder: readonly UnlockId[];
}

export interface RivalSpec {
  key: string;
  name: string;
  /** Sprite of the rival's farm sign, used by the client. */
  sign: string;
  start: { cash: number; hens: number; coops: readonly CoopKind[]; feed: { tier: FeedTier; kg: number } };
  style: HeuristicStyle;
}

/** The two rival farms drawn in the art (17-sign-upstart, 17-sign-old-money). */
export const RIVALS: readonly RivalSpec[] = [
  {
    key: 'upstart',
    name: 'Upstart Eggs',
    sign: '17-sign-upstart',
    start: { cash: 60, hens: 24, coops: ['red'], feed: { tier: 'cheap', kg: 50 } },
    style: { reserve: 10, tier: 'cheap', fill: 1.1, holdBelow: 0, feedDays: 3, unlockOrder: ['conveyor', 'hopper', 'grader', 'clerk'] },
  },
  {
    key: 'old-money',
    name: 'Old Money Farms',
    sign: '17-sign-old-money',
    start: { cash: 400, hens: 130, coops: ['deluxe', 'red', 'starter'], feed: { tier: 'premium', kg: 150 } },
    style: { reserve: 150, tier: 'premium', fill: 0.95, holdBelow: 0.6, feedDays: 5, unlockOrder: ['grader', 'clerk', 'conveyor', 'hopper'] },
  },
];

export interface AgentView {
  farmId: string;
  key: string;
  name: string;
  day: number;
  cash: number;
  hens: number;
  capacity: number;
  freePlots: number;
  crate: EggStock;
  feedGrams: FeedStock;
  feedTier: FeedTier;
  unlocks: UnlockId[];
  multiplier: number;
  history: MarketDay[];
  style: HeuristicStyle;
}

export interface AgentBrain {
  readonly kind: 'heuristic' | 'nearai';
  decide(view: AgentView): Promise<AgentAction[]>;
}

const sum = (o: Partial<Record<string, number>>): number => Object.values(o).reduce<number>((a, b) => a + (b ?? 0), 0);

export class HeuristicBrain implements AgentBrain {
  readonly kind = 'heuristic' as const;

  async decide(v: AgentView): Promise<AgentAction[]> {
    const actions: AgentAction[] = [];
    const s = v.style;
    let cash = v.cash;
    const unlocks = new Set(v.unlocks);

    // Sell the crate unless the market is too weak to bother and there is room to wait.
    if (sum(v.crate) > 0 && (v.multiplier >= s.holdBelow || sum(v.crate) > v.hens * 3)) {
      actions.push({ t: 'sell', items: { ...v.crate } });
      cash += sum(
        Object.fromEntries(EGG_GRADES.map((g) => [g, v.crate[g] * ECONOMY.eggs.basePrice[g] * v.multiplier])),
      );
    }

    // Keep the trough stocked: feed comes first.
    if (v.feedTier !== s.tier) actions.push({ t: 'setFeedTier', tier: s.tier });
    const needPerDay = Math.max(1, v.hens) * ECONOMY.feed.kgPerHenPerDay * 1000;
    const stock = sum(v.feedGrams);
    if (stock < needPerDay * s.feedDays) {
      const bagPrice = ECONOMY.feed.tiers[s.tier].bagPrice * (unlocks.has('hopper') ? 1 - ECONOMY.unlocks.hopper.feedCostDiscount : 1);
      const wanted = Math.ceil((needPerDay * (s.feedDays + 2) - stock) / (ECONOMY.feed.bagKg * 1000));
      const bags = Math.min(ECONOMY.limits.maxBagsPerPurchase, wanted, Math.floor(cash / bagPrice));
      if (bags > 0) {
        actions.push({ t: 'buyFeed', tier: s.tier, bags });
        cash -= bags * bagPrice;
      }
    }

    // Grow only while a hen still earns its keep at today's price.
    const margin = henDailyMargin({ tier: s.tier, multiplier: v.multiplier, unlocks: [...unlocks] });
    if (margin > 0.05) {
      const target = Math.floor(v.capacity * s.fill);
      const affordable = Math.floor((cash - s.reserve) / ECONOMY.hen.price);
      const count = Math.min(ECONOMY.limits.maxHensPerPurchase, target - v.hens, affordable);
      if (count > 0) {
        actions.push({ t: 'buyHens', count });
        cash -= count * ECONOMY.hen.price;
      }
      if (v.hens >= v.capacity * 0.9 && v.freePlots > 0) {
        const kind = cash - s.reserve >= ECONOMY.coops.kinds.deluxe.price ? 'deluxe' : 'red';
        if (cash - s.reserve >= ECONOMY.coops.kinds[kind].price) {
          actions.push({ t: 'buildCoop', kind });
          cash -= ECONOMY.coops.kinds[kind].price;
        }
      }
    }

    // Machines once there is plenty of slack.
    const next = s.unlockOrder.find((u) => !unlocks.has(u));
    if (next && cash - s.reserve * 2 >= ECONOMY.unlocks[next].price) actions.push({ t: 'buyUnlock', unlock: next });

    return actions;
  }
}

const agentActionSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('sell'), items: z.object(Object.fromEntries(EGG_GRADES.map((g) => [g, z.number().int().min(0).optional()]))) }),
  z.object({ t: z.literal('buyHens'), count: z.number().int().min(1).max(ECONOMY.limits.maxHensPerPurchase) }),
  z.object({ t: z.literal('buyFeed'), tier: z.enum(FEED_TIERS), bags: z.number().int().min(1).max(ECONOMY.limits.maxBagsPerPurchase) }),
  z.object({ t: z.literal('setFeedTier'), tier: z.enum(FEED_TIERS) }),
  z.object({ t: z.literal('buildCoop'), kind: z.enum(COOP_KINDS).exclude(['starter']) }),
  z.object({ t: z.literal('buyUnlock'), unlock: z.enum(UNLOCK_IDS) }),
]);
const decisionSchema = z.object({ actions: z.array(agentActionSchema).max(8) });

/** Parses a model reply into actions; accepts the JSON bare or inside a code fence. */
export function parseDecision(reply: string): AgentAction[] | null {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = decisionSchema.safeParse(JSON.parse(match[0]));
    return parsed.success ? (parsed.data.actions as AgentAction[]) : null;
  } catch {
    return null;
  }
}

/** Asks a NEAR AI Cloud model for the day's decision; falls back to the heuristic on any failure. */
export class NearAiBrain implements AgentBrain {
  readonly kind = 'nearai' as const;
  private readonly fallback = new HeuristicBrain();

  constructor(
    private readonly client: NearAiClient,
    private readonly log: (line: string) => void = console.warn,
  ) {}

  async decide(v: AgentView): Promise<AgentAction[]> {
    const { style: _style, farmId: _farmId, ...visible } = v;
    try {
      const reply = await this.client.chat(
        [
          {
            role: 'system',
            content:
              `You run ${v.name}, a rival egg farm in a shared market. Each decision costs ${ECONOMY.agents.inferenceCostPerDecision} coins. ` +
              `Your cash below ${ECONOMY.agents.bustBelowCash} means bankruptcy. Egg prices are base prices times a market multiplier ` +
              `set by everyone's total daily supply: clamp((${ECONOMY.market.referenceSupply} / supply) ^ ${ECONOMY.market.exponent}, ` +
              `${ECONOMY.market.minMultiplier}, ${ECONOMY.market.maxMultiplier}). Hens cost ${ECONOMY.hen.price}; feed bags are ` +
              `${ECONOMY.feed.bagKg} kg, hens eat ${ECONOMY.feed.kgPerHenPerDay} kg a day. Reply with JSON only: ` +
              `{"actions":[...]} using t = sell{items}, buyHens{count}, buyFeed{tier,bags}, setFeedTier{tier}, buildCoop{kind}, buyUnlock{unlock}.`,
          },
          { role: 'user', content: JSON.stringify({ farm: visible, prices: ECONOMY.eggs.basePrice, unlocks: ECONOMY.unlocks }) },
        ],
        { maxTokens: 800, timeoutMs: 15_000 },
      );
      const actions = parseDecision(reply);
      if (actions) return actions;
      this.log(`[agents] ${v.key}: unreadable NEAR AI reply, using the heuristic`);
    } catch (err) {
      this.log(`[agents] ${v.key}: NEAR AI call failed (${err instanceof Error ? err.message : String(err)}), using the heuristic`);
    }
    return this.fallback.decide(v);
  }
}
