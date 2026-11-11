// The seven agents of Yolk Street. Each has a role, a personality that sets how it haggles, and the
// art and voice the client plays when it speaks. When one goes bust, a successor of the same role
// opens a few days later under the next name in its list.
import { AGENT_ROLE, type AgentKind, type AgentRole, type CardKind, type CoopKind, type FeedTier } from '@coys/shared';

export interface Personality {
  /** Share of the gap to its walk-away price an agent gives up per haggle round (0 to 1). */
  concession: number;
  /** Above 0.5 an agent walks away from an insulting ask instead of countering. */
  pride: number;
  /** How far its walk-away price sits from its opening offer. */
  flex: number;
}

export interface CastMember {
  kind: AgentKind;
  role: AgentRole;
  names: string[];
  personality: Personality;
  portrait: string;
  voice: string;
  /** Rival farms start with a farm; others start with cash and stock. */
  farm?: { cash: number; hens: number; coops: CoopKind[]; feed: { tier: FeedTier; kg: number } };
  sign?: string;
}

export const CAST: Record<AgentKind, CastMember> = {
  upstart: {
    kind: 'upstart',
    role: AGENT_ROLE.upstart,
    names: ['Upstart Eggs', 'Hatch and Dash', 'Sunny Side Startup', 'Scramble Co.'],
    personality: { concession: 0.55, pride: 0.2, flex: 0.12 },
    portrait: '04-upstart',
    voice: '40-upstart',
    farm: { cash: 60, hens: 24, coops: ['red'], feed: { tier: 'cheap', kg: 50 } },
    sign: '17-sign-upstart',
  },
  'old-money': {
    kind: 'old-money',
    role: AGENT_ROLE['old-money'],
    names: ['Old Money Farms', 'Heritage Hens Ltd.', 'Coopersmith and Sons'],
    personality: { concession: 0.3, pride: 0.9, flex: 0.08 },
    portrait: '05-old-money',
    voice: '40-old-money',
    farm: { cash: 400, hens: 130, coops: ['deluxe', 'red', 'starter'], feed: { tier: 'premium', kg: 150 } },
    sign: '17-sign-old-money',
  },
  squeezer: {
    kind: 'squeezer',
    role: AGENT_ROLE.squeezer,
    names: ['The Squeezer', 'Pinch Feed Co.', 'Tight Grip Grain'],
    personality: { concession: 0.2, pride: 0.6, flex: 0.06 },
    portrait: '06-squeezer',
    voice: '40-squeezer',
  },
  loyalist: {
    kind: 'loyalist',
    role: AGENT_ROLE.loyalist,
    names: ['The Loyalist', 'Neighbourly Feed', 'Old Friend Mills'],
    personality: { concession: 0.6, pride: 0.1, flex: 0.1 },
    portrait: '07-loyalist',
    voice: '40-loyalist',
  },
  bakery: {
    kind: 'bakery',
    role: AGENT_ROLE.bakery,
    names: ['Yolk Street Bakery', 'Rise and Shine Bakes', 'The Crumb'],
    personality: { concession: 0.4, pride: 0.4, flex: 0.1 },
    portrait: '08-bakery-buyer',
    voice: '40-bakery-buyer',
  },
  trader: {
    kind: 'trader',
    role: AGENT_ROLE.trader,
    names: ['The Market Trader', 'Fine Shell Traders', 'Golden Basket'],
    personality: { concession: 0.35, pride: 0.5, flex: 0.1 },
    portrait: '09-market-trader',
    voice: '40-market-trader',
  },
  wholesaler: {
    kind: 'wholesaler',
    role: AGENT_ROLE.wholesaler,
    names: ['The Wholesaler', 'Bulk Barn', 'Crate and Freight'],
    personality: { concession: 0.25, pride: 0.3, flex: 0.06 },
    portrait: '10-wholesaler',
    voice: '40-wholesaler',
  },
};

export const nameFor = (kind: AgentKind, generation: number): string => {
  const names = CAST[kind].names;
  return names[(generation - 1) % names.length] ?? CAST[kind].names[0] ?? kind;
};

