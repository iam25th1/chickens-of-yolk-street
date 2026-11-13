// What an agent sees and what it may decide. The same Decision shape comes from the rule policy or
// from NEAR AI Cloud (as structured JSON output validated here); the game then bounds every number
// and applies it through the same validated actions players use.
import { z } from 'zod';
import {
  COOP_KINDS,
  ECONOMY,
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
    /** The entrant registry entry of an AI farm that entered later; null for the base cast. */
    entrant: string | null;
    /** Its own latest weekly reflection: what went well or badly, and what it said it would change. */
    reflection: string | null;
    /** The public one-line reasons it gave on its last few decisions, newest last. */
    reasons: string[];
  };
  market: {
    multiplier: number;
    prices: Record<EggGrade, number>;
    /** Demand: the daily supply at which the multiplier is 1.00 (grows with active farms). */
    reference: number;
    supplyYesterday: number;
    history: MarketDay[];
    crash: boolean;
    auctionHens: number;
    /**
     * The last three closed days, oldest first: supply over demand (above 1 a glut, below 1
     * scarcity), and how far the multiplier moved per day across them.
     */
    trend: { supplyOverDemand: number[]; slope: number };
    /** Farms and agents that went bust in the last five days. */
    busts: { name: string; ai: boolean; day: number }[];
    /** Open AI farms (rival agents) and open player farms. */
    open: { aiFarms: number; playerFarms: number };
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
    /** Feed credit still owed to suppliers, in coins. */
    owes: number;
  } | null;
  farms: FarmBrief[];
}

/** An agent's own numbers over the week it reflects on. */
export interface WeekNumbers {
  fromDay: number;
  toDay: number;
  cashStart: number;
  cashNow: number;
  /** Deals and refusals with farms over the week. */
  deals: number;
  refusals: number;
  /** Other farms and agents that went bust during the week. */
  bustsSeen: number;
  multiplierLow: number;
  multiplierHigh: number;
  /** Days the market closed at or below the crash line. */
  glutDays: number;
}

/** A hard day: the market crashed or is glutting, or the agent's cash is under its struggle line. */
export const hardDay = (c: AgentContext): boolean =>
  c.market.crash || c.market.multiplier <= ECONOMY.market.crashAt || c.market.supplyYesterday > c.market.reference * 1.1 || c.agent.struggling;

const grade = z.enum(EGG_GRADES);
const tier = z.enum(FEED_TIERS);
const qty = z.number().int().min(1).max(200);
const share = z.number().min(0.2).max(3);
const line = z.string().max(160);

export const farmActionSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('buyHens'), count: z.number().int().min(1).max(20) }),
  z.strictObject({ t: z.literal('buyFeed'), tier, bags: z.number().int().min(1).max(10) }),
  // feed now from the Loyalist, paid with interest when it falls due; an agent cannot default
  z.strictObject({ t: z.literal('buyFeedOnCredit'), tier, bags: z.number().int().min(1).max(10) }),
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

/** Longest public reason, in characters. */
export const REASON_MAX = 80;

