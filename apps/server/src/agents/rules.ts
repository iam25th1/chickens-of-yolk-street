// Rule policies: how each agent behaves without a model, and whenever the model's answer is
// unusable or the inference budget is spent. Each follows its character from the design doc, reads
// the last three days' supply against demand (not only today's price), and gives one public reason.
import {
  ECONOMY,
  EGG_GRADES,
  bakeryPrice,
  desperation,
  feedGramsPerHenDay,
  henDailyMargin,
  loyalistBagPrice,
  squeezerBagPrice,
  traderPrice,
  wholesalePrice,
  type AgentKind,
  type EggGrade,
  type FeedTier,
  type UnlockId,
} from '@coys/shared';
import { cleanText, emptyDecision, REASON_MAX, type AgentContext, type Decision, type FarmBrief, type WeekNumbers } from './decision';
import { entrantByKey } from './entrants';

const sum = (o: Partial<Record<string, number>>): number => Object.values(o).reduce<number>((a, b) => a + (b ?? 0), 0);
const players = (c: AgentContext): FarmBrief[] => c.farms.filter((f) => f.owner === 'player');

interface RivalStyle {
  reserve: number;
  tier: FeedTier;
  fill: (multiplier: number) => number;
  /** Below this multiplier it holds back holdShare of its crate; at or above it sells everything. */
  holdBelow: number;
  holdShare: number;
  feedDays: number;
  unlockOrder: UnlockId[];
  /** On a good week: how full it packs its coops, and whether it buys feed on credit to do it. */
  boom: { fill: number; reserve: number; borrows: boolean };
  /** In a glut it dumps fresh eggs as sell orders at this share of the live price (0: never). */
  dumpShare: number;
}

const RIVAL_STYLE: Record<'upstart' | 'old-money', RivalStyle> = {
  // lives on feed credit, over-expands on good weeks (every coin into hens, coops packed past
  // capacity), cheap feed, dumps every egg at any price in a glut: crashes hardest when the boom
  // it fed turns into a glut and its credit falls due
  upstart: {
    reserve: 6,
    tier: 'cheap',
    fill: (m) => (m >= 1.2 ? 1.15 : 1.05),
    holdBelow: 0,
    holdShare: 0,
    feedDays: 2,
    unlockOrder: ['conveyor', 'hopper'],
    boom: { fill: 1.2, reserve: 0, borrows: true },
    dumpShare: 0.66,
  },
  // never panics: holds half its eggs back in a slump and sells the lot once the price recovers
  // (the release is a glut of its own), keeps cash, buys bust farms' hens cheap
  'old-money': {
    reserve: 150,
    tier: 'premium',
    fill: () => 0.95,
    holdBelow: 0.9,
    holdShare: 0.5,
    feedDays: 6,
    unlockOrder: ['grader', 'clerk', 'conveyor'],
    boom: { fill: 0.95, reserve: 150, borrows: false },
    dumpShare: 0,
  },
};

/** A good week: the last few closes averaged well above 1.00x. */
export const BOOM_AVERAGE = 1.08;
const goodWeek = (c: AgentContext): boolean => {
  const recent = c.market.history.slice(-5);
  return recent.length >= 3 && recent.reduce((s, h) => s + h.multiplier, 0) / recent.length >= BOOM_AVERAGE;
};

/** A glut: the price is down at the crash line, or yesterday's supply ran well past demand. */
const glutting = (c: AgentContext, over: number): boolean =>
  c.market.multiplier <= ECONOMY.market.crashAt + 0.1 || c.market.supplyYesterday > c.market.reference * over;

/** Scarcity that lasts: supply ran under demand on (nearly) every one of the last three closed days. */
export const scarceTrend = (c: AgentContext): boolean => {
  const r = c.market.trend.supplyOverDemand;
  return r.length >= 2 && r.filter((x) => x < 0.95).length >= Math.min(r.length, 2) && (r.at(-1) ?? 1) < 1;
};

/** A glut that lasts or is building: supply ran past demand on average, or is climbing past it while the price falls. */
export const glutTrend = (c: AgentContext): boolean => {
  const r = c.market.trend.supplyOverDemand;
  if (r.length < 2) return false;
  const avg = r.reduce((a, b) => a + b, 0) / r.length;
  return avg > 1.08 || ((r.at(-1) ?? 0) > 1.05 && c.market.trend.slope < -0.03);
};

