// Badges: cosmetic only, they change nothing in the game. Each badge counts one number the server
// keeps for a farm (its metric) and is earned when that number reaches a threshold: three thresholds
// for a badge with levels (bronze, silver, gold), or one for a plain badge. A secret badge shows as a
// mystery until it is earned. The server evaluates them (apps/server/src/game/badges.ts) after the
// actions that can move them and at every day close; the client draws them from the badge sheets.
import { ECONOMY, LAND_IDS } from './economy';

/** Row names of the x-badge-icons sheet (16x16 art px, drawn centred on the 32x32 frame). */
export const BADGE_ICONS = [
  'egg',
  'egg-golden',
  'eggs-crate',
  'egg-cracked',
  'coin',
  'cash-burst',
  'market',
  'shop',
  'feed',
  'hen',
  'clock',
  'ledger',
  'glut',
  'peak',
  'haggle',
  'contract',
  'coop',
  'tophat',
  'old-hen',
  'conveyor',
  'grader',
  'cart',
  'hopper',
  'clerk',
  'repair',
  'gear',
  'bust',
  'rank',
  'number-one',
  'ticket',
  'feather-fluff',
  'feather-plume',
  'feather-quill',
  'feather-golden-quill',
  'good-standing',
  'night-owl',
  'crow',
  'mystery',
  'chick',
  'sparkle',
] as const;
export type BadgeIcon = (typeof BADGE_ICONS)[number];

/** Sheets of the badge art: frames (rows bronze, silver, gold, plain, locked; frame 0 still, 1 to 3 a glint) and icons. */
export const BADGE_FRAME_SHEET = 'x-badge-frames';
export const BADGE_ICON_SHEET = 'x-badge-icons';

export const BADGE_CATEGORIES = ['eggs', 'market', 'haggling', 'contracts', 'flock', 'machines', 'rivals', 'feathers', 'days', 'fun'] as const;
export type BadgeCategory = (typeof BADGE_CATEGORIES)[number];

export const BADGE_TIERS = ['bronze', 'silver', 'gold'] as const;
export type BadgeTier = (typeof BADGE_TIERS)[number];
/** What a farm has of a badge: a tier of a badge with levels, or plain for a badge without. */
export type BadgeLevel = BadgeTier | 'plain';

/** Order of the levels, lowest first (plain counts as one level). */
export const BADGE_LEVEL_RANK: Record<BadgeLevel, number> = { plain: 1, bronze: 1, silver: 2, gold: 3 };

/** The numbers the server counts for badges. Each is a whole number (coins in whole coins, shares in percent). */
export const BADGE_METRICS = [
  'eggsCollected',
  'eggsPicked',
  'goldenCollected',
  'bestDayLaid',
  'crateNow',
  'conveyorSaved',
  'eggsBroken',
  'eggsSold',
  'glutSales',
  'peakSales',
  'goldenPeakSales',
  'ordersFilled',
  'bigTrades',
  'bestShare',
  'cashNow',
  'netWorth',
  'bestDayProfit',
  'profitDays',
  'biggestSale',
  'hagglesWon',
  'hagglesLost',
  'haggleKinds',
  'refusals',
  'deliveries',
  'bestDeliveryStreak',
  'cleanContracts',
  'contractsTaken',
  'fullCoops',
  'hens',
  'traitsSeen',
  'oldestHen',
  'tophats',
  'coops',
  'deluxeCoops',
  'auctionHens',
  'ownsConveyor',
  'ownsGrader',
  'ownsCart',
  'ownsHopper',
  'ownsClerk',
  'machinesOwned',
  'repairs',
  'bestRepairStreak',
  'daysNoBreakdown',
  'breakdowns',
  'machineUnits',
  'rivalsOutlasted',
  'top3Days',
  'firstDays',
  'topHalfDays',
  'bestClimb',
  'ticketsWon',
  'mintedFluff',
  'mintedPlume',
  'mintedQuill',
  'mintedGoldenQuill',
  'mintedGrades',
  'milestonesReached',
  'goodDays',
  'daysPlayed',
  'daysClosed',
  'fedDays',
  'premiumDays',
  'nightActions',
  'bestCrowStreak',
  'shoestringDays',
  'renamed',
  'landPlots',
  'landCoops',
] as const;
export type BadgeMetric = (typeof BADGE_METRICS)[number];

