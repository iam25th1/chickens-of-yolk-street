// The shop and settings. Prices shown come from ECONOMY and the shared formulas for display; the
// server quotes and charges every purchase.
import { useEffect, type ReactNode } from 'react';
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
import { useState } from 'react';
import { uiSound, useServices } from '../app/services';
import { useViewport } from '../app/Stage';
import type { Action } from '../net/socket';
import { henLayers } from '../pixi/farm/HenActor';
import { CATEGORY_LABEL, SOUND_CATEGORIES, type SoundCategory } from '../audio/categories';
import { DEFAULT_SETTINGS, settings } from '../state/settings';
import { useStore } from '../state/store';
import { replayTour } from '../state/tour';
import { uiEvents, type ShopTab } from '../state/ui';
import { Modal } from './Modal';
import { Paged } from './Paged';
import { SheetSprite } from './SheetSprite';

export type { ShopTab };

/** A bordered panel at a fixed spot (screens drawn for 640x360: the title's settings, login). */
export function Panel({ title, x, y, w, h, onClose, children }: { title: string; x: number; y: number; w: number; h: number; onClose: () => void; children: ReactNode }) {
  const { audio } = useServices();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="panel" role="dialog" aria-label={title} style={{ left: x, top: y, width: w, height: h, zIndex: 20 }}>
      <div className="row spread">
        <h2 className="panel-title">{title}</h2>
        <button
          className="btn"
          aria-label="Close"
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

export const UNLOCK_TEXT: Record<UnlockId, { name: string; effect: string; saves: string; sprite: string; row: string }> = {
  conveyor: { name: 'CONVEYOR', effect: 'BREAKAGE 5% TO 2%', saves: 'FEWER EGGS CRACK ON THE WAY TO THE CRATE: 3 MORE OF EVERY 100 SURVIVE', sprite: '18b-conveyor-clean', row: 'horizontal' },
  grader: { name: 'EGG GRADER', effect: '+10% EGG PRICE', saves: 'SORTS YOUR EGGS SO EVERY ONE SELLS FOR 10% MORE', sprite: '19-egg-grader', row: 'idle' },
  cart: { name: 'DELIVERY CART', effect: 'DELIVERS CONTRACTS AT DUSK', saves: 'NEVER MISS A CONTRACT DELIVERY: THE CART TAKES THEM AT DUSK', sprite: '20-delivery-cart', row: 'idle' },
  hopper: { name: 'FEED HOPPER', effect: '-10% FEED COST', saves: 'BUYS FEED IN BULK: EVERY BAG COSTS 10% LESS', sprite: '21-feed-hopper', row: 'idle' },
  clerk: { name: 'SALES CLERK', effect: '+5% REVENUE, TAKES GOOD OFFERS', saves: 'EARNS 5% MORE ON SALES AND ANSWERS GOOD OFFERS FOR YOU', sprite: '22-sales-clerk', row: 'idle' },
};

/** A machine's art at its farm size (exact conveyor tiles twice over, painted machines at the world's density). */
export function MachineArt({ unlock }: { unlock: UnlockId }) {
  const v = useViewport();
  const t = UNLOCK_TEXT[unlock];
  return unlock === 'conveyor' ? <SheetSprite id={t.sprite} row={t.row} zoom={2} /> : <SheetSprite id={t.sprite} row={t.row} size={v.p} box={{ w: 40, h: 40 }} />;
}

/** A hen as she looks on the farm, all her trait layers, at whole device pixels. */
export function HenArt({ hen, scale = 1, box }: { hen: Parameters<typeof henLayers>[0]; scale?: number; box?: { w: number; h: number } }) {
  const v = useViewport();
  const layers = henLayers(hen);
  return <SheetSprite id={layers[0] ?? '02-body'} layers={layers} row="idle" size={v.p * scale} box={box} />;
}

function HenTile({ hen, cash, onBuy, tour }: { hen: ShopHenView; cash: number; onBuy: () => void; tour?: string }) {
  const traits = [hen.body, hen.eyes !== 'default' ? hen.eyes : '', hen.comb !== 'default' ? hen.comb : '', hen.accessory !== 'none' ? hen.accessory : ''].filter(Boolean);
  return (
    <div className="col" style={{ position: 'relative', width: 84, gap: 2, alignItems: 'center', background: hen.source === 'auction' ? '#e3cc96' : undefined, padding: 2 }}>
      {/* an auction hen (from a farm that went bust) wears a small tag; the button still says what it does */}
      {hen.source === 'auction' && (
        <span className="auction-tag" data-ui="auction-tag" style={{ position: 'absolute', left: 2, top: 2 }}>
          AUCTION
        </span>
      )}
      <HenArt hen={hen} box={{ w: 40, h: 40 }} />
      <span style={{ textAlign: 'center', minHeight: 16, lineHeight: '8px' }}>{traits.join(' ').toUpperCase()}</span>
      <span>LAYS {Math.round(hen.layingTrait * 100)}%</span>
      <button className={`btn ${hen.source === 'auction' ? 'red' : ''}`} data-tour={tour} disabled={cash < hen.priceMilli / 1000} onClick={onBuy}>
        BUY {(hen.priceMilli / 1000).toFixed(0)}
      </button>
    </div>
  );
}

export function ShopPanel({
  farm,
  send,
  onClose,
  onMachine,
  tab,
  onTab,
}: {
  farm: FarmState;
  send: (a: Action) => Promise<boolean>;
  onClose: () => void;
  onMachine: (u: UnlockId) => void;
  tab: ShopTab;
  onTab: (t: ShopTab) => void;
}) {
  const { audio } = useServices();
  const [count, setCount] = useState(1);
  // the farm's own feed, or the cheapest when a bag of it is more than the farm has
  const [tier, setTier] = useState<FeedTier>(() => (farm.cashMilli / 1000 >= ECONOMY.feed.tiers[farm.feedTier].bagPrice ? farm.feedTier : 'cheap'));
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
  const credit = loyalistBagPrice(tier, 0);
  return (
    <Modal title="FARM SHOP" onClose={onClose} w={420} h={300}>
      <div className="tabs">
        {(['hens', 'feed', 'coops', 'machines'] as const).map((t) => (
          <button
            key={t}
            className={`btn ${tab === t ? 'red' : ''}`}
            data-tour={`shop-${t}`}
            onMouseEnter={() => uiSound(audio, 'hover')}
            onClick={click(() => {
              onTab(t);
              uiEvents.emit({ kind: 'tab', modal: 'shop', tab: t });
            })}
          >
            {t.toUpperCase()}
          </button>
        ))}
      </div>
      {tab === 'hens' && (
        <div className="col" style={{ gap: 6 }}>
          <span style={{ lineHeight: '10px' }}>EVERY HEN IS ONE OF A KIND: HER LOOKS AND HOW WELL SHE LAYS ARE HERS ALONE.</span>
          {farm.shop.some((h) => h.source === 'auction') && (
            <span style={{ lineHeight: '10px', color: '#7f2215' }} data-ui="auction-line">
              AUCTION HENS COME FROM FARMS THAT WENT BUST, SOLD CHEAP.
            </span>
          )}
          {farm.shop.length === 0 ? (
            <span>THE BREEDER IS OUT. MORE AT DAWN.</span>
          ) : (
            <Paged
              cell="auto"
              gap={4}
              ui="shop-hen-grid"
              items={farm.shop.map((h, i) => (
                <HenTile key={h.id} hen={h} cash={cash} tour={i === 0 ? 'buy-hen' : undefined} onBuy={click(() => void send({ t: 'buyHen', henId: h.id }))} />
              ))}
            />
          )}
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
          <span style={{ lineHeight: '10px' }}>
            HENS EAT AT DAWN. THE TROUGH HAS {feedDays.toFixed(1)} DAYS LEFT. BETTER FEED MEANS MORE EGGS AND BETTER GRADES.
          </span>
          <div className="col" style={{ gap: 3 }} data-tour="feed-tiers">
            {FEED_TIERS.map((t) => (
              <button key={t} className={`chip ${t === tier ? 'on' : ''}`} style={{ border: 0, font: 'inherit', justifyContent: 'space-between' }} onClick={click(() => setTier(t))}>
                <span>{t.toUpperCase()}</span>
                <span>HENS LAY {Math.round(ECONOMY.feed.tiers[t].laying * 100)}%</span>
                <span>{ECONOMY.feed.tiers[t].bagPrice} A BAG</span>
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => setBags(Math.max(1, bags - 1))} aria-label="Fewer bags">
              -
            </button>
            <span>
              {bags} BAG{bags > 1 ? 'S' : ''}
            </span>
            <button className="btn" onClick={() => setBags(Math.min(ECONOMY.limits.maxBagsPerPurchase, bags + 1))} aria-label="More bags">
              +
            </button>
            <button className="btn red" data-tour="buy-feed" disabled={cash < quote * bags} onClick={click(() => void send({ t: 'buyFeed', tier, bags }))}>
              BUY ABOUT {(quote * bags).toFixed(0)}
            </button>
            <button className="btn" data-tour="buy-feed-credit" onClick={click(() => void send({ t: 'buyFeedOnCredit', tier, bags }))}>
              ON CREDIT {(credit * bags).toFixed(0)}
            </button>
            <button className="btn" onClick={click(() => void send({ t: 'setFeedTier', tier }))} disabled={farm.feedTier === tier}>
              FEED THIS
            </button>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span>SUPPLIER</span>
            {(['loyalist', 'squeezer'] as const).map((s) => (
              <button key={s} className={`chip ${farm.supplier === s ? 'on' : ''}`} style={{ border: 0, font: 'inherit' }} onClick={click(() => void send({ t: 'setSupplier', supplier: s }))}>
                {s === 'loyalist' ? 'THE LOYALIST' : 'THE SQUEEZER'}
              </button>
            ))}
          </div>
          <span style={{ color: '#8b5a2b', lineHeight: '10px' }}>
            {farm.supplier === 'squeezer' ? 'THE SQUEEZER CHARGES MORE WHEN YOU LOOK HUNGRY.' : 'THE LOYALIST GIVES REGULARS A DISCOUNT AND CREDIT: PAY IN 5 DAYS.'}
          </span>
        </div>
      )}
      {tab === 'coops' && (
        <Paged
          items={[
            ...farm.coops.map((c) => {
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
            }),
            ...(['red', 'deluxe'] as const).map((k) => (
              <div key={k} className="row spread">
                <span>
                  NEW {k.toUpperCase()} COOP: {ECONOMY.coops.kinds[k].capacity} HENS
                </span>
                <button className="btn red" disabled={freePlots <= 0 || cash < ECONOMY.coops.kinds[k].price} onClick={click(() => void send({ t: 'buildCoop', kind: k }))}>
                  BUILD {ECONOMY.coops.kinds[k].price}
                </button>
              </div>
            )),
            <span key="free">
              {freePlots} FREE PLOT{freePlots === 1 ? '' : 'S'}
            </span>,
          ]}
        />
      )}
      {tab === 'machines' && (
        <Paged
          gap={2}
          items={UNLOCK_IDS.map((u) => {
            const owned = farm.unlocks.includes(u);
            const t = UNLOCK_TEXT[u];
            return (
              <div key={u} className="row spread" style={{ minHeight: 34 }}>
                <div className="row" style={{ gap: 6 }}>
                  <div style={{ width: 40, display: 'flex', justifyContent: 'center' }}>
                    <MachineArt unlock={u} />
                  </div>
                  <div className="col" style={{ gap: 2 }}>
                    <span>{t.name}</span>
                    <span style={{ color: '#8b5a2b' }}>{t.effect}</span>
                  </div>
                </div>
                <div className="row" style={{ gap: 3 }}>
                  <button className="btn" data-tour={`machine-${u}`} onClick={click(() => onMachine(u))}>
                    WHAT IT DOES
                  </button>
                  {owned ? (
                    <span className="chip on">OWNED</span>
                  ) : (
                    <button className="btn red" disabled={cash < ECONOMY.unlocks[u].price} onClick={click(() => void send({ t: 'buyUnlock', unlock: u }))}>
                      BUY {ECONOMY.unlocks[u].price}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        />
      )}
    </Modal>
  );
}

/** Settings: a volume and mute for every sound category, reduce motion, the guide and the tour. */
export function SettingsBody({ onClose, onGuide, farm, onRename }: { onClose: () => void; onGuide?: () => void; farm?: FarmState | null; onRename?: () => void }) {
  const { audio } = useServices();
  const s = useStore(settings, (v) => v);
  useEffect(() => audio.setLevels(s.sound), [audio, s.sound]);
  const set = (c: SoundCategory, patch: Partial<{ volume: number; muted: boolean }>) => settings.set({ sound: { ...s.sound, [c]: { ...s.sound[c], ...patch } } });
  // a sample of each category so the player hears the level they set
  const SAMPLE: Partial<Record<SoundCategory, string>> = { hens: '01-cluck', eggs: '08-egg-pop', cards: '18-stamp', haggling: '19-haggle-win', machines: '24-machine', market: '23-sign-creak', voices: '40-loyalist', ui: '35-click', stings: '45-new-day' };
  return (
    <div className="col" style={{ gap: 8 }}>
      {farm && onRename && (
        <div className="row spread" style={{ gap: 6 }} data-ui="farm-name-setting">
          <span style={{ minWidth: 0 }}>
            FARM NAME: <b>{farm.name.toUpperCase()}</b>
          </span>
          <button
            className="btn"
            data-tour="rename-farm"
            onClick={() => {
              uiSound(audio, 'click');
              onRename();
            }}
          >
            {farm.renameFromDay !== null ? `RENAME FROM DAY ${farm.renameFromDay}` : 'RENAME'}
          </button>
        </div>
      )}
      <Paged
        gap={3}
        ui="sound-settings"
        items={[
          ...SOUND_CATEGORIES.map((c) => (
            <div key={c} className="row" style={{ gap: 4 }}>
              <span style={{ width: 128, flex: 'none', color: c === 'master' ? '#b8321f' : undefined }}>{CATEGORY_LABEL[c]}</span>
              <input
                className="slider"
                style={{ flex: 1, minWidth: 0, width: 'auto' }}
                type="range"
                min={0}
                max={100}
                aria-label={`${CATEGORY_LABEL[c]} volume`}
                value={Math.round(s.sound[c].volume * 100)}
                onChange={(e) => set(c, { volume: Number(e.target.value) / 100 })}
                onMouseUp={() => {
                  const id = SAMPLE[c];
                  if (id) audio.play(id);
                }}
              />
              <span style={{ width: 28, flex: 'none', textAlign: 'right' }}>{s.sound[c].muted ? 'OFF' : `${Math.round(s.sound[c].volume * 100)}%`}</span>
              <button className="toggle" role="switch" aria-checked={!s.sound[c].muted} aria-label={`${CATEGORY_LABEL[c]} on`} onClick={() => set(c, { muted: !s.sound[c].muted })} />
            </div>
          )),
          <button
            key="reset"
            className="btn"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => {
              uiSound(audio, 'click');
              settings.set({ sound: DEFAULT_SETTINGS.sound });
            }}
          >
            RESET SOUND TO DEFAULT
          </button>,
        ]}
      />
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
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {onGuide && (
          <button
            className="btn red"
            data-tour="open-guide"
            onClick={() => {
              uiSound(audio, 'click');
              onGuide();
            }}
          >
            HOW TO PLAY
          </button>
        )}
        <button
          className="btn"
          data-tour="replay-tour"
          onClick={() => {
            uiSound(audio, 'click');
            replayTour();
            onClose();
          }}
        >
          REPLAY THE TOUR
        </button>
      </div>
    </div>
  );
}

export function SettingsPanel({ onClose, onGuide }: { onClose: () => void; onGuide?: () => void }) {
  return (
    <Panel title="SETTINGS" x={140} y={24} w={360} h={312} onClose={onClose}>
      <div style={{ maxHeight: 268, overflow: 'hidden' }} data-room={268}>
        <SettingsBody onClose={onClose} onGuide={onGuide} />
      </div>
    </Panel>
  );
}
