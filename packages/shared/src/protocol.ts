// WebSocket protocol between client and server. The server is authoritative: no client message
// carries a balance or an outcome. The only prices a client sends are proposals (a haggle ask, a
// limit order), which the server bounds, and which an agent or a counterparty must accept.
// Schemas are strict, so unknown fields are rejected.
import { z } from 'zod';
import { COOP_KINDS, ECONOMY, EGG_GRADES, FEED_TIERS, UNLOCK_IDS } from './economy';
import type { BodyColour, CoopKind, EggGrade, FeedTier, UnlockId } from './economy';
import type { AgentKind, AgentRole, CardKind } from './market';

export const PROTOCOL_VERSION = 2;

const rid = z.string().min(1).max(40);
const id = z.string().min(1).max(64);
const coins = z.number().finite().positive().max(1_000_000);

export const CARD_CHOICES = ['accept', 'decline', 'counter', 'switchSupplier', 'matchPrice', 'sellNow', 'hold', 'sellHens'] as const;
export type CardChoice = (typeof CARD_CHOICES)[number];

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), v: z.literal(PROTOCOL_VERSION), session: z.string().min(1).max(2048) }).strict(),
  z.object({ t: z.literal('ping'), n: z.number().int().nonnegative() }).strict(),
  z
    .object({ t: z.literal('buyHens'), rid, count: z.number().int().min(1).max(ECONOMY.limits.maxHensPerPurchase) })
    .strict(),
  z.object({ t: z.literal('buyHen'), rid, henId: id }).strict(),
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
  /** Answer a decision card. `ask` (coins per unit) only with counter: a proposal the agent may refuse. */
  z.object({ t: z.literal('respondCard'), rid, cardId: id, choice: z.enum(CARD_CHOICES), ask: coins.optional() }).strict(),
  z.object({ t: z.literal('deliverContract'), rid, contractId: id }).strict(),
  /** Limit sell: rests in the order book at the player's price until someone buys or it expires. */
  z
    .object({ t: z.literal('placeOrder'), rid, grade: z.enum(EGG_GRADES), qty: z.number().int().min(1).max(1000), price: coins })
    .strict(),
  z.object({ t: z.literal('cancelOrder'), rid, orderId: id }).strict(),
  /** Trade against a resting order: sell into a buy order, or buy another player's eggs. */
  z.object({ t: z.literal('fillOrder'), rid, orderId: id, qty: z.number().int().min(1).max(1000) }).strict(),
  z
    .object({ t: z.literal('setClerkFloor'), rid, floor: z.number().min(ECONOMY.clerk.minFloor).max(ECONOMY.clerk.maxFloor) })
    .strict(),
  z.object({ t: z.literal('setSupplier'), rid, supplier: z.enum(['squeezer', 'loyalist']) }).strict(),
  z.object({ t: z.literal('getLedger'), rid }).strict(),
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