/** The rules a few badges read, beside ECONOMY's own numbers. Cosmetic: none of them moves a price. */
export const BADGE_RULES = {
  /** A street sale at or under this multiplier is a sale into a glut (the crash line). */
  glutAt: ECONOMY.market.crashAt,
  /** A street sale at or over this multiplier is a sale at a peak. */
  peakAt: 1.5,
  /** One trade worth this many coins or more is a big trade (the board's big trades). */
  bigTradeCoins: 25,
  /** The first share of a day is dawn: an action then keeps the rooster crow streak. */
  dawnShare: 0.1,
  /** A day closed with less than this many coins (and the farm still farming) is a shoestring day. */
  shoestringCoins: 1,
  /** Every look a hen can have: body colours, eyes, combs and accessories. */
  traits: ['body:cream', 'body:brown', 'body:black', 'eyes:default', 'eyes:sleepy', 'eyes:wild', 'comb:default', 'comb:spiky', 'comb:mohawk', 'comb:nub', 'accessory:none', 'accessory:tophat', 'accessory:bowtie', 'accessory:shades'],
  /** The traders a farm haggles with: both suppliers and all three buyers. */
  haggleKinds: ['squeezer', 'loyalist', 'bakery', 'trader', 'wholesaler'],
} as const;

export interface BadgeDef {
  id: string;
  name: string;
  category: BadgeCategory;
  icon: BadgeIcon;
  /** Hidden (drawn as a mystery) until earned. */
  secret: boolean;
  metric: BadgeMetric;
  /** One threshold (a plain badge), or three (bronze, silver, gold), rising. */
  levels: readonly [number] | readonly [number, number, number];
  /** One line: what earns the badge at a threshold. */
  text: (n: number) => string;
}

