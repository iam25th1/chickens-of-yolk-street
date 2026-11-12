// UI-layer effects: coins arcing to the cash counter, the deal stamp (drawn on the card that sold,
// see Cards.tsx), and toasts (kept here, drawn in the toast zone by the guide).
import { useEffect, useRef } from 'react';
import { useServices } from '../app/services';
import { viewport } from '../app/viewport';
import { motion } from '../motion/ui';
import { Emitter, createStore } from '../state/store';

export type UiFx =
  | { kind: 'coins'; from: { x: number; y: number }; count: number }
  | { kind: 'stamp'; row: 'sold' | 'accepted' | 'declined' | 'counter'; coins: number }
  | { kind: 'toast'; text: string; tone?: 'good' | 'bad' }
  | { kind: 'bust'; name: string; sign: string | null };

export const uiFx = new Emitter<UiFx>();

export interface Toast {
  id: number;
  text: string;
  tone: 'good' | 'bad';
}
/** The news shown in the toast zone, newest last. */
export const toasts = createStore<{ list: Toast[] }>({ list: [] });
let nextToast = 0;

function pushToast(text: string, tone: 'good' | 'bad'): void {
  const id = nextToast++;
  toasts.set((s) => ({ list: [...s.list.slice(-3), { id, text, tone }] }));
  setTimeout(() => toasts.set((s) => ({ list: s.list.filter((t) => t.id !== id) })), 4200);
}

uiFx.on((fx) => {
  if (fx.kind === 'toast') pushToast(fx.text, fx.tone ?? 'good');
  else if (fx.kind === 'bust') pushToast(`${fx.name.toUpperCase()} WENT BUST. THEIR HENS ARE AT AUCTION IN THE SHOP.`, 'bad');
});

/** Where the cash counter is, in UI pixels. */
function cashAt(): { x: number; y: number } {
  const el = document.getElementById('cash-counter');
  const ui = el?.closest('.ui') as HTMLElement | null;
  if (!el || !ui) return { x: 22, y: 2 };
  const v = viewport.get();
  const r = el.getBoundingClientRect();
  const u = ui.getBoundingClientRect();
  // client rectangles are in CSS pixels; a UI pixel is p / dpr of them
  const s = v.p / v.dpr;
  return { x: Math.round((r.left - u.left) / s), y: Math.round((r.top - u.top) / s) };
}

export function FxLayer() {
  const { assets, audio } = useServices();
  const layer = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      uiFx.on((fx) => {
        if (fx.kind !== 'coins') return;
        const host = layer.current;
        if (!host) return;
        const frame = assets.frameRects('35-particles', 'coin')[0];
        const atlas = assets.atlasSize('35-particles');
        const to = cashAt();
        for (let i = 0; i < fx.count; i++) {
          const c = document.createElement('div');
          c.className = 'sprite fx';
          Object.assign(c.style, {
            position: 'absolute',
            left: '0',
            top: '0',
            width: `${frame?.w ?? 16}px`,
            height: `${frame?.h ?? 16}px`,
            backgroundImage: `url(${assets.url('35-particles')})`,
            backgroundSize: `${atlas.w}px ${atlas.h}px`,
            backgroundPosition: frame ? `${-frame.x}px ${-frame.y}px` : '0 0',
          });
          host.appendChild(c);
          const from = { x: fx.from.x - 8 + (Math.random() * 16 - 8), y: fx.from.y - 8 };
          motion.arc(c, from, to, 560 + i * 25, 60 + Math.random() * 30, i * 45);
          if (i % 3 === 0) audio.play('14-coins-small', { delayMs: 560 + i * 70, volume: 0.6 });
        }
        setTimeout(() => {
          const counter = document.getElementById('cash-counter');
          if (counter) motion.pop(counter, 1.5);
        }, 600 + fx.count * 45);
      }),
    [assets, audio],
  );

  return <div ref={layer} className="layer" style={{ zIndex: 45 }} />;
}
