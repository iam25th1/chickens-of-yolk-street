// Agent pricing formulas. Pure functions over ECONOMY, shared by server rules, tests and the UI.
import { ECONOMY, eggPrice, type EggGrade, type FeedTier } from './economy';

export const AGENT_KINDS = ['upstart', 'old-money', 'squeezer', 'loyalist', 'bakery', 'trader', 'wholesaler'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export type AgentRole = 'rival' | 'supplier' | 'buyer';

export const AGENT_ROLE: Record<AgentKind, AgentRole> = {
  upstart: 'rival',
  'old-money': 'rival',
  squeezer: 'supplier',
  loyalist: 'supplier',
  bakery: 'buyer',
  trader: 'buyer',
  wholesaler: 'buyer',
};

export const CARD_KINDS = [
  'bulk-order',
  'premium-order',
  'standing-contract',
  'feed-deal',
  'credit-terms',
  'undercut',
  'buyout-offer',
  'glut-warning',
  'player-trade',
] as const;
export type CardKind = (typeof CARD_KINDS)[number];

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * How desperate a farm looks to a supplier, 0 (comfortable) to 1 (out of feed and cash).
 * Days of feed left weigh most; low cash adds to it.
 */
export function desperation(feedDays: number, cash: number): number {
  const feed = clamp(1 - feedDays / 5, 0, 1);
  const money = clamp(1 - cash / 60, 0, 1);
  return clamp(feed * 0.75 + money * 0.35, 0, 1);
}

/** The Squeezer prices a farm's desperation into every bag. */
export function squeezerBagPrice(tier: FeedTier, desperate: number): number {
  const s = ECONOMY.suppliers.squeezer;
  return ECONOMY.feed.tiers[tier].bagPrice * (s.baseMarkup + s.desperationMarkup * clamp(desperate, 0, 1));
}

/** The Loyalist takes a little off for every past deal with the same farm. */
export function loyalistBagPrice(tier: FeedTier, pastDeals: number): number {
  const l = ECONOMY.suppliers.loyalist;
  return ECONOMY.feed.tiers[tier].bagPrice * (l.baseMarkup - Math.min(l.maxDiscount, l.discountPerDeal * Math.max(0, pastDeals)));
}

/** What a feed credit costs when it falls due. */
export const creditDue = (principal: number): number => principal * (1 + ECONOMY.suppliers.loyalist.creditInterest);

/** The bakery's contract price per egg at today's market. */
export const bakeryPrice = (multiplier: number): number =>
  eggPrice('white', multiplier, []) * ECONOMY.buyers.bakery.priceShare;

/** The trader pays a premium for brown and golden, capped below what it can resell them for. */
export function traderPrice(grade: 'brown' | 'golden', multiplier: number): number {
  const t = ECONOMY.buyers.trader;
  return Math.min(eggPrice(grade, multiplier, []) * t.premium, t.resale[grade] * 0.92);
}

/** The wholesaler buys anything cheap. */
export const wholesalePrice = (grade: EggGrade, multiplier: number): number =>
  eggPrice(grade, multiplier, []) * ECONOMY.buyers.wholesaler.priceShare;

/** Whether a limit price sits inside the allowed band around the live price. */
export function limitPriceOk(grade: EggGrade, priceCoins: number, multiplier: number): boolean {
  const live = eggPrice(grade, multiplier, []);
  return priceCoins >= live * ECONOMY.orders.minPriceShare && priceCoins <= live * ECONOMY.orders.maxPriceShare;
}
