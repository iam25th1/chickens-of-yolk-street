// The how-to-play tour: ten steps that teach the whole game by doing it. Each step dims everything
// but the thing to do (a spotlight that follows it, even a hen or an egg on the farm), says what it
// is in a line or two in the guide zone, and moves on only when the player does it. Back, Skip and
// progress dots; replayable from Settings. The goal tracker takes over when it ends.
import { useEffect, useRef, useState } from 'react';
import { feedGramsPerHenDay, loyalistBagPrice, squeezerBagPrice, desperation, type FarmState, type GameEvent, type MarketState } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { useViewport } from '../app/Stage';
import type { Rect } from '../app/viewport';
import type { Action } from '../net/socket';
import { events } from '../state/game';
import { useStore } from '../state/store';
import { finishTour, tour, tourStep } from '../state/tour';
import { closeModal, openModal, ui, uiEvents, type ModalState, type UiEvent } from '../state/ui';
import { uiFx } from './FxLayer';
import { waitingCards } from './Desk';

export interface TourCtx {
  modal: ModalState | null;
  farm: FarmState;
  market: MarketState;
}

/** What the spotlight points at: a DOM element by its data-tour name, or a thing on the farm. */
export type TourTarget = { dom: string; tag?: string } | { world: 'egg' | 'crate' | 'trough' | 'sign' | 'farmhouse' | 'yard'; tag?: string };

type Signal = { from: 'server'; e: GameEvent } | { from: 'ui'; e: UiEvent };

export interface TourStep {
  title: string;
  text: string | ((c: TourCtx) => string);
  target(c: TourCtx): TourTarget | null;
  done(s: Signal): boolean;
  /** Runs when the step starts. */
  enter?(send: (a: Action) => Promise<boolean>, c: TourCtx): void;
  /** True when the step cannot happen right now (the player may move on). */
  blocked?(c: TourCtx): boolean;
}

const close: TourTarget = { dom: 'close', tag: 'CLOSE THIS FIRST' };
const opened = (s: Signal, kind: ModalState['kind']) => s.from === 'ui' && s.e.kind === 'opened' && s.e.modal.kind === kind;
const tapped = (s: Signal, what: string) => s.from === 'ui' && s.e.kind === 'tapped' && s.e.what === what;
const server = (s: Signal, kind: GameEvent['kind']) => s.from === 'server' && s.e.kind === kind;

function feedQuote(farm: FarmState): number {
  const feed = farm.feedGrams.cheap + farm.feedGrams.standard + farm.feedGrams.premium;
  const days = farm.hens.length ? feed / (farm.hens.length * feedGramsPerHenDay()) : 99;
  const cash = farm.cashMilli / 1000;
  return farm.supplier === 'squeezer' ? squeezerBagPrice(farm.feedTier, desperation(days, cash)) : loyalistBagPrice(farm.feedTier, 0);
}

