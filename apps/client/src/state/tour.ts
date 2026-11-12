// The how-to-play tour: on until the player finishes or skips it, and back on from Settings.
import { createStore } from './store';

const KEY = 'coys.onboarded';

const seen = (): boolean => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

export const tour = createStore<{ active: boolean; step: number }>({ active: !seen(), step: 0 });

export function finishTour(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // storage blocked: it shows again next visit
  }
  tour.set({ active: false, step: 0 });
}

export function replayTour(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage blocked
  }
  tour.set({ active: true, step: 0 });
}

export function tourStep(step: number): void {
  tour.set({ step });
}
