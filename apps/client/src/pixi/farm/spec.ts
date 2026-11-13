// The farm's size table: how big each thing is drawn, relative to a hen (1.0 = her height with her
// default comb, standing). scripts/lib/derive.ts sets each painted sheet's art ratio from it, so
// the atlases are cut at exactly these sizes (no scaling at run time, every texel whole); the two
// exact pixel-art sheets (the belt and the props) keep their own pixel grid and say so. Tests in
// test/spec.test.ts measure the derived atlases against this table.

/** A hen's height in world pixels (body with the default comb, standing, at art ratio 8). */
export const HEN_PX = 27.1;

export interface SizeSpec {
  /** Size as built, relative to the hen, by height (or width for the trough). */
  rel: number;
  /** The brief's starting proportion. */
  brief: number;
  by: 'height' | 'width';
  /** Sheets drawn at this size, and the row measured. */
  sprites: string[];
  row: string;
  /** Why the built size differs from the brief, if it does. */
  note?: string;
}

export const SIZE_TABLE = {
  hen: { rel: 1, brief: 1, by: 'height', sprites: ['02-body'], row: 'idle' },
  egg: { rel: 0.35, brief: 0.35, by: 'height', sprites: ['11-egg-white', '11-egg-cream', '11-egg-brown', '11-egg-golden'], row: 'wobble' },
  crate: { rel: 0.9, brief: 0.9, by: 'height', sprites: ['12-crate'], row: 'empty' },
  trough: { rel: 1.4, brief: 1.4, by: 'width', sprites: ['14-trough'], row: 'full' },
  sack: { rel: 1.0, brief: 1.0, by: 'height', sprites: ['13-sack-cheap', '13-sack-standard', '13-sack-premium'], row: 'idle' },
  'coop-starter': { rel: 2.2, brief: 2.2, by: 'height', sprites: ['15-coop-starter'], row: 'idle' },
  'coop-red': { rel: 2.6, brief: 2.6, by: 'height', sprites: ['15-coop-red'], row: 'idle' },
  'coop-deluxe': { rel: 3.2, brief: 3.2, by: 'height', sprites: ['15-coop-deluxe'], row: 'idle' },
  farmhouse: { rel: 3.6, brief: 3.6, by: 'height', sprites: ['16-farmhouse'], row: 'day' },
  conveyor: {
    rel: 16 / HEN_PX,
    brief: 0.4,
    by: 'height',
    sprites: ['18b-conveyor-clean'],
    row: 'horizontal',
    note: 'the belt is exact pixel art on the 16 px tile grid it shares with the ground; one tile (0.59) keeps every pixel whole, 0.4 would need new art',
  },
  grader: { rel: 1.6, brief: 1.6, by: 'height', sprites: ['19-egg-grader'], row: 'idle' },
  cart: { rel: 1.6, brief: 1.6, by: 'height', sprites: ['20-delivery-cart'], row: 'idle' },
  hopper: { rel: 2.0, brief: 2.0, by: 'height', sprites: ['21-feed-hopper'], row: 'idle' },
  clerk: { rel: 1.4, brief: 1.4, by: 'height', sprites: ['22-sales-clerk'], row: 'idle' },
  sign: { rel: 1.4, brief: 1.4, by: 'height', sprites: ['17-sign-farm', '17-sign-upstart', '17-sign-old-money'], row: 'sway' },
  'hatch-egg': {
    rel: 24 / HEN_PX,
    brief: 24 / HEN_PX,
    by: 'height',
    sprites: ['x-hatch-egg'],
    row: 'wobble',
    note: 'exact pixel art (24 px tall and 20 wide at rest, on its own 32 px grid): just room for a crouched hen, big and goofy next to a laid egg',
  },
  'hay-bale': {
    rel: 26 / HEN_PX,
    brief: 0.8,
    by: 'height',
    sprites: ['24-farm-props'],
    row: 'hay-bale',
    note: 'exact pixel art (26 px tall at its own grid); shrinking it to 0.8 would break its pixels',
  },
} as const satisfies Record<string, SizeSpec>;

export type Thing = keyof typeof SIZE_TABLE;