export const TOUR: TourStep[] = [
  {
    title: 'COLLECT AN EGG',
    text: 'YOUR HENS LAY THROUGH THE DAY. TAP AN EGG ON THE GROUND TO PUT IT IN YOUR CRATE.',
    target: (c) => (c.modal ? close : { world: 'egg', tag: 'TAP THE EGG' }),
    done: (s) => server(s, 'collected'),
  },
  {
    title: 'SELL THE CRATE',
    text: "EGGS WAIT IN THE CRATE. SELL THEM AT TODAY'S PRICE WITH THE SELL BUTTON ON THE CRATE'S CARD.",
    target: (c) => (c.modal?.kind === 'sell' ? { dom: 'sell-modal', tag: 'SELL' } : c.modal ? close : { dom: 'sell', tag: 'SELL' }),
    done: (s) => server(s, 'sold'),
  },
  {
    title: 'ONE SHARED MARKET',
    text: 'PRICES COME FROM ONE MARKET SHARED BY EVERY FARM AND TRADER ON THE STREET. OPEN THE MARKET BOARD.',
    target: (c) => (c.modal ? close : { dom: 'market', tag: 'THE BOARD' }),
    done: (s) => opened(s, 'market'),
  },
  {
    title: 'GLUT OR SHORTAGE',
    text: 'WHEN EVERYONE SELLS AT ONCE, PRICES CRASH (A GLUT). WHEN EGGS ARE SCARCE, THEY RISE. TAP THE SUPPLY METER.',
    target: (c) =>
      c.modal?.kind === 'market' ? (c.modal.tab === 'board' ? { dom: 'supply', tag: 'TAP THE METER' } : { dom: 'market-board' }) : c.modal ? close : { dom: 'market', tag: 'THE BOARD' },
    done: (s) => tapped(s, 'supply'),
  },
  {
    title: 'FEED THE HENS',
    text: 'NO FEED, NO EGGS. BETTER FEED MEANS MORE AND BETTER EGGS. TAP THE TROUGH AND BUY A BAG.',
    target: (c) => {
      if (c.modal?.kind === 'shop') {
        if (c.modal.tab !== 'feed') return { dom: 'shop-feed' };
        return c.farm.cashMilli / 1000 >= feedQuote(c.farm) ? { dom: 'buy-feed', tag: 'BUY A BAG' } : { dom: 'buy-feed-credit', tag: 'PAY LATER' };
      }
      return c.modal ? close : { world: 'trough', tag: 'THE TROUGH' };
    },
    done: (s) => server(s, 'feedBought'),
  },
  {
    title: 'HAGGLE',
    text: 'TRADERS AND SUPPLIERS SEND YOU OFFERS. OPEN THE NEW CARD AND PRESS COUNTER TO ASK FOR MORE.',
    enter: (send) => void send({ t: 'practiceCard' }),
    target: (c) => {
      if (c.modal?.kind === 'card') return { dom: 'counter', tag: 'COUNTER' };
      if (c.modal) return close;
      return waitingCards(c.farm).length ? { dom: 'card-queue', tag: 'OPEN IT' } : { dom: 'card-count', tag: 'AN OFFER IS ON ITS WAY' };
    },
    done: (s) => server(s, 'haggle') || (s.from === 'server' && s.e.kind === 'cardResolved' && !s.e.auto && s.e.card.round > 0),
    blocked: (c) => !c.modal && waitingCards(c.farm).length === 0,
  },
  {
    title: 'EVERY HEN IS YOURS',
    text: (c) =>
      c.market.minting === 'live'
        ? 'BUY A HEN IN THE SHOP. SHE IS ONE OF A KIND, AND AT A DAY CLOSE SHE IS RECORDED ON NEAR AS YOURS FOR GOOD.'
        : c.market.minting === 'paused'
          ? 'BUY A HEN IN THE SHOP. SHE IS ONE OF A KIND. RECORDING HENS ON NEAR AS YOURS FOR GOOD IS PAUSED FOR NOW: HERS WAITS.'
          : 'BUY A HEN IN THE SHOP. SHE IS ONE OF A KIND: HER LOOKS AND HER LAYING ARE HERS ALONE.',
    target: (c) => {
      if (c.modal?.kind === 'shop') return c.modal.tab === 'hens' ? { dom: 'buy-hen', tag: 'BUY HER' } : { dom: 'shop-hens' };
      return c.modal ? close : { dom: 'shop', tag: 'THE SHOP' };
    },
    done: (s) => server(s, 'hensBought'),
  },
  {
    title: 'MACHINES DO CHORES',
    text: 'MACHINES WORK FOR YOU. IN THE SHOP, SEE WHAT THE CONVEYOR SAVES.',
    target: (c) => {
      if (c.modal?.kind === 'shop') return c.modal.tab === 'machines' ? { dom: 'machine-conveyor', tag: 'WHAT IT DOES' } : { dom: 'shop-machines' };
      return c.modal ? close : { dom: 'shop', tag: 'THE SHOP' };
    },
    done: (s) => s.from === 'ui' && s.e.kind === 'opened' && s.e.modal.kind === 'machine' && s.e.modal.unlock === 'conveyor',
  },
  {
    title: 'RIVALS GO BUST',
    text: 'RIVAL FARMS CAN RUN OUT OF COINS AND GO BUST. THEIR HENS GO TO AUCTION. OPEN THE BOARD AND TAP THE FARMS.',
    target: (c) =>
      c.modal?.kind === 'market' ? (c.modal.tab === 'board' ? { dom: 'farms', tag: 'THE FARMS' } : { dom: 'market-board' }) : c.modal ? close : { dom: 'market', tag: 'THE BOARD' },
    done: (s) => tapped(s, 'farms'),
  },
  {
    title: 'THE LEDGER',
    text: 'EACH DAY CLOSES WITH A RECEIPT IN THE LEDGER: COINS IN AND OUT, AND THE RECORD ON NEAR. OPEN IT.',
    target: (c) => (c.modal ? close : { dom: 'ledger', tag: 'THE LEDGER' }),
    done: (s) => opened(s, 'ledger'),
  },
];

