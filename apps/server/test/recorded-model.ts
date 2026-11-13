// A recorded stand-in for the model. NEAR AI Cloud answers 402 (no credits), so the model's side of
// the 30-day comparison replays recorded decisions: per agent kind and situation (glut, scarcity,
// normal), a few in-character decisions with reasons that differ from the rules (other price
// shares, holding, expansion timing), and some replies that are not usable, to exercise the
// fallbacks. scripts/record-agent-decisions.ts writes them to test/fixtures/agent-replies.json:
// authored here by default, or recorded from the real model with --live once there are credits.
//
// Replies are recorded against a sample context (player farms player-0 and player-1, an AI farm
// rival-0, sell orders sell-0 and sell-1); the replay maps those ids to the live ones in order and
// scales a rival's numbers to its own farm, as a model reading the live observation would.
import { AGENT_KINDS, ECONOMY, feedGramsPerHenDay, type AgentKind } from '@coys/shared';
import { NearAiClient } from '../src/ai/nearai';
import { CAST } from '../src/agents/cast';
import { emptyDecision, hardDay, type AgentContext, type Decision, type FarmAction, type FarmBrief } from '../src/agents/decision';
import { glutTrend, ruleDecision, scarceTrend } from '../src/agents/rules';

export const SITUATIONS = ['glut', 'scarcity', 'normal'] as const;
export type Situation = (typeof SITUATIONS)[number];

/** What a reply was recorded against, as far as the replay needs it to scale a reply to a live agent. */
export interface Sample {
  cash: number;
  /** Rivals: the farm (hens, coop room, crate, feed in grams). */
  own: { hens: number; capacity: number; crate: { white: number; cream: number; brown: number; golden: number }; feedGrams: number } | null;
  /** Suppliers: bags per tier. */
  stock: Record<string, number>;
}

export interface AgentReplies {
  about: string;
  /** 'authored' stand-ins, or the model the replies were recorded from. */
  source: string;
  /** Per kind and situation: what the replies were recorded against, and the replies. */
  samples: Record<AgentKind, Record<Situation, { sample: Sample; replies: Decision[] }>>;
  /** Replies the server must not use: not JSON, half a decision, a number out of range. */
  invalid: string[];
  /** Weekly reflections, per kind. */
  reflections: Record<AgentKind, string[]>;
}

/** The situation a decision is made in: a glut or crash day, lasting scarcity, or neither. */
export function situationOf(c: AgentContext): Situation {
  if (hardDay(c) && !c.agent.struggling) return 'glut';
  if (glutTrend(c)) return 'glut';
  if (scarceTrend(c) || c.market.multiplier >= 1.25) return 'scarcity';
  return 'normal';
}

const MARKETS: Record<Situation, { multiplier: number; supplyYesterday: number; trend: number[]; slope: number }> = {
  glut: { multiplier: 0.62, supplyYesterday: 330, trend: [1.2, 1.3, 1.35], slope: -0.12 },
  scarcity: { multiplier: 1.35, supplyYesterday: 190, trend: [0.82, 0.85, 0.8], slope: 0.08 },
  normal: { multiplier: 1.02, supplyYesterday: 236, trend: [1, 0.98, 1.02], slope: 0 },
};

const OWN: Partial<
  Record<AgentKind, { hens: number; capacity: number; crate: { white: number; cream: number; brown: number; golden: number }; tier: 'cheap' | 'premium'; feedKg: number; cash: number }>
> = {
  upstart: { hens: 26, capacity: 30, crate: { white: 10, cream: 6, brown: 3, golden: 0 }, tier: 'cheap', feedKg: 6, cash: 70 },
  'old-money': { hens: 100, capacity: 102, crate: { white: 30, cream: 35, brown: 30, golden: 3 }, tier: 'premium', feedKg: 60, cash: 420 },
};

const brief = (farmId: string, owner: 'player' | 'agent', over: Partial<FarmBrief>): FarmBrief => ({
  farmId,
  name: farmId,
  owner,
  hens: 24,
  capacity: 30,
  crate: { white: 12, cream: 8, brown: 5, golden: 0 },
  dailyEggs: 19,
  feedDays: 3,
  cash: 60,
  quality: 0.38,
  sells: [],
  hasContractWithMe: false,
  owesMe: 0,
  memory: { deals: 1, refusals: 0, hagglesWon: 0, hagglesLost: 0, misses: 0, sulking: false },
  ...over,
});

