// The how-to-play tour: steps that teach the whole game by doing it. Each step dims
// everything but the thing to do (a spotlight that follows it, even a hen or an egg on the farm),
// and its box sits beside it with a pointer (never over it; centred when there is no target).
// A step moves on when the player does the thing; NEXT appears after a few seconds so nobody is
// stuck. BACK, NEXT, SKIP STEP and END TOUR (asked once more) on every step, "STEP 3 OF 11" with
// dots; replayable from Settings.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { feedGramsPerHenDay, loyalistBagPrice, squeezerBagPrice, desperation, type FarmState, type GameEvent, type MarketState } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { useViewport } from '../app/Stage';
import type { Rect } from '../app/viewport';
import type { Action } from '../net/socket';
import { events } from '../state/game';
import { createStore, useStore } from '../state/store';
import { motion } from '../motion/ui';
import { pageBand, placeBesideCard, placeForTour, type Placement } from './tourPlace';
import { overlays } from '../state/overlays';
import { finishTour, tour, tourStep } from '../state/tour';
import { closeModal, openModal, ui, uiEvents, type ModalState, type UiEvent } from '../state/ui';
import { uiFx } from './FxLayer';
import { waitingCards } from './Desk';
import { SheetSprite } from './SheetSprite';

export interface TourCtx {
  modal: ModalState | null;
  farm: FarmState;
  market: MarketState;
}

/** What the spotlight points at: a DOM element by its data-tour name, or a thing on the farm. */
/** The egg the tour points at, kept while it lasts. */
let stickyEgg: string | undefined;

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
  /** The farm's own hen tells this step (her portrait beside the text). */
  hen?: boolean;
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
    text: 'PRICES COME FROM ONE MARKET SHARED BY EVERY FARM AND TRADER ON THE STREET. OPEN THE MARKET (OR TAP YOUR FARM SIGN).',
    target: (c) => (c.modal ? close : { dom: 'market', tag: 'THE MARKET' }),
    done: (s) => opened(s, 'market'),
  },
  {
    title: 'GLUT OR SHORTAGE',
    text: "WHEN EVERYONE SELLS AT ONCE, PRICES CRASH (A GLUT). WHEN EGGS ARE SCARCE, THEY RISE. TAP THE SUPPLY METER ON THE MARKET'S PRICES.",
    target: (c) =>
      c.modal?.kind === 'market' ? (c.modal.tab === 'prices' ? { dom: 'supply', tag: 'TAP THE METER' } : { dom: 'market-prices' }) : c.modal ? close : { dom: 'market', tag: 'THE MARKET' },
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
    title: 'ONE OF A KIND',
    hen: true,
    text: (c) =>
      c.market.minting === 'off'
        ? 'BUY A HEN IN THE SHOP. SHE IS ONE OF A KIND: HER LOOKS AND HER LAYING ARE HERS ALONE.'
        : 'BUY A HEN IN THE SHOP. HER LOOKS AND HER LAYING ARE HERS ALONE. HENS STAY ON YOUR FARM; ONLY FEATHERS ARE MINTED.',
    target: (c) => {
      if (c.modal?.kind === 'shop') return c.modal.tab === 'hens' ? { dom: 'buy-hen', tag: 'BUY HER' } : { dom: 'shop-hens' };
      return c.modal ? close : { dom: 'shop', tag: 'THE SHOP' };
    },
    done: (s) => server(s, 'hensBought'),
  },
  {
    title: 'MACHINES WORK',
    text: 'MACHINES WORK FOR YOU. IN THE SHOP, SEE WHAT THE CONVEYOR SAVES.',
    target: (c) => {
      if (c.modal?.kind === 'shop') return c.modal.tab === 'machines' ? { dom: 'machine-conveyor', tag: 'WHAT IT DOES' } : { dom: 'shop-machines' };
      return c.modal ? close : { dom: 'shop', tag: 'THE SHOP' };
    },
    done: (s) => s.from === 'ui' && s.e.kind === 'opened' && s.e.modal.kind === 'machine' && s.e.modal.unlock === 'conveyor',
  },
  {
    title: 'MACHINES WEAR',
    text: 'A MACHINE WEARS AS IT WORKS. UNDER 50% IT DOES LESS, UNDER 20% IT MAY BREAK DOWN. TAP ONE TO SEE ITS CONDITION AND REPAIR IT.',
    target: (c) => (c.modal?.kind === 'machine' ? { dom: 'machine-saves', tag: 'CONDITION AND REPAIR' } : c.modal ? close : null),
    // nothing to do here but read: NEXT moves on
    done: () => false,
  },
  {
    title: 'RIVALS GO BUST',
    text: "RIVAL FARMS CAN RUN OUT OF COINS AND GO BUST. THEIR HENS GO TO THE MARKET'S HEN AUCTION. OPEN THE MARKET, THEN FARMS, AND TAP THE SIGNS.",
    target: (c) =>
      c.modal?.kind === 'market' ? (c.modal.tab === 'farms' ? { dom: 'farms', tag: 'THE FARMS' } : { dom: 'market-farms' }) : c.modal ? close : { dom: 'market', tag: 'THE MARKET' },
    done: (s) => tapped(s, 'farms'),
  },
  {
    title: 'THE FEATHER MINT (BETA)',
    hen: true,
    text: (c) =>
      `MILESTONES WIN FEATHER TICKETS. MINT ONE HERE FOR A FEATHER WITH A RANDOM NUMBER, A CLAIM ON ONE OF ${c.market.feathers.max} FOUNDING HENS (PLANNED).${c.farm.guest ? ' A GUEST SIGNS IN TO MINT.' : ''} OPEN THE MINT.`,
    target: (c) => (c.modal?.kind === 'feathers' ? { dom: 'mint-tickets', tag: 'YOUR TICKETS' } : c.modal ? close : { dom: 'feathers', tag: 'MINT' }),
    done: (s) => opened(s, 'feathers'),
  },
  {
    title: 'YOUR PROFILE',
    text: "YOUR PROFILE KEEPS YOUR FARM'S RECORD: RANK, EGGS, MONEY, FLOCK, MACHINES, AND THE BADGES YOU EARN (JUST FOR SHOW). OPEN IT.",
    target: (c) => (c.modal?.kind === 'profile' ? { dom: 'profile-badges', tag: 'YOUR BADGES' } : c.modal ? close : { dom: 'profile', tag: 'PROFILE' }),
    done: (s) => opened(s, 'profile'),
  },
  {
    title: 'THE LEDGER',
    text: 'EACH DAY CLOSES WITH A RECEIPT IN THE LEDGER: COINS IN AND OUT, AND THE RECORD ON NEAR. OPEN IT.',
    target: (c) => (c.modal ? close : { dom: 'ledger', tag: 'THE LEDGER' }),
    done: (s) => opened(s, 'ledger'),
  },
];

