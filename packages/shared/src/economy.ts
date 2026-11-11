// Every number in the game economy lives in ECONOMY. Server, client and tests read it from here;
// nothing else in the codebase may hard-code a price, rate or threshold.

export const FEED_TIERS = ['cheap', 'standard', 'premium'] as const;
export type FeedTier = (typeof FEED_TIERS)[number];

export const EGG_GRADES = ['white', 'cream', 'brown', 'golden'] as const;
export type EggGrade = (typeof EGG_GRADES)[number];

export const COOP_KINDS = ['starter', 'red', 'deluxe'] as const;
export type CoopKind = (typeof COOP_KINDS)[number];

export const UNLOCK_IDS = ['conveyor', 'grader', 'cart', 'hopper', 'clerk'] as const;
export type UnlockId = (typeof UNLOCK_IDS)[number];

export const BODY_COLOURS = ['cream', 'brown', 'black'] as const;
export type BodyColour = (typeof BODY_COLOURS)[number];

export type GradeMix = Readonly<Record<EggGrade, number>>;

export const ECONOMY = {
  day: {
    /** One in-game day in real milliseconds. */
    lengthMs: 180_000,
    /** Hens lay between these fractions of the day. */
    layWindow: { start: 0.06, end: 0.7 },
    /** From this fraction of the day on it is night: hens sleep. */
    nightStart: 0.8,
  },
  hen: {
    price: 8,
    /** Eggs per hen per day before feed, trait, age and crowding. */
    baseLaying: 0.8,
    primeLifeDays: 120,
    /** Laying multiplier once a hen is past its prime laying life. */
    agedLayingFactor: 0.5,
    /** NFT laying trait multiplier range. */
    trait: { min: 0.85, max: 1.15 },
  },
  eggs: {
    breakage: 0.05,
    basePrice: { white: 1.0, cream: 1.2, brown: 1.5, golden: 6.0 } satisfies Record<EggGrade, number>,
  },
  feed: {
    bagKg: 25,
    kgPerHenPerDay: 0.12,
    tiers: {
      cheap: { bagPrice: 70, laying: 0.8, gradeMix: { white: 60, cream: 30, brown: 10, golden: 0 } },
      standard: { bagPrice: 100, laying: 1.0, gradeMix: { white: 40, cream: 35, brown: 24, golden: 1 } },
      premium: { bagPrice: 140, laying: 1.1, gradeMix: { white: 25, cream: 35, brown: 37, golden: 3 } },
    } satisfies Record<FeedTier, { bagPrice: number; laying: number; gradeMix: GradeMix }>,
  },
  coops: {
    kinds: {
      starter: { capacity: 12, price: 0 },
      red: { capacity: 30, price: 150 },
      deluxe: { capacity: 60, price: 450 },
    } satisfies Record<CoopKind, { capacity: number; price: number }>,
    /** Coop plots on one farm. */
    plots: 4,
  },
  crowding: {
    /** Laying lost for every 10% of hens over capacity. */
    lossPerTenPercentOver: 0.15,
    maxLoss: 0.9,
  },
  market: {
    /** Daily supply at which the price multiplier is exactly 1. */
    referenceSupply: 600,
    exponent: 0.8,
    minMultiplier: 0.4,
    maxMultiplier: 2.5,
    /** At or below this multiplier the market has crashed. */
    crashAt: 0.8,
    /** Multiplier for the very first day, before any supply exists. */
    openingMultiplier: 1.0,
  },
  agents: {
    inferenceCostPerDecision: 0.5,
    decisionsPerDay: 1,
    /** An agent whose cash falls below this is bust. */
    bustBelowCash: 0,
    /** Bust hens are auctioned at this fraction of the hen price. */
    auctionPriceFactor: 0.5,
  },
  start: {
    cash: 50,
    hens: 10,
    coop: 'starter' as CoopKind,
    /** Starter bag so day one can lay: 50 coins cannot buy a 70-coin bag. */
    feed: { tier: 'standard' as FeedTier, kg: 25 },
  },
  unlocks: {
    conveyor: { price: 40, breakage: 0.02 },
    grader: { price: 80, eggPriceBonus: 0.1 },
    cart: { price: 120 },
    hopper: { price: 100, feedCostDiscount: 0.1 },
    clerk: { price: 160, revenueBonus: 0.05 },
  } satisfies Record<UnlockId, { price: number; [effect: string]: number }>,
  limits: {
    maxHensPerPurchase: 20,
    maxBagsPerPurchase: 10,
  },
} as const;