/** The context a reply is recorded against: two player farms, an AI farm, two sell orders. */
export function sampleContext(kind: AgentKind, situation: Situation): AgentContext {
  const m = MARKETS[situation];
  const own = OWN[kind];
  const base = ECONOMY.eggs.basePrice;
  return {
    day: 12,
    agent: {
      id: `sample-${kind}`,
      kind,
      role: CAST[kind].role,
      name: CAST[kind].names[0] ?? kind,
      cash: own?.cash ?? 520,
      stock: CAST[kind].role === 'supplier' ? { cheap: 28, standard: 45, premium: 20 } : {},
      struggling: false,
      entrant: null,
      reflection: null,
      reasons: [],
    },
    market: {
      multiplier: m.multiplier,
      prices: { white: base.white * m.multiplier, cream: base.cream * m.multiplier, brown: base.brown * m.multiplier, golden: base.golden * m.multiplier },
      reference: 240,
      supplyYesterday: m.supplyYesterday,
      history: [],
      crash: m.multiplier <= ECONOMY.market.crashAt,
      auctionHens: situation === 'glut' ? 12 : 0,
      trend: { supplyOverDemand: m.trend, slope: m.slope },
      busts: situation === 'glut' ? [{ name: 'Hatch and Dash', ai: true, day: 10 }] : [],
      open: { aiFarms: 3, playerFarms: 2 },
    },
    own: own
      ? {
          hens: own.hens,
          capacity: own.capacity,
          freePlots: 1,
          crate: own.crate,
          feedGrams: { cheap: own.tier === 'cheap' ? own.feedKg * 1000 : 0, standard: 0, premium: own.tier === 'premium' ? own.feedKg * 1000 : 0 },
          feedTier: own.tier,
          unlocks: [],
          owes: 0,
        }
      : null,
    farms: [
      brief('player-0', 'player', { cash: 18, feedDays: 1.2, memory: { deals: 3, refusals: 1, hagglesWon: 0, hagglesLost: 1, misses: 0, sulking: false } }),
      brief('player-1', 'player', { hens: 40, capacity: 42, dailyEggs: 31, quality: 0.45, cash: 140, sells: [{ orderId: 'sell-0', grade: 'white', qty: 10, price: 0.95 * m.multiplier }] }),
      brief('rival-0', 'agent', { hens: 30, sells: [{ orderId: 'sell-1', grade: 'brown', qty: 6, price: base.brown * m.multiplier * 0.7 }] }),
    ],
  };
}

type Variant = (d: Decision, c: AgentContext) => Decision;
const v =
  (reason: string, change: (d: Decision, c: AgentContext) => void): Variant =>
  (rule, c) => {
    const d: Decision = JSON.parse(JSON.stringify(rule)) as Decision;
    d.note = 'recorded stand-in';
    d.reason = reason;
    change(d, c);
    return d;
  };
const sellShare = (d: Decision, c: AgentContext, keep: number): void => {
  const crate = c.own?.crate;
  if (!crate) return;
  d.farmActions = d.farmActions.filter((a) => a.t !== 'sell');
  d.farmActions.unshift({
    t: 'sell',
    items: {
      white: Math.floor(crate.white * (1 - keep)),
      cream: Math.floor(crate.cream * (1 - keep)),
      brown: Math.floor(crate.brown * (1 - keep)),
      golden: crate.golden ? Math.floor(crate.golden * (1 - keep)) : 0,
    },
  });
};
const noHens = (d: Decision): void => {
  d.farmActions = d.farmActions.filter((a) => a.t !== 'buyHens' && a.t !== 'buildCoop');
};
const shares = (d: Decision, s: number, kinds?: string[]): void => {
  for (const o of d.offers) if ('priceShare' in o && (!kinds || kinds.includes(o.kind))) o.priceShare = s;
};

