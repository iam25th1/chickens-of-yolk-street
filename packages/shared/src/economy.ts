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

/** The neighbouring plots a farm can buy around its home plot, in the order the shop lists them. */
export const LAND_IDS = ['east', 'west', 'north', 'south'] as const;
export type LandId = (typeof LAND_IDS)[number];
export const LAND_NAME: Record<LandId, string> = { east: 'EAST FIELD', west: 'WEST MEADOW', north: 'NORTH PASTURE', south: 'SOUTH ORCHARD' };

/** The goal chain that teaches the game, in order, with its coin rewards. */
export const GOAL_IDS = ['collect', 'sell', 'coop', 'haggle', 'machine', 'rival'] as const;

/**
 * Milestones: each gives a farm in good standing one roll for a Feather Ticket, once. In order of
 * how soon a farm usually reaches them.
 */
export const MILESTONE_IDS = ['full-coop', 'good-week', 'eggs-sold', 'haggles-won', 'all-machines', 'outlast-rival', 'top-three'] as const;
export type MilestoneId = (typeof MILESTONE_IDS)[number];

/** Feather grades, lowest first: the grade sets a Feather's odds of a high-rarity hen at the reveal. */
export const FEATHER_GRADES = ['fluff', 'plume', 'quill', 'golden-quill'] as const;
export type FeatherGrade = (typeof FEATHER_GRADES)[number];

