// Rule policies: how each agent behaves without a model, and whenever the model's answer is
// unusable or the inference budget is spent. Each follows its character from the design doc.
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
  type EggGrade,
  type FeedTier,
  type UnlockId,
} from '@coys/shared';
import { emptyDecision, type AgentContext, type Decision, type FarmBrief } from './decision';

const sum = (o: Partial<Record<string, number>>): number => Object.values(o).reduce<number>((a, b) => a + (b ?? 0), 0);
const players = (c: AgentContext): FarmBrief[] => c.farms.filter((f) => f.owner === 'player');

interface RivalStyle {
  reserve: number;
  tier: FeedTier;
  fill: (multiplier: number) => number;
  holdBelow: number;
  feedDays: number;
  unlockOrder: UnlockId[];
}

const RIVAL_STYLE: Record<'upstart' | 'old-money', RivalStyle> = {
  // over-expands on good weeks, cheap feed, dumps every egg: crashes hardest in a glut
  upstart: { reserve: 6, tier: 'cheap', fill: (m) => (m >= 1.2 ? 1.4 : 1.05), holdBelow: 0, feedDays: 2, unlockOrder: ['conveyor', 'hopper'] },
  // never panics: holds eggs in a slump, keeps cash, buys bust farms' hens cheap
  'old-money': { reserve: 150, tier: 'premium', fill: () => 0.95, holdBelow: 0.7, feedDays: 6, unlockOrder: ['grader', 'clerk', 'conveyor'] },
};

function rival(c: AgentContext, kind: 'upstart' | 'old-money'): Decision {
  const d = emptyDecision(kind === 'upstart' ? 'grow while it pays, sell everything' : 'steady: hold in a slump, buy cheap');
  const own = c.own;
  if (!own) return d;
  const s = RIVAL_STYLE[kind];
  const m = c.market.multiplier;
  let cash = c.agent.cash;

  const eggs = sum(own.crate);
  if (eggs > 0 && (m >= s.holdBelow || eggs > own.hens * 3)) {
    d.farmActions.push({ t: 'sell', items: { ...own.crate } });
    cash += EGG_GRADES.reduce((t, g) => t + own.crate[g] * c.market.prices[g], 0);
  }

  if (own.feedTier !== s.tier) d.farmActions.push({ t: 'setFeedTier', tier: s.tier });
  const need = Math.max(1, own.hens) * feedGramsPerHenDay();
  const stock = sum(own.feedGrams);
  if (stock < need * s.feedDays) {
    const bagPrice = ECONOMY.feed.tiers[s.tier].bagPrice * (own.unlocks.includes('hopper') ? 0.9 : 1) * 1.05;
    const bags = Math.min(10, Math.ceil((need * (s.feedDays + 2) - stock) / (ECONOMY.feed.bagKg * 1000)), Math.floor(cash / bagPrice));
    if (bags > 0) {
      d.farmActions.push({ t: 'buyFeed', tier: s.tier, bags });
      cash -= bags * bagPrice;
    }
  }

  const margin = henDailyMargin({ tier: s.tier, multiplier: m, unlocks: own.unlocks });
  const affordable = Math.floor((cash - s.reserve) / ECONOMY.hen.price);
  if (kind === 'old-money' && c.market.auctionHens > 0 && affordable > 0) {
    // bust farms' hens at half price: Old Money's favourite purchase
    const count = Math.min(20, c.market.auctionHens, affordable, Math.max(0, Math.floor(own.capacity * 1.1) - own.hens));
    if (count > 0) {
      d.farmActions.push({ t: 'buyHens', count });
      cash -= count * ECONOMY.hen.price * ECONOMY.agents.auctionPriceFactor;
    }
  } else if (margin > 0.05) {
    const target = Math.floor(own.capacity * s.fill(m));
    const count = Math.min(20, target - own.hens, affordable);
    if (count > 0) {
      d.farmActions.push({ t: 'buyHens', count });
      cash -= count * ECONOMY.hen.price;
    }
  }
  if (own.hens >= own.capacity * 0.9 && own.freePlots > 0 && margin > 0.1) {
    const kindCoop = cash - s.reserve >= ECONOMY.coops.kinds.deluxe.price ? 'deluxe' : 'red';
    if (cash - s.reserve >= ECONOMY.coops.kinds[kindCoop].price) {
      d.farmActions.push({ t: 'buildCoop', kind: kindCoop });
      cash -= ECONOMY.coops.kinds[kindCoop].price;
    }
  }
  const next = s.unlockOrder.find((u) => !own.unlocks.includes(u));
  if (next && cash - s.reserve * 2 >= ECONOMY.unlocks[next].price) d.farmActions.push({ t: 'buyUnlock', unlock: next });

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
  return d;
}