/** In-character decisions per kind and situation, each a change from what the rules would do. */
const VARIANTS: Record<AgentKind, Record<Situation, Variant[]>> = {
  upstart: {
    glut: [
      v('Flooded! Everything must go, cheap. I will be back bigger.', (d) => {
        noHens(d);
        for (const s of d.sellOrders) s.priceShare = 0.55;
      }),
      v('Everyone is scared. I am buying hens while they are cheap!', (d) => {
        d.farmActions.push({ t: 'buyHens', count: 6 });
        for (const s of d.sellOrders) s.priceShare = 0.7;
      }),
      v('Holding some eggs a day. Prices bounce back, right?', (d, c) => {
        sellShare(d, c, 0.5);
        noHens(d);
        d.sellOrders = [];
      }),
    ],
    scarcity: [
      v('Eggs are short! Ten more hens and a new coop, let us go!', (d) => {
        noHens(d);
        d.farmActions.push({ t: 'buyHens', count: 10 }, { t: 'buildCoop', kind: 'red' });
      }),
      v('Borrowing feed so every coin goes into hens!', (d) => {
        noHens(d);
        d.farmActions.push({ t: 'buyFeedOnCredit', tier: 'cheap', bags: 3 }, { t: 'buyHens', count: 8 });
      }),
      v('Short supply, high prices. Selling it all, undercutting the slow.', (d) => shares(d, 0.88)),
    ],
    normal: [
      v('Steady day. Selling everything, undercutting the slow ones.', (d) => shares(d, 0.9)),
      v('A few more hens. Always be growing!', (d) => {
        noHens(d);
        d.farmActions.push({ t: 'buyHens', count: 4 });
      }),
    ],
  },
  'old-money': {
    glut: [
      v('We hold seventy percent of our eggs. Gluts pass.', (d, c) => {
        sellShare(d, c, 0.7);
        noHens(d);
      }),
      v('We hold half and buy cheap hens from the fallen.', (d, c) => {
        sellShare(d, c, 0.5);
        noHens(d);
        d.farmActions.push({ t: 'buyHens', count: 10 });
      }),
      v('The plain eggs go. The golden ones wait for a better day.', (d, c) => {
        sellShare(d, c, 0);
        for (const a of d.farmActions) if (a.t === 'sell') a.items.golden = 0;
        noHens(d);
      }),
    ],
    scarcity: [
      v('Scarcity rewards the patient. We sell all and add hens.', (d, c) => {
        sellShare(d, c, 0);
        noHens(d);
        d.farmActions.push({ t: 'buyHens', count: 10 }, { t: 'buyUnlock', unlock: 'grader' });
      }),
      v('A good price. We sell, and we keep our cash.', (d, c) => {
        sellShare(d, c, 0);
        noHens(d);
      }),
    ],
    normal: [
      v('Business as usual. We sell at a fair price.', (d, c) => sellShare(d, c, 0)),
      v('We offer to take a struggling neighbour off its hens. A kindness.', (d, c) => {
        sellShare(d, c, 0);
        d.offers = [{ kind: 'buyout-offer', farmId: 'player-0', hens: 4, priceShare: 0.8, line: '' }];
      }),
    ],
  },
  squeezer: {
    glut: [
      v('Eggs are cheap, feed is not. Pay up.', (d) => {
        d.markup = 1.1;
        shares(d, 1.25);
      }),
      v('Gluts make farms desperate. Prices up.', (d) => {
        d.markup = 1.2;
      }),
    ],
    scarcity: [
      v('Everyone is buying hens. Feed costs more now.', (d) => {
        d.markup = 1.3;
        d.restock.standard = Math.max(d.restock.standard, 80);
      }),
      v('Busy street, thin barns. My price went up.', (d) => {
        d.markup = 1.25;
      }),
    ],
    normal: [v('Same as ever: my price. Take it or leave it.', (d) => (d.markup = 1.15))],
  },
  loyalist: {
    glut: [
      v('Hard times, friend. Credit for regulars, a little off the list.', (d) => {
        d.markup = 0.92;
        d.offers = [
          { kind: 'credit-terms', farmId: 'player-0', tier: 'standard', bags: 2, priceShare: 0.95, line: '' },
          { kind: 'credit-terms', farmId: 'player-1', tier: 'standard', bags: 2, priceShare: 0.95, line: '' },
        ];
      }),
      v('Rough week on the street. Same fair price, friend.', (d) => (d.markup = 0.95)),
    ],
    scarcity: [
      v('Demand is up. Barn stocked so nobody goes hungry.', (d) => {
        d.restock = { cheap: 60, standard: 100, premium: 40 };
      }),
    ],
    normal: [v('Fair price for regulars, as always.', (d) => (d.markup = 0.98))],
  },
  bakery: {
    glut: [
      v('Cheap eggs! Filling the larder for the week.', (d) => {
        d.buyOrders = [
          { grade: 'white', qty: 50, priceShare: 0.9 },
          { grade: 'cream', qty: 50, priceShare: 0.9 },
        ];
        for (const o of d.offers) if (o.kind === 'standing-contract') o.priceShare = 1.1;
      }),
      v('The ovens are hungry and eggs are cheap. Buying.', (d) => {
        d.buyOrders = [
          { grade: 'white', qty: 40, priceShare: 0.95 },
          { grade: 'cream', qty: 40, priceShare: 0.95 },
        ];
      }),
    ],
    scarcity: [
      v('Eggs are scarce. Locking in contracts for the ovens.', (d) => {
        d.buyOrders = [{ grade: 'white', qty: 10, priceShare: 1 }];
        for (const o of d.offers) if (o.kind === 'standing-contract') Object.assign(o, { priceShare: 1.2, days: 8 });
      }),
    ],
    normal: [
      v('Steady baking. Contracts for reliable farms.', (d) => {
        for (const o of d.offers) if (o.kind === 'standing-contract') o.priceShare = 1.12;
      }),
    ],
  },
  trader: {
    glut: [
      v('Fine eggs going cheap. Buying for the town stall.', (d) => {
        d.buyOrders = [
          { grade: 'brown', qty: 30, priceShare: 0.95 },
          { grade: 'golden', qty: 4, priceShare: 0.95 },
        ];
        shares(d, 1.1, ['premium-order']);
      }),
    ],
    scarcity: [
      v('Good browns are rare. I pay well for quality.', (d) => {
        d.buyOrders = [{ grade: 'brown', qty: 8, priceShare: 1.1 }];
        shares(d, 1.3, ['premium-order']);
      }),
    ],
    normal: [v('Quality at a fair premium. Bring me browns.', (d) => shares(d, 1.2, ['premium-order']))],
  },
  wholesaler: {
    glut: [
      v('Glut. Buying deep and cheap.', (d) => {
        d.buyOrders = (['white', 'cream', 'brown', 'golden'] as const).map((grade) => ({ grade, qty: 80, priceShare: 0.62 }));
        shares(d, 0.65, ['bulk-order']);
      }),
      v('Glut. Carts out. Paying a little more for volume.', (d) => {
        d.buyOrders = (['white', 'cream', 'brown', 'golden'] as const).map((grade) => ({ grade, qty: 60, priceShare: 0.68 }));
      }),
    ],
    scarcity: [
      v('Scarce. Buying light.', (d) => {
        d.buyOrders = (['white', 'cream'] as const).map((grade) => ({ grade, qty: 15, priceShare: 0.72 }));
        d.offers = d.offers.filter((o) => o.kind !== 'bulk-order');
      }),
    ],
    normal: [v('Volume at the right price.', (d) => shares(d, 0.72, ['bulk-order']))],
  },
};

