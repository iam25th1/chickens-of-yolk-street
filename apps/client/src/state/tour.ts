// The how-to-play tour: it shows once for every new player, on the first entry to their farm, with
// no click needed; the server remembers it is done (on any browser), and this browser remembers it
// too in case the server's word is late. Settings can replay it.
import { createStore } from './store';

const key = (farmId: string) => `coys.toured.${farmId}`;

export const tour = createStore<{ active: boolean; step: number; farmId: string | null }>({ active: false, step: 0, farmId: null });

const seenHere = (farmId: string): boolean => {
  try {
    return localStorage.getItem(key(farmId)) === '1';
  } catch {
    return false;
  }
};

/** On entering a farm: start the tour when its player has never done it. */
export function startTourFor(farmId: string, doneOnServer: boolean): void {
  if (tour.get().farmId === farmId) return;
  tour.set({ farmId, active: !doneOnServer && !seenHere(farmId), step: 0 });
}

export function finishTour(): void {
  const { farmId } = tour.get();
  if (farmId) {
    try {
      localStorage.setItem(key(farmId), '1');
    } catch {
      // storage blocked: the server still remembers
    }
  }
  tour.set({ active: false, step: 0 });
}

export function replayTour(): void {
  tour.set({ active: true, step: 0 });
}

export function tourStep(step: number): void {
  tour.set({ step });
}
