// The 777 Founding Hens the Feathers are planned to hatch into at the mainnet launch: each with a
// number, an original goofy name, a rarity (exactly 7 Legendary, 70 Epic, 200 Rare, 500 Common),
// traits from the existing hen layers and a palette made by recolouring those layers in code
// (recolourBody, recolourComb). No two hens share a look or a name. Legendary and Epic hens wear
// palettes no lower rarity uses, and every Legendary hen has a sparkle. Seeded: the same seed
// always makes the same file, byte for byte.
import { createHash } from 'node:crypto';
import { RARITIES, type Rarity } from '@coys/shared';

type Rgb = [number, number, number];
type Ramp = [Rgb, Rgb];

export const EYES = ['default', 'sleepy', 'wild'] as const;
export const COMBS = ['default', 'spiky', 'mohawk', 'nub'] as const;
export const ACCESSORIES = ['none', 'tophat', 'bowtie', 'shades'] as const;

/** Body palettes ([dark, light] ramps for recolourBody; cream is the art's own colour). Disjoint by rarity. */
export const BODY_PALETTES: Record<Rarity, Record<string, Ramp | null>> = {
  common: {
    cream: null,
    brown: [
      [92, 48, 26],
      [196, 128, 74],
    ],
    black: [
      [16, 15, 20],
      [64, 60, 70],
    ],
    buff: [
      [138, 92, 44],
      [236, 198, 138],
    ],
    grey: [
      [66, 68, 76],
      [176, 178, 186],
    ],
    rust: [
      [112, 44, 22],
      [212, 112, 62],
    ],
  },
  rare: {
    sage: [
      [64, 86, 58],
      [170, 196, 150],
    ],
    lavender: [
      [88, 70, 118],
      [206, 186, 232],
    ],
    sky: [
      [52, 92, 132],
      [168, 210, 238],
    ],
    cocoa: [
      [58, 34, 26],
      [150, 104, 82],
    ],
  },
  epic: {
    teal: [
      [18, 86, 92],
      [96, 206, 198],
    ],
    plum: [
      [70, 22, 64],
      [186, 92, 170],
    ],
    cobalt: [
      [24, 40, 116],
      [104, 140, 236],
    ],
  },
  legendary: {
    gold: [
      [146, 92, 8],
      [255, 222, 92],
    ],
    obsidian: [
      [8, 6, 14],
      [86, 60, 132],
    ],
    opal: [
      [150, 170, 196],
      [252, 246, 255],
    ],
  },
};

/** Comb colours ([dark, light] ramps for recolourComb; red is the art's own). Epic and Legendary ones are theirs alone. */
export const COMB_PALETTES: Record<Rarity, Record<string, Ramp | null>> = {
  common: {
    red: null,
    rose: [
      [150, 40, 76],
      [248, 140, 172],
    ],
  },
  rare: {
    red: null,
    rose: [
      [150, 40, 76],
      [248, 140, 172],
    ],
    amber: [
      [160, 82, 10],
      [252, 186, 70],
    ],
  },
  epic: {
    violet: [
      [76, 30, 140],
      [184, 132, 250],
    ],
    cyan: [
      [8, 108, 132],
      [110, 230, 250],
    ],
  },
  legendary: {
    golden: [
      [170, 110, 0],
      [255, 236, 120],
    ],
    pearl: [
      [170, 170, 190],
      [255, 255, 255],
    ],
  },
};

export const RARITY_COUNTS: Record<Rarity, number> = { legendary: 7, epic: 70, rare: 200, common: 500 };

