// What an agent sees and what it may decide. The same Decision shape comes from the rule policy or
// from NEAR AI Cloud (as structured JSON output validated here); the game then bounds every number
// and applies it through the same validated actions players use.
import { z } from 'zod';
import {
  COOP_KINDS,
  EGG_GRADES,
  FEED_TIERS,
  UNLOCK_IDS,
  type AgentKind,
  type AgentRole,
  type EggGrade,
  type EggStock,
  type FeedStock,
  type FeedTier,
  type MarketDay,
  type UnlockId,
} from '@coys/shared';

export interface MemoryBrief {
  deals: number;
  refusals: number;
  hagglesWon: number;
  hagglesLost: number;
  misses: number;
  sulking: boolean;
}

export interface FarmBrief {
  farmId: string;
  name: string;
  owner: 'player' | 'agent';
  hens: number;
  capacity: number;
  crate: EggStock;
  /** Eggs laid on an average day lately. */
  dailyEggs: number;
  feedDays: number;
  cash: number;
  /** Share of brown and golden in recent sales. */
  quality: number;
  /** Open sell orders this farm has in the book. */
  sells: { orderId: string; grade: EggGrade; qty: number; price: number }[];
  hasContractWithMe: boolean;
  owesMe: number;
  memory: MemoryBrief;
}

export interface AgentContext {
  day: number;
  agent: {
    id: string;
    kind: AgentKind;
    role: AgentRole;
    name: string;
    cash: number;
    /** Suppliers: bags per tier. Buyers: eggs per grade. */
    stock: Record<string, number>;
    struggling: boolean;
  };
  market: {
    multiplier: number;
    prices: Record<EggGrade, number>;
    supplyYesterday: number;
    history: MarketDay[];
    crash: boolean;
    auctionHens: number;
  };
  /** Rival farms only: their own farm. */
  own: {
    hens: number;
    capacity: number;
    freePlots: number;
    crate: EggStock;
    feedGrams: FeedStock;
    feedTier: FeedTier;
    unlocks: UnlockId[];
  } | null;
  farms: FarmBrief[];
}

const grade = z.enum(EGG_GRADES);
const tier = z.enum(FEED_TIERS);
const qty = z.number().int().min(1).max(200);
const share = z.number().min(0.2).max(3);
const line = z.string().max(160);

export const farmActionSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('buyHens'), count: z.number().int().min(1).max(20) }),
  z.strictObject({ t: z.literal('buyFeed'), tier, bags: z.number().int().min(1).max(10) }),
  z.strictObject({ t: z.literal('setFeedTier'), tier }),
  z.strictObject({ t: z.literal('buildCoop'), kind: z.enum(COOP_KINDS).exclude(['starter']) }),
  z.strictObject({ t: z.literal('buyUnlock'), unlock: z.enum(UNLOCK_IDS) }),
  z.strictObject({
    t: z.literal('sell'),
    items: z.strictObject({
      white: z.number().int().min(0),
      cream: z.number().int().min(0),
      brown: z.number().int().min(0),
      golden: z.number().int().min(0),
    }),
  }),
]);
export type FarmAction = z.infer<typeof farmActionSchema>;

export const offerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('bulk-order'), farmId: z.string(), qty, priceShare: share, line }),
  z.strictObject({ kind: z.literal('premium-order'), farmId: z.string(), grade: z.enum(['brown', 'golden']), qty, priceShare: share, line }),
  z.strictObject({
    kind: z.literal('standing-contract'),
    farmId: z.string(),
    qtyPerDay: z.number().int().min(1).max(30),
    days: z.number().int().min(2).max(14),
    priceShare: share,
    line,
  }),
  z.strictObject({ kind: z.literal('feed-deal'), farmId: z.string(), tier, bags: z.number().int().min(1).max(10), priceShare: share, line }),
  z.strictObject({ kind: z.literal('credit-terms'), farmId: z.string(), tier, bags: z.number().int().min(1).max(10), priceShare: share, line }),
  z.strictObject({ kind: z.literal('undercut'), farmId: z.string(), grade, qty, priceShare: share, line }),
  z.strictObject({ kind: z.literal('buyout-offer'), farmId: z.string(), hens: z.number().int().min(1).max(10), priceShare: share, line }),
  z.strictObject({ kind: z.literal('glut-warning'), farmId: z.string(), line }),
]);
export type Offer = z.infer<typeof offerSchema>;

export const decisionSchema = z.strictObject({
  /** One short sentence of reasoning, logged with the decision. */
  note: z.string().max(240),
  farmActions: z.array(farmActionSchema).max(6),
  sellOrders: z.array(z.strictObject({ grade, qty, priceShare: share })).max(4),
  buyOrders: z.array(z.strictObject({ grade, qty, priceShare: share })).max(4),
  offers: z.array(offerSchema).max(8),
  fills: z.array(z.strictObject({ orderId: z.string(), qty })).max(8),
  restock: z.strictObject({ cheap: z.number().int().min(0).max(200), standard: z.number().int().min(0).max(200), premium: z.number().int().min(0).max(200) }),
  /** Suppliers: list price as a multiple of the base bag price. */
  markup: z.number().min(0.8).max(1.6),
});
export type Decision = z.infer<typeof decisionSchema>;

export const emptyDecision = (note = ''): Decision => ({
  note,
  farmActions: [],
  sellOrders: [],
  buyOrders: [],
  offers: [],
  fills: [],
  restock: { cheap: 0, standard: 0, premium: 0 },
  markup: 1,
});

/** JSON Schema handed to the model as its structured output format. */
export const decisionJsonSchema = (): Record<string, unknown> => z.toJSONSchema(decisionSchema) as Record<string, unknown>;

/** Parses a model reply; returns null when it does not match the schema. */
export function parseDecision(reply: string): Decision | null {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = decisionSchema.safeParse(JSON.parse(match[0]));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
