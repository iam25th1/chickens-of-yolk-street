// Asset index types (mirrors scripts/lib/pack.ts) and per-asset display scale.
//
// The game renders at 640x360. Grid art (tiles, UI, plates) is drawn at 1/grid, so each art pixel
// is one game pixel. Soft art has no grid; each sheet gets a whole-number divisor chosen for the
// farm's proportions, sampled nearest-neighbour.

export interface SpriteEntry {
  json: string;
  png: string;
  sha256: string;
  role: string;
  docTracker: string | null;
  label: string;
  width: number;
  height: number;
  grid: number;
  anchor: 'feet' | 'center';
  static: boolean;
  rows: Record<string, { mode: 'loop' | 'once'; vanish: boolean; frameCount: number; totalMs: number }>;
}

export interface SoundEntry {
  docSound: number | null;
  kind: 'one-shot' | 'loop' | 'music';
  label: string;
  presses: { file: string; pitch: number }[];
  files: Record<string, { sha256: string }>;
  loop: { file: string; loopStartSample: number; loopEndSample: number; sampleRate: number; channels: number } | null;
}

export interface AssetIndex {
  version: 1;
  source: { repo: string; commit: string | null; manifestSha256: string };
  sprites: Record<string, SpriteEntry>;
  sounds: Record<string, SoundEntry>;
  traits: {
    stackOrder: string[];
    options: Record<string, string[]>;
    layers: Record<string, string>;
    bodyRecolour: Record<string, [[number, number, number], [number, number, number]]>;
  };
  canonical: Record<string, string>;
  unused: string[];
}

export interface SheetFrame {
  frame: { x: number; y: number; w: number; h: number };
  anchor: { x: number; y: number };
  duration: number;
}

export interface SheetJson {
  frames: Record<string, SheetFrame>;
  animations: Record<string, string[]>;
  meta: { image: string; size: { w: number; h: number }; grid: number };
}

export const ASSET_BASE = '/assets/';

const SOFT_DIVISORS: [RegExp, number][] = [
  [/^0[12]-/, 6], // hens and their trait layers
  [/^03-chick$/, 8],
  [/^11-egg-/, 12],
  [/^1[24]-/, 6], // crate, trough
  [/^13-sack-/, 8],
  [/^1[56]-/, 4], // coops, farmhouse
  [/^(17|19|19b|20|21|22)-/, 6], // signs and machines
  [/^(0[4-9]|10)-/, 4], // characters
  [/^x-hen-portrait$/, 4],
];

/** How many art pixels make one game pixel for this sheet. */
export function divisorFor(id: string, entry: SpriteEntry): number {
  if (entry.grid > 1) return entry.grid;
  for (const [re, d] of SOFT_DIVISORS) if (re.test(id)) return d;
  return 6;
}

/** Sheets with soft anti-aliased edges get a hard alpha cut at load, so nearest sampling stays clean. */
export const needsAlphaCut = (entry: SpriteEntry): boolean => entry.grid === 1;

export const BOOT_SPRITES = [
  '25-loading-plate',
  '25-loading-anim',
  '26-title-plate',
  '26-title-anim',
  '28-logo',
  '31-ui-pieces',
  '32-icons',
  '33-split-flap',
  '34-cursor',
];

export const FARM_SPRITES = [
  '01-hen-anims',
  '02-body',
  '02-eyes-sleepy',
  '02-eyes-wild',
  '02-comb-default',
  '02-comb-spiky',
  '02-comb-mohawk',
  '02-comb-nub',
  '02-acc-tophat',
  '02-acc-bowtie',
  '02-acc-shades',
  '11-egg-white',
  '11-egg-cream',
  '11-egg-brown',
  '11-egg-golden',
  '12-crate',
  '13-sack-cheap',
  '13-sack-standard',
  '13-sack-premium',
  '14-trough',
  '15-coop-starter',
  '15-coop-red',
  '15-coop-deluxe',
  '16-farmhouse',
  '17-sign-farm',
  '17-sign-upstart',
  '17-sign-old-money',
  '18-conveyor',
  '19-egg-grader',
  '20-delivery-cart',
  '21-feed-hopper',
  '22-sales-clerk',
  '23-farm-tileset',
  '24-farm-props',
  '29-card-bulk-order',
  '29-card-feed-deal',
  '29-card-glut-warning',
  '29-card-standing-contract',
  '30-stamps',
  '35-particles',
];

export const BOOT_SOUNDS = ['44-jingle', '41-title', '35-hover', '35-click', '35-back'];

export const FARM_SOUNDS = [
  '42-farm-day',
  '43-market-tension',
  '39-day',
  '38-night',
  '05-snore',
  '25-conveyor',
  '26-sorter',
  '01-cluck',
  '02-lay',
  '03-flap',
  '04-sad',
  '07-chorus',
  '08-egg-pop',
  '09-crack',
  '10-splat',
  '11-golden',
  '12-crate',
  '14-coins-small',
  '14-coins-large',
  '15-kaching',
  '17-card',
  '18-stamp',
  '21-build',
  '22-boing',
  '23-sign-fall',
  '24-machine',
  '28-grain',
  '29-alarm-bell',
  '32-collapse',
  '33-siren',
  '37-crow',
  '45-deal-closed',
  '45-market-crash',
  '45-new-day',
  '45-rival-bust',
];
