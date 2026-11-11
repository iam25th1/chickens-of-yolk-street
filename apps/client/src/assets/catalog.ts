// Asset index types (mirrors scripts/lib/pack.ts), atlas groups and the sound sets per screen.
// Sprites themselves come from derived.json (see assets/store.ts).

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

export const ASSET_BASE = '/assets/';

/** Atlas groups by screen: the loading screen first, then the title, then the farm. */
export const BOOT_GROUPS = ['boot'] as const;
export const TITLE_GROUPS = ['title', 'ui'] as const;
export const FARM_GROUPS = ['farm', 'fx'] as const;
/** Loaded in the background once the farm is up (DOM card art also loads on its own). */
export const LATER_GROUPS = ['cards', 'market'] as const;

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
  '40-upstart',
  '40-old-money',
  '40-squeezer',
  '40-loyalist',
  '40-bakery-buyer',
  '40-market-trader',
  '40-wholesaler',
  '19-haggle-win',
  '20-fail',
  '34-market',
  '16-ticker',
  '13-tray',
  '30-stamp-thump',
  '31-flap',
];