export type Unlocks = ReadonlySet<UnlockId> | readonly UnlockId[];

const has = (unlocks: Unlocks, id: UnlockId): boolean =>
  Array.isArray(unlocks) ? unlocks.includes(id) : (unlocks as ReadonlySet<UnlockId>).has(id);

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Coins are kept server-side as integer thousandths so ledgers add up exactly. */
export const toMilli = (coins: number): number => Math.round(coins * 1000);
export const fromMilli = (milli: number): number => milli / 1000;

/** clamp((referenceSupply / supply) ^ exponent, min, max). No supply means the top of the range. */
export function marketMultiplier(totalDailySupply: number): number {
  const m = ECONOMY.market;
  if (totalDailySupply <= 0) return m.maxMultiplier;
  return clamp(Math.pow(m.referenceSupply / totalDailySupply, m.exponent), m.minMultiplier, m.maxMultiplier);
}

export const isCrash = (multiplier: number): boolean => multiplier <= ECONOMY.market.crashAt;

/** Laying multiplier from crowding: 15% lost per 10% over capacity, at most 90% lost. */
export function crowdingFactor(hens: number, capacity: number): number {
  const c = ECONOMY.crowding;
  if (hens <= capacity) return 1;
  if (capacity <= 0) return 1 - c.maxLoss;
  const overFraction = (hens - capacity) / capacity;
  return 1 - Math.min(c.maxLoss, c.lossPerTenPercentOver * (overFraction / 0.1));
}

export const ageFactor = (ageDays: number): number =>
  ageDays >= ECONOMY.hen.primeLifeDays ? ECONOMY.hen.agedLayingFactor : 1;

export function coopCapacity(kinds: readonly CoopKind[]): number {
  return kinds.reduce((sum, k) => sum + ECONOMY.coops.kinds[k].capacity, 0);
}

export function nextCoopKind(kind: CoopKind): CoopKind | null {
  const i = COOP_KINDS.indexOf(kind);
  return COOP_KINDS[i + 1] ?? null;
}

/** Upgrading pays the difference between the two coop prices. */
export function coopUpgradeCost(from: CoopKind, to: CoopKind): number {
  return ECONOMY.coops.kinds[to].price - ECONOMY.coops.kinds[from].price;
}

export const breakageRate = (unlocks: Unlocks): number =>
  has(unlocks, 'conveyor') ? ECONOMY.unlocks.conveyor.breakage : ECONOMY.eggs.breakage;

export function feedBagPrice(tier: FeedTier, unlocks: Unlocks): number {
  const discount = has(unlocks, 'hopper') ? ECONOMY.unlocks.hopper.feedCostDiscount : 0;
  return ECONOMY.feed.tiers[tier].bagPrice * (1 - discount);
}

export function feedCostPerHenDay(tier: FeedTier, unlocks: Unlocks): number {
  return (feedBagPrice(tier, unlocks) / ECONOMY.feed.bagKg) * ECONOMY.feed.kgPerHenPerDay;
}

/** Price of one egg of a grade at the live multiplier, with the grader bonus. */
export function eggPrice(grade: EggGrade, multiplier: number, unlocks: Unlocks): number {
  const bonus = has(unlocks, 'grader') ? ECONOMY.unlocks.grader.eggPriceBonus : 0;
  return ECONOMY.eggs.basePrice[grade] * multiplier * (1 + bonus);
}

export type EggCounts = Partial<Record<EggGrade, number>>;

/** Value of a sale: per-grade egg prices, then the clerk's revenue bonus on the total. */
export function saleValue(items: EggCounts, multiplier: number, unlocks: Unlocks): number {
  let total = 0;
  for (const grade of EGG_GRADES) total += (items[grade] ?? 0) * eggPrice(grade, multiplier, unlocks);
  const clerk = has(unlocks, 'clerk') ? ECONOMY.unlocks.clerk.revenueBonus : 0;
  return total * (1 + clerk);
}