export const decisionSchema = z.strictObject({
  /** One short sentence of reasoning, logged with the decision. */
  note: z.string().max(240),
  /** One public line, in character, shown to players on the market board. */
  reason: z.string().max(REASON_MAX),
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

export const emptyDecision = (note = '', reason = ''): Decision => ({
  note,
  reason,
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

/** Control characters (C0, DEL and C1) never reach a player. */
const CONTROL = (code: number): boolean => code < 32 || (code >= 127 && code < 160);
/** The en and em dash, which the game's text never uses: they become commas. */
const DASHES = [String.fromCharCode(0x2013), String.fromCharCode(0x2014)];

/**
 * Text for players and logs: no control characters, one line, long dashes as commas, and cut to at
 * most `max` UTF-16 units without splitting a character in two.
 */
export function cleanText(s: string, max: number): string {
  const flat = Array.from(s, (ch) => (CONTROL(ch.codePointAt(0) ?? 0) ? ' ' : DASHES.includes(ch) ? ', ' : ch))
    .join('')
    .replace(/\s+,/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  let out = '';
  for (const ch of flat) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out.trimEnd();
}

/** Free text in a raw decision, cleaned and cut to the schema's lengths before it is checked. */
function cleanStrings(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (typeof r.note === 'string') r.note = cleanText(r.note, 240);
  if (typeof r.reason === 'string') r.reason = cleanText(r.reason, REASON_MAX);
  if (Array.isArray(r.offers)) {
    r.offers = r.offers.map((o: unknown) =>
      o && typeof o === 'object' && typeof (o as { line?: unknown }).line === 'string' ? { ...o, line: cleanText((o as { line: string }).line, 160) } : o,
    );
  }
  return r;
}

/** The JSON object in a model reply (it may come fenced or with words around it), or null. */
function jsonIn(reply: string): unknown {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as unknown;
  } catch {
    return null;
  }
}

/** Parses a model reply against the schema alone; returns null when it does not match. */
export function parseDecision(reply: string): Decision | null {
  const parsed = decisionSchema.safeParse(cleanStrings(jsonIn(reply)));
  return parsed.success ? parsed.data : null;
}

/** The offers each role may make; anything else in a decision is dropped. */
const OFFERS_BY_ROLE: Record<AgentRole, readonly Offer['kind'][]> = {
  rival: ['undercut', 'buyout-offer'],
  supplier: ['feed-deal', 'credit-terms'],
  buyer: ['bulk-order', 'premium-order', 'standing-contract', 'glut-warning'],
};

/**
 * The one check every decision passes, from the model or the rules: the schema (strings cleaned and
 * cut first), then the agent's own view of the world. Only its role's parts are kept; offers go to
 * player farms it can see, fills only to sell orders it can see (no more than they hold),
 * and a rival sells no more eggs than it saw in its crate. Returns null when the schema does not match.
 */
export function validateDecision(raw: unknown, c: AgentContext, onDrop: (what: string) => void = () => undefined): Decision | null {
  const parsed = decisionSchema.safeParse(cleanStrings(typeof raw === 'string' ? jsonIn(raw) : raw));
  if (!parsed.success) return null;
  const d = parsed.data;
  const role = c.agent.role;
  const out = emptyDecision(d.note, d.reason);

  const crate = c.own?.crate;
  if (role === 'rival' && crate) {
    for (const a of d.farmActions) {
      if (a.t !== 'sell') {
        out.farmActions.push(a);
        continue;
      }
      const items = { white: Math.min(a.items.white, crate.white), cream: Math.min(a.items.cream, crate.cream), brown: Math.min(a.items.brown, crate.brown), golden: Math.min(a.items.golden, crate.golden) };
      if (items.white + items.cream + items.brown + items.golden > 0) out.farmActions.push({ t: 'sell', items });
      else onDrop('an empty sale');
    }
    // sell orders go up after the close, for the eggs collected then: the game bounds them by the crate at that time
    out.sellOrders = d.sellOrders;
  } else if (d.farmActions.length + d.sellOrders.length > 0) onDrop('farm actions without a farm');

  if (role === 'buyer') {
    out.buyOrders = d.buyOrders;
    const visible = new Map(c.farms.flatMap((f) => f.sells.map((o) => [o.orderId, o.qty] as const)));
    for (const f of d.fills) {
      const left = visible.get(f.orderId);
      if (left === undefined || left <= 0) {
        onDrop(`a fill of unknown order ${f.orderId.slice(0, 40)}`);
        continue;
      }
      const q = Math.min(f.qty, left);
      out.fills.push({ orderId: f.orderId, qty: q });
      visible.set(f.orderId, left - q);
    }
  } else if (d.buyOrders.length + d.fills.length > 0) onDrop('buy orders or fills from a non-buyer');

  if (role === 'supplier') {
    out.restock = d.restock;
    out.markup = d.markup;
  }

  // a farm takes one card a day from each agent (the first offer to it): the cards decide which
  const players = new Set(c.farms.filter((f) => f.owner === 'player').map((f) => f.farmId));
  for (const o of d.offers) {
    if (!OFFERS_BY_ROLE[role].includes(o.kind)) onDrop(`a ${o.kind} offer outside its role`);
    else if (!players.has(o.farmId)) onDrop(`an offer to unknown farm ${o.farmId.slice(0, 40)}`);
    else out.offers.push(o);
  }
  return out;
}