const say = (s: string): string => cleanText(s, REASON_MAX);

/** A rival's style: its kind's, with an entering AI farm's own settings on top. */
function styleFor(c: AgentContext, kind: 'upstart' | 'old-money'): RivalStyle {
  const base = RIVAL_STYLE[kind];
  const own = entrantByKey(c.agent.entrant)?.rules;
  if (!own) return base;
  return {
    ...base,
    reserve: own.reserve ?? base.reserve,
    tier: own.tier ?? base.tier,
    holdBelow: own.holdBelow ?? base.holdBelow,
    holdShare: own.holdShare ?? base.holdShare,
    dumpShare: own.dumpShare ?? base.dumpShare,
    boom: { ...base.boom, reserve: own.reserve ?? base.boom.reserve, borrows: own.borrows ?? base.boom.borrows },
  };
}

function rival(c: AgentContext, kind: 'upstart' | 'old-money'): Decision {
  const d = emptyDecision(kind === 'upstart' ? 'grow while it pays, sell everything' : 'steady: hold in a slump, buy cheap');
  const own = c.own;
  if (!own) return d;
  const s = styleFor(c, kind);
  const m = c.market.multiplier;
  const boom = goodWeek(c);
  // the trend, not only today: grow into lasting scarcity, hold and stop growing into a building glut
  const scarce = scarceTrend(c);
  const glut = glutTrend(c);
  const reserve = boom ? s.boom.reserve : s.reserve;
  let cash = c.agent.cash;
  if (boom && kind === 'upstart') d.note = 'good week: borrow, pack the coops, grow';
  const said: { auction?: number; hens?: number; held?: boolean; dumped?: boolean; borrowed?: boolean; coop?: boolean; paused?: boolean } = {};

  const eggs = sum(own.crate);
  if (eggs > 0) {
    // a holder holds a little more when the glut is building
    const holdShare = glut && s.holdShare > 0 ? Math.min(0.7, s.holdShare + 0.15) : s.holdShare;
    const holding = (m < s.holdBelow || (glut && s.holdShare > 0)) && eggs <= own.hens * 3;
    const items = { ...own.crate };
    if (holding) for (const g of EGG_GRADES) items[g] = Math.floor(items[g] * (1 - holdShare));
    said.held = holding && sum(items) < eggs;
    if (sum(items) > 0) {
      d.farmActions.push({ t: 'sell', items });
      cash += EGG_GRADES.reduce((t, g) => t + items[g] * c.market.prices[g], 0);
    }
  }

  if (own.feedTier !== s.tier) d.farmActions.push({ t: 'setFeedTier', tier: s.tier });
  const need = Math.max(1, own.hens) * feedGramsPerHenDay();
  const stock = sum(own.feedGrams);
  const bagPrice = ECONOMY.feed.tiers[s.tier].bagPrice * (own.unlocks.includes('hopper') ? 0.9 : 1) * 1.05;
  const want = Math.ceil((need * (s.feedDays + 2) - stock) / (ECONOMY.feed.bagKg * 1000));
  // bags the Loyalist would still lend against this farm
  const room = Math.floor((ECONOMY.suppliers.loyalist.creditLimit - own.owes) / (bagPrice * (1 + ECONOMY.suppliers.loyalist.creditInterest)));
  if (boom && s.boom.borrows && stock < need * (s.feedDays + 2)) {
    // feed on the Loyalist's credit, so every coin goes into hens; it falls due in a few days
    const bags = Math.min(10, want + 2, room);
    if (bags > 0) {
      d.farmActions.push({ t: 'buyFeedOnCredit', tier: s.tier, bags });
      said.borrowed = true;
    }
  } else if (stock < need * s.feedDays) {
    const bags = Math.min(10, want, Math.floor(cash / bagPrice));
    if (bags > 0) {
      d.farmActions.push({ t: 'buyFeed', tier: s.tier, bags });
      cash -= bags * bagPrice;
    } else if (s.boom.borrows && room > 0) {
      // short of cash for even one bag: it borrows rather than let the flock go hungry
      d.farmActions.push({ t: 'buyFeedOnCredit', tier: s.tier, bags: 1 });
      said.borrowed = true;
    }
  }

  const margin = henDailyMargin({ tier: s.tier, multiplier: m, unlocks: own.unlocks });
  const affordable = Math.floor((cash - reserve) / ECONOMY.hen.price);
  // only a boom (and only for a farm that borrows into it) buys hens into a building glut
  const grows = !glut || (boom && s.boom.borrows);
  if (kind === 'old-money' && c.market.auctionHens > 0 && affordable > 0) {
    // bust farms' hens at half price: Old Money's favourite purchase
    const count = Math.min(20, c.market.auctionHens, affordable, Math.max(0, Math.floor(own.capacity * 1.1) - own.hens));
    if (count > 0) {
      d.farmActions.push({ t: 'buyHens', count });
      cash -= count * ECONOMY.hen.price * ECONOMY.agents.auctionPriceFactor;
      said.auction = count;
    }
  } else if (margin > 0.05 && grows) {
    const target = Math.floor(own.capacity * (boom ? s.boom.fill : s.fill(m) + (scarce ? 0.05 : 0)));
    const count = Math.min(20, target - own.hens, affordable);
    if (count > 0) {
      d.farmActions.push({ t: 'buyHens', count });
      cash -= count * ECONOMY.hen.price;
      said.hens = count;
    }
  } else if (margin > 0.05 && !grows) said.paused = true;
  if (own.hens >= own.capacity * 0.9 && own.freePlots > 0 && margin > 0.1 && grows) {
    const kindCoop = cash - reserve >= ECONOMY.coops.kinds.deluxe.price ? 'deluxe' : 'red';
    if (cash - reserve >= ECONOMY.coops.kinds[kindCoop].price) {
      d.farmActions.push({ t: 'buildCoop', kind: kindCoop });
      cash -= ECONOMY.coops.kinds[kindCoop].price;
      said.coop = true;
    }
  }
  const next = s.unlockOrder.find((u) => !own.unlocks.includes(u));
  if (next && !boom && cash - s.reserve * 2 >= ECONOMY.unlocks[next].price) d.farmActions.push({ t: 'buyUnlock', unlock: next });

  // in a glut the Upstart dumps tomorrow's crate at any price; the Wholesaler's bids soak it up
  if (s.dumpShare > 0 && glutting(c, 1.1)) {
    const daily = Math.ceil(own.hens * ECONOMY.hen.baseLaying);
    for (const g of EGG_GRADES) {
      const share = ECONOMY.feed.tiers[own.feedTier].gradeMix[g] / 100;
      const qty = Math.min(200, Math.ceil(daily * share));
      if (qty > 0 && d.sellOrders.length < 4) d.sellOrders.push({ grade: g, qty, priceShare: s.dumpShare });
    }
    said.dumped = d.sellOrders.length > 0;
  }

  for (const f of players(c)) {
    if (f.memory.sulking) continue;
    if (kind === 'upstart' && f.crate.brown >= 4 && own.crate.brown > 0) {
      const q = Math.min(f.crate.brown, 10);
      d.offers.push({ kind: 'undercut', farmId: f.farmId, grade: 'brown', qty: q, priceShare: 0.92, line: '' });
    }
    if (kind === 'old-money' && f.hens >= 12 && f.cash < 25 && cash > s.reserve) {
      d.offers.push({ kind: 'buyout-offer', farmId: f.farmId, hens: Math.min(4, f.hens - 8), priceShare: 0.85, line: '' });
    }
  }
  d.reason = say(rivalReason(kind, said, { boom, scarce, glut, m }));
  return d;
}