const FIRST = [
  'Henrietta', 'Clementine', 'Pip', 'Marge', 'Nugget', 'Doris', 'Biscuit', 'Waffles', 'Gertie', 'Mabel', 'Olive', 'Peggy', 'Poppy', 'Rosie',
  'Tilly', 'Winnie', 'Ziggy', 'Bea', 'Coco', 'Dottie', 'Fern', 'Goldie', 'Hattie', 'Ivy', 'Junie', 'Kiki', 'Lulu', 'Minnie', 'Nell', 'Opal',
  'Pansy', 'Queenie', 'Ruby', 'Sadie', 'Trixie', 'Una', 'Vera', 'Wanda', 'Yolanda', 'Zelda', 'Agnes', 'Bonnie', 'Cleo', 'Daisy', 'Elsie',
  'Florence', 'Gwen', 'Hazel', 'Ingrid', 'Josie', 'Kitty', 'Lottie', 'Maude', 'Noodle', 'Ottilie', 'Pickles', 'Ramona', 'Sprout', 'Tansy', 'Wilma',
];
const FRONT = [
  'Feather', 'Puddle', 'Wobble', 'Scramble', 'Crumb', 'Yolk', 'Noodle', 'Butter', 'Pebble', 'Thimble', 'Wiggle', 'Fluff', 'Dapple', 'Muddle',
  'Bumble', 'Waddle', 'Fizzle', 'Pudding', 'Turnip', 'Custard', 'Haystack', 'Mumble', 'Squiggle', 'Toast',
];
const BACK = ['bottom', 'worth', 'foot', 'beak', 'comb', 'wing', 'ton', 'wick', 'shire', 'bury', 'nest', 'muffin', 'puff', 'tuft'];
const TITLES: Record<Rarity, string[]> = {
  legendary: ['Duchess', 'Empress', 'Grand Dame', 'Her Fluffiness', 'Archduchess', 'Lady High', 'Queen Mother'],
  epic: ['Lady', 'Baroness', 'Captain', 'Professor', 'Madame', 'Countess', 'Admiral', 'Doctor'],
  rare: ['Auntie', 'Miss', 'Nana', 'Little', 'Big'],
  common: [],
};

export interface FounderTraits {
  body: string;
  eyes: (typeof EYES)[number];
  comb: (typeof COMBS)[number];
  combColour: string;
  accessory: (typeof ACCESSORIES)[number];
}

export interface Founder {
  /** Place in founders.json, 1 to 777 (the reveal hands founders out by this number). */
  number: number;
  name: string;
  rarity: Rarity;
  traits: FounderTraits;
  /** The ramps the recolours use (null: the art's own colour). */
  palette: { body: Ramp | null; comb: Ramp | null };
  fx: 'sparkle' | null;
}

export interface FoundersFile {
  version: 1;
  seed: string;
  counts: Record<Rarity, number>;
  founders: Founder[];
}

/** A seeded stream: sha256("{seed}|{i}") as 52-bit fractions. */
function stream(seed: string): () => number {
  let i = 0;
  return () => {
    const h = createHash('sha256').update(`${seed}|${i++}`).digest('hex');
    return parseInt(h.slice(0, 13), 16) / 2 ** 52;
  };
}

const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;

export function lookKey(t: FounderTraits): string {
  return `${t.body}/${t.eyes}/${t.comb}/${t.combColour}/${t.accessory}`;
}

export function generateFounders(seed: string): FoundersFile {
  const rnd = stream(seed);
  const looks = new Set<string>();
  const names = new Set<string>();
  const out: Omit<Founder, 'number'>[] = [];
  for (const rarity of RARITIES) {
    const bodies = Object.keys(BODY_PALETTES[rarity]);
    const combs = Object.keys(COMB_PALETTES[rarity]);
    for (let k = 0; k < RARITY_COUNTS[rarity]; k++) {
      let traits: FounderTraits;
      do {
        traits = { body: pick(rnd, bodies), eyes: pick(rnd, EYES), comb: pick(rnd, COMBS), combColour: pick(rnd, combs), accessory: pick(rnd, ACCESSORIES) };
      } while (looks.has(lookKey(traits)));
      looks.add(lookKey(traits));
      let name: string;
      do {
        const sur = `${pick(rnd, FRONT)}${pick(rnd, BACK)}`;
        const title = TITLES[rarity].length ? `${pick(rnd, TITLES[rarity])} ` : '';
        name = `${title}${pick(rnd, FIRST)} ${sur}`;
      } while (names.has(name));
      names.add(name);
      out.push({
        name,
        rarity,
        traits,
        palette: { body: BODY_PALETTES[rarity][traits.body] ?? null, comb: COMB_PALETTES[rarity][traits.combColour] ?? null },
        fx: rarity === 'legendary' ? 'sparkle' : null,
      });
    }
  }
  // shuffle, so a number says nothing about rarity
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as Omit<Founder, 'number'>, out[i] as Omit<Founder, 'number'>];
  }
  return { version: 1, seed, counts: { ...RARITY_COUNTS }, founders: out.map((f, i) => ({ number: i + 1, ...f })) };
}

/** founders.json exactly as written (its SHA-256 is the provenance hash). */
export const foundersJson = (file: FoundersFile): string => {
  const { founders, ...head } = file;
  const top = JSON.stringify(head).slice(0, -1);
  return `${top},"founders":[\n${founders.map((f) => JSON.stringify(f)).join(',\n')}\n]}\n`;
};

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');