const times = (n: number): string => (n === 1 ? 'ONCE' : `${n} TIMES`);
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const s = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 'S'}`;

type Spec = Omit<BadgeDef, 'secret' | 'category'> & { secret?: boolean };
const group = (category: BadgeCategory, specs: Spec[]): BadgeDef[] => specs.map((b) => ({ ...b, category, secret: b.secret ?? false }));

export const BADGES: readonly BadgeDef[] = [
  ...group('eggs', [
    { id: 'first-egg', name: 'FIRST EGG', icon: 'egg', metric: 'eggsCollected', levels: [1], text: () => 'PUT YOUR FIRST EGG IN THE CRATE.' },
    { id: 'crate-filler', name: 'CRATE FILLER', icon: 'eggs-crate', metric: 'eggsCollected', levels: [100, 1000, 10000], text: (n) => `PUT ${n} EGGS IN THE CRATE.` },
    { id: 'hand-picked', name: 'HAND PICKED', icon: 'egg', metric: 'eggsPicked', levels: [50, 500, 2500], text: (n) => `PICK UP ${n} EGGS BY HAND.` },
    { id: 'golden-egg', name: 'GOLDEN EGG', icon: 'egg-golden', metric: 'goldenCollected', levels: [1], text: () => 'COLLECT A GOLDEN EGG.' },
    { id: 'golden-hoard', name: 'GOLDEN HOARD', icon: 'egg-golden', metric: 'goldenCollected', levels: [10, 50, 250], text: (n) => `COLLECT ${n} GOLDEN EGGS.` },
    { id: 'laying-day', name: 'LAYING DAY', icon: 'hen', metric: 'bestDayLaid', levels: [25, 60, 150], text: (n) => `YOUR HENS LAY ${n} EGGS IN ONE DAY.` },
    { id: 'packed-crate', name: 'PACKED CRATE', icon: 'eggs-crate', metric: 'crateNow', levels: [50, 150, 400], text: (n) => `HOLD ${n} EGGS IN THE CRATE AT ONCE.` },
    { id: 'safe-landing', name: 'SAFE LANDING', icon: 'conveyor', metric: 'conveyorSaved', levels: [10, 100, 500], text: (n) => `THE CONVEYOR SAVES ${n} EGGS FROM CRACKING.` },
  ]),
  ...group('market', [
    { id: 'first-sale', name: 'FIRST SALE', icon: 'coin', metric: 'eggsSold', levels: [1], text: () => 'SELL YOUR FIRST EGG.' },
    { id: 'market-stall', name: 'MARKET STALL', icon: 'market', metric: 'eggsSold', levels: [100, 1000, 5000], text: (n) => `SELL ${n} EGGS.` },
    { id: 'into-the-glut', name: 'INTO THE GLUT', icon: 'glut', metric: 'glutSales', levels: [1], text: () => `SELL TO THE STREET IN A GLUT, WITH PRICES AT ${pct(BADGE_RULES.glutAt)} OR LESS.` },
    { id: 'top-of-the-market', name: 'TOP OF THE MARKET', icon: 'peak', metric: 'peakSales', levels: [1, 5, 20], text: (n) => `SELL TO THE STREET AT A PEAK (PRICES AT ${pct(BADGE_RULES.peakAt)} OR MORE) ${times(n)}.` },
    { id: 'order-filler', name: 'ORDER FILLER', icon: 'shop', metric: 'ordersFilled', levels: [1, 10, 50], text: (n) => `FILL ${s(n, 'BUYER ORDER')} FROM THE BOOK.` },
    { id: 'big-trade', name: 'BIG TRADE', icon: 'cash-burst', metric: 'bigTrades', levels: [1], text: () => `MAKE ONE SALE WORTH ${BADGE_RULES.bigTradeCoins} COINS OR MORE.` },
    { id: 'market-mover', name: 'MARKET MOVER', icon: 'market', metric: 'bestShare', levels: [10, 25, 50], text: (n) => `SELL ${n}% OF ALL THE EGGS THE STREET SELLS IN ONE DAY.` },
    { id: 'coin-purse', name: 'COIN PURSE', icon: 'coin', metric: 'cashNow', levels: [200, 1000, 5000], text: (n) => `HOLD ${n} COINS.` },
    { id: 'nest-egg', name: 'NEST EGG', icon: 'ledger', metric: 'netWorth', levels: [500, 2000, 10000], text: (n) => `REACH A NET WORTH OF ${n} COINS.` },
    { id: 'good-day', name: 'GOOD DAY', icon: 'cash-burst', metric: 'bestDayProfit', levels: [25, 100, 400], text: (n) => `MAKE ${n} COINS OF PROFIT IN ONE DAY.` },
    { id: 'in-the-black', name: 'IN THE BLACK', icon: 'ledger', metric: 'profitDays', levels: [5, 20, 60], text: (n) => `CLOSE ${s(n, 'DAY')} WITH A PROFIT.` },
  ]),
  ...group('haggling', [
    { id: 'first-haggle', name: 'FIRST HAGGLE', icon: 'haggle', metric: 'hagglesWon', levels: [1], text: () => 'WIN YOUR FIRST HAGGLE.' },
    { id: 'haggler', name: 'HAGGLER', icon: 'haggle', metric: 'hagglesWon', levels: [10, 25, 50], text: (n) => `WIN ${n} HAGGLES.` },
    { id: 'worked-the-room', name: 'WORKED THE ROOM', icon: 'clerk', metric: 'haggleKinds', levels: [BADGE_RULES.haggleKinds.length], text: () => 'WIN A HAGGLE AGAINST EVERY TRADER: BOTH SUPPLIERS AND ALL THREE BUYERS.' },
    { id: 'no-thanks', name: 'NO THANKS', icon: 'contract', metric: 'refusals', levels: [10, 50, 200], text: (n) => `TURN DOWN ${n} OFFERS.` },
    { id: 'thick-skin', name: 'THICK SKIN', icon: 'haggle', metric: 'hagglesLost', levels: [10], secret: true, text: (n) => `HAVE ${n} TRADERS WALK AWAY FROM YOUR ASKING PRICE.` },
  ]),
  ...group('contracts', [
    { id: 'signed', name: 'SIGNED AND SEALED', icon: 'contract', metric: 'contractsTaken', levels: [1], text: () => 'TAKE A STANDING CONTRACT.' },
    { id: 'first-delivery', name: 'FIRST DELIVERY', icon: 'contract', metric: 'deliveries', levels: [1], text: () => 'DELIVER A CONTRACT DAY.' },
    { id: 'on-time', name: 'ON TIME', icon: 'clock', metric: 'bestDeliveryStreak', levels: [5, 15, 40], text: (n) => `DELIVER ${n} CONTRACT DAYS IN A ROW WITHOUT A MISS.` },
    { id: 'standing-order', name: 'STANDING ORDER', icon: 'cart', metric: 'deliveries', levels: [10, 50, 200], text: (n) => `DELIVER ${n} CONTRACT DAYS.` },
    { id: 'clean-record', name: 'CLEAN RECORD', icon: 'ledger', metric: 'cleanContracts', levels: [1, 5, 15], text: (n) => `FINISH ${s(n, 'CONTRACT')} WITHOUT A MISS.` },
  ]),
  ...group('flock', [
    { id: 'full-house', name: 'FULL HOUSE', icon: 'coop', metric: 'fullCoops', levels: [1], text: () => 'FILL YOUR COOPS.' },
    { id: 'big-flock', name: 'BIG FLOCK', icon: 'hen', metric: 'hens', levels: [20, 60, 150], text: (n) => `KEEP ${n} HENS.` },
    { id: 'seen-them-all', name: 'SEEN THEM ALL', icon: 'sparkle', metric: 'traitsSeen', levels: [BADGE_RULES.traits.length], text: () => 'KEEP HENS OF EVERY LOOK: EACH BODY, EYES, COMB AND ACCESSORY.' },
    { id: 'old-bird', name: 'OLD BIRD', icon: 'old-hen', metric: 'oldestHen', levels: [30, 60, 120], text: (n) => `KEEP A HEN ${n} DAYS OLD.` },
    { id: 'dapper', name: 'DAPPER', icon: 'tophat', metric: 'tophats', levels: [1], text: () => 'KEEP A HEN IN A TOP HAT.' },
    { id: 'builder', name: 'BUILDER', icon: 'coop', metric: 'coops', levels: [2, 3, ECONOMY.coops.plots], text: (n) => `OWN ${n} COOPS.` },
    { id: 'deluxe-living', name: 'DELUXE LIVING', icon: 'coop', metric: 'deluxeCoops', levels: [1], text: () => 'OWN A DELUXE COOP.' },
    { id: 'auction-find', name: 'AUCTION FIND', icon: 'bust', metric: 'auctionHens', levels: [1, 10, 30], text: (n) => `BUY ${s(n, 'HEN')} AT AUCTION.` },
    { id: 'new-ground', name: 'NEW GROUND', icon: 'sparkle', metric: 'landPlots', levels: [1], text: () => 'BUY A PLOT OF LAND BESIDE YOUR FARM.' },
    { id: 'four-corners', name: 'FOUR CORNERS', icon: 'rank', metric: 'landPlots', levels: [LAND_IDS.length], text: () => 'OWN ALL FOUR PLOTS AROUND YOUR FARM: EAST, WEST, NORTH AND SOUTH.' },
    { id: 'room-to-roost', name: 'ROOM TO ROOST', icon: 'coop', metric: 'landCoops', levels: [1], text: () => 'BUILD A COOP ON LAND YOU BOUGHT.' },
  ]),
  ...group('machines', [
    { id: 'on-the-belt', name: 'ON THE BELT', icon: 'conveyor', metric: 'ownsConveyor', levels: [1], text: () => 'BUY THE CONVEYOR.' },
    { id: 'graded', name: 'GRADED', icon: 'grader', metric: 'ownsGrader', levels: [1], text: () => 'BUY THE EGG GRADER.' },
    { id: 'on-the-road', name: 'ON THE ROAD', icon: 'cart', metric: 'ownsCart', levels: [1], text: () => 'BUY THE DELIVERY CART.' },
    { id: 'hopper-happy', name: 'HOPPER HAPPY', icon: 'hopper', metric: 'ownsHopper', levels: [1], text: () => 'BUY THE FEED HOPPER.' },
    { id: 'front-desk', name: 'FRONT DESK', icon: 'clerk', metric: 'ownsClerk', levels: [1], text: () => 'HIRE THE SALES CLERK.' },
    { id: 'fully-automated', name: 'FULLY AUTOMATED', icon: 'gear', metric: 'machinesOwned', levels: [5], text: () => 'OWN ALL FIVE MACHINES.' },
    { id: 'handy', name: 'HANDY', icon: 'repair', metric: 'repairs', levels: [1, 10, 30], text: (n) => `PAY FOR ${s(n, 'REPAIR')}.` },
    { id: 'stitch-in-time', name: 'STITCH IN TIME', icon: 'repair', metric: 'bestRepairStreak', levels: [3, 10, 25], text: (n) => `REPAIR ${n} MACHINES IN A ROW BEFORE ANY BREAKS DOWN.` },
    { id: 'smooth-running', name: 'SMOOTH RUNNING', icon: 'gear', metric: 'daysNoBreakdown', levels: [10, 30, 90], text: (n) => `RUN YOUR MACHINES FOR ${n} DAYS WITHOUT A BREAKDOWN.` },
    { id: 'hard-at-work', name: 'HARD AT WORK', icon: 'gear', metric: 'machineUnits', levels: [100, 1000, 5000], text: (n) => `YOUR MACHINES CARRY, GRADE, DELIVER AND POUR ${n} TIMES.` },
    { id: 'spare-parts', name: 'SPARE PARTS', icon: 'repair', metric: 'breakdowns', levels: [1], secret: true, text: () => 'HAVE A MACHINE BREAK DOWN.' },
  ]),
  ...group('rivals', [
    { id: 'last-one-standing', name: 'LAST ONE STANDING', icon: 'bust', metric: 'rivalsOutlasted', levels: [1, 3, 6], text: (n) => `OUTLAST ${s(n, 'RIVAL FARM')} THAT GO BUST.` },
    { id: 'podium', name: 'PODIUM', icon: 'rank', metric: 'top3Days', levels: [1, 7, 30], text: (n) => `CLOSE ${s(n, 'DAY')} IN THE STREET'S TOP ${ECONOMY.feathers.topRank}.` },
    { id: 'number-one', name: 'NUMBER ONE', icon: 'number-one', metric: 'firstDays', levels: [1, 7, 30], text: (n) => `CLOSE ${s(n, 'DAY')} AS THE RICHEST FARM ON THE STREET.` },
    { id: 'top-half', name: 'TOP HALF', icon: 'rank', metric: 'topHalfDays', levels: [1, 10, 50], text: (n) => `CLOSE ${s(n, 'DAY')} IN THE TOP HALF OF THE STREET.` },
    { id: 'climber', name: 'CLIMBER', icon: 'rank', metric: 'bestClimb', levels: [2, 5, 10], text: (n) => `CLIMB ${n} PLACES IN ONE DAY.` },
  ]),
  ...group('feathers', [
    { id: 'ticket-holder', name: 'TICKET HOLDER', icon: 'ticket', metric: 'ticketsWon', levels: [1], text: () => 'WIN A FEATHER TICKET.' },
    { id: 'lucky', name: 'LUCKY', icon: 'ticket', metric: 'ticketsWon', levels: [2, 4, 7], text: (n) => `WIN ${n} FEATHER TICKETS.` },
    { id: 'fluff', name: 'FLUFF', icon: 'feather-fluff', metric: 'mintedFluff', levels: [1], text: () => 'MINT A FLUFF FEATHER.' },
    { id: 'plume', name: 'PLUME', icon: 'feather-plume', metric: 'mintedPlume', levels: [1], text: () => 'MINT A PLUME FEATHER.' },
    { id: 'quill', name: 'QUILL', icon: 'feather-quill', metric: 'mintedQuill', levels: [1], text: () => 'MINT A QUILL FEATHER.' },
    { id: 'golden-quill', name: 'GOLDEN QUILL', icon: 'feather-golden-quill', metric: 'mintedGoldenQuill', levels: [1], text: () => 'MINT A GOLDEN QUILL FEATHER.' },
    { id: 'full-plumage', name: 'FULL PLUMAGE', icon: 'feather-quill', metric: 'mintedGrades', levels: [4], text: () => 'MINT A FEATHER OF EVERY GRADE.' },
    { id: 'milestone-hunter', name: 'MILESTONE HUNTER', icon: 'sparkle', metric: 'milestonesReached', levels: [2, 4, 7], text: (n) => `REACH ${n} MILESTONES.` },
  ]),
  ...group('days', [
    { id: 'opening-day', name: 'OPENING DAY', icon: 'chick', metric: 'daysClosed', levels: [1], text: () => 'SEE YOUR FARM THROUGH ITS FIRST DAY CLOSE.' },
    { id: 'good-standing', name: 'GOOD STANDING', icon: 'good-standing', metric: 'goodDays', levels: [7, 30, 100], text: (n) => `STAY IN GOOD STANDING FOR ${n} DAYS.` },
    { id: 'old-hand', name: 'OLD HAND', icon: 'clock', metric: 'daysPlayed', levels: [7, 30, 100], text: (n) => `KEEP YOUR FARM ON THE STREET FOR ${n} DAYS.` },
    { id: 'well-fed', name: 'WELL FED', icon: 'feed', metric: 'fedDays', levels: [7, 30, 100], text: (n) => `FEED YOUR HENS ON ${n} DAYS.` },
    { id: 'premium-diet', name: 'PREMIUM DIET', icon: 'feed', metric: 'premiumDays', levels: [3, 10, 30], text: (n) => `FEED YOUR HENS PREMIUM FEED ON ${n} DAYS.` },
  ]),
  ...group('fun', [
    { id: 'night-owl', name: 'NIGHT OWL', icon: 'night-owl', metric: 'nightActions', levels: [1], text: () => 'DO BUSINESS AFTER DARK, WHILE THE HENS SLEEP.' },
    { id: 'rooster-crew', name: 'ROOSTER CREW', icon: 'crow', metric: 'bestCrowStreak', levels: [3, 7, 14], text: (n) => `BE ON YOUR FARM WHEN THE ROOSTER CROWS (AT DAWN) ${n} DAYS IN A ROW.` },
    { id: 'omelette', name: 'OMELETTE', icon: 'egg-cracked', metric: 'eggsBroken', levels: [100], secret: true, text: (n) => `CRACK ${n} EGGS.` },
    { id: 'shoestring', name: 'SHOESTRING', icon: 'coin', metric: 'shoestringDays', levels: [1], secret: true, text: () => `CLOSE A DAY WITH LESS THAN ${BADGE_RULES.shoestringCoins} COIN AND KEEP FARMING.` },
    { id: 'clear-the-crate', name: 'CLEAR THE CRATE', icon: 'cash-burst', metric: 'biggestSale', levels: [200], secret: true, text: (n) => `SELL ${n} EGGS TO THE STREET IN ONE GO.` },
    { id: 'gold-rush', name: 'GOLD RUSH', icon: 'egg-golden', metric: 'goldenPeakSales', levels: [1], secret: true, text: () => 'SELL A GOLDEN EGG AT A PEAK.' },
    { id: 'new-sign', name: 'NEW SIGN', icon: 'sparkle', metric: 'renamed', levels: [1], secret: true, text: () => 'RENAME YOUR FARM IN SETTINGS.' },
  ]),
];