function rivalReason(
  kind: 'upstart' | 'old-money',
  did: { auction?: number; hens?: number; held?: boolean; dumped?: boolean; borrowed?: boolean; coop?: boolean; paused?: boolean },
  saw: { boom: boolean; scarce: boolean; glut: boolean; m: number },
): string {
  if (kind === 'upstart') {
    if (did.dumped) return 'Street is flooded. Dumping eggs cheap, I need the cash!';
    if (saw.boom && (did.borrowed || did.hens)) return `Good week! Borrowed feed${did.hens ? `, ${did.hens} more hens` : ''}. Watch me grow!`;
    if (did.hens && saw.scarce) return `Eggs short three days running. ${did.hens} more hens!`;
    if (did.coop) return 'New coop going up. Old Money, you are next!';
    if (did.hens) return `${did.hens} more hens. Bigger is better!`;
    if (did.paused) return 'Glut building. No new hens till it clears. Smart, right?';
    if (did.borrowed) return 'Short this week. Feed on credit, pay it back later!';
    return 'Selling everything at the going price. Next!';
  }
  if (did.auction) return `${did.auction} auction hens at half price. Thank you, upstarts.`;
  if (did.held) return saw.glut ? 'A glut is building. We hold our eggs and wait.' : 'Holding half our eggs until the price recovers.';
  if (did.hens && saw.scarce) return `Eggs are scarce. ${did.hens} more hens, at our pace.`;
  if (did.coop) return 'A new coop. Heritage grows, slowly and surely.';
  if (did.hens) return `${did.hens} more hens. Patience pays.`;
  if (did.paused) return 'Too many eggs on the street. We grow when it clears.';
  return saw.m >= 1 ? 'Selling the lot. The price is fair again.' : 'Steady as ever. Selling at the going rate.';
}

