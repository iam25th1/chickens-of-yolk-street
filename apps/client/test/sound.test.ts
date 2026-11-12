// Every sound in the game belongs to exactly one settings category, and the sound settings load,
// carry an older save over and fall back to the defaults.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATEGORY_OF, DEFAULT_LEVELS, SOUND_CATEGORIES, gainOf } from '../src/audio/categories';
import { parseSettings } from '../src/state/settings';

const index = JSON.parse(readFileSync(new URL('../public/assets/index.json', import.meta.url), 'utf8')) as { sounds: Record<string, unknown> };

describe('sound categories', () => {
  it('puts every sound in the game in exactly one category', () => {
    const ids = Object.keys(index.sounds).sort();
    expect(Object.keys(CATEGORY_OF).sort()).toEqual(ids);
    for (const [id, c] of Object.entries(CATEGORY_OF)) {
      expect(SOUND_CATEGORIES, id).toContain(c);
      expect(c, id).not.toBe('master');
    }
    // and every category but master holds at least one sound
    for (const c of SOUND_CATEGORIES.filter((x) => x !== 'master')) expect(Object.values(CATEGORY_OF)).toContain(c);
  });

  it('plays a category at master times its own level, silent when either is muted', () => {
    const levels = structuredClone(DEFAULT_LEVELS);
    levels.master.volume = 0.5;
    levels.hens.volume = 0.5;
    expect(gainOf(levels, 'hens')).toBeCloseTo(0.0625);
    levels.hens.muted = true;
    expect(gainOf(levels, 'hens')).toBe(0);
    levels.hens.muted = false;
    levels.master.muted = true;
    expect(gainOf(levels, 'eggs')).toBe(0);
  });

  it('loads saved levels, carries an older save over and falls back to defaults', () => {
    expect(parseSettings(null).sound).toEqual(DEFAULT_LEVELS);
    expect(parseSettings('not json').sound).toEqual(DEFAULT_LEVELS);
    const old = parseSettings(JSON.stringify({ music: 0.2, sfx: 0.4, reduceMotion: true }));
    expect(old.sound.music.volume).toBe(0.2);
    expect(old.sound.hens.volume).toBe(0.4);
    expect(old.reduceMotion).toBe(true);
    const saved = parseSettings(JSON.stringify({ sound: { voices: { volume: 0.1, muted: true } } }));
    expect(saved.sound.voices).toEqual({ volume: 0.1, muted: true });
    expect(saved.sound.music).toEqual(DEFAULT_LEVELS.music);
  });
});
