// The AI farm registry: new rival farms that open on Yolk Street when eggs run short or a rival goes
// bust (the entry rule in game/cast-runtime.ts). Each is a rival agent of an existing kind, so it
// reuses that kind's portrait, sign and voice (no new art), with its own names, persona, haggling
// personality and a starting farm smaller than the base rivals'. Its rule policy is its look-alike's
// with a few of its own settings.
import type { CoopKind, FeedTier } from '@coys/shared';
import type { Personality } from './cast';

export interface Entrant {
  key: string;
  /** The base rival it looks and sounds like, and whose rule policy it starts from. */
  looks: 'upstart' | 'old-money';
  names: string[];
  personality: Personality;
  /** A few sentences for the model: goals, temperament, how it talks, what it never does. */
  persona: string;
  farm: { cash: number; hens: number; coops: CoopKind[]; feed: { tier: FeedTier; kg: number } };
  /** Its own settings on top of its look-alike's rule policy. */
  rules: { reserve?: number; tier?: FeedTier; holdBelow?: number; holdShare?: number; borrows?: boolean; dumpShare?: number };
}

export const ENTRANTS: readonly Entrant[] = [
  {
    key: 'early-bird',
    looks: 'upstart',
    names: ['Early Bird Eggs', 'Dawn Patrol Poultry', 'First Light Farm'],
    personality: { concession: 0.5, pride: 0.3, flex: 0.1 },
    persona:
      'A new farm run by two early risers. Goal: earn a place on Yolk Street before the big farms notice. Eager but careful with cash: it grows only when eggs are short. Talks bright and earnest, about mornings. Never borrows to grow and never dumps eggs below half price.',
    farm: { cash: 50, hens: 14, coops: ['red'], feed: { tier: 'cheap', kg: 40 } },
    rules: { reserve: 15, borrows: false, dumpShare: 0.75 },
  },
  {
    key: 'cluck-collective',
    looks: 'upstart',
    names: ['Cluck Collective', 'The Hen Co-op', 'Many Hands Hatchery'],
    personality: { concession: 0.45, pride: 0.5, flex: 0.1 },
    persona:
      'A farm owned by the people who work it. Goal: a fair price and a steady living for every member. Slow to change and stubborn about fairness. Talks in we and us, earnest and a little preachy. Never undercuts a neighbour on purpose and never sells below a fair price unless the street is flooded.',
    farm: { cash: 70, hens: 18, coops: ['red'], feed: { tier: 'standard', kg: 40 } },
    rules: { reserve: 20, tier: 'standard', borrows: false, holdBelow: 0.85, holdShare: 0.3, dumpShare: 0 },
  },
  {
    key: 'gilded-roost',
    looks: 'old-money',
    names: ['Gilded Roost Estates', 'Silver Spur Poultry', 'Ermine and Egg'],
    personality: { concession: 0.25, pride: 0.8, flex: 0.07 },
    persona:
      "A rich investor's hobby farm. Goal: win on quality and buy up cheap hens. Haughty, bored by small sums, fond of premium feed. Talks grand and weary, as if eggs were beneath it. Never sells golden eggs cheap and never buys cheap feed.",
    farm: { cash: 220, hens: 40, coops: ['deluxe'], feed: { tier: 'premium', kg: 60 } },
    rules: { reserve: 90 },
  },
  {
    key: 'pennywise',
    looks: 'old-money',
    names: ['Pennywise Poultry', 'Thrift and Feather', 'Careful Coop'],
    personality: { concession: 0.3, pride: 0.6, flex: 0.08 },
    persona:
      'A frugal, old-fashioned farm. Goal: never lose a coin. Cautious, patient and suspicious of booms; it holds eggs back when prices are low and keeps a fat cash cushion. Talks in proverbs about thrift. Never borrows and never buys on a hunch.',
    farm: { cash: 160, hens: 30, coops: ['red', 'starter'], feed: { tier: 'standard', kg: 60 } },
    rules: { reserve: 70, tier: 'standard', holdBelow: 0.95, holdShare: 0.4 },
  },
];

export const entrantByKey = (key: string | null | undefined): Entrant | null => (key ? (ENTRANTS.find((e) => e.key === key) ?? null) : null);

export const entrantName = (e: Entrant, generation: number): string => e.names[(generation - 1) % e.names.length] ?? e.names[0] ?? e.key;
