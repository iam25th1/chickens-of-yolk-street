// Every sound in the game belongs to exactly one category, and each category has its own volume and
// mute in Settings (master sits over all of them). The test in test/sound.test.ts checks this list
// against the packed sound index.

export const SOUND_CATEGORIES = ['master', 'music', 'ambience', 'hens', 'eggs', 'cards', 'haggling', 'machines', 'market', 'voices', 'ui', 'stings'] as const;
export type SoundCategory = (typeof SOUND_CATEGORIES)[number];
export type SoundBus = Exclude<SoundCategory, 'master'>;

export const CATEGORY_LABEL: Record<SoundCategory, string> = {
  master: 'MASTER',
  music: 'MUSIC',
  ambience: 'AMBIENCE',
  hens: 'HENS',
  eggs: 'EGGS AND MONEY',
  cards: 'CARDS AND STAMPS',
  haggling: 'HAGGLING',
  machines: 'MACHINES',
  market: 'MARKET AND RIVALS',
  voices: 'AGENT VOICES',
  ui: 'BUTTONS (UI)',
  stings: 'NEW DAY AND STINGS',
};

export const CATEGORY_OF: Record<string, SoundBus> = {
  '41-title': 'music',
  '42-farm-day': 'music',
  '43-market-tension': 'music',
  '44-jingle': 'music',
  '38-night': 'ambience',
  '39-day': 'ambience',
  '01-cluck': 'hens',
  '03-flap': 'hens',
  '04-sad': 'hens',
  '05-snore': 'hens',
  '06-peep': 'hens',
  '07-chorus': 'hens',
  '02-lay': 'eggs',
  '08-egg-pop': 'eggs',
  '09-crack': 'eggs',
  '10-splat': 'eggs',
  '11-golden': 'eggs',
  '12-crate': 'eggs',
  '14-coins-small': 'eggs',
  '14-coins-large': 'eggs',
  '15-kaching': 'eggs',
  '36-grab': 'eggs',
  '36-drop': 'eggs',
  '17-card': 'cards',
  '18-stamp': 'cards',
  '30-stamp-thump': 'cards',
  '19-haggle-win': 'haggling',
  '20-fail': 'haggling',
  '22-boing': 'haggling',
  '13-tray': 'machines',
  '21-build': 'machines',
  '24-machine': 'machines',
  '25-conveyor': 'machines',
  '26-sorter': 'machines',
  '27-cart': 'machines',
  '28-grain': 'machines',
  '16-ticker': 'market',
  '23-sign-creak': 'market',
  '23-sign-fall': 'market',
  '31-flap': 'market',
  '32-collapse': 'market',
  '33-siren': 'market',
  '34-market': 'market',
  '40-upstart': 'voices',
  '40-old-money': 'voices',
  '40-squeezer': 'voices',
  '40-loyalist': 'voices',
  '40-bakery-buyer': 'voices',
  '40-market-trader': 'voices',
  '40-wholesaler': 'voices',
  '35-hover': 'ui',
  '35-click': 'ui',
  '35-back': 'ui',
  '37-crow': 'stings',
  '45-new-day': 'stings',
  '45-deal-closed': 'stings',
  '45-rival-bust': 'stings',
  '45-market-crash': 'stings',
  '29-alarm-bell': 'stings',
};

export interface Level {
  volume: number;
  muted: boolean;
}
export type SoundLevels = Record<SoundCategory, Level>;

export const DEFAULT_LEVELS: SoundLevels = Object.fromEntries(
  SOUND_CATEGORIES.map((c) => [c, { volume: c === 'music' ? 0.7 : c === 'ambience' ? 0.75 : c === 'master' ? 1 : 0.85, muted: false }]),
) as SoundLevels;

/** The gain a category plays at (master times its own; squared for a natural fader). */
export function gainOf(levels: SoundLevels, c: SoundBus): number {
  const m = levels.master;
  const l = levels[c];
  if (m.muted || l.muted) return 0;
  return m.volume * m.volume * l.volume * l.volume;
}