const REFLECTIONS: Record<AgentKind, string[]> = {
  upstart: [
    'Big week! More hens than ever, and sure, the glut stung, but I am still here. Next week I keep a little feed money back. A little.',
    'Rough one. I grew into a flood and paid for it. Next week I watch the street before I buy hens. Then I buy hens.',
  ],
  'old-money': [
    'A satisfactory week. We held our eggs through the slump and sold into the recovery, as always. Next week: the same patience, and an eye on the auction.',
    'Upstarts flooded the street and the price suffered for it. We lost a little, they lost more. Next week we hold more and buy their hens.',
  ],
  squeezer: [
    'Hungry farms paid my price, mostly. A few walked. Next week I squeeze the desperate ones and leave the rest be.',
    'Thin week: too many refusals. Next week I trim the list price a hair, only a hair.',
  ],
  loyalist: [
    'The regulars kept coming and paid what they owed. Next week I keep the barn full and a little credit ready for anyone short.',
    'A hard week for the street, friend. Next week a little off the list for the regulars, and credit for the honest ones.',
  ],
  bakery: [
    'The ovens stayed full and the contracts mostly delivered. Next week I lock in a longer contract with the farm that never missed.',
    'A lean week: two missed deliveries and dear eggs. Next week fewer contracts, steadier farms.',
  ],
  trader: [
    'Good browns moved at good prices; one farm slipped on quality and I walked. Next week I pay up only where the quality holds.',
    'A thin week at the stall. Next week I buy deeper while fine eggs are cheap.',
  ],
  wholesaler: ['Volume moved. Margin held. Next week: more carts in the glut.', 'Bought too dear on a scarce day. Next week: lighter bids when eggs are short.'],
};

