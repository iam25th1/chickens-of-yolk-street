import { createStore } from './store';

export interface Settings {
  music: number;
  sfx: number;
  /** Turns off screen shake and hitstop only. Off by default. */
  reduceMotion: boolean;
}

const KEY = 'coys.settings';
const DEFAULTS: Settings = { music: 0.7, sfx: 0.85, reduceMotion: false };

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<Settings>;
    return {
      music: typeof v.music === 'number' ? Math.min(1, Math.max(0, v.music)) : DEFAULTS.music,
      sfx: typeof v.sfx === 'number' ? Math.min(1, Math.max(0, v.sfx)) : DEFAULTS.sfx,
      reduceMotion: v.reduceMotion === true,
    };
  } catch {
    return DEFAULTS;
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