/** Founding Hen rarities, highest first. */
export const RARITIES = ['legendary', 'epic', 'rare', 'common'] as const;
export type Rarity = (typeof RARITIES)[number];
export type GoalId = (typeof GOAL_IDS)[number];
export const GOAL_REWARDS: Record<GoalId, number> = { collect: 2, sell: 3, coop: 5, haggle: 5, machine: 8, rival: 10 };

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
    /** Coop plots on the home plot (bought land adds its own: ECONOMY.land). */
    plots: 4,
  },
  /**
   * Land: a farm starts on its home plot and may buy the four plots around it, in any order. The
   * first plot bought costs prices[0], the second prices[1], and so on, whichever plot it is. Each
   * plot adds coopSlots coop plots (numbered after the home plot's four, in LAND_IDS order, so a
   * coop keeps its number whatever was bought first), a pasture the hens walk, and room for props
   * (props spots). depth is how far the plot reaches out from the home plot, in 16-pixel tiles.
   * Prices tuned with the 30-day simulation (apps/server/test/sim.test.ts, its SIM LAND line): the
   * street's most successful farm can pay for its first plot by day 3 to 6, two by day 10, three by
   * day 16 to 21 and all four only by day 28 to 30, or not within the 30 days; the simulation's
   * greedy players, who never build a second coop, never hold enough.
   */
  land: {
    prices: [600, 900, 1200, 1500],
    plots: {
      east: { coopSlots: 2, props: 3, depth: 18 },
      west: { coopSlots: 2, props: 3, depth: 16 },
      north: { coopSlots: 2, props: 3, depth: 13 },
      south: { coopSlots: 2, props: 4, depth: 15 },
    } satisfies Record<LandId, { coopSlots: number; props: number; depth: number }>,
  },
  crowding: {
    /** Laying lost for every 10% of hens over capacity. */
    lossPerTenPercentOver: 0.15,
    maxLoss: 0.9,
  },
  market: {
    /**
     * Fixed reference for the economy sheet: the daily supply at which the multiplier is exactly 1
     * when the reference is not scaled (marketMultiplier's default).
     */
    referenceSupply: 600,
    /**
     * Live demand per active farm. The live market's reference supply is this times the number of
     * active farms (player farms plus open agents), so a typical day sits near 1.00x whether two
     * players or twenty share Yolk Street. Tuned with the 30-day simulation (apps/server/test/sim.test.ts).
     */
    demandPerActiveFarm: 15,
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
    /** Below this cash an agent thinks only every other day (on the main model: a hard day). */
    struggleCash: 40,
    /** Days after a bust before a new agent of the same role opens. */
    replaceAfterDays: 3,
    /** In-game days between an agent's weekly reflections. */
    reflectEveryDays: 7,
    /**
     * New AI farms. At each day close, while the open AI farms are under the cap, one enters with
     * this chance when supply stayed under demand for the last `scarceDays` closed days or a rival
     * went bust in the last `bustLookbackDays`. Under the floor one enters whatever the chance. The
     * cap is the larger of `capFloor` and `capPerPlayerFarm` times the open player farms, rounded down.
     */
    entry: { chance: 0.25, minAiFarms: 2, capFloor: 4, capPerPlayerFarm: 1.5, scarceDays: 3, bustLookbackDays: 5 },
  },
  /** Feed suppliers buy bags wholesale and sell them to farms. */
  suppliers: {
    startCash: 500,
    startBags: 80,
    /** What a supplier pays per bag, as a share of the list price. */
    wholesaleShare: 0.72,
    restockBelowBags: 30,
    restockBags: 60,
    squeezer: {
      /** Price = list x (base + desperation x how desperate the farm is, 0 to 1). */
      baseMarkup: 1.05,
      desperationMarkup: 0.5,
    },
    loyalist: {
      baseMarkup: 1.0,
      discountPerDeal: 0.02,
      maxDiscount: 0.15,
      creditDays: 5,
      creditInterest: 0.08,
      /** Most coins of feed a farm may owe the Loyalist at once. */
      creditLimit: 300,
    },
  },
  /** Egg buyers pay farms, then earn from what they make or resell. */
  buyers: {
    bakery: {
      startCash: 700,
      /** Coins the bakery earns per egg it bakes. */
      bakeValue: 2.1,
      contractDays: { min: 4, max: 8 },
      qtyPerDay: { min: 3, max: 8 },
      /** Contract price per egg, as a share of the live white price. */
      priceShare: 1.15,
      /** Share of one day's contract value charged for a missed delivery. */
      missPenaltyShare: 0.25,
      cancelAfterMisses: 2,
      /** Days the bakery refuses new contracts after a cancellation. */
      sulkDays: 4,
    },
    trader: {
      startCash: 600,
      /** What the trader resells brown and golden eggs for in town. */
      resale: { brown: 2.6, golden: 9.5 },
      /** Premium over the live price it offers for brown and golden. */
      premium: 1.25,
      /** Share of brown and golden among a farm's recent sales below which the trader walks away. */
      minQuality: 0.3,
      walkAwayDays: 3,
    },
    wholesaler: {
      startCash: 900,
      /** Bulk price as a share of the live price. */
      priceShare: 0.72,
      bulkQty: { min: 8, max: 50 },
      /** The wholesaler resells everything it buys into the street market the next day. */
      resellShare: 1.0,
    },
  },
  cards: {
    minPerDay: 2,
    maxPerDay: 4,
    /** Cards arrive spread through the day at these fractions. */
    arriveAt: [0.12, 0.3, 0.48, 0.64],
  },
  haggle: {
    maxRounds: 3,
    /** Asks further than this share from the agent's offer are refused outright. */
    maxAskStretch: 0.8,
  },
  orders: {
    maxOpenPerFarm: 10,
    expireAfterDays: 3,
    /** Limit prices must sit within these shares of the live price. */
    minPriceShare: 0.2,
    maxPriceShare: 5,
  },
  clerk: {
    defaultFloor: 1.0,
    minFloor: 0.5,
    maxFloor: 3,
  },
  shop: {
    /** Fresh hens offered each morning, beside any auction hens. */
    hensPerDay: 6,
  },
  start: {
    cash: 50,
    hens: 10,
    coop: 'starter' as CoopKind,
    /** Starter bag so day one can lay: 50 coins cannot buy a 70-coin bag. */
    feed: { tier: 'standard' as FeedTier, kg: 25 },
  },
  unlocks: {
    /** Eggs ride the belt into the crate carryMs after they are laid. wear: condition lost a day it runs. */
    conveyor: { price: 40, breakage: 0.02, carryMs: 5000, wear: 0.01 },
    grader: { price: 80, eggPriceBonus: 0.1, wear: 0.015 },
    /** wear: condition lost per delivery. */
    cart: { price: 35, wear: 0.01 },
    /** Pours feed in at day close when the trough holds less than refillBelowDays, up to fillToDays. */
    hopper: { price: 60, feedCostDiscount: 0.1, refillBelowDays: 1.5, fillToDays: 3, wear: 0.01 },
    clerk: { price: 60, revenueBonus: 0.05, wear: 0.01 },
  } satisfies Record<UnlockId, { price: number; wear: number; [effect: string]: number }>,
  /**
   * Machines wear: condition runs from 100% to 0%, falling each in-game day a machine works (the
   * cart: each delivery). Full effect at fullEffectAbove and over, then falling in line with the
   * condition. Below breakdownBelow, each day close may break it (breakdownChance): it stops until
   * repaired. A repair to 100% costs repairShare of the price for a machine at 0%, in proportion.
   */
  wear: { fullEffectAbove: 0.5, breakdownBelow: 0.2, breakdownChance: 0.15, repairShare: 0.4, hintBelow: 0.3 },
  /**
   * The Feathers (beta): testnet NFTs that are claim tickets for the 777 Founding Hens, planned to
   * be revealed and minted as hens at the mainnet launch. Ordinary hens are never minted. A farm in
   * good standing gets one roll at each milestone; a win is a Feather Ticket. Redeeming a ticket
   * with a coin fee mints one Feather at the next day close (the game pays testnet gas and storage),
   * its grade set by the farm's management score at redemption. 777 ever: the contract enforces it.
   */
  feathers: {
    maxSupply: 777,
    /** Chance a milestone's roll wins a ticket. */
    odds: 0.3,
    /** Good standing: never bust this season, no credit past its due day, no contract missed in this many days. */
    missWindowDays: 3,
    /** Milestone thresholds. */
    goodDays: 7,
    eggsSold: 500,
    hagglesWon: 10,
    topRank: 3,
    /** Coins to redeem one ticket. */
    redeemFee: 25,
    /**
     * The management score at redemption, 0 to 1: each part scores 0 to 1 against its full mark
     * (days in good standing, coins of profit, haggles won; the delivery record is delivered over
     * delivered plus missed), weighted. A farm with no contracts yet scores noContracts for delivery.
     */
    score: {
      weights: { goodDays: 0.3, delivery: 0.25, haggles: 0.2, profit: 0.25 },
      full: { goodDays: 30, haggles: 20, profit: 1000 },
      noContracts: 0.5,
    },
    /** The lowest management score for each grade. */
    bands: { fluff: 0, plume: 0.35, quill: 0.6, 'golden-quill': 0.85 },
    /** Each grade's weight toward each hen rarity at the reveal, in RARITIES order (Legendary, Epic, Rare, Common). */
    gradeWeights: { fluff: [1, 1, 1, 1], plume: [2, 2, 1.5, 1], quill: [4, 3, 2, 1], 'golden-quill': [8, 5, 3, 1] },
    /** The 777 Founding Hens by rarity, in RARITIES order. */
    rarityCounts: [7, 70, 200, 500],
  },
  limits: {
    maxHensPerPurchase: 20,
    maxBagsPerPurchase: 10,
  },
} as const;

