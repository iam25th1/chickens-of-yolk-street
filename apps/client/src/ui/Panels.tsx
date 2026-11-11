// Shop and settings panels. Prices shown come from ECONOMY and the shared formulas for display;
// the server quotes and charges every purchase.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ECONOMY,
  FEED_TIERS,
  UNLOCK_IDS,
  coopUpgradeCost,
  desperation,
  feedGramsPerHenDay,
  loyalistBagPrice,
  nextCoopKind,
  squeezerBagPrice,
  type FarmState,
  type FeedTier,
  type ShopHenView,
  type UnlockId,
} from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { motion } from '../motion/ui';
import type { Action } from '../net/socket';
import { henLayers } from '../pixi/farm/HenActor';
import { settings } from '../state/settings';
import { useStore } from '../state/store';

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
  cart: { name: 'DELIVERY CART', effect: 'DELIVERS CONTRACTS AT DUSK', sprite: '20-delivery-cart', row: 'idle' },
  hopper: { name: 'FEED HOPPER', effect: '-10% FEED COST', sprite: '21-feed-hopper', row: 'idle' },
  clerk: { name: 'SALES CLERK', effect: '+5% REVENUE, TAKES GOOD OFFERS', sprite: '22-sales-clerk', row: 'idle' },
};

function HenTile({ hen, cash, onBuy }: { hen: ShopHenView; cash: number; onBuy: () => void }) {
  const { assets } = useServices();
  const traits = [hen.body, hen.eyes !== 'default' ? hen.eyes : '', hen.comb !== 'default' ? hen.comb : '', hen.accessory !== 'none' ? hen.accessory : ''].filter(Boolean);
  return (
    <div className="col" style={{ width: 70, gap: 2, alignItems: 'center', background: hen.source === 'auction' ? '#e3cc96' : undefined, padding: 2 }}>
      <img alt="" className="sprite" width={43} height={44} style={{ objectFit: 'none', objectPosition: '0 0' }} src={assets.henPortrait(henLayers(hen))} />
      <span style={{ textAlign: 'center' }}>{traits.join(' ').toUpperCase()}</span>
      <span>LAYS X{hen.layingTrait.toFixed(2)}</span>
      <button className={`btn ${hen.source === 'auction' ? 'red' : ''}`} disabled={cash < hen.priceMilli / 1000} onClick={onBuy}>
        {hen.source === 'auction' ? 'AUCTION ' : ''}
        {(hen.priceMilli / 1000).toFixed(0)}
      </button>
    </div>
  );
}

export function ShopPanel({ farm, send, onClose }: { farm: FarmState; send: (a: Action) => Promise<boolean>; onClose: () => void }) {
  const { audio, assets } = useServices();
  const [tab, setTab] = useState<'hens' | 'feed' | 'coops' | 'machines'>('hens');
  const [count, setCount] = useState(1);
  const [tier, setTier] = useState<FeedTier>(farm.feedTier);
  const [bags, setBags] = useState(1);
  const cash = farm.cashMilli / 1000;
  const click = (fn: () => void) => () => {
    uiSound(audio, 'click');
    fn();
  };
  const freePlots = ECONOMY.coops.plots - farm.coops.length;
  const feed = farm.feedGrams.cheap + farm.feedGrams.standard + farm.feedGrams.premium;
  const feedDays = farm.hens.length ? feed / (farm.hens.length * feedGramsPerHenDay()) : 99;
  const quote = (farm.supplier === 'squeezer' ? squeezerBagPrice(tier, desperation(feedDays, cash)) : loyalistBagPrice(tier, 0)) * (farm.unlocks.includes('hopper') ? 0.9 : 1);
  return (
    <Panel title="FARM SHOP" x={60} y={36} w={388} h={292} onClose={onClose}>
      <div className="row" style={{ gap: 4, marginBottom: 6 }}>
        {(['hens', 'feed', 'coops', 'machines'] as const).map((t) => (
          <button key={t} className={`btn ${tab === t ? 'red' : ''}`} onMouseEnter={() => uiSound(audio, 'hover')} onClick={click(() => setTab(t))}>
            {t.toUpperCase()}
          </button>
        ))}
      </div>
      {tab === 'hens' && (
        <div className="col" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 4, flexWrap: 'wrap', height: 178, overflowY: 'auto', alignContent: 'flex-start' }}>
            {farm.shop.map((h) => (
              <HenTile key={h.id} hen={h} cash={cash} onBuy={click(() => void send({ t: 'buyHen', henId: h.id }))} />
            ))}
            {farm.shop.length === 0 && <span>THE BREEDER IS OUT. MORE AT DAWN.</span>}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span>OR RANDOM HENS:</span>
            <button className="btn" onClick={click(() => setCount(Math.max(1, count - 1)))} aria-label="Fewer hens">
              -
            </button>
            <span>{count}</span>
            <button className="btn" onClick={click(() => setCount(Math.min(ECONOMY.limits.maxHensPerPurchase, count + 1)))} aria-label="More hens">
              +
            </button>
            <button className="btn red" disabled={cash < count * ECONOMY.hen.price * ECONOMY.agents.auctionPriceFactor} onClick={click(() => void send({ t: 'buyHens', count }))}>
              BUY UP TO {count * ECONOMY.hen.price}
            </button>
          </div>
        </div>
      )}
      {tab === 'feed' && (
        <div className="col" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 6 }}>
            <span>SUPPLIER</span>
            {(['loyalist', 'squeezer'] as const).map((s) => (
              <button key={s} className={`chip ${farm.supplier === s ? 'on' : ''}`} style={{ border: 0, font: 'inherit' }} onClick={click(() => void send({ t: 'setSupplier', supplier: s }))}>
                <img alt="" className="sprite" width={16} height={16} src={assets.thumbnail(s === 'loyalist' ? '07-loyalist' : '06-squeezer', 'idle', 0, 16)} />
                {s === 'loyalist' ? 'THE LOYALIST' : 'THE SQUEEZER'}
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 4 }}>
            {FEED_TIERS.map((t) => (
              <button key={t} className={`chip ${t === tier ? 'on' : ''}`} style={{ border: 0, font: 'inherit' }} onClick={click(() => setTier(t))}>
                {t.toUpperCase()} X{ECONOMY.feed.tiers[t].laying.toFixed(2)}
              </button>
            ))}
            <button className="btn" onClick={click(() => void send({ t: 'setFeedTier', tier }))} disabled={farm.feedTier === tier}>
              FEED THIS
            </button>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn" onClick={() => setBags(Math.max(1, bags - 1))}>
              -
            </button>
            <span>
              {bags} BAG{bags > 1 ? 'S' : ''} OF {ECONOMY.feed.bagKg}KG
            </span>
            <button className="btn" onClick={() => setBags(Math.min(ECONOMY.limits.maxBagsPerPurchase, bags + 1))}>
              +
            </button>
            <button className="btn red" disabled={cash < quote * bags} onClick={click(() => void send({ t: 'buyFeed', tier, bags }))}>
              BUY ABOUT {(quote * bags).toFixed(0)}
            </button>
          </div>
          <span>
            TROUGH: {feedDays.toFixed(1)} DAYS. {farm.supplier === 'squeezer' ? 'THE SQUEEZER CHARGES MORE WHEN YOU LOOK HUNGRY.' : 'THE LOYALIST GIVES REGULARS A DISCOUNT AND CREDIT.'}
          </span>
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
