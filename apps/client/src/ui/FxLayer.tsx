// UI-layer effects: coins arcing to the cash counter, the deal stamp, and toasts.
import { useEffect, useRef, useState } from 'react';
import { useServices } from '../app/services';
import { juice, sizeShake } from '../motion/juice';
import { motion } from '../motion/ui';
import { Emitter } from '../state/store';
import { SheetSprite } from './SheetSprite';

export type UiFx =
  | { kind: 'coins'; from: { x: number; y: number }; count: number }
  | { kind: 'stamp'; row: 'sold' | 'accepted' | 'declined' | 'counter'; coins: number }
  | { kind: 'toast'; text: string; tone?: 'good' | 'bad' };

export const uiFx = new Emitter<UiFx>();

/** Where coins land: the cash counter in the top bar. */
const CASH_AT = { x: 22, y: 4 };

function Stamp({ row, coins, onDone }: { row: string; coins: number; onDone: () => void }) {
  const { audio } = useServices();
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const tl = motion.stamp(
      el.current,
      () => {
        juice.hitstop(coins >= 30 ? 140 : 80);
        juice.shake(sizeShake(coins), 260 + coins * 4);
        audio.play('18-stamp');
        audio.play('15-kaching', { delayMs: 90 });
        if (coins >= 30) audio.play('45-deal-closed', { delayMs: 250 });
      },
      onDone,
    );
    return () => {
      tl.pause();
    };
    // run once per stamp
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={el} style={{ position: 'absolute', left: 222, top: 150, opacity: 0, zIndex: 30, pointerEvents: 'none' }}>
      <SheetSprite id="30-stamps" row={row} play="once" />
      <div className="display shadowed" style={{ textAlign: 'center', color: '#f6e7c1', marginTop: -2 }}>
        +{coins.toFixed(2)}
      </div>
    </div>
  );
}

export function FxLayer() {
  const { assets, audio } = useServices();
  const layer = useRef<HTMLDivElement>(null);
  const [stamps, setStamps] = useState<{ id: number; row: string; coins: number }[]>([]);
  const [toasts, setToasts] = useState<{ id: number; text: string; tone: 'good' | 'bad' }[]>([]);
  const next = useRef(0);

  useEffect(
    () =>
      uiFx.on((fx) => {
        if (fx.kind === 'coins') {
          const host = layer.current;
          if (!host) return;
          const sheet = assets.sheet('35-particles');
          const frame = sheet.frames['coin/0']?.frame;
          for (let i = 0; i < fx.count; i++) {
            const c = document.createElement('div');
            c.className = 'sprite';
            Object.assign(c.style, {
              position: 'absolute',
              left: '0',
              top: '0',
              width: '16px',
              height: '16px',
              backgroundImage: `url(${assets.url('35-particles')})`,
              backgroundSize: `${sheet.meta.size.w / 8}px ${sheet.meta.size.h / 8}px`,
              backgroundPosition: frame ? `${-frame.x / 8}px ${-frame.y / 8}px` : '0 0',
            });
            host.appendChild(c);
            const from = { x: fx.from.x - 8 + (Math.random() * 16 - 8), y: fx.from.y - 8 };
            motion.arc(c, from, CASH_AT, 560 + i * 25, 60 + Math.random() * 30, i * 45);
            if (i % 3 === 0) audio.play('14-coins-small', { delayMs: 560 + i * 70, volume: 0.6 });
          }
          setTimeout(() => {
            const counter = document.getElementById('cash-counter');
            if (counter) motion.pop(counter, 1.5);
          }, 600 + fx.count * 45);
        } else if (fx.kind === 'stamp') {
          const id = next.current++;
          setStamps((s) => [...s, { id, row: fx.row, coins: fx.coins }]);
        } else {
          const id = next.current++;
          setToasts((t) => [...t.slice(-2), { id, text: fx.text, tone: fx.tone ?? 'good' }]);
          setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2800);
        }
      }),
    [assets, audio],
  );

  return (
    <div ref={layer} className="layer" style={{ zIndex: 25 }}>
      {stamps.map((s) => (
        <Stamp key={s.id} row={s.row} coins={s.coins} onDone={() => setStamps((all) => all.filter((x) => x.id !== s.id))} />
      ))}
      {toasts.map((t, i) => (
        <Toast key={t.id} text={t.text} tone={t.tone} index={i} />
      ))}
    </div>
  );
}

function Toast({ text, tone, index }: { text: string; tone: 'good' | 'bad'; index: number }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (el.current) motion.enter(el.current);
  }, []);
  return (
    <div style={{ position: 'absolute', left: 254, top: 32 + index * 18, transform: 'translateX(-50%)' }}>
      <div ref={el} className="toast" role="status" style={{ background: tone === 'bad' ? '#7f2215' : undefined }}>
        {text}
      </div>
    </div>
  );
}