/** A hen in the shop: fresh from the breeder or from a bust farm's auction. */
export interface ShopHenView extends HenView {
  source: 'breeder' | 'auction';
  priceMilli: number;
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

export type CardStatus = 'open' | 'accepted' | 'declined' | 'expired' | 'won' | 'failed';

export interface CardView {
  id: string;
  kind: CardKind;
  agentKind: AgentKind | null;
  from: string;
  day: number;
  arriveAtMs: number;
  status: CardStatus;
  /** Haggle rounds used so far. */
  round: number;
  /** The counterparty's current price per unit (egg, bag or hen), in milli-coins. */
  offerMilli: number;
  qty: number;
  grade: EggGrade | 'any' | null;
  tier: FeedTier | null;
  /** Contract length or credit term, in days. */
  days: number | null;
  /** What the agent says (typed out in the overlay). */
  line: string;
  choices: CardChoice[];
}

export interface ContractView {
  id: string;
  agentName: string;
  grade: EggGrade | 'any';
  qtyPerDay: number;
  priceMilli: number;
  daysLeft: number;
  deliveredToday: boolean;
  misses: number;
}

export interface DebtView {
  id: string;
  agentName: string;
  dueDay: number;
  dueMilli: number;
  status: 'open' | 'paid' | 'defaulted';
}

export interface OrderView {
  id: string;
  side: 'buy' | 'sell';
  owner: string;
  ownerKind: 'player' | 'agent';
  mine: boolean;
  grade: EggGrade;
  qty: number;
  priceMilli: number;
  expiresDay: number;
}

export interface TradeView {
  day: number;
  seller: string;
  buyer: string;
  grade: EggGrade;
  qty: number;
  priceMilli: number;
  totalMilli: number;
  via: 'street' | 'order' | 'card' | 'contract' | 'resale' | 'player';
}

export interface AgentView {
  id: string;
  kind: AgentKind;
  role: AgentRole;
  name: string;
  status: 'open' | 'bust';
  cashMilli: number;
  generation: number;
  /** Rival farms only. */
  hens: number | null;
  /** NEAR testnet sub-account that holds the agent's tokens, once created. */
  account: string | null;
}

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
  supplier: 'squeezer' | 'loyalist';
  /** The sales clerk accepts offers at or above this multiple of the live price. */
  clerkFloor: number;
  /** Today's cards that have arrived, open or answered. */
  cards: CardView[];
  contracts: ContractView[];
  debts: DebtView[];
  orders: OrderView[];
  shop: ShopHenView[];
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

export interface RivalRank {
  name: string;
  kind: 'player' | AgentKind;
  hens: number;
  cashMilli: number;
  bust: boolean;
}

export interface MarketState {
  day: number;
  /** Live multiplier for today, set by yesterday's total supply. */
  multiplier: number;
  /** Price of one egg per grade in milli-coins at the live multiplier, before farm bonuses. */
  pricesMilli: Record<EggGrade, number>;
  supplyToday: number;
  /** Today's demand: the supply at which tomorrow's multiplier would be 1.00. Grows with active farms. */
  reference: number;
  crash: boolean;
  history: MarketDay[];
  farms: { players: number; agents: number; bust: number };
  settlement: Settlement | null;
  agents: AgentView[];
  /** Open orders, best first. */
  book: OrderView[];
  /** Recent big trades, newest first. */
  trades: TradeView[];
  ranking: RivalRank[];
  /** Testnet explorer base for receipts, or null when settlement is off. */
  explorer: string | null;
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
  delivered: number;
  missed: number;
}

export interface LedgerDay {
  day: number;
  incomeMilli: number;
  costMilli: number;
  netMilli: number;
  byKind: Record<string, number>;
  settlement: Settlement | null;
}

export type CardOutcome = 'accepted' | 'declined' | 'won' | 'failed' | 'expired';

export type GameEvent =
  | { kind: 'hensBought'; count: number; fromAuction: number; costMilli: number }
  | { kind: 'feedBought'; tier: FeedTier; bags: number; costMilli: number; supplier: string }
  | { kind: 'coopBuilt'; coopId: string; coopKind: CoopKind; plot: number; costMilli: number }
  | { kind: 'coopUpgraded'; coopId: string; coopKind: CoopKind; costMilli: number }
  | { kind: 'unlockBought'; unlock: UnlockId; costMilli: number }
  | { kind: 'sold'; items: EggStock; totalMilli: number; multiplier: number }
  | { kind: 'collected'; eggId: string; grade: EggGrade }
  | { kind: 'dayEnded'; summary: DaySummary }
  | { kind: 'rivalBust'; name: string; agentKind: AgentKind; hens: number }
  | { kind: 'agentOpened'; name: string; agentKind: AgentKind }
  | { kind: 'cardArrived'; card: CardView }
  | { kind: 'haggle'; card: CardView; mood: 'warm' | 'firm' | 'cross' }
  | { kind: 'cardResolved'; card: CardView; outcome: CardOutcome; totalMilli: number; auto: boolean }
  | { kind: 'contractDelivered'; contractId: string; qty: number; totalMilli: number; auto: boolean }
  | { kind: 'contractMissed'; contractId: string; penaltyMilli: number }
  | { kind: 'debtCharged'; debtId: string; paidMilli: number; defaulted: boolean }
  | { kind: 'orderFilled'; orderId: string; side: 'buy' | 'sell'; qty: number; priceMilli: number; counterparty: string }
  | { kind: 'bigTrade'; trade: TradeView };

export type ServerMessage =
  | { t: 'welcome'; v: number; playerId: string; name: string; farm: FarmState; market: MarketState; clock: ClockState }
  | { t: 'farm'; farm: FarmState }
  | { t: 'market'; market: MarketState }
  | { t: 'clock'; clock: ClockState }
  | { t: 'event'; event: GameEvent }
  | { t: 'ledger'; days: LedgerDay[] }
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
