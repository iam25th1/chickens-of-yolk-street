// Settings kept per browser: a volume and mute for every sound category, and reduce motion. They
// apply at once and persist; older saves (one music and one effects volume) carry over.
import { DEFAULT_LEVELS, SOUND_CATEGORIES, type SoundLevels } from '../audio/categories';
import { createStore } from './store';

export interface Settings {
  sound: SoundLevels;
  /** Turns off screen shake and hitstop only. Off by default. */
  reduceMotion: boolean;
}

const KEY = 'coys.settings';
export const DEFAULT_SETTINGS: Settings = { sound: DEFAULT_LEVELS, reduceMotion: false };

const clamp = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);

export function parseSettings(raw: string | null): Settings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const v = JSON.parse(raw) as { sound?: Partial<SoundLevels>; music?: number; sfx?: number; reduceMotion?: boolean };
    const sound = { ...DEFAULT_LEVELS };
    for (const c of SOUND_CATEGORIES) {
      const l = v.sound?.[c];
      if (l) sound[c] = { volume: clamp(l.volume, DEFAULT_LEVELS[c].volume), muted: l.muted === true };
    }
    // an older save: one music volume and one for every effect
    if (!v.sound && (typeof v.music === 'number' || typeof v.sfx === 'number')) {
      for (const c of SOUND_CATEGORIES) {
        if (c === 'master') continue;
        sound[c] = { volume: clamp(c === 'music' ? v.music : v.sfx, DEFAULT_LEVELS[c].volume), muted: false };
      }
    }
    return { sound, reduceMotion: v.reduceMotion === true };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function load(): Settings {
  try {
    return parseSettings(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export const settings = createStore<Settings>(load());

settings.subscribe(() => {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings.get()));
  } catch {
    // storage blocked: settings last for this visit only
  }
});