/** Bags of feed the farms it can see eat in a day, between them. */
const streetBagsPerDay = (c: AgentContext): number => c.farms.reduce((t, f) => t + (f.hens * feedGramsPerHenDay()) / (ECONOMY.feed.bagKg * 1000), 0);

/** How the street's feed splits between the tiers, roughly. */
const TIER_SHARE: Record<FeedTier, number> = { cheap: 0.35, standard: 0.45, premium: 0.2 };

function supplier(c: AgentContext, kind: 'squeezer' | 'loyalist'): Decision {
  const d = emptyDecision(kind === 'squeezer' ? 'price in their desperation' : 'look after regulars, extend credit');
  const s = ECONOMY.suppliers;
  let cash = c.agent.cash;
  // restock to the street's demand: about five days of its half of the feed farms eat, never under the old floor
  const daily = streetBagsPerDay(c) / 2;
  let restocked = 0;
  let short = 0;
  for (const t of ['cheap', 'standard', 'premium'] as const) {
    const have = c.agent.stock[t] ?? 0;
    const floor = Math.max(s.restockBelowBags, Math.ceil(daily * TIER_SHARE[t] * 5));
    if (have < floor) {
      short++;
      const cost = ECONOMY.feed.tiers[t].bagPrice * s.wholesaleShare;
      const bags = Math.min(200, Math.max(s.restockBags, floor * 2 - have), Math.floor((cash - 40) / cost));
      if (bags > 0) {
        d.restock[t] = bags;
        cash -= bags * cost;
        restocked += bags;
      }
    }
  }
  const field = players(c).map((f) => ({ f, desp: desperation(f.feedDays, f.cash) }));
  const mood = field.length ? field.reduce((a, x) => a + x.desp, 0) / field.length : 0;
  const glut = glutTrend(c);
  // the list price on top of each farm's own quote: the Squeezer leans on a hungry market and on a
  // thin barn; the Loyalist eases off a little for its regulars while a glut squeezes them
  d.markup = kind === 'squeezer' ? 1 + 0.25 * mood + (short >= 2 && restocked === 0 ? 0.05 : 0) : glut ? 0.97 : 1;

  for (const { f, desp } of field) {
    if (f.memory.sulking) continue;
    const tier: FeedTier = 'standard';
    const daysNeeded = Math.max(0, 6 - f.feedDays);
    const bags = Math.max(1, Math.min(4, Math.ceil((daysNeeded * Math.max(1, f.hens) * feedGramsPerHenDay()) / (ECONOMY.feed.bagKg * 1000))));
    const list = ECONOMY.feed.tiers[tier].bagPrice;
    if (kind === 'squeezer' && desp >= 0.25) {
      d.offers.push({ kind: 'feed-deal', farmId: f.farmId, tier, bags, priceShare: squeezerBagPrice(tier, desp) / list, line: '' });
    }
    if (kind === 'loyalist') {
      // a farm takes the first card from each agent: credit first for a regular too short of cash to pay for a bag now
      const cashShort = f.cash < list * 1.2;
      if (cashShort && f.feedDays < 3 && f.owesMe + bags * list < s.loyalist.creditLimit && f.memory.misses === 0) {
        d.offers.push({ kind: 'credit-terms', farmId: f.farmId, tier, bags, priceShare: loyalistBagPrice(tier, f.memory.deals) / list, line: '' });
      }
      if (f.memory.deals > 0 || desp >= 0.2) {
        d.offers.push({ kind: 'feed-deal', farmId: f.farmId, tier, bags, priceShare: loyalistBagPrice(tier, f.memory.deals) / list, line: '' });
      }
    }
  }
  const credit = d.offers.filter((o) => o.kind === 'credit-terms').length;
  if (kind === 'squeezer') {
    const pct = Math.round((d.markup - 1) * 100);
    d.reason = say(
      pct >= 10 ? `Hungry farms, thin troughs. List price up ${pct}%.` : restocked ? `Barn topped up, ${restocked} bags. Prices hold. Pay up.` : 'Plenty in the barn. Same price. Take it or leave it.',
    );
  } else {
    d.reason = say(
      credit
        ? `Credit for ${credit} farm${credit === 1 ? '' : 's'} short this week. Pay me when you can, friend.`
        : glut
          ? 'Hard week on the street. A little off the list for everyone.'
          : restocked
            ? `Restocked ${restocked} bags. Nobody goes hungry, friend.`
            : 'Barn is full. Same fair price for my regulars.',
    );
  }
  return d;
}