/** Walk-away price for an opening offer, from personality and what the agent remembers. */
export function reserveFor(
  kind: AgentKind,
  offer: number,
  side: 'agent_buys' | 'agent_sells',
  memory: { deals: number; hagglesWon: number; misses: number },
): number {
  const p = CAST[kind].personality;
  const flex = Math.max(0, p.flex + 0.015 * Math.min(memory.deals, 6) - 0.03 * Math.min(memory.hagglesWon, 4) - 0.05 * memory.misses);
  return side === 'agent_buys' ? offer * (1 + flex) : offer * (1 - flex);
}

type Vars = Record<string, string | number>;
const fill = (s: string, v: Vars): string => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ''));

const LINES: Partial<Record<AgentKind, Partial<Record<CardKind, string>>>> = {
  upstart: { undercut: "The trader wants browns. I'm selling at {price}. Match me or watch me take it." },
  'old-money': { 'buyout-offer': "Times are hard, I hear. I'll take {qty} hens at {price} apiece. A kindness, really." },
  squeezer: { 'feed-deal': 'Trough looking thin, friend. {qty} bags of {tier}, {price} a bag. Take it or leave it.' },
  loyalist: {
    'feed-deal': 'For a regular like you: {qty} bags of {tier} at {price} a bag.',
    'credit-terms': 'Short this week? Take {qty} bags now and pay {due} in {days} days.',
  },
  bakery: { 'standing-contract': 'Fresh bread needs fresh eggs. {qty} a day for {days} days, {price} each. Deal?' },
  trader: {
    'premium-order': 'Those {grade} eggs of yours. {qty} at {price} each, cash today.',
    'glut-warning': "The street's flooded. Prices drop tomorrow. Sell now or sit tight.",
  },
  wholesaler: {
    'bulk-order': "I'll take {qty} eggs off your hands. Any grade. {price} each.",
    'glut-warning': 'Everyone is selling. I would be quick, if I were you.',
  },
};

export function lineFor(kind: AgentKind | null, card: CardKind, v: Vars): string {
  if (card === 'player-trade') return fill('{seller} is selling {qty} {grade} at {price} each.', v);
  const template = (kind && LINES[kind]?.[card]) ?? 'Here is my offer: {qty} at {price}.';
  return fill(template, v);
}

const REPLIES: Record<'counter' | 'walk' | 'win' | 'insulted', Record<AgentKind, string>> = {
  counter: {
    upstart: '{price}! Final, final offer. Probably.',
    'old-money': '{price}. Do not test my patience.',
    squeezer: '{price}. And I am being generous.',
    loyalist: 'For you? {price}. Can not go lower than that.',
    bakery: '{price}. The ovens are waiting.',
    trader: '{price}. Quality costs, but so does time.',
    wholesaler: '{price}. Volume is my margin.',
  },
  walk: {
    upstart: 'Forget it. I will find eggs elsewhere.',
    'old-money': 'We are done here.',
    squeezer: 'Your loss. Someone else will be hungrier.',
    loyalist: 'Maybe next week, then.',
    bakery: 'The bread will not bake itself. Goodbye.',
    trader: 'Not worth my stall space.',
    wholesaler: 'Pass.',
  },
  win: {
    upstart: 'Ugh, fine. Deal!',
    'old-money': 'Very well. You drive a hard bargain.',
    squeezer: 'Hmph. Deal. Do not get used to it.',
    loyalist: 'Done, friend.',
    bakery: 'Deal. See you at dawn.',
    trader: 'Agreed. Bring your best.',
    wholesaler: 'Fine. Loading the cart.',
  },
  insulted: {
    upstart: 'Ha! No.',
    'old-money': 'How dare you.',
    squeezer: 'Are you joking? Out.',
    loyalist: 'That hurts, friend.',
    bakery: 'That is not a price, that is a prank.',
    trader: 'Insulting.',
    wholesaler: 'Not even close.',
  },
};

export const replyFor = (kind: AgentKind, mood: keyof typeof REPLIES, v: Vars): string => fill(REPLIES[mood][kind], v);