/** A spotlight target's box in UI pixels, read from the page or the farm. */
function measure(t: TourTarget, v: ReturnType<typeof useViewport>, ui: HTMLElement | null): Rect | null {
  const s = v.p / v.dpr;
  if ('dom' in t) {
    const el = document.querySelector(`[data-tour="${t.dom}"]`);
    if (!el || !ui) return null;
    const r = el.getBoundingClientRect();
    const u = ui.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: (r.left - u.left) / s, y: (r.top - u.top) / s, w: r.width / s, h: r.height / s };
  }
  const farm = (window as unknown as { __coysFarm?: { targets(): { kind: string; x: number; y: number; w: number; h: number }[]; yard(): { x: number; y: number; w: number; h: number } } }).__coysFarm;
  if (!farm) return null;
  if (t.world === 'yard') {
    const y = farm.yard();
    return { x: y.x / s, y: y.y / s, w: y.w / s, h: y.h / s };
  }
  const kind = t.world === 'trough' ? 'feed' : t.world;
  const list = farm.targets().filter((x) => x.kind === kind);
  const pick = list[0];
  if (!pick) {
    if (t.world !== 'egg') return null;
    const y = farm.yard();
    return { x: y.x / s, y: y.y / s, w: y.w / s, h: y.h / s };
  }
  return { x: pick.x / s, y: pick.y / s, w: pick.w / s, h: pick.h / s };
}

