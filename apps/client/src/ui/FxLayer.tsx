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
  | { kind: 'toast'; text: string; tone?: 'good' | 'bad' }
  | { kind: 'bust'; name: string; sign: string | null };

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
  const [bust, setBust] = useState<{ id: number; name: string; sign: string | null } | null>(null);
  const next = useRef(0);

  useEffect(
    () =>
      uiFx.on((fx) => {
        if (fx.kind === 'coins') {
          const host = layer.current;
          if (!host) return;
          const frame = assets.frameRects('35-particles', 'coin')[0];
          const atlas = assets.atlasSize('35-particles');
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
              backgroundSize: `${atlas.w}px ${atlas.h}px`,
              backgroundPosition: frame ? `${-frame.x}px ${-frame.y}px` : '0 0',
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
        } else if (fx.kind === 'bust') {
          const id = next.current++;
          setBust({ id, name: fx.name, sign: fx.sign });
          setTimeout(() => setBust((b) => (b?.id === id ? null : b)), 3200);
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
      <div className="stage640">
        {stamps.map((s) => (
          <Stamp key={s.id} row={s.row} coins={s.coins} onDone={() => setStamps((all) => all.filter((x) => x.id !== s.id))} />
        ))}
        {bust && <BustBanner key={bust.id} name={bust.name} sign={bust.sign} />}
        {toasts.map((t, i) => (
          <Toast key={t.id} text={t.text} tone={t.tone} index={i} />
        ))}
      </div>
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

/** A rival's sign tips over while its name goes down. */
function BustBanner({ name, sign }: { name: string; sign: string | null }) {
  const { assets } = useServices();
  const el = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (el.current) motion.enter(el.current);
    if (!sign) return;
    const names = assets.frameRects(sign, 'tip-over');
    let i = 0;
    const t = setInterval(() => {
      i = Math.min(names.length - 1, i + 1);
      setFrame(i);
    }, 260);
    return () => clearInterval(t);
  }, [assets, sign]);
  return (
    <div ref={el} className="panel" style={{ left: 150, top: 110, width: 210, height: 96, zIndex: 35, textAlign: 'center' }}>
      {sign && <SheetSprite id={sign} row="tip-over" frame={frame} style={{ margin: '0 auto' }} />}
      <div className="display" style={{ color: '#b8321f' }}>{name.toUpperCase()}</div>
      <div>WENT BUST. THEIR HENS ARE AT AUCTION.</div>
    </div>
  );
}
