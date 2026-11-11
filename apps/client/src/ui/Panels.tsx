// Shop and settings panels. Shop prices come from ECONOMY for display; the server charges.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ECONOMY, UNLOCK_IDS, coopUpgradeCost, nextCoopKind, type FarmState, type UnlockId } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { motion } from '../motion/ui';
import type { Action } from '../net/socket';
import { settings } from '../state/settings';
import { useStore } from '../state/store';
import { SheetSprite } from './SheetSprite';

export function Panel({ title, x, y, w, h, onClose, children }: { title: string; x: number; y: number; w: number; h: number; onClose: () => void; children: ReactNode }) {
  const { audio } = useServices();
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (el.current) motion.enter(el.current);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div ref={el} className="panel" role="dialog" aria-label={title} style={{ left: x, top: y, width: w, height: h, zIndex: 20 }}>
      <div className="row spread">
        <h2 className="panel-title">{title}</h2>
        <button
          className="btn"
          aria-label="Close"
          onMouseEnter={() => uiSound(audio, 'hover')}
          onClick={() => {
            uiSound(audio, 'back');
            onClose();
          }}
        >
          X
        </button>
      </div>
      {children}
    </div>
  );
}

const UNLOCK_TEXT: Record<UnlockId, { name: string; effect: string; sprite: string; row: string }> = {
  conveyor: { name: 'CONVEYOR', effect: 'BREAKAGE 5% TO 2%', sprite: '18-conveyor', row: 'horizontal' },
  grader: { name: 'EGG GRADER', effect: '+10% EGG PRICE', sprite: '19-egg-grader', row: 'idle' },
  cart: { name: 'DELIVERY CART', effect: 'RUNS CONTRACTS (SOON)', sprite: '20-delivery-cart', row: 'idle' },
  hopper: { name: 'FEED HOPPER', effect: '-10% FEED COST', sprite: '21-feed-hopper', row: 'idle' },
  clerk: { name: 'SALES CLERK', effect: '+5% REVENUE', sprite: '22-sales-clerk', row: 'idle' },
};

