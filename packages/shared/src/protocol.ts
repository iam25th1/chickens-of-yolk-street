// WebSocket protocol between client and server. The server is authoritative: no client message
// carries a price, a balance or an outcome. Schemas are strict, so unknown fields are rejected.
import { z } from 'zod';
import { COOP_KINDS, ECONOMY, EGG_GRADES, FEED_TIERS, UNLOCK_IDS } from './economy';
import type { BodyColour, CoopKind, EggGrade, FeedTier, UnlockId } from './economy';

export const PROTOCOL_VERSION = 1;

const rid = z.string().min(1).max(40);
const id = z.string().min(1).max(64);

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), v: z.literal(PROTOCOL_VERSION), session: z.string().min(1).max(2048) }).strict(),
  z.object({ t: z.literal('ping'), n: z.number().int().nonnegative() }).strict(),
  z
    .object({ t: z.literal('buyHens'), rid, count: z.number().int().min(1).max(ECONOMY.limits.maxHensPerPurchase) })
    .strict(),
  z
    .object({
      t: z.literal('buyFeed'),
      rid,
      tier: z.enum(FEED_TIERS),
      bags: z.number().int().min(1).max(ECONOMY.limits.maxBagsPerPurchase),
    })
    .strict(),
  z.object({ t: z.literal('setFeedTier'), rid, tier: z.enum(FEED_TIERS) }).strict(),
  z.object({ t: z.literal('buildCoop'), rid, kind: z.enum(COOP_KINDS).exclude(['starter']) }).strict(),
  z.object({ t: z.literal('upgradeCoop'), rid, coopId: id }).strict(),
  z.object({ t: z.literal('buyUnlock'), rid, unlock: z.enum(UNLOCK_IDS) }).strict(),
  z
    .object({
      t: z.literal('sell'),
      rid,
      items: z
        .object(Object.fromEntries(EGG_GRADES.map((g) => [g, z.number().int().min(0).max(100_000).optional()])))
        .strict(),
    })
    .strict(),
  z.object({ t: z.literal('collect'), rid, eggId: id }).strict(),
  z
    .object({ t: z.literal('linkWallet'), rid, accountId: z.string().regex(/^([0-9a-f]{64}|[a-z0-9_-]{2,48}\.testnet)$/) })
    .strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ActionMessage = Exclude<ClientMessage, { t: 'hello' } | { t: 'ping' }>;

export function parseClientMessage(raw: unknown): { ok: true; msg: ClientMessage } | { ok: false; error: string } {
  const result = clientMessageSchema.safeParse(raw);
  if (result.success) return { ok: true, msg: result.data };
  const issue = result.error.issues[0];
  return { ok: false, error: issue ? `${issue.path.join('.') || 'message'}: ${issue.message}` : 'invalid message' };
}

// ---- server to client ------------------------------------------------------------------------

export interface HenView {
  id: string;
  body: BodyColour;
  eyes: 'default' | 'sleepy' | 'wild';
  comb: 'default' | 'spiky' | 'mohawk' | 'nub';
  accessory: 'none' | 'tophat' | 'bowtie' | 'shades';
  layingTrait: number;
  ageDays: number;
}

export interface CoopView {
  id: string;
  kind: CoopKind;
  plot: number;
}

export interface LaidEgg {
  id: string;
  henId: string;
  /** Milliseconds after the start of the day. */
  atMs: number;
  grade: EggGrade;
  broken: boolean;
  collected: boolean;
}

export type EggStock = Record<EggGrade, number>;
export type FeedStock = Record<FeedTier, number>;

export interface FarmState {
  farmId: string;
  name: string;
  cashMilli: number;
  feedTier: FeedTier;
  /** Feed in grams per tier. */
  feedGrams: FeedStock;
  /** Feed laying multiplier the hens got today (0 when the trough was empty at dawn). */
  fedToday: number;
  hens: HenView[];
  coops: CoopView[];
  crate: EggStock;
  unlocks: UnlockId[];
  /** Today's lay plan for this farm, revealed to the owner so hens animate on time. */
  layPlan: LaidEgg[];
  bust: boolean;
}

export interface ClockState {
  day: number;
  dayStartedAt: number;
  dayLengthMs: number;
  serverNow: number;
}

export interface MarketDay {
  day: number;
  supply: number;
  multiplier: number;
}

export interface Settlement {
  day: number;
  status: 'pending' | 'sent' | 'noop' | 'failed';
  txHash: string | null;
}

export interface MarketState {
  day: number;
  /** Live multiplier for today, set by yesterday's total supply. */
  multiplier: number;
  /** Price of one egg per grade in milli-coins at the live multiplier, before farm bonuses. */
  pricesMilli: Record<EggGrade, number>;
  supplyToday: number;
  crash: boolean;
  history: MarketDay[];
  farms: { players: number; agents: number; bust: number };
  settlement: Settlement | null;
}

export interface DaySummary {
  day: number;
  laid: number;
  broken: number;
  autoCollected: number;
  feedGramsUsed: number;
  fedMultiplier: number;
  closingSupply: number;
  nextMultiplier: number;
}

export type GameEvent =
  | { kind: 'hensBought'; count: number; fromAuction: number; costMilli: number }
  | { kind: 'feedBought'; tier: FeedTier; bags: number; costMilli: number }
  | { kind: 'coopBuilt'; coopId: string; coopKind: CoopKind; plot: number; costMilli: number }
  | { kind: 'coopUpgraded'; coopId: string; coopKind: CoopKind; costMilli: number }
  | { kind: 'unlockBought'; unlock: UnlockId; costMilli: number }
  | { kind: 'sold'; items: EggStock; totalMilli: number; multiplier: number }
  | { kind: 'collected'; eggId: string; grade: EggGrade }
  | { kind: 'dayEnded'; summary: DaySummary }
  | { kind: 'rivalBust'; name: string; hens: number };

export type ServerMessage =
  | { t: 'welcome'; v: number; playerId: string; name: string; farm: FarmState; market: MarketState; clock: ClockState }
  | { t: 'farm'; farm: FarmState }
  | { t: 'market'; market: MarketState }
  | { t: 'clock'; clock: ClockState }
  | { t: 'event'; event: GameEvent }
  | { t: 'ack'; rid: string; ok: true; duplicate?: boolean }
  | { t: 'ack'; rid: string; ok: false; code: ErrorCode; message: string }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong'; n: number; serverNow: number };

export type ErrorCode =
  | 'bad_message'
  | 'unauthenticated'
  | 'rate_limited'
  | 'insufficient_funds'
  | 'insufficient_stock'
  | 'invalid_action'
  | 'not_found'
  | 'farm_bust'
  | 'server_error';

export const emptyEggStock = (): EggStock => ({ white: 0, cream: 0, brown: 0, golden: 0 });
export const emptyFeedStock = (): FeedStock => ({ cheap: 0, standard: 0, premium: 0 });