function supplier(c: AgentContext, kind: 'squeezer' | 'loyalist'): Decision {
  const d = emptyDecision(kind === 'squeezer' ? 'price in their desperation' : 'look after regulars, extend credit');
  const s = ECONOMY.suppliers;
  let cash = c.agent.cash;
  for (const t of ['cheap', 'standard', 'premium'] as const) {
    if ((c.agent.stock[t] ?? 0) < s.restockBelowBags) {
      const cost = ECONOMY.feed.tiers[t].bagPrice * s.wholesaleShare;
      const bags = Math.min(s.restockBags, Math.floor((cash - 40) / cost));
      if (bags > 0) {
        d.restock[t] = bags;
        cash -= bags * cost;
      }
    }
  }
  const field = players(c).map((f) => ({ f, desp: desperation(f.feedDays, f.cash) }));
  const mood = field.length ? field.reduce((a, x) => a + x.desp, 0) / field.length : 0;
  // the list price on top of each farm's own quote: the Squeezer leans on a hungry market
  d.markup = kind === 'squeezer' ? 1 + 0.25 * mood : 1;

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
      if (f.memory.deals > 0 || desp >= 0.2) {
        d.offers.push({ kind: 'feed-deal', farmId: f.farmId, tier, bags, priceShare: loyalistBagPrice(tier, f.memory.deals) / list, line: '' });
      }
      const cashShort = f.cash < list * 1.2;
      if (cashShort && f.feedDays < 3 && f.owesMe + bags * list < s.loyalist.creditLimit && f.memory.misses === 0) {
        d.offers.push({ kind: 'credit-terms', farmId: f.farmId, tier, bags, priceShare: loyalistBagPrice(tier, f.memory.deals) / list, line: '' });
      }
    }
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
  // everyday flour-and-egg buying through the book
  for (const g of ['white', 'cream'] as const) {
    const price = c.market.prices[g] * 0.97;
    const want = Math.min(30, Math.floor((c.agent.cash * 0.3) / Math.max(0.1, price)));
    if (want > 0) d.buyOrders.push({ grade: g, qty: want, priceShare: 0.97 });
  }
  for (const f of c.farms) {
    for (const o of f.sells) {
      if ((o.grade === 'white' || o.grade === 'cream') && o.price <= c.market.prices[o.grade] * 1.05) d.fills.push({ orderId: o.orderId, qty: o.qty });
    }
  }
  return d;
}

function trader(c: AgentContext): Decision {
  const d = emptyDecision('pay up for quality, walk from farms that slip');
  const t = ECONOMY.buyers.trader;
  const m = c.market.multiplier;
  const glut = c.market.supplyYesterday > ECONOMY.market.referenceSupply * 1.05 || m <= ECONOMY.market.crashAt + 0.1;
  for (const f of players(c)) {
    if (glut) d.offers.push({ kind: 'glut-warning', farmId: f.farmId, line: '' });
    if (f.memory.sulking || f.quality < t.minQuality) continue;
    for (const g of ['golden', 'brown'] as const) {
      if (f.crate[g] >= (g === 'golden' ? 1 : 3)) {
        const q = Math.min(f.crate[g], g === 'golden' ? 3 : 12);
        d.offers.push({ kind: 'premium-order', farmId: f.farmId, grade: g, qty: q, priceShare: traderPrice(g, m) / c.market.prices[g], line: '' });
        break;
      }
    }
  }
  for (const g of ['brown', 'golden'] as const) {
    const want = Math.min(20, Math.floor((c.agent.cash * 0.3) / Math.max(0.1, c.market.prices[g])));
    if (want > 0) d.buyOrders.push({ grade: g, qty: want, priceShare: 1.05 });
  }
  for (const f of c.farms) {
    for (const o of f.sells) {
      if ((o.grade === 'brown' || o.grade === 'golden') && o.price <= traderPrice(o.grade, m) * 0.95) d.fills.push({ orderId: o.orderId, qty: o.qty });
    }
  }
  return d;
}

function wholesaler(c: AgentContext): Decision {
  const d = emptyDecision('buy anything cheap, move volume');
  const w = ECONOMY.buyers.wholesaler;
  const m = c.market.multiplier;
  const glut = c.market.supplyYesterday > ECONOMY.market.referenceSupply * 1.2;
  let budget = c.agent.cash;
  for (const f of players(c)) {
    const eggs = sum(f.crate);
    if (glut) d.offers.push({ kind: 'glut-warning', farmId: f.farmId, line: '' });
    if (f.memory.sulking || eggs < w.bulkQty.min) continue;
    const q = Math.min(eggs, w.bulkQty.max);
    const cost = q * wholesalePrice('white', m);
    if (budget < cost) continue;
    d.offers.push({ kind: 'bulk-order', farmId: f.farmId, qty: q, priceShare: w.priceShare, line: '' });
    budget -= cost;
  }
  for (const g of EGG_GRADES) {
    const want = Math.min(40, Math.floor((budget * 0.15) / Math.max(0.1, c.market.prices[g] * 0.7)));
    if (want > 0) d.buyOrders.push({ grade: g, qty: want, priceShare: 0.7 });
  }
  for (const f of c.farms) for (const o of f.sells) if (o.price <= c.market.prices[o.grade] * 0.78) d.fills.push({ orderId: o.orderId, qty: o.qty });
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