export function ShopPanel({ farm, send, onClose }: { farm: FarmState; send: (a: Action) => Promise<boolean>; onClose: () => void }) {
  const { audio, assets } = useServices();
  const [tab, setTab] = useState<'hens' | 'coops' | 'machines'>('hens');
  const [count, setCount] = useState(1);
  const cash = farm.cashMilli / 1000;
  const click = (fn: () => void) => () => {
    uiSound(audio, 'click');
    fn();
  };
  const freePlots = ECONOMY.coops.plots - farm.coops.length;
  return (
    <Panel title="FARM SHOP" x={92} y={56} w={320} h={232} onClose={onClose}>
      <div className="row" style={{ gap: 4, marginBottom: 8 }}>
        {(['hens', 'coops', 'machines'] as const).map((t) => (
          <button key={t} className={`btn ${tab === t ? 'red' : ''}`} onMouseEnter={() => uiSound(audio, 'hover')} onClick={click(() => setTab(t))}>
            {t.toUpperCase()}
          </button>
        ))}
      </div>
      {tab === 'hens' && (
        <div className="col">
          <div className="row" style={{ gap: 8 }}>
            <SheetSprite id="32-icons" row="hen" play="loop" />
            <span>
              HENS COST {ECONOMY.hen.price} EACH. EACH LAYS ABOUT {ECONOMY.hen.baseLaying} EGGS A DAY AND EATS {ECONOMY.feed.kgPerHenPerDay * 1000}G OF FEED.
            </span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn" onClick={click(() => setCount(Math.max(1, count - 1)))} aria-label="Fewer hens">
              -
            </button>
            <span className="big">{count}</span>
            <button className="btn" onClick={click(() => setCount(Math.min(ECONOMY.limits.maxHensPerPurchase, count + 1)))} aria-label="More hens">
              +
            </button>
            <button className="btn red" disabled={cash < count * ECONOMY.hen.price} onClick={click(() => void send({ t: 'buyHens', count }))}>
              BUY FOR {count * ECONOMY.hen.price}
            </button>
          </div>
          <span>CROWDED COOPS LAY LESS: -15% FOR EVERY 10% OVER CAPACITY.</span>
        </div>
      )}
      {tab === 'coops' && (
        <div className="col">
          {farm.coops.map((c) => {
            const next = nextCoopKind(c.kind);
            return (
              <div key={c.id} className="row spread">
                <span>
                  PLOT {c.plot + 1}: {c.kind.toUpperCase()} ({ECONOMY.coops.kinds[c.kind].capacity} HENS)
                </span>
                {next ? (
                  <button className="btn" disabled={cash < coopUpgradeCost(c.kind, next)} onClick={click(() => void send({ t: 'upgradeCoop', coopId: c.id }))}>
                    TO {next.toUpperCase()} {coopUpgradeCost(c.kind, next)}
                  </button>
                ) : (
                  <span>BIGGEST</span>
                )}
              </div>
            );
          })}
          {(['red', 'deluxe'] as const).map((k) => (
            <div key={k} className="row spread">
              <span>
                NEW {k.toUpperCase()} COOP: {ECONOMY.coops.kinds[k].capacity} HENS
              </span>
              <button className="btn red" disabled={freePlots <= 0 || cash < ECONOMY.coops.kinds[k].price} onClick={click(() => void send({ t: 'buildCoop', kind: k }))}>
                BUILD {ECONOMY.coops.kinds[k].price}
              </button>
            </div>
          ))}
          <span>{freePlots} FREE PLOT{freePlots === 1 ? '' : 'S'}</span>
        </div>
      )}
      {tab === 'machines' && (
        <div className="col" style={{ gap: 1 }}>
          {UNLOCK_IDS.map((u) => {
            const owned = farm.unlocks.includes(u);
            const t = UNLOCK_TEXT[u];
            return (
              <div key={u} className="row spread" style={{ height: 32 }}>
                <div className="row" style={{ gap: 6 }}>
                  <img alt="" src={assets.thumbnail(t.sprite, t.row, 0, u === 'conveyor' ? 4 : 8)} width={32} height={32} className="sprite" />
                  <div className="col" style={{ gap: 2 }}>
                    <span>{t.name}</span>
                    <span style={{ color: '#8b5a2b' }}>{t.effect}</span>
                  </div>
                </div>
                {owned ? (
                  <span className="chip on">OWNED</span>
                ) : (
                  <button className="btn" disabled={cash < ECONOMY.unlocks[u].price} onClick={click(() => void send({ t: 'buyUnlock', unlock: u }))}>
                    BUY {ECONOMY.unlocks[u].price}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { audio } = useServices();
  const s = useStore(settings, (v) => v);
  useEffect(() => audio.setVolumes(s.music, s.sfx), [audio, s.music, s.sfx]);
  return (
    <Panel title="SETTINGS" x={176} y={88} w={288} h={168} onClose={onClose}>
      <div className="col" style={{ gap: 10 }}>
        <label className="col">
          <span>MUSIC {Math.round(s.music * 100)}%</span>
          <input className="slider" type="range" min={0} max={100} value={Math.round(s.music * 100)} onChange={(e) => settings.set({ music: Number(e.target.value) / 100 })} />
        </label>
        <label className="col">
          <span>EFFECTS {Math.round(s.sfx * 100)}%</span>
          <input
            className="slider"
            type="range"
            min={0}
            max={100}
            value={Math.round(s.sfx * 100)}
            onChange={(e) => settings.set({ sfx: Number(e.target.value) / 100 })}
            onMouseUp={() => audio.play('08-egg-pop')}
          />
        </label>
        <div className="row spread">
          <span>REDUCE MOTION (NO SHAKE OR HITSTOP)</span>
          <button
            className="toggle"
            role="switch"
            aria-checked={s.reduceMotion}
            aria-label="Reduce motion"
            onClick={() => {
              uiSound(audio, 'click');
              settings.set({ reduceMotion: !s.reduceMotion });
            }}
          />
        </div>
      </div>
    </Panel>
  );
}