function bakery(c: AgentContext): Decision {
  const d = emptyDecision('steady volume, contracts with reliable farms');
  const b = ECONOMY.buyers.bakery;
  const m = c.market.multiplier;
  const contractPrice = bakeryPrice(m);
  let budget = c.agent.cash;
  for (const f of players(c)) {
    if (f.memory.sulking || f.hasContractWithMe) continue;
    const perDay = Math.max(b.qtyPerDay.min, Math.min(b.qtyPerDay.max, Math.round(f.dailyEggs * 0.35)));
    const days = Math.min(b.contractDays.max, Math.max(b.contractDays.min, 4 + f.memory.deals));
    if (budget < perDay * contractPrice * 2) break;
    d.offers.push({ kind: 'standing-contract', farmId: f.farmId, qtyPerDay: perDay, days, priceShare: b.priceShare, line: '' });
    budget -= perDay * contractPrice * 2;
  }
  // everyday flour-and-egg buying through the book: deeper while eggs are cheap, lighter while scarce
  const glut = glutTrend(c) || glutting(c, 1.1);
  const scarce = !glut && scarceTrend(c);
  const depth = glut ? 1.5 : scarce ? 0.5 : 1;
  for (const g of ['white', 'cream'] as const) {
    const price = c.market.prices[g] * 0.97;
    const want = Math.min(Math.round(30 * depth), Math.floor((c.agent.cash * 0.3 * depth) / Math.max(0.1, price)));
    if (want > 0) d.buyOrders.push({ grade: g, qty: want, priceShare: 0.97 });
  }
  for (const f of c.farms) {
    for (const o of f.sells) {
      if ((o.grade === 'white' || o.grade === 'cream') && o.price <= c.market.prices[o.grade] * 1.05) d.fills.push({ orderId: o.orderId, qty: o.qty });
    }
  }
  const contracts = d.offers.length;
  d.reason = say(
    glut
      ? 'Eggs are cheap this week. Stocking up for the ovens.'
      : scarce
        ? 'Eggs are scarce. Buying light, contracts first.'
        : contracts
          ? `Contracts out to ${contracts} farm${contracts === 1 ? '' : 's'}. Fresh eggs at dawn, please.`
          : 'Steady baking. Whites and creams at a fair price.',
  );
  return d;
}

