// The seven agents of Yolk Street. Each has a role, a personality that sets how it haggles, a persona
// the model plays (goals, temperament, how it talks, what it never does), and the art and voice the
// client plays when it speaks. When one goes bust, a successor of the same role opens a few days
// later under the next name in its list. AI farms that enter later are in entrants.ts.
import { AGENT_ROLE, type AgentKind, type AgentRole, type CardKind, type CoopKind, type FeedTier } from '@coys/shared';
import { entrantByKey } from './entrants';

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
  /** A few sentences for the model's system prompt; in-game lines stay in this character. */
  persona: string;
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
    persona:
      'A young, loud, hungry egg farm. Goal: grow fast and beat Old Money. Optimistic and impatient; on a good week it borrows feed on credit and packs its coops. Talks fast and cocky, with big promises. Never holds eggs back for a better price and never admits a mistake for long.',
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
    persona:
      "An old, rich family egg farm. Goal: stay on top and outlast every upstart. Patient, proud and cold; it holds eggs back in a slump, keeps a cash cushion and buys bust farms' hens cheap. Talks in clipped, condescending, well-mannered sentences. Never panics, never borrows.",
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
    persona:
      "A feed supplier who profits from need. Goal: the best margin on every bag. Shrewd and unsentimental; it prices a farm's desperation into each bag and raises its list price when the street runs low. Talks curt and blunt, with a sneer. Never gives credit, never discounts for loyalty.",
    portrait: '06-squeezer',
    voice: '40-squeezer',
  },
  loyalist: {
    kind: 'loyalist',
    role: AGENT_ROLE.loyalist,
    names: ['The Loyalist', 'Neighbourly Feed', 'Old Friend Mills'],
    personality: { concession: 0.6, pride: 0.1, flex: 0.1 },
    persona:
      'A neighbourly feed supplier. Goal: keep its regulars fed and coming back. Warm, patient and forgiving; it takes a little off for every past deal and gives short credit to good farms that are short of cash. Calls players friend. Never gouges a desperate farm, never lends to one that missed a payment.',
    portrait: '07-loyalist',
    voice: '40-loyalist',
  },
  bakery: {
    kind: 'bakery',
    role: AGENT_ROLE.bakery,
    names: ['Yolk Street Bakery', 'Rise and Shine Bakes', 'The Crumb'],
    personality: { concession: 0.4, pride: 0.4, flex: 0.1 },
    persona:
      "The street's bakery. Goal: white and cream eggs for the ovens every dawn at a fair price. Practical and punctual, dislikes surprises; it prefers standing contracts with reliable farms. Talks warm and busy, about ovens and dough. Never chases golden eggs, never keeps a farm that missed deliveries.",
    portrait: '08-bakery-buyer',
    voice: '40-bakery-buyer',
  },
  trader: {
    kind: 'trader',
    role: AGENT_ROLE.trader,
    names: ['The Market Trader', 'Fine Shell Traders', 'Golden Basket'],
    personality: { concession: 0.35, pride: 0.5, flex: 0.1 },
    persona:
      'A market trader of fine eggs. Goal: buy brown and golden eggs and resell them in town at a profit. Discerning, quick and a little vain; it pays up for quality, walks away from farms that slip and warns of gluts. Talks sharp and knowing. Never pays more than it can resell for, never buys white eggs.',
    portrait: '09-market-trader',
    voice: '40-market-trader',
  },
  wholesaler: {
    kind: 'wholesaler',
    role: AGENT_ROLE.wholesaler,
    names: ['The Wholesaler', 'Bulk Barn', 'Crate and Freight'],
    personality: { concession: 0.25, pride: 0.3, flex: 0.06 },
    persona:
      'A bulk egg wholesaler. Goal: volume at a low price, resold the next day. Flat, patient and unhurried; it buys anything cheap and bids deeper when the street is flooded. Talks in few words: numbers and carts. Never pays above the market and never haggles for long.',
    portrait: '10-wholesaler',
    voice: '40-wholesaler',
  },
};

export const nameFor = (kind: AgentKind, generation: number): string => {
  const names = CAST[kind].names;
  return names[(generation - 1) % names.length] ?? CAST[kind].names[0] ?? kind;
};

/** An agent's haggling personality: its own as an entering AI farm, else its kind's. */
export const personalityFor = (kind: AgentKind, entrant: string | null): Personality => entrantByKey(entrant)?.personality ?? CAST[kind].personality;

/** An agent's persona for the model: its own as an entering AI farm, else its kind's. */
export const personaFor = (kind: AgentKind, entrant: string | null): string => entrantByKey(entrant)?.persona ?? CAST[kind].persona;

/** Walk-away price for an opening offer, from personality and what the agent remembers. */
export function reserveFor(
  kind: AgentKind,
  offer: number,
  side: 'agent_buys' | 'agent_sells',
  memory: { deals: number; hagglesWon: number; misses: number },
  personality: Personality = CAST[kind].personality,
): number {
  const p = personality;
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

const BROKE: Record<AgentKind, string> = {
  upstart: 'Lying low today. Back tomorrow, bigger!',
  'old-money': 'Not receiving visitors today.',
  squeezer: 'Shop shut. Come back with coin.',
  loyalist: 'Taking a quiet day, friend.',
  bakery: 'Ovens are cold today. Tight week.',
  trader: 'Stall closed today. Counting coins.',
  wholesaler: 'Cart stays home today.',
};

/** The public reason of an agent too broke to pay for a decision today (it sits the day out). */
export const brokeLine = (kind: AgentKind): string => BROKE[kind];