/** The spotlight: four shades around the target (they take every other click) and a ring with a tag. */
export function Spotlight({ ctx }: { ctx: TourCtx }) {
  const v = useViewport();
  const t = useStore(tour, (s) => s);
  const [rect, setRect] = useState<Rect | null>(null);
  const [tag, setTag] = useState('');
  const host = useRef<HTMLDivElement>(null);
  const step = TOUR[t.step];
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  useEffect(() => {
    if (!t.active || !step) return;
    let raf = 0;
    const loop = () => {
      const target = step.target(ctxRef.current);
      const ui = host.current?.closest('.ui') as HTMLElement | null;
      let r = target ? measure(target, v, ui) : null;
      if (target && 'world' in target && target.world === 'egg' && r && !(window as unknown as { __coysFarm?: { targets(): { kind: string }[] } }).__coysFarm?.targets().some((x) => x.kind === 'egg')) {
        setTag('WAIT FOR A HEN TO LAY');
      } else setTag(target?.tag ?? '');
      if (r) r = { x: Math.round(r.x) - 3, y: Math.round(r.y) - 3, w: Math.round(r.w) + 6, h: Math.round(r.h) + 6 };
      setRect((old) => (old && r && old.x === r.x && old.y === r.y && old.w === r.w && old.h === r.h ? old : r));
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [t.active, step, v]);
  if (!t.active || !step) return null;
  const W = v.uiW;
  const H = v.uiH;
  return (
    <div ref={host} className="layer" style={{ zIndex: 40 }} data-ui="spotlight">
      {rect && (
        <>
          <div className="spot-shade" style={{ left: 0, top: 0, width: W, height: Math.max(0, rect.y) }} />
          <div className="spot-shade" style={{ left: 0, top: rect.y + rect.h, width: W, height: Math.max(0, H - rect.y - rect.h) }} />
          <div className="spot-shade" style={{ left: 0, top: rect.y, width: Math.max(0, rect.x), height: rect.h }} />
          <div className="spot-shade" style={{ left: rect.x + rect.w, top: rect.y, width: Math.max(0, W - rect.x - rect.w), height: rect.h }} />
          <div className="spot-ring" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />
          {tag && (
            <div className="spot-tag" style={{ left: Math.max(2, Math.min(W - 120, rect.x)), top: rect.y > 30 ? rect.y - 16 : rect.y + rect.h + 6 }}>
              {tag}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The step box in the guide zone, and the logic that moves the tour on when the player acts. */
export function TourBox({ ctx, rect, send }: { ctx: TourCtx; rect: Rect; send: (a: Action) => Promise<boolean> }) {
  const { audio } = useServices();
  const t = useStore(tour, (s) => s);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const entered = useRef(-1);
  const step = TOUR[t.step];
  // the server turned the step's action down (no stock, no coins): the player may move on
  const [refusedAt, setRefusedAt] = useState(-1);
  useEffect(
    () =>
      events.on((e) => {
        if (e.kind === 'refused' && tour.get().active) setRefusedAt(tour.get().step);
      }),
    [],
  );

  // the step starts: run its opener once
  useEffect(() => {
    if (!t.active || !step || entered.current === t.step) return;
    entered.current = t.step;
    step.enter?.(send, ctxRef.current);
  }, [t.active, t.step, step, send]);

  // the player did the thing: next step (the hen they just bought opens on her card)
  useEffect(() => {
    if (!t.active) return;
    const advance = (s: Signal) => {
      const cur = tour.get();
      const st = TOUR[cur.step];
      if (!cur.active || !st?.done(s)) return;
      audio.play('19-haggle-win', { volume: 0.5 });
      if (s.from === 'server' && s.e.kind === 'hensBought' && s.e.henIds?.[0]) {
        const henId = s.e.henIds[0];
        setTimeout(() => openModal({ kind: 'hen', henId }), 300);
      }
      if (cur.step + 1 >= TOUR.length) {
        finishTour();
        uiFx.emit({ kind: 'toast', text: 'YOU KNOW THE WHOLE GAME. THE GOALS PICK UP FROM HERE.' });
      } else tourStep(cur.step + 1);
    };
    const offServer = events.on((e) => advance({ from: 'server', e: e as GameEvent }));
    const offUi = uiEvents.on((e) => advance({ from: 'ui', e }));
    return () => {
      offServer();
      offUi();
    };
  }, [t.active, audio]);

  if (!t.active || !step) return null;
  const blocked = (step.blocked?.(ctx) ?? false) || refusedAt === t.step;
  return (
    <div className="tour-box zone" data-ui="tour" role="status" aria-label="How to play" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: 41 }}>
      <div className="row" style={{ gap: 4 }}>
        <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {t.step + 1}/{TOUR.length} {step.title}
        </span>
        <span className="tour-dots" aria-hidden="true">
          {TOUR.map((_, i) => (
            <i key={i} className={i === t.step ? 'on' : i < t.step ? 'done' : ''} />
          ))}
        </span>
        <button
          className="btn"
          disabled={t.step === 0}
          onClick={() => {
            uiSound(audio, 'back');
            closeModal();
            tourStep(Math.max(0, t.step - 1));
          }}
        >
          BACK
        </button>
        {blocked && (
          <button
            className="btn"
            onClick={() => {
              uiSound(audio, 'click');
              tourStep(t.step + 1);
            }}
          >
            LATER
          </button>
        )}
        <button
          className="btn"
          data-tour="tour-skip"
          onClick={() => {
            uiSound(audio, 'back');
            finishTour();
          }}
        >
          SKIP
        </button>
      </div>
      <span style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>{typeof step.text === 'function' ? step.text(ctx) : step.text}</span>
    </div>
  );
}

/** The ui store, for components that only need the open modal. */
export const useModal = (): ModalState | null => useStore(ui, (s) => s.modal);