/** Expected price of one egg of a feed tier's grade mix at a 1.00x market, no bonuses. */
export function averageEggBasePrice(tier: FeedTier): number {
  const mix = ECONOMY.feed.tiers[tier].gradeMix;
  return EGG_GRADES.reduce((sum, g) => sum + (mix[g] / 100) * ECONOMY.eggs.basePrice[g], 0);
}

/** Map a uniform roll in [0, 1) to an egg grade using the tier's grade mix. */
export function gradeForRoll(tier: FeedTier, roll: number): EggGrade {
  const mix = ECONOMY.feed.tiers[tier].gradeMix;
  let edge = 0;
  for (const g of EGG_GRADES) {
    edge += mix[g] / 100;
    if (roll < edge) return g;
  }
  return 'white';
}

export interface LayingInput {
  /** Feed laying multiplier for the day (0 when unfed). */
  feedMultiplier: number;
  trait?: number;
  ageDays?: number;
  crowding?: number;
}

/** Eggs per day for one hen. */
export function henLayingRate(input: LayingInput): number {
  return (
    ECONOMY.hen.baseLaying *
    input.feedMultiplier *
    (input.trait ?? 1) *
    ageFactor(input.ageDays ?? 0) *
    (input.crowding ?? 1)
  );
}

export interface MarginInput {
  tier: FeedTier;
  multiplier: number;
  unlocks?: Unlocks;
  trait?: number;
  ageDays?: number;
  crowding?: number;
}

/** Expected coins one hen earns per day after feed, at a market multiplier. */
export function henDailyMargin(input: MarginInput): number {
  const unlocks = input.unlocks ?? [];
  const tier = ECONOMY.feed.tiers[input.tier];
  const layInput: LayingInput = { feedMultiplier: tier.laying };
  if (input.trait !== undefined) layInput.trait = input.trait;
  if (input.ageDays !== undefined) layInput.ageDays = input.ageDays;
  if (input.crowding !== undefined) layInput.crowding = input.crowding;
  const sellable = henLayingRate(layInput) * (1 - breakageRate(unlocks));
  const mix = tier.gradeMix;
  const perEgg = saleValue(
    { white: mix.white / 100, cream: mix.cream / 100, brown: mix.brown / 100, golden: mix.golden / 100 },
    input.multiplier,
    unlocks,
  );
  return sellable * perEgg - feedCostPerHenDay(input.tier, unlocks);
}

/** Days for a hen to earn back its price. Infinity when the margin is not positive. */
export function henPaybackDays(input: MarginInput): number {
  const margin = henDailyMargin(input);
  return margin > 0 ? ECONOMY.hen.price / margin : Number.POSITIVE_INFINITY;
}

export interface ReinvestInput {
  hens: number;
  cash: number;
  reserve: number;
  capacity: number;
  tier: FeedTier;
  multiplier: number;
  maxDays?: number;
}

export interface ReinvestDay {
  day: number;
  bought: number;
  hens: number;
  cashAfterBuying: number;
}

/**
 * Projection used by the economy sheet: each morning buy hens while cash stays at or above the
 * reserve, then earn the expected daily margin per hen. Returns the day the coop is full.
 */
export function simulateReinvest(input: ReinvestInput): { dayFilled: number | null; days: ReinvestDay[] } {
  const margin = henDailyMargin({ tier: input.tier, multiplier: input.multiplier });
  const price = ECONOMY.hen.price;
  let hens = input.hens;
  let cash = input.cash;
  const days: ReinvestDay[] = [];
  for (let day = 1; day <= (input.maxDays ?? 365); day++) {
    let bought = 0;
    while (hens < input.capacity && cash - price >= input.reserve) {
      cash -= price;
      hens += 1;
      bought += 1;
    }
    days.push({ day, bought, hens, cashAfterBuying: cash });
    if (hens >= input.capacity) return { dayFilled: day, days };
    cash += hens * margin;
  }
  return { dayFilled: null, days };
}