/** The element the tour points at: never a pager's hidden measuring copy; on a later page, the pager's NEXT. */
function domTarget(id: string): { el: Element; next: boolean } | null {
  const el = [...document.querySelectorAll(`[data-tour="${id}"]`)].find((e) => !e.closest('.paged-measure'));
  if (el) return { el, next: false };
  const hidden = document.querySelector(`.paged-measure [data-tour="${id}"]`);
  const next = hidden?.closest('.paged')?.querySelector('[data-ui="page-next"]:not([disabled])');
  return next ? { el: next, next: true } : null;
}

/** A spotlight target's box in UI pixels, read from the page or the farm (next: it is the pager's NEXT). */
function measure(t: TourTarget, v: ReturnType<typeof useViewport>, ui: HTMLElement | null): (Rect & { next?: boolean }) | null {
  const s = v.p / v.dpr;
  if ('dom' in t) {
    const found = domTarget(t.dom);
    if (!found || !ui) return null;
    const el = found.el;
    const r = el.getBoundingClientRect();
    const u = ui.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: (r.left - u.left) / s, y: (r.top - u.top) / s, w: r.width / s, h: r.height / s, next: found.next };
  }
  const farm = (window as unknown as { __coysFarm?: { targets(): { kind: string; id?: string; x: number; y: number; w: number; h: number }[]; yard(): { x: number; y: number; w: number; h: number } } }).__coysFarm;
  if (!farm) return null;
  if (t.world === 'yard') {
    const y = farm.yard();
    return { x: y.x / s, y: y.y / s, w: y.w / s, h: y.h / s };
  }
  const kind = t.world === 'trough' ? 'feed' : t.world;
  const list = farm.targets().filter((x) => x.kind === kind);
  // the same egg while it is there (eggs come and go, and the belt carries some): the box does not jump
  const pick = (kind === 'egg' && list.find((x) => x.id !== undefined && x.id === stickyEgg)) || list[0];
  if (kind === 'egg') stickyEgg = pick?.id;
  if (!pick) {
    if (t.world !== 'egg') return null;
    const y = farm.yard();
    return { x: y.x / s, y: y.y / s, w: y.w / s, h: y.h / s };
  }
  return { x: pick.x / s, y: pick.y / s, w: pick.w / s, h: pick.h / s };
}