/** The numbers of a context the replay scales by. */
export function sampleOf(c: AgentContext): Sample {
  const o = c.own;
  return {
    cash: c.agent.cash,
    own: o ? { hens: o.hens, capacity: o.capacity, crate: o.crate, feedGrams: o.feedGrams.cheap + o.feedGrams.standard + o.feedGrams.premium } : null,
    stock: c.agent.role === 'supplier' ? c.agent.stock : {},
  };
}

/** The fixture the recording script writes when there is no model to record from. */
export function authoredReplies(): AgentReplies {
  const samples = {} as AgentReplies['samples'];
  for (const kind of AGENT_KINDS) {
    samples[kind] = {} as AgentReplies['samples'][AgentKind];
    for (const situation of SITUATIONS) {
      const c = sampleContext(kind, situation);
      const rule = ruleDecision(c);
      samples[kind][situation] = { sample: sampleOf(c), replies: VARIANTS[kind][situation].map((f) => f(rule, c)) };
    }
  }
  return {
    about: 'Recorded agent replies for the 30-day model-vs-rules comparison (apps/server/test/agent-compare.test.ts). Written by scripts/record-agent-decisions.ts.',
    source: 'authored',
    samples,
    invalid: [
      'I think I will buy some eggs today.',
      '{"note":"forgot the rest"}',
      JSON.stringify({ ...emptyDecision('too keen', 'Markup to the moon.'), markup: 9 }),
      `${JSON.stringify(emptyDecision('cut off', 'Half a reply')).slice(0, 60)}`,
    ],
    reflections: REFLECTIONS,
  };
}

/** Per-call counts the comparison and the credits report read. */
export interface ReplayTally {
  calls: number;
  decisions: number;
  reflections: number;
  invalid: number;
  byModel: Record<string, number>;
  promptChars: number;
  replyChars: number;
  /** Prompt and reply characters of decision calls only, for the per-call average. */
  decisionPromptChars: number;
  decisionReplyChars: number;
  /** Calls and tokens (as reported) per model. */
  tokens: Record<string, { calls: number; prompt: number; completion: number }>;
}

const hash = (s: string): number => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);

/**
 * A sample reply, mapped to the live observation as a model reading it would: ids in order, and a
 * reply's intent kept rather than its numbers. A rival sells the same share of its crate, buys feed
 * up to the same days of feed (and some when it is nearly out), fills its coops to the same share
 * and spends the same share of its cash on hens, and builds or buys a machine only with the cash for
 * it; a supplier restocks up to the same stock.
 */
export function replay(reply: Decision, sample: Sample, c: AgentContext): Decision {
  const d: Decision = JSON.parse(JSON.stringify(reply)) as Decision;
  const players = c.farms.filter((f) => f.owner === 'player').map((f) => f.farmId);
  const ai = c.farms.filter((f) => f.owner === 'agent').map((f) => f.farmId);
  const orders = c.farms.flatMap((f) => f.sells.map((o) => o.orderId));
  const farmId = (id: string): string => {
    const [what, n] = id.split('-');
    const list = what === 'player' ? players : what === 'rival' ? ai : null;
    return (list && list[Number(n)]) ?? id;
  };
  for (const o of d.offers) o.farmId = farmId(o.farmId);
  for (const f of d.fills) f.orderId = (f.orderId.startsWith('sell-') && orders[Number(f.orderId.slice(5))]) || f.orderId;
  const own = c.own;
  const was = sample.own;
  if (was && own) {
    const bag = ECONOMY.feed.bagKg * 1000;
    const perHen = feedGramsPerHenDay();
    const stock = own.feedGrams.cheap + own.feedGrams.standard + own.feedGrams.premium;
    const actions: FarmAction[] = [];
    let fed = false;
    for (const a of d.farmActions) {
      if (a.t === 'sell') {
        for (const g of ['white', 'cream', 'brown', 'golden'] as const) a.items[g] = Math.round((a.items[g] / Math.max(1, was.crate[g])) * own.crate[g]);
        actions.push(a);
      } else if (a.t === 'buyFeed' || a.t === 'buyFeedOnCredit') {
        const days = (was.feedGrams + a.bags * bag) / (Math.max(1, was.hens) * perHen);
        const bags = Math.min(10, Math.ceil((days * Math.max(1, own.hens) * perHen - stock) / bag));
        if (bags > 0) actions.push({ ...a, tier: own.feedTier, bags });
        fed = true;
      } else if (a.t === 'buyHens') {
        const fill = Math.min(1.3, (was.hens + a.count) / Math.max(1, was.capacity));
        const share = (a.count * ECONOMY.hen.price) / Math.max(1, sample.cash);
        const count = Math.min(20, Math.round(fill * own.capacity - own.hens), Math.floor((share * c.agent.cash) / ECONOMY.hen.price));
        if (count > 0) actions.push({ t: 'buyHens', count });
      } else if (a.t === 'buildCoop') {
        if (own.freePlots > 0 && c.agent.cash >= ECONOMY.coops.kinds[a.kind].price * 1.5) actions.push(a);
      } else if (a.t === 'buyUnlock') {
        if (!own.unlocks.includes(a.unlock) && c.agent.cash >= ECONOMY.unlocks[a.unlock].price * 2) actions.push(a);
      } else actions.push(a);
    }
    // nearly out of feed: whatever it recorded, a farm reading its trough buys some
    if (!fed && stock < own.hens * perHen * 2) actions.push({ t: 'buyFeed', tier: own.feedTier, bags: Math.max(1, Math.min(10, Math.ceil((own.hens * perHen * 4 - stock) / bag))) });
    d.farmActions = actions;
    const flock = own.hens / Math.max(1, was.hens);
    for (const s of d.sellOrders) s.qty = Math.max(1, Math.min(200, Math.round(s.qty * flock)));
  }
  if (c.agent.role === 'supplier') {
    for (const t of ['cheap', 'standard', 'premium'] as const) d.restock[t] = Math.max(0, Math.min(200, (sample.stock[t] ?? 0) + d.restock[t] - (c.agent.stock[t] ?? 0)));
  }
  return d;
}