function trader(c: AgentContext): Decision {
  const d = emptyDecision('pay up for quality, walk from farms that slip');
  const t = ECONOMY.buyers.trader;
  const m = c.market.multiplier;
  const glut = glutting(c, 1.05);
  for (const f of players(c)) {
    const before = d.offers.length;
    if (!f.memory.sulking && f.quality >= t.minQuality) {
      for (const g of ['golden', 'brown'] as const) {
        // what it expects in the crate by tomorrow: the crate now or a day's lay at the farm's quality
        const expected = Math.max(f.crate[g], Math.floor(f.dailyEggs * (g === 'golden' ? 0.02 : f.quality * 0.8)));
        if (expected >= (g === 'golden' ? 1 : 3)) {
          const q = Math.min(expected, g === 'golden' ? 3 : 12);
          d.offers.push({ kind: 'premium-order', farmId: f.farmId, grade: g, qty: q, priceShare: traderPrice(g, m) / c.market.prices[g], line: '' });
          break;
        }
      }
    }
    // a farm gets one card from each agent a day: the warning only when there is no order to make
    if (glut && d.offers.length === before) d.offers.push({ kind: 'glut-warning', farmId: f.farmId, line: '' });
  }
  // standing bids for fine eggs: deeper in a lasting glut, lighter while eggs are scarce
  const deep = glutTrend(c);
  const scarce = !deep && scarceTrend(c);
  const depth = deep ? 1.5 : scarce ? 0.5 : 1;
  for (const g of ['brown', 'golden'] as const) {
    const want = Math.min(Math.round(20 * depth), Math.floor((c.agent.cash * 0.3 * depth) / Math.max(0.1, c.market.prices[g])));
    if (want > 0) d.buyOrders.push({ grade: g, qty: want, priceShare: 1.05 });
  }
  for (const f of c.farms) {
    for (const o of f.sells) {
      if ((o.grade === 'brown' || o.grade === 'golden') && o.price <= traderPrice(o.grade, m) * 0.95) d.fills.push({ orderId: o.orderId, qty: o.qty });
    }
  }
  const orders = d.offers.filter((o) => o.kind === 'premium-order').length;
  d.reason = say(
    orders
      ? `Premium orders to ${orders} farm${orders === 1 ? '' : 's'}. Bring me your best browns.`
      : deep || glut
        ? 'Flooded street. Fine eggs are cheap today, and I am buying.'
        : scarce
          ? 'Quality is scarce. Buying light, paying fair.'
          : 'Watching quality. Nothing worth my stall today.',
  );
  return d;
}

function wholesaler(c: AgentContext): Decision {
  const d = emptyDecision('buy anything cheap, move volume');
  const w = ECONOMY.buyers.wholesaler;
  const m = c.market.multiplier;
  const glut = glutting(c, 1.2);
  // its bids read the trend too: deep through a lasting glut, not only on the day of one
  const deep = glut || glutTrend(c);
  let budget = c.agent.cash;
  for (const f of players(c)) {
    // a day's lay counts too: the bulk order lands as a card while the crate is full
    const eggs = Math.max(sum(f.crate), f.dailyEggs);
    const q = Math.min(eggs, w.bulkQty.max);
    const cost = q * wholesalePrice('white', m);
    if (!f.memory.sulking && eggs >= w.bulkQty.min && budget >= cost) {
      d.offers.push({ kind: 'bulk-order', farmId: f.farmId, qty: q, priceShare: w.priceShare, line: '' });
      budget -= cost;
    } else if (glut) d.offers.push({ kind: 'glut-warning', farmId: f.farmId, line: '' });
  }
  // standing bids under the market; in a glut it bids deeper into its cash, to resell tomorrow, and
  // while eggs stay scarce it bids light
  const scarce = !deep && scarceTrend(c);
  for (const g of EGG_GRADES) {
    const want = Math.min(deep ? 80 : scarce ? 20 : 40, Math.floor((budget * (deep ? 0.3 : scarce ? 0.08 : 0.15)) / Math.max(0.1, c.market.prices[g] * 0.7)));
    if (want > 0) d.buyOrders.push({ grade: g, qty: want, priceShare: 0.7 });
  }
  for (const f of c.farms) for (const o of f.sells) if (o.price <= c.market.prices[o.grade] * 0.78) d.fills.push({ orderId: o.orderId, qty: o.qty });
  const bulk = d.offers.filter((o) => o.kind === 'bulk-order').length;
  d.reason = say(deep ? 'Glut. Buying deep. Reselling tomorrow.' : scarce ? 'Scarce. Buying light.' : bulk ? `Bulk orders to ${bulk}. Cash on the cart.` : 'Bids under the market. Volume is my margin.');
  return d;
}