/** The spotlight: four shades around the target (they take every other click) and a ring round it. */
export function Spotlight({ ctx }: { ctx: TourCtx }) {
  const v = useViewport();
  const t = useStore(tour, (s) => s);
  const card = useStore(overlays, (s) => s.card);
  const [rect, setRect] = useState<Rect | null>(null);
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
      if (r) r = { x: Math.round(r.x) - 3, y: Math.round(r.y) - 3, w: Math.round(r.w) + 6, h: Math.round(r.h) + 6 };
      setRect((old) => (old && r && old.x === r.x && old.y === r.y && old.w === r.w && old.h === r.h ? old : r));
      // the target (UI pixels) and what to do with it, for the step box beside it
      const tagText = target && 'world' in target && target.world === 'egg' && r && !(window as unknown as { __coysFarm?: { targets(): { kind: string }[] } }).__coysFarm?.targets().some((x) => x.kind === 'egg') ? 'WAIT FOR A HEN TO LAY' : r?.next ? 'NEXT PAGE' : (target?.tag ?? '');
      const was = tourTarget.get();
      const next = r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
      const same = (was.rect === null && next === null) || (!!was.rect && !!next && was.rect.x === next.x && was.rect.y === next.y && was.rect.w === next.w && was.rect.h === next.h);
      if (!same || was.tag !== tagText) tourTarget.set({ rect: next, tag: tagText });
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [t.active, step, v]);
  if (!t.active || !step) return null;
  const W = v.uiW;
  const H = v.uiH;
  // an open card always wins: the shades leave the whole card clear (readable, every button on it
  // takes a tap) and the ring still marks the target on it
  const hole = card ? { x: card.x - 1, y: card.y - 1, w: card.w + 2, h: card.h + 2 } : rect;
  return (
    <div ref={host} className="layer" style={{ zIndex: 40 }} data-ui="spotlight">
      {/* no target on screen: the whole window dims, and still takes clicks through */}
      {!hole && <div className="spot-shade" style={{ left: 0, top: 0, width: W, height: H, pointerEvents: 'none' }} />}
      {hole && (
        <>
          <div className="spot-shade" style={{ left: 0, top: 0, width: W, height: Math.max(0, hole.y) }} />
          <div className="spot-shade" style={{ left: 0, top: hole.y + hole.h, width: W, height: Math.max(0, H - hole.y - hole.h) }} />
          <div className="spot-shade" style={{ left: 0, top: hole.y, width: Math.max(0, hole.x), height: hole.h }} />
          <div className="spot-shade" style={{ left: hole.x + hole.w, top: hole.y, width: Math.max(0, W - hole.x - hole.w), height: hole.h }} />
        </>
      )}
      {rect && <div className="spot-ring" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />}
    </div>
  );
}

/** Where the spotlight is (UI pixels), for the step box to sit beside it. */
export const tourTarget = createStore<{ rect: Rect | null; tag: string }>({ rect: null, tag: '' });

/** The widths the step box tries, widest first (the narrow ones are for phones; 128 fits the column beside a card). */
const BOX_WIDTHS = [264, 220, 180, 150, 128];
/** Seconds an action step waits before NEXT appears. */
export const NEXT_AFTER_S = 5;