/**
 * The fake NEAR AI client: a fetch that answers each decision from the recorded replies for the
 * agent's kind and situation (a variant picked by agent and day), each reflection from the recorded
 * ones, and every `invalidEvery`th call with an unusable reply. Usage is counted as a tokenizer
 * would (about 3 characters a token).
 */
export function recordedModel(fixture: AgentReplies, opts: { invalidEvery?: number } = {}): { client: NearAiClient; tally: ReplayTally } {
  const every = opts.invalidEvery ?? 12;
  const tally: ReplayTally = { calls: 0, decisions: 0, reflections: 0, invalid: 0, byModel: {}, promptChars: 0, replyChars: 0, decisionPromptChars: 0, decisionReplyChars: 0, tokens: {} };
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[]; response_format?: unknown };
    tally.calls++;
    tally.byModel[body.model] = (tally.byModel[body.model] ?? 0) + 1;
    const prompt = body.messages.reduce((n, m) => n + m.content.length, 0);
    let content: string;
    if (!body.response_format) {
      // a weekly reflection: the kind is named in the system prompt
      tally.reflections++;
      const kind = AGENT_KINDS.find((k) => body.messages[0]?.content.includes(`(${k})`)) ?? 'upstart';
      const list = fixture.reflections[kind];
      content = list[hash(body.messages[1]?.content ?? '') % list.length] ?? '';
    } else {
      tally.decisions++;
      const c = JSON.parse(body.messages[1]?.content ?? '{}') as AgentContext;
      if (tally.calls % every === 0) {
        tally.invalid++;
        content = fixture.invalid[tally.invalid % fixture.invalid.length] ?? '';
      } else {
        const entry = fixture.samples[c.agent.kind][situationOf(c)];
        const reply = entry.replies[hash(`${c.agent.name}:${c.day}`) % entry.replies.length] ?? emptyDecision('nothing recorded', 'Quiet day.');
        content = JSON.stringify(replay(reply, entry.sample, c));
      }
      tally.decisionPromptChars += prompt;
      tally.decisionReplyChars += content.length;
    }
    tally.promptChars += prompt;
    tally.replyChars += content.length;
    const usage = { prompt_tokens: Math.ceil(prompt / 3), completion_tokens: Math.ceil(content.length / 3) };
    const t = (tally.tokens[body.model] ??= { calls: 0, prompt: 0, completion: 0 });
    t.calls++;
    t.prompt += usage.prompt_tokens;
    t.completion += usage.completion_tokens;
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }));
  }) as typeof fetch;
  return { client: new NearAiClient({ apiKey: 'recorded', fetchImpl }), tally };
}
