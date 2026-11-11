// Game feel: hitstop and screen shake. Reduce motion turns off exactly these two.
import { engine } from 'animejs';
import { settings } from '../state/settings';

let frozenUntil = 0;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
const shake = { amp: 0, start: 0, ms: 0 };

export const juice = {
  /** Freezes the world and every anime.js timeline for a beat. */
  hitstop(ms: number): void {
    if (settings.get().reduceMotion) return;
    const now = performance.now();
    frozenUntil = Math.max(frozenUntil, now + ms);
    engine.pause();
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      engine.resume();
    }, frozenUntil - now);
  },

  frozen(): boolean {
    return performance.now() < frozenUntil;
  },

  /** Screen shake in game pixels, decaying over ms. */
  shake(amp: number, ms: number): void {
    if (settings.get().reduceMotion) return;
    const now = performance.now();
    const remaining = shake.ms ? shake.amp * Math.max(0, 1 - (now - shake.start) / shake.ms) : 0;
    if (amp < remaining) return;
    shake.amp = amp;
    shake.start = now;
    shake.ms = ms;
  },

  /** Current whole-pixel shake offset. */
  offset(): { x: number; y: number } {
    if (!shake.ms) return { x: 0, y: 0 };
    const k = 1 - (performance.now() - shake.start) / shake.ms;
    if (k <= 0 || settings.get().reduceMotion) {
      shake.ms = 0;
      return { x: 0, y: 0 };
    }
    const a = shake.amp * k * k;
    return { x: Math.round((Math.random() * 2 - 1) * a), y: Math.round((Math.random() * 2 - 1) * a) };
  },
};

export const sizeShake = (coins: number): number => Math.min(8, 2 + Math.round(coins / 15));