/** The step box beside the spotlight, and the logic that moves the tour on when the player acts. */
export function TourBox({ ctx, send }: { ctx: TourCtx; send: (a: Action) => Promise<boolean> }) {
  const v = useViewport();
  const target = useStore(tourTarget, (s) => s.rect);
  const action = useStore(tourTarget, (s) => s.tag);
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

  // NEXT shows after a few seconds on a step (at once when the step cannot happen now); coming back
  // to a step starts its few seconds again
  const [waited, setWaited] = useState(-1);
  useEffect(() => {
    if (!t.active) return;
    setWaited(-1);
    const id = setTimeout(() => setWaited(t.step), NEXT_AFTER_S * 1000);
    return () => clearTimeout(id);
  }, [t.active, t.step]);
  const [ending, setEnding] = useState(false);
  useEffect(() => setEnding(false), [t.step]);

  // the box's height at each width it may take, measured in a hidden copy, then its place
  const measureRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState<number[]>([]);
  useLayoutEffect(() => {
    const m = measureRef.current;
    if (!m) return;
    const hs = [...m.children].map((c) => (c as HTMLElement).offsetHeight);
    if (hs.join() !== heights.join()) setHeights(hs);
  }, [heights, t.step, ending, waited, refusedAt, v.uiW, v.uiH]);
  const sizes = BOX_WIDTHS.map((w, i) => ({ w, h: heights[i] ?? 0 })).filter((s) => s.h > 0);
  // an open card always wins (overlay manager, state/overlays.ts): the bubble goes beside a modal card
  // (pointing at the target on it), and under a full page it sits in the band the page keeps free
  const card = useStore(overlays, (s) => s.card);
  const band = card?.kind === 'page' ? pageBand(card, v.zones, v.uiW, v.portrait) : null;
  const beside = sizes.length && card?.kind === 'card' ? placeBesideCard(target, sizes, v.zones, { w: v.uiW, h: v.uiH }, card) : null;
  const place: Placement | null = !sizes.length || band ? null : (beside ?? placeForTour(target, sizes, v.zones, v.portrait));
  // a new step drops in
  useEffect(() => {
    if (boxRef.current && t.active) motion.enter(boxRef.current);
  }, [t.step, t.active]);

  if (!t.active || !step) return null;
  const blocked = (step.blocked?.(ctx) ?? false) || refusedAt === t.step;
  const showNext = blocked || waited === t.step;
  const go = (n: number) => {
    uiSound(audio, n < t.step ? 'back' : 'click');
    closeModal();
    if (n >= TOUR.length) {
      finishTour();
      uiFx.emit({ kind: 'toast', text: 'TOUR OVER. REPLAY IT ANY TIME FROM SETTINGS.' });
    } else tourStep(Math.max(0, n));
  };
  const text = typeof step.text === 'function' ? step.text(ctx) : step.text;
  const content = (w: number, live: boolean) => (
    <div className="tour-box" style={{ width: w }} data-ui={live ? 'tour' : undefined} role={live ? 'dialog' : undefined} aria-label={live ? 'How to play' : undefined}>
      <div className="row spread" style={{ gap: 6 }}>
        <span className="tour-step" data-ui={live ? 'tour-progress' : undefined}>
          STEP {t.step + 1} OF {TOUR.length}
        </span>
        <span className="tour-dots" aria-hidden="true">
          {TOUR.map((_, i) => (
            <i key={i} className={i === t.step ? 'on' : i < t.step ? 'done' : ''} />
          ))}
        </span>
      </div>
      <span className="panel-title tour-title">{step.title}</span>
      <span className="row" style={{ alignItems: 'flex-start', gap: 6 }}>
        {step.hen && <SheetSprite id="x-hen-portrait" row="talk" play={live ? 'loop' : false} size={v.p} box={{ w: 32, h: 32 }} />}
        <span className="tour-text">{text}</span>
      </span>
      {action && (
        <span className="tour-action" data-ui={live ? 'tour-action' : undefined}>
          {place?.side === 'right' ? '< ' : place?.side === 'left' ? '' : place?.side === 'below' ? '^ ' : place?.side === 'above' ? 'v ' : ''}
          {action}
          {place?.side === 'left' ? ' >' : ''}
        </span>
      )}
      {ending ? (
        <div className="col" style={{ gap: 4 }}>
          <span className="tour-text">END THE TOUR? YOU CAN REPLAY IT FROM SETTINGS.</span>
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            <button className="btn red" data-ui={live ? 'tour-end-yes' : undefined} onClick={() => go(TOUR.length)}>
              END TOUR
            </button>
            <button
              className="btn"
              data-ui={live ? 'tour-end-no' : undefined}
              onClick={() => {
                uiSound(audio, 'click');
                setEnding(false);
              }}
            >
              KEEP GOING
            </button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          <button className="btn" data-ui={live ? 'tour-back' : undefined} disabled={t.step === 0} onClick={() => go(t.step - 1)}>
            BACK
          </button>
          {showNext && (
            <button className="btn red" data-ui={live ? 'tour-next' : undefined} onClick={() => go(t.step + 1)}>
              {t.step + 1 >= TOUR.length ? 'DONE' : 'NEXT'}
            </button>
          )}
          <button className="btn" data-ui={live ? 'tour-skip-step' : undefined} data-tour={live ? 'tour-skip' : undefined} onClick={() => go(t.step + 1)}>
            SKIP STEP
          </button>
          <button
            className="btn"
            data-ui={live ? 'tour-end' : undefined}
            onClick={() => {
              uiSound(audio, 'click');
              setEnding(true);
            }}
          >
            END TOUR
          </button>
        </div>
      )}
    </div>
  );
  // the pointer: a notch on the box's edge facing the target
  const pointer =
    place && place.side !== 'center'
      ? place.side === 'right'
        ? { left: -6, top: place.pointer - 6, borderWidth: '6px 6px 6px 0', borderColor: 'transparent var(--ink) transparent transparent' }
        : place.side === 'left'
          ? { left: place.w, top: place.pointer - 6, borderWidth: '6px 0 6px 6px', borderColor: 'transparent transparent transparent var(--ink)' }
          : place.side === 'below'
            ? { left: place.pointer - 6, top: -6, borderWidth: '0 6px 6px 6px', borderColor: 'transparent transparent var(--ink) transparent' }
            : { left: place.pointer - 6, top: place.h, borderWidth: '6px 6px 0 6px', borderColor: 'var(--ink) transparent transparent transparent' }
      : null;
  if (band) {
    // the strip under a full page: the step, its title and what to do, and the buttons
    return (
      <>
        <div ref={measureRef} className="paged-measure" aria-hidden="true">
          {BOX_WIDTHS.map((w) => (
            <div key={w}>{content(Math.min(w, v.zones.world.w - 8), false)}</div>
          ))}
        </div>
        <div ref={boxRef} className="zone tour-place tour-strip" data-ui="tour-place" data-side="band" style={{ left: band.x, top: band.y, width: band.w, height: band.h, zIndex: 41 }}>
          <div className="tour-box" data-ui="tour" role="dialog" aria-label="How to play" style={{ width: '100%', height: '100%', boxSizing: 'border-box', gap: 3 }}>
            <span className="row" style={{ gap: 6, alignItems: 'baseline', minWidth: 0 }}>
              <span className="tour-step" data-ui="tour-progress" style={{ flex: 'none' }}>
                STEP {t.step + 1} OF {TOUR.length}
              </span>
              <span className="tour-title-small">{step.title}</span>
              {action && (
                <span className="tour-action" data-ui="tour-action" style={{ flex: 'none' }}>
                  ^ {action}
                </span>
              )}
            </span>
            <span className="row" style={{ gap: 4 }}>
              <button className="btn" data-ui="tour-back" disabled={t.step === 0} onClick={() => go(t.step - 1)}>
                BACK
              </button>
              {showNext && (
                <button className="btn red" data-ui="tour-next" onClick={() => go(t.step + 1)}>
                  {t.step + 1 >= TOUR.length ? 'DONE' : 'NEXT'}
                </button>
              )}
              <button className="btn" data-ui="tour-skip-step" onClick={() => go(t.step + 1)}>
                SKIP STEP
              </button>
              <button
                className="btn"
                data-ui="tour-end"
                onClick={() => {
                  uiSound(audio, 'click');
                  finishTour();
                }}
              >
                END TOUR
              </button>
            </span>
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      <div ref={measureRef} className="paged-measure" aria-hidden="true">
        {BOX_WIDTHS.map((w) => (
          <div key={w}>{content(Math.min(w, v.zones.world.w - 8), false)}</div>
        ))}
      </div>
      {place && (
        <div ref={boxRef} className="zone tour-place" data-ui="tour-place" data-side={place.side} style={{ left: place.x, top: place.y, width: place.w, zIndex: 41 }}>
          {content(place.w, true)}
          {pointer && <span className="tour-pointer" aria-hidden="true" style={{ position: 'absolute', width: 0, height: 0, borderStyle: 'solid', ...pointer }} />}
        </div>
      )}
    </>
  );
}

/** The ui store, for components that only need the open modal. */
export const useModal = (): ModalState | null => useStore(ui, (s) => s.modal);