export const BADGE_BY_ID: ReadonlyMap<string, BadgeDef> = new Map(BADGES.map((b) => [b.id, b]));

/** The levels a badge has, lowest first: plain, or bronze, silver and gold. */
export const badgeLevels = (b: BadgeDef): BadgeLevel[] => (b.levels.length === 1 ? ['plain'] : [...BADGE_TIERS]);

/** The level a metric value reaches, or null when it reaches none. */
export function levelFor(b: BadgeDef, value: number): BadgeLevel | null {
  const names = badgeLevels(b);
  let out: BadgeLevel | null = null;
  for (const [i, t] of b.levels.entries()) if (value >= t) out = names[i] ?? null;
  return out;
}

/** The threshold of a level of a badge. */
export function thresholdOf(b: BadgeDef, level: BadgeLevel): number {
  const i = badgeLevels(b).indexOf(level);
  return b.levels[Math.max(0, i)] ?? b.levels[0];
}

/** The next level a badge can reach from the one held (null held: the first), or null when it is complete. */
export function nextLevel(b: BadgeDef, held: BadgeLevel | null): BadgeLevel | null {
  const names = badgeLevels(b);
  if (held === null) return names[0] ?? null;
  return names[names.indexOf(held) + 1] ?? null;
}

/** Whether level a is above level b (null is below everything). */
export const levelAbove = (a: BadgeLevel | null, b: BadgeLevel | null): boolean => (a === null ? 0 : BADGE_LEVEL_RANK[a]) > (b === null ? 0 : BADGE_LEVEL_RANK[b]);

/** A badge's line for a level (the next one to earn, or the one held). */
export const badgeText = (b: BadgeDef, level: BadgeLevel): string => b.text(thresholdOf(b, level));

/** A farm's best few badges for a small row: gold first, then silver, bronze and plain, rarer categories first. */
export function topBadges<T extends { id: string; level: BadgeLevel }>(earned: T[], n: number): T[] {
  const weight = (x: T): number => (x.level === 'gold' ? 4 : x.level === 'silver' ? 3 : x.level === 'plain' ? 2.5 : 2) + (BADGE_BY_ID.get(x.id)?.secret ? 0.5 : 0);
  const order = new Map(BADGES.map((b, i) => [b.id, i]));
  return [...earned].sort((a, b) => weight(b) - weight(a) || (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0)).slice(0, n);
}
