// The one way the screen changes: a short fade through the game's dark brown. The curtain closes
// (the screen that is up stays drawn until it is covered), the change happens behind it, the next
// screen gets its art and data and draws, and only then does the curtain open. Never a blank, a
// previous or a half-drawn frame; the same everywhere.
import { animate } from 'animejs';

const CLOSE_MS = 170;
const OPEN_MS = 230;

let el: HTMLDivElement | null = null;
let busy: Promise<void> = Promise.resolve();

/** The curtain's element (App mounts it once, over everything). */
export function mountCurtain(node: HTMLDivElement | null): void {
  el = node;
}

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });

const fade = (to: number, ms: number) =>
  new Promise<void>((resolve) => {
    if (!el) return resolve();
    el.style.pointerEvents = to > 0 ? 'auto' : 'none';
    animate(el, { opacity: to, duration: ms, ease: 'linear', onComplete: () => resolve() });
  });

/**
 * Covers the screen, runs `change` (which may return a promise: the next screen's art and data), waits
 * for two drawn frames, then uncovers. Changes queue: one at a time.
 */
export function swap(change: () => unknown): Promise<void> {
  const run = busy.then(async () => {
    await fade(1, CLOSE_MS);
    try {
      await change();
    } finally {
      await frames(3);
      await fade(0, OPEN_MS);
    }
  });
  busy = run.catch(() => undefined);
  return run;
}

/** Covers the screen until `ready` settles (a change whose next screen says itself when it is drawn). */
export function hold(ready: Promise<unknown>): Promise<void> {
  return swap(() => ready);
}

/** The farm says when it has drawn (its state is in and its scene is up): the curtain then opens. */
let farmResolve: (() => void) | null = null;
export function expectFarm(maxMs = 8000): Promise<void> {
  return new Promise<void>((resolve) => {
    farmResolve = resolve;
    // a farm that never comes (signed out, offline) still lets the curtain open
    setTimeout(resolve, maxMs);
  });
}
export function farmDrawn(): void {
  farmResolve?.();
  farmResolve = null;
}
