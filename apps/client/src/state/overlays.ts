// The overlay manager's state: which card (a modal, or a full page) is open and where (UI pixels). The
// rules (ui/tourPlace.ts, ui/Tour.tsx and the components): an open card always wins, so nothing is
// drawn over it and the tour's shade leaves it clear; the tour bubble goes beside a card it points at
// (in landscape the column beside the modal zone always has room for it); a full page, which covers the
// window, keeps a band at its foot free while the tour is on (TOUR_BAND) and the bubble sits there as a
// strip; badge and milestone toasts stay in the toast corner, which no card or bubble covers.
import { useLayoutEffect, type RefObject } from 'react';
import type { Rect } from '../app/viewport';
import { viewport } from '../app/viewport';
import { createStore } from './store';

export interface CardRect extends Rect {
  kind: 'card' | 'page';
}
export const overlays = createStore<{ card: CardRect | null }>({ card: null });

/** The band (UI pixels) a full page keeps free at its foot for the tour's strip while the tour is on. */
export const TOUR_BAND = 40;

/** An element's box in UI pixels (client rectangles are CSS pixels; a UI pixel is p / dpr of them). */
export function uiRectOf(el: Element): Rect | null {
  const ui = el.closest('.ui') as HTMLElement | null;
  if (!ui) return null;
  const v = viewport.get();
  const s = v.p / v.dpr;
  const r = el.getBoundingClientRect();
  const u = ui.getBoundingClientRect();
  return { x: Math.round((r.left - u.left) / s), y: Math.round((r.top - u.top) / s), w: Math.round(r.width / s), h: Math.round(r.height / s) };
}

const same = (a: CardRect | null, b: CardRect | null) => a === b || (!!a && !!b && a.kind === b.kind && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/** Registers the open card's box while it is mounted, following its size; clears it when it goes. */
export function useCardRect(ref: RefObject<HTMLElement | null>, kind: 'card' | 'page' = 'card'): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const box = uiRectOf(el);
      const r = box ? { ...box, kind } : null;
      if (!same(r, overlays.get().card)) overlays.set({ card: r });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // its place moves with the window (and its open animation) without its size changing
    const off = viewport.subscribe(update);
    const t = setInterval(update, 250);
    return () => {
      ro.disconnect();
      off();
      clearInterval(t);
      overlays.set({ card: null });
    };
  }, [ref, kind]);
}