/** How much of each machine's effect a farm gets (0 to 1): its condition, 0 when broken. */
export interface MachinePower {
  readonly power: Partial<Record<UnlockId, number>>;
}

export type Unlocks = ReadonlySet<UnlockId> | readonly UnlockId[] | MachinePower;

/** A machine's effect share: 1 at full strength (or when the list just says the farm has it), 0 when absent. */
export function power(unlocks: Unlocks, id: UnlockId): number {
  if (Array.isArray(unlocks)) return unlocks.includes(id) ? 1 : 0;
  if ('power' in unlocks) return clamp01((unlocks as MachinePower).power[id] ?? 0);
  return (unlocks as ReadonlySet<UnlockId>).has(id) ? 1 : 0;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** A machine's effect at a condition: full at fullEffectAbove and over, then in line with the condition; 0 when broken. */
export function machineEffect(condition: number, broken: boolean): number {
  if (broken) return 0;
  return clamp01(condition / ECONOMY.wear.fullEffectAbove);
}

/** Coins to repair a machine to 100% from a condition. */
export function repairCost(unlock: UnlockId, condition: number): number {
  return Math.round(ECONOMY.unlocks[unlock].price * ECONOMY.wear.repairShare * clamp01(1 - condition) * 100) / 100;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Coins are kept server-side as integer thousandths so ledgers add up exactly. */
export const toMilli = (coins: number): number => Math.round(coins * 1000);
export const fromMilli = (milli: number): number => milli / 1000;

/** The live market's reference supply: demand per active farm times the active farms (at least one). */
export function marketReference(activeFarms: number): number {
  return Math.max(1, Math.floor(activeFarms)) * ECONOMY.market.demandPerActiveFarm;
}

/** Most AI farms open at once: the cap floor, or more with more open player farms. */
export function aiFarmCap(openPlayerFarms: number): number {
  const e = ECONOMY.agents.entry;
  return Math.max(e.capFloor, Math.floor(e.capPerPlayerFarm * Math.max(0, openPlayerFarms)));
}

/**
 * clamp((reference / supply) ^ exponent, min, max). No supply means the top of the range. The
 * reference defaults to the fixed sheet value; the live market passes marketReference(activeFarms).
 */
export function marketMultiplier(totalDailySupply: number, reference: number = ECONOMY.market.referenceSupply): number {
  const m = ECONOMY.market;
  if (totalDailySupply <= 0) return m.maxMultiplier;
  return clamp(Math.pow(reference / totalDailySupply, m.exponent), m.minMultiplier, m.maxMultiplier);
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

/** Coins for the next plot of land for a farm that owns `owned` plots (null when it owns them all). */
export function landPrice(owned: number): number | null {
  return ECONOMY.land.prices[owned] ?? null;
}

/** The coop plot numbers a plot of land adds (after the home plot's, in LAND_IDS order). */
export function landCoopPlots(id: LandId): number[] {
  let next: number = ECONOMY.coops.plots;
  for (const l of LAND_IDS) {
    const n = ECONOMY.land.plots[l].coopSlots;
    if (l === id) return Array.from({ length: n }, (_, i) => next + i);
    next += n;
  }
  return [];
}

/** Every coop plot a farm with this land may build on: the home plot's, then each owned plot's, in LAND_IDS order. */
export function coopPlots(land: readonly LandId[]): number[] {
  const home = Array.from({ length: ECONOMY.coops.plots }, (_, i) => i);
  return [...home, ...LAND_IDS.filter((l) => land.includes(l)).flatMap(landCoopPlots)];
}

/** The plot of land a coop plot number lies on, or null for the home plot. */
export function landOfCoopPlot(plot: number): LandId | null {
  return LAND_IDS.find((l) => landCoopPlots(l).includes(plot)) ?? null;
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
  ECONOMY.eggs.breakage - (ECONOMY.eggs.breakage - ECONOMY.unlocks.conveyor.breakage) * power(unlocks, 'conveyor');

export function feedBagPrice(tier: FeedTier, unlocks: Unlocks): number {
  const discount = ECONOMY.unlocks.hopper.feedCostDiscount * power(unlocks, 'hopper');
  return ECONOMY.feed.tiers[tier].bagPrice * (1 - discount);
}

/** Whole grams one hen eats per day (integer, so feed stock never drifts). */
export const feedGramsPerHenDay = (): number => Math.round(ECONOMY.feed.kgPerHenPerDay * 1000);

export function feedCostPerHenDay(tier: FeedTier, unlocks: Unlocks): number {
  return (feedBagPrice(tier, unlocks) / ECONOMY.feed.bagKg) * ECONOMY.feed.kgPerHenPerDay;
}

/** Price of one egg of a grade at the live multiplier, with the grader bonus. */
export function eggPrice(grade: EggGrade, multiplier: number, unlocks: Unlocks): number {
  const bonus = ECONOMY.unlocks.grader.eggPriceBonus * power(unlocks, 'grader');
  return ECONOMY.eggs.basePrice[grade] * multiplier * (1 + bonus);
}

export type EggCounts = Partial<Record<EggGrade, number>>;

/** Value of a sale: per-grade egg prices, then the clerk's revenue bonus on the total. */
export function saleValue(items: EggCounts, multiplier: number, unlocks: Unlocks): number {
  let total = 0;
  for (const grade of EGG_GRADES) total += (items[grade] ?? 0) * eggPrice(grade, multiplier, unlocks);
  const clerk = ECONOMY.unlocks.clerk.revenueBonus * power(unlocks, 'clerk');
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

/**
 * The farm machine payback is measured on: mid-game (20 hens), standard feed, a 1.00x market, and
 * one standing bakery contract of 6 eggs a day that a player without the cart misses 3 days in 10.
 */
export const MACHINE_REFERENCE = { hens: 20, tier: 'standard' as FeedTier, multiplier: 1, contractEggsPerDay: 6, missRateWithoutCart: 0.3 };

/** Coins a day a machine earns on the reference farm at full effect. */
export function machineDailyBenefit(u: UnlockId, ref: typeof MACHINE_REFERENCE = MACHINE_REFERENCE): number {
  const tier = ECONOMY.feed.tiers[ref.tier];
  const laid = ref.hens * ECONOMY.hen.baseLaying * tier.laying;
  const perEgg = averageEggBasePrice(ref.tier) * ref.multiplier;
  const sold = laid * (1 - ECONOMY.eggs.breakage) * perEgg;
  switch (u) {
    case 'conveyor':
      return laid * (ECONOMY.eggs.breakage - ECONOMY.unlocks.conveyor.breakage) * perEgg;
    case 'grader':
      return sold * ECONOMY.unlocks.grader.eggPriceBonus;
    case 'clerk':
      return sold * ECONOMY.unlocks.clerk.revenueBonus;
    case 'hopper':
      return ref.hens * feedCostPerHenDay(ref.tier, []) * ECONOMY.unlocks.hopper.feedCostDiscount;
    case 'cart': {
      const b = ECONOMY.buyers.bakery;
      return ref.missRateWithoutCart * b.missPenaltyShare * ref.contractEggsPerDay * ECONOMY.eggs.basePrice.white * b.priceShare * ref.multiplier;
    }
  }
}

/**
 * A machine's payback on the reference farm: days to earn its price at full effect, and whether it
 * earns its price before its first repair is due (when its condition reaches the breakdown zone),
 * counting the days below full effect at their share.
 */
export function machinePayback(u: UnlockId, ref: typeof MACHINE_REFERENCE = MACHINE_REFERENCE): { benefit: number; paybackDays: number; daysToRepair: number; earnedBeforeRepair: number; paysBeforeRepair: boolean } {
  const w = ECONOMY.wear;
  const rate = ECONOMY.unlocks[u].wear; // a day of work (the cart: one delivery a day on the reference farm)
  const benefit = machineDailyBenefit(u, ref);
  const fullDays = (1 - w.fullEffectAbove) / rate;
  const fadingDays = (w.fullEffectAbove - w.breakdownBelow) / rate;
  const fadingShare = (1 + w.breakdownBelow / w.fullEffectAbove) / 2;
  const earnedBeforeRepair = benefit * (fullDays + fadingDays * fadingShare);
  const price = ECONOMY.unlocks[u].price;
  return { benefit, paybackDays: price / benefit, daysToRepair: fullDays + fadingDays, earnedBeforeRepair, paysBeforeRepair: earnedBeforeRepair >= price };
}

/**
 * Net coins from owning a machine for `days` on the reference farm: repaired whenever it reaches the
 * repair hint, or never repaired (it fades, then breaks down at breakdownChance a day and stops).
 * Expected values, no randomness.
 */
export function machineNet(u: UnlockId, days: number, repair: boolean, ref: typeof MACHINE_REFERENCE = MACHINE_REFERENCE): number {
  const w = ECONOMY.wear;
  const rate = ECONOMY.unlocks[u].wear;
  const benefit = machineDailyBenefit(u, ref);
  let net = -ECONOMY.unlocks[u].price;
  let condition = 1;
  let working = 1; // the chance it has not broken down yet
  for (let d = 0; d < days; d++) {
    net += benefit * machineEffect(condition, false) * working;
    condition = Math.max(0, condition - rate * working);
    if (repair && condition < w.hintBelow) {
      net -= repairCost(u, condition);
      condition = 1;
    } else if (condition < w.breakdownBelow) working *= 1 - w.breakdownChance;
  }
  return net;
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