/** The rule decision for any agent. */
export function ruleDecision(c: AgentContext): Decision {
  switch (c.agent.kind) {
    case 'upstart':
    case 'old-money':
      return rival(c, c.agent.kind);
    case 'squeezer':
    case 'loyalist':
      return supplier(c, c.agent.kind);
    case 'bakery':
      return bakery(c);
    case 'trader':
      return trader(c);
    case 'wholesaler':
      return wholesaler(c);
  }
}

export const gradesByValue: EggGrade[] = ['golden', 'brown', 'cream', 'white'];

const WENT_WELL: Record<AgentKind, string> = {
  upstart: 'Growing like I said!',
  'old-money': 'A satisfactory week, as expected.',
  squeezer: 'Good margins. Hungry farms pay.',
  loyalist: 'A good week, the regulars kept coming.',
  bakery: 'The ovens stayed full.',
  trader: 'Good stock moved at good prices.',
  wholesaler: 'Volume moved. Margin held.',
};

const WENT_BADLY: Record<AgentKind, string> = {
  upstart: 'Rough week, but I am not done!',
  'old-money': 'A poor week. Unacceptable.',
  squeezer: 'Thin week. Too soft on them.',
  loyalist: 'A hard week for all of us.',
  bakery: 'A lean week at the ovens.',
  trader: 'A thin week at the stall.',
  wholesaler: 'Bad week. Bought too dear.',
};

/** The next week's change, from the week's numbers and the agent's role. */
function nextWeek(c: AgentContext, w: WeekNumbers): string {
  const role = c.agent.role;
  if (role === 'rival') {
    if (w.glutDays >= 3) return c.agent.kind === 'upstart' ? 'Next week: fewer new hens till the glut clears. Maybe.' : 'Next week: hold more eggs back and buy no hens until the glut clears.';
    if (w.multiplierHigh >= 1.15) return 'Next week: more hens while eggs are short.';
    return 'Next week: keep the flock fed and sell at the going price.';
  }
  if (role === 'supplier') {
    if (w.refusals > w.deals) return c.agent.kind === 'squeezer' ? 'Next week: ease the price a hair. Only a hair.' : 'Next week: gentler prices and more credit for regulars.';
    return 'Next week: keep the barn full ahead of demand.';
  }
  if (w.refusals > w.deals) return 'Next week: better offers, or they will keep saying no.';
  if (w.glutDays >= 3) return 'Next week: buy deeper while eggs stay cheap.';
  return 'Next week: same again, lighter if eggs turn scarce.';
}

/** The weekly reflection from the agent's own numbers, when the model is not asked or fails. */
export function ruleReflection(c: AgentContext, w: WeekNumbers): string {
  const delta = Math.round(w.cashNow) - Math.round(w.cashStart);
  const sign = delta >= 0 ? '+' : '-';
  const busts = w.bustsSeen ? `, ${w.bustsSeen} bust${w.bustsSeen === 1 ? '' : 's'} seen` : '';
  const facts =
    `Days ${w.fromDay} to ${w.toDay}: cash ${Math.round(w.cashStart)} to ${Math.round(w.cashNow)} (${sign}${Math.abs(delta)}), ` +
    `${w.deals} deal${w.deals === 1 ? '' : 's'}, ${w.refusals} refusal${w.refusals === 1 ? '' : 's'}${busts}, prices ${w.multiplierLow.toFixed(2)}x to ${w.multiplierHigh.toFixed(2)}x` +
    `${w.glutDays ? ` (${w.glutDays} glut day${w.glutDays === 1 ? '' : 's'})` : ''}.`;
  return cleanText(`${facts} ${delta >= 0 ? WENT_WELL[c.agent.kind] : WENT_BADLY[c.agent.kind]} ${nextWeek(c, w)}`, 400);
}
