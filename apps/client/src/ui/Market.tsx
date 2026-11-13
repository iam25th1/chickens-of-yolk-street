// The Market: a page of its own over the town square (on a phone the farm stays behind it), under
// the top bar, with tabs. PRICES: today's price per grade, the street's sales against what it needs
// (a glut sinks tomorrow's price, scarcity lifts it), the last closed days on a chart, and what each
// AI trader last said. SELL: sell from the crate at today's price, or post an order at your own
// price. BUY ORDERS: what the AI buyers want, each filled from the crate in one tap. YOUR ORDERS:
// your open orders, with cancel. TRADE: other farms' offers to buy, and your own offers as everyone
// sees them. HEN AUCTION: hens from bust farms. FARMS: the street's farms ranked, with their signs and best badges; a farm opens its public profile.
// Every tab opens with one plain line; every list is paged to fit the window (never a scrollbar).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ECONOMY, EGG_GRADES, MARKET_CHART_DAYS, coopCapacity, eggPrice, saleValue, type EggGrade, type FarmState, type MarketChartDay, type MarketState, type OrderView } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { useViewport } from '../app/Stage';
import { motion } from '../motion/ui';
import type { Action } from '../net/socket';
import { useStore } from '../state/store';
import { uiEvents, type MarketTab } from '../state/ui';
import { AiBadge } from './AiBadge';
import { BadgeRow } from './Badge';
import { LOOK } from './cast';
import { toasts, uiFx } from './FxLayer';
import { SplitFlap } from './Hud';
import { Paged } from './Paged';
import { HenArt } from './Panels';
import { openPublicProfile } from './PublicProfile';
import { SheetSprite } from './SheetSprite';

type Send = (a: Action) => Promise<boolean>;

const coins = (milli: number): string => (milli / 1000).toFixed(2);
const GRADE: Record<EggGrade, string> = { white: 'WHITE', cream: 'CREAM', brown: 'BROWN', golden: 'GOLDEN' };
const ROLE = { rival: 'RIVAL FARM', supplier: 'FEED SUPPLIER', buyer: 'BUYER' } as const;
/** The widest the page grows (UI pixels): on a big window the town square shows round it. */
const MAX_W = 760;

/** The tabs, each with its one plain line. */
export const MARKET_TABS: { id: MarketTab; label: string; line: string }[] = [
  { id: 'prices', label: 'PRICES', line: "ONE PRICE FOR EVERY FARM. TODAY'S PRICE COMES FROM YESTERDAY'S SALES AGAINST WHAT THE STREET NEEDED." },
  { id: 'sell', label: 'SELL', line: "SELL FROM YOUR CRATE AT TODAY'S PRICE NOW, OR POST YOUR OWN PRICE AND WAIT FOR A BUYER." },
  { id: 'buyers', label: 'BUY ORDERS', line: 'WHAT THE AI BUYERS WANT TODAY. SELL STRAIGHT FROM YOUR CRATE AT THEIR PRICE.' },
  { id: 'mine', label: 'YOUR ORDERS', line: 'YOUR EGGS WAITING FOR A BUYER AT YOUR PRICE. CANCEL ONE TO PUT ITS EGGS BACK IN YOUR CRATE.' },
  { id: 'trade', label: 'TRADE', line: 'EGGS OTHER FARMS OFFER AT THEIR OWN PRICE, AND THE OFFERS YOU HAVE OUT FOR EVERYONE TO SEE.' },
  { id: 'auction', label: 'HEN AUCTION', line: "HENS FROM FARMS THAT WENT BUST, AT HALF THE BREEDER'S PRICE. EACH ONE IS ONE OF A KIND." },
  { id: 'farms', label: 'FARMS', line: 'EVERY FARM ON THE STREET, RICHEST FIRST. TAP A FARM FOR ITS PUBLIC PROFILE AND BADGES.' },
];

/** A price against today's street price for its grade, in words. */
function vsToday(priceMilli: number, grade: EggGrade, market: MarketState): string {
  const live = market.pricesMilli[grade];
  const d = live > 0 ? Math.round((priceMilli / live - 1) * 100) : 0;
  return d === 0 ? "AT TODAY'S PRICE" : d > 0 ? `${d}% OVER TODAY'S PRICE` : `${-d}% UNDER TODAY'S PRICE`;
}

/** One sign per rival farm: the open farm when there is one, else the last that went bust. */
function rivalSigns(market: MarketState): { sign: string; name: string; bust: boolean }[] {
  const byKind = new Map<string, { sign: string; name: string; bust: boolean }>();
  for (const r of market.ranking) {
    if (r.kind === 'player') continue;
    const sign = LOOK[r.kind].sign;
    if (!sign) continue;
    const have = byKind.get(r.kind);
    if (!have || (have.bust && !r.bust)) byKind.set(r.kind, { sign, name: r.name, bust: r.bust });
  }
  return [...byKind.values()];
}

function H3({ children }: { children: ReactNode }) {
  return (
    <h3 className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
      {children}
    </h3>
  );
}

/** A column of the page: an optional heading, then content that takes the height left. */
function Column({ title, width, children, ui }: { title?: string; width?: number; children: ReactNode; ui?: string }) {
  return (
    <div className="col" data-ui={ui} style={{ gap: 4, minHeight: 0, minWidth: 0, ...(width ? { width, flex: 'none' } : { flex: 1 }) }}>
      {title && <H3>{title}</H3>}
      {children}
    </div>
  );
}

/** A row of a list: what it is (wrapping), and its button on the right. */
function OrderRow({ order, main, sub, button, ui }: { order: string; main: ReactNode; sub: ReactNode; button: ReactNode; ui: string }) {
  return (
    <div className="row" data-ui={ui} data-order={order} style={{ gap: 6, alignItems: 'center', width: '100%' }}>
      <span className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ lineHeight: '9px', overflowWrap: 'anywhere' }}>{main}</span>
        <span style={{ lineHeight: '9px', color: '#8b5a2b' }}>{sub}</span>
      </span>
      {button}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <span style={{ lineHeight: '10px' }}>{children}</span>;
}

export function MarketPage({ farm, market, send, tab, onTab, onClose }: { farm: FarmState; market: MarketState; send: Send; tab: MarketTab; onTab: (t: MarketTab) => void; onClose: () => void }) {
  const { audio } = useServices();
  const v = useViewport();
  const news = useStore(toasts, (s) => s.list.at(-1) ?? null);
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-ui="market-page"]');
    if (el) motion.enter(el);
  }, []);
  // Escape leaves, as from a modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const top = v.zones.top.h + 4;
  const width = Math.min(v.uiW - 8, MAX_W);
  const left = Math.round((v.uiW - width) / 2);
  const wide = !v.portrait;
  const side = Math.min(280, Math.floor((width - 22) * 0.48));
  const line = (MARKET_TABS.find((t) => t.id === tab) ?? MARKET_TABS[0])?.line ?? '';
  const props: TabProps = { farm, market, send, wide, side, onTab };
  return (
    <div
      className="panel"
      role="dialog"
      aria-label="Market"
      data-ui="market-page"
      data-tab={tab}
      style={{ left, top, width, height: v.uiH - top - 4, zIndex: 30, display: 'flex', flexDirection: 'column', gap: 4, boxSizing: 'border-box', padding: 7 }}
    >
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <h2 className="panel-title" style={{ margin: 0 }}>
          MARKET
        </h2>
        <span style={{ flex: 'none' }}>DAY {market.day}</span>
        {/* the newest news (a sale, a fill, a refusal): the toast zone is under the page */}
        <span style={{ flex: 1, minWidth: 0, lineHeight: '9px', color: news?.tone === 'bad' ? '#b8321f' : '#2f6f9e' }} data-ui="market-news" role="status">
          {news?.text ?? ''}
        </span>
        <button
          className="btn"
          data-ui="market-close"
          data-tour="close"
          onClick={() => {
            uiSound(audio, 'back');
            onClose();
          }}
        >
          BACK TO THE FARM
        </button>
      </div>
      <div className="tabs" style={{ flexWrap: 'wrap', margin: 0, rowGap: 6 }} data-ui="market-tabs">
        {MARKET_TABS.map((t) => (
          <button
            key={t.id}
            className={`btn ${tab === t.id ? 'red' : ''}`}
            data-tour={`market-${t.id}`}
            data-ui="market-tab"
            aria-pressed={tab === t.id}
            onMouseEnter={() => uiSound(audio, 'hover')}
            onClick={() => {
              uiSound(audio, 'click');
              onTab(t.id);
              uiEvents.emit({ kind: 'tab', modal: 'market', tab: t.id });
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="meaning" data-ui="market-line">
        {line}
      </p>
      <div key={tab} data-ui={`market-${tab}-tab`} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: wide ? 'row' : 'column', gap: wide ? 10 : 6 }}>
        {tab === 'prices' && <PricesTab {...props} />}
        {tab === 'sell' && <SellTab {...props} />}
        {tab === 'buyers' && <BuyOrdersTab {...props} />}
        {tab === 'mine' && <YourOrdersTab {...props} />}
        {tab === 'trade' && <TradeTab {...props} />}
        {tab === 'auction' && <AuctionTab {...props} />}
        {tab === 'farms' && <FarmsTab {...props} />}
      </div>
    </div>
  );
}

interface TabProps {
  farm: FarmState;
  market: MarketState;
  send: Send;
  /** A landscape window: two columns side by side; a portrait one: one column. */
  wide: boolean;
  /** The left column's width on a wide window. */
  side: number;
  onTab: (t: MarketTab) => void;
}

/** A button's click: the click sound, then the action. */
function useClick() {
  const { audio } = useServices();
  return (fn: () => void) => () => {
    uiSound(audio, 'click');
    fn();
  };
}

// ---- PRICES ---------------------------------------------------------------------------------------

type ChartView = 'level' | EggGrade;

/**
 * The last closed days as bars (one egg of a grade, or the price level), the normal price as a line.
 * (A paged list draws its items twice, once to measure them: the view is kept by the tab, so both agree.)
 */
function PriceChart({ days, view, onView }: { days: MarketChartDay[]; view: ChartView; onView: (v: ChartView) => void }) {
  const click = useClick();
  const value = (d: MarketChartDay) => (view === 'level' ? d.multiplier : d.pricesMilli[view] / 1000);
  const normal = view === 'level' ? 1 : ECONOMY.eggs.basePrice[view];
  const fmt = (x: number) => (view === 'level' ? `${Math.round(x * 100)}%` : x.toFixed(2));
  const H = 44;
  // a little room over the highest bar
  const max = Math.max(normal * 1.5, ...days.map(value)) * 1.1;
  const at = (x: number) => Math.max(1, Math.round((x / max) * H));
  const values = days.map(value);
  // the closed days shown: up to MARKET_CHART_DAYS
  const span = days.length || MARKET_CHART_DAYS;
  return (
    <div className="col" style={{ gap: 3 }} data-ui="market-chart">
      <H3>{view === 'level' ? `PRICE LEVEL, THE LAST ${span} DAYS` : `ONE ${GRADE[view]} EGG, THE LAST ${span} DAYS`}</H3>
      <div className="row" style={{ gap: 3, flexWrap: 'wrap' }} data-ui="chart-views">
        {(['level', ...EGG_GRADES] as const).map((g) => (
          <button key={g} className={`chip ${g === view ? 'on' : ''}`} style={{ border: 0, font: 'inherit' }} onClick={click(() => onView(g))}>
            {g === 'level' ? 'LEVEL' : GRADE[g]}
          </button>
        ))}
      </div>
      {days.length === 0 ? (
        <Empty>NO MARKET DAY HAS CLOSED YET. THE CHART FILLS AS DAYS CLOSE.</Empty>
      ) : (
        <>
          <div
            style={{ position: 'relative', height: H, display: 'flex', alignItems: 'flex-end', gap: 2, padding: '0 2px', background: '#f6e7c1', boxShadow: '0 0 0 1px #2a160c' }}
            data-ui="chart-bars"
          >
            {days.map((d) => (
              <span
                key={d.day}
                data-day={d.day}
                title={`DAY ${d.day}: ${fmt(value(d))}`}
                style={{ flex: 1, height: at(value(d)), background: d.multiplier <= ECONOMY.market.crashAt ? '#7f2215' : d.multiplier < 1 ? '#b8321f' : '#5c9e3a' }}
              />
            ))}
            {/* a normal price */}
            <span style={{ position: 'absolute', left: 0, right: 0, bottom: at(normal), height: 1, background: '#2a160c', opacity: 0.6 }} />
          </div>
          {/* each day's sales against what the street needed: red a glut, green scarce */}
          <div style={{ display: 'flex', gap: 2, padding: '0 2px', height: 3 }} data-ui="chart-gluts">
            {days.map((d) => (
              <span
                key={d.day}
                title={d.demand === null ? `DAY ${d.day}: SOLD ${d.supply}` : `DAY ${d.day}: SOLD ${d.supply} OF ${d.demand} NEEDED`}
                style={{ flex: 1, background: d.demand === null ? '#b8743a' : d.supply > d.demand ? '#b8321f' : '#5c9e3a' }}
              />
            ))}
          </div>
          <div className="row spread" style={{ gap: 6 }}>
            <span>DAY {days[0]?.day}</span>
            <span>
              HIGH {fmt(Math.max(...values))} LOW {fmt(Math.min(...values))}
            </span>
            <span>DAY {days.at(-1)?.day}</span>
          </div>
          <span style={{ lineHeight: '9px', color: '#8b5a2b' }}>THE LINE IS A NORMAL PRICE; RED BARS ARE UNDER IT. UNDER THE BARS: RED, A GLUT THAT DAY; GREEN, SCARCE.</span>
        </>
      )}
    </div>
  );
}

function PricesTab({ market, wide, side }: TabProps) {
  const [view, setView] = useState<ChartView>('level');
  const prev = market.history.at(-1)?.multiplier ?? market.multiplier;
  const up = market.multiplier >= prev;
  const share = market.reference ? Math.min(2, market.supplyToday / market.reference) : 0;
  const prices = (
    <div key="prices" className="col" style={{ gap: 4 }} data-ui="market-prices-today">
      <H3>TODAY&apos;S PRICE, ONE EGG</H3>
      {EGG_GRADES.map((g) => (
        <div key={g} className="row spread" data-tour={g === 'white' ? 'prices' : undefined}>
          <span>{GRADE[g]}</span>
          <span className="row" style={{ gap: 3 }}>
            <SplitFlap text={coins(market.pricesMilli[g]).padStart(5, '0')} />
            <span className={up ? 'up' : 'down'}>{up ? '^' : 'v'}</span>
          </span>
        </div>
      ))}
      <span>
        PRICES AT {Math.round(market.multiplier * 100)}% OF NORMAL{market.crash ? ': A CRASH' : ''}
      </span>
    </div>
  );
  const meter = (
    <button
      key="supply"
      className="col"
      data-tour="supply"
      data-ui="market-supply"
      style={{ gap: 3, border: 0, padding: 4, background: '#e3cc96', font: 'inherit', textAlign: 'left', color: 'inherit', cursor: 'inherit' }}
      onClick={() => uiEvents.emit({ kind: 'tapped', what: 'supply' })}
    >
      <span>
        TODAY THE STREET SOLD {market.supplyToday} OF THE {market.reference} IT NEEDS
      </span>
      <span style={{ position: 'relative', height: 6, background: '#f6e7c1', boxShadow: '0 0 0 1px #2a160c', display: 'block' }}>
        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.round((share / 2) * 100)}%`, background: share > 1 ? '#b8321f' : '#5c9e3a' }} />
        <span style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: '#2a160c' }} />
      </span>
      <span style={{ lineHeight: '10px', color: '#7f2215' }}>{share > 1 ? 'TOO MANY EGGS: A GLUT. PRICES FALL TOMORROW.' : 'EGGS ARE SCARCE: PRICES RISE TOMORROW.'} PAST THE LINE IS A GLUT.</span>
    </button>
  );
  const chart = <PriceChart key="chart" days={market.chart} view={view} onView={setView} />;
  const cast = market.agents.map((a) => (
    <div key={a.id} className="col" style={{ opacity: a.status === 'bust' ? 0.5 : 1, gap: 2 }} data-ui="cast-agent">
      <div className="row spread" style={{ gap: 6, alignItems: 'flex-start' }}>
        <span style={{ flex: 1, minWidth: 0, lineHeight: '9px' }}>
          {a.name.toUpperCase()}
          <AiBadge />
        </span>
        <span style={{ flex: 'none' }}>{a.status === 'bust' ? 'BUST' : ROLE[a.role]}</span>
      </div>
      {/* its latest public reason: under 80 characters, wrapping inside the row */}
      <span style={{ lineHeight: '9px', color: '#8b5a2b', overflowWrap: 'anywhere' }} data-ui="cast-reason">
        {a.reason ? a.reason.toUpperCase() : 'NOTHING SAID YET. EACH SPEAKS WHEN A DAY CLOSES.'}
      </span>
    </div>
  ));
  const trades = [
    <H3 key="big">BIG TRADES</H3>,
    ...(market.trades.length === 0 ? [<Empty key="quiet">QUIET SO FAR.</Empty>] : []),
    ...market.trades.slice(0, 12).map((t, i) => (
      <span key={`t${i}`} style={{ lineHeight: '9px' }}>
        {t.seller.toUpperCase()}
        {t.sellerAi && <AiBadge />} SOLD {t.qty} {GRADE[t.grade]} TO {t.buyer.toUpperCase()}
        {t.buyerAi && <AiBadge />} FOR {coins(t.totalMilli)}
      </span>
    )),
  ];
  if (!wide) {
    return <Paged fill gap={6} ui="market-prices-info" items={[prices, meter, chart, <H3 key="cast">WHAT THE AI TRADERS SAY</H3>, ...cast, ...trades]} />;
  }
  return (
    <>
      <Column width={side}>
        <Paged fill gap={6} ui="market-prices-info" items={[prices, meter, chart]} />
      </Column>
      <Column title="WHAT THE AI TRADERS SAY">
        <Paged fill gap={5} ui="market-cast" items={[...cast, ...trades]} />
      </Column>
    </>
  );
}

// ---- SELL -----------------------------------------------------------------------------------------

function SellTab({ farm, market, send, wide, side }: TabProps) {
  const click = useClick();
  const [busy, setBusy] = useState(false);
  const total = EGG_GRADES.reduce((s, g) => s + farm.crate[g], 0);
  const sell = (items: Partial<Record<EggGrade, number>>) =>
    click(() => {
      setBusy(true);
      void send({ t: 'sell', items }).finally(() => setBusy(false));
    });
  const now = [
    ...EGG_GRADES.map((g) => (
      <div key={g} className="row spread" style={{ gap: 6 }} data-ui="sell-row">
        <span style={{ flex: 1 }}>
          {farm.crate[g]} {GRADE[g]}
        </span>
        <span style={{ flex: 'none' }}>{eggPrice(g, market.multiplier, farm.unlocks).toFixed(2)} EACH</span>
        <button className="btn" data-ui={`sell-${g}`} style={{ minWidth: 56 }} disabled={busy || farm.crate[g] <= 0} onClick={sell({ [g]: farm.crate[g] })}>
          SELL {farm.crate[g]}
        </button>
      </div>
    )),
    <div key="all" className="row spread" style={{ gap: 6, borderTop: '1px solid #8b5a2b', paddingTop: 4 }}>
      <span style={{ flex: 1, lineHeight: '9px' }}>
        THE WHOLE CRATE: {total} EGGS FOR {saleValue(farm.crate, market.multiplier, farm.unlocks).toFixed(2)}
      </span>
      <button className="btn red" data-ui="sell-crate" disabled={busy || total === 0} onClick={sell({ ...farm.crate })}>
        SELL ALL
      </button>
    </div>,
    ...(farm.unlocks.includes('grader')
      ? [
          <span key="grader" style={{ color: '#2f6f9e', lineHeight: '9px' }}>
            THE GRADER ADDS +10% TO EVERY EGG (IN THE PRICES SHOWN).
          </span>,
        ]
      : []),
    ...(farm.unlocks.includes('clerk')
      ? [
          <span key="clerk" style={{ color: '#2f6f9e', lineHeight: '9px' }}>
            THE SALES CLERK ADDS +5% TO THE TOTAL.
          </span>,
        ]
      : []),
  ];
  const form = usePostForm(farm, market);
  const post = <PostOrder key="post" farm={farm} market={market} send={send} form={form} />;
  if (!wide) return <Paged fill gap={5} ui="market-sell" items={[<H3 key="now-title">SELL NOW AT TODAY&apos;S PRICE</H3>, ...now, <H3 key="post-title">OR POST YOUR OWN PRICE</H3>, post]} />;
  return (
    <>
      <Column width={side + 30} title="SELL NOW AT TODAY'S PRICE">
        <Paged fill gap={5} ui="market-sell-now" items={now} />
      </Column>
      <Column title="OR POST YOUR OWN PRICE">
        <Paged fill gap={5} ui="market-post" items={[post]} />
      </Column>
    </>
  );
}

/** The sell order being made: its grade, how many, and its price in milli-coins. */
interface PostForm {
  grade: EggGrade;
  qty: number;
  price: number;
  setGrade: (g: EggGrade) => void;
  setQty: (n: number) => void;
  setPrice: (n: number) => void;
}

/** The order form's state, kept by the tab (a paged list draws its items twice, once to measure them). */
function usePostForm(farm: FarmState, market: MarketState): PostForm {
  const [grade, setGrade] = useState<EggGrade>(() => EGG_GRADES.find((g) => farm.crate[g] > 0) ?? 'brown');
  const live = market.pricesMilli[grade];
  const [qty, setQty] = useState(() => Math.max(1, Math.min(5, farm.crate[grade])));
  const [price, setPrice] = useState(live);
  // a new grade, or a new day's price, starts at today's price
  useEffect(() => setPrice(live), [grade, live]);
  // never more eggs than the crate has of the grade
  const have = farm.crate[grade];
  useEffect(() => setQty((q) => Math.max(1, Math.min(q, have || 1))), [have]);
  return { grade, qty, price, setGrade, setQty, setPrice };
}

/** A sell order at the player's price: grade, how many, the price (within the bounds the server allows), POST. */
function PostOrder({ farm, market, send, form }: { farm: FarmState; market: MarketState; send: Send; form: PostForm }) {
  const click = useClick();
  const { grade, qty, price, setGrade, setQty, setPrice } = form;
  const live = market.pricesMilli[grade];
  const have = farm.crate[grade];
  // the server takes prices from a fifth to five times today's (a milli-coin inside, for rounding)
  const lo = Math.ceil(live * ECONOMY.orders.minPriceShare) + 1;
  const hi = Math.floor(live * ECONOMY.orders.maxPriceShare) - 1;
  const step = Math.max(10, Math.round(live * 0.05));
  const open = farm.orders.length;
  const full = open >= ECONOMY.orders.maxOpenPerFarm;
  return (
    <div className="col" style={{ gap: 5 }} data-ui="post-order-form">
      <div className="row" style={{ gap: 3, flexWrap: 'wrap' }}>
        {EGG_GRADES.map((g) => (
          <button key={g} className={`chip ${g === grade ? 'on' : ''}`} style={{ border: 0, font: 'inherit' }} data-ui="post-grade" onClick={click(() => setGrade(g))}>
            {GRADE[g]} {farm.crate[g]}
          </button>
        ))}
      </div>
      <div className="row" style={{ gap: 4 }}>
        <button className="btn" aria-label="Fewer eggs" onClick={click(() => setQty(Math.max(1, qty - 1)))}>
          -
        </button>
        <span style={{ minWidth: 52, textAlign: 'center' }}>{qty} EGGS</span>
        <button className="btn" aria-label="More eggs" onClick={click(() => setQty(Math.min(Math.max(1, have), qty + 1)))}>
          +
        </button>
      </div>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        <button className="btn" aria-label="Lower price" onClick={click(() => setPrice(Math.max(lo, price - step)))}>
          -
        </button>
        <span style={{ minWidth: 52, textAlign: 'center' }} data-ui="post-price">
          {coins(price)} EACH
        </span>
        <button className="btn" aria-label="Higher price" onClick={click(() => setPrice(Math.min(hi, price + step)))}>
          +
        </button>
        <span style={{ color: '#8b5a2b' }}>{vsToday(price, grade, market)}</span>
      </div>
      <button
        className="btn red"
        data-ui="post-order"
        style={{ alignSelf: 'flex-start' }}
        disabled={full || have < qty || have === 0}
        onClick={click(() => {
          const text = `ORDER POSTED: ${qty} ${GRADE[grade]} AT ${coins(price)} EACH`;
          void send({ t: 'placeOrder', grade, qty, price: price / 1000 }).then((ok) => ok && uiFx.emit({ kind: 'toast', text }));
        })}
      >
        POST {qty} {GRADE[grade]} AT {coins(price)}
      </button>
      <span style={{ lineHeight: '9px', color: '#8b5a2b' }}>
        THE EGGS LEAVE YOUR CRATE AND WAIT IN THE BOOK FOR A BUYER OR ANOTHER FARM, FOR UP TO {ECONOMY.orders.expireAfterDays} DAYS. {open} OF {ECONOMY.orders.maxOpenPerFarm} ORDERS OPEN.
      </span>
    </div>
  );
}

// ---- BUY ORDERS -----------------------------------------------------------------------------------

function BuyOrdersTab({ farm, market, send }: TabProps) {
  const click = useClick();
  const buys = market.book.filter((o) => o.side === 'buy');
  const rows = buys.map((o) => {
    const n = Math.min(o.qty, farm.crate[o.grade]);
    return (
      <OrderRow
        key={o.id}
        order={o.id}
        ui="buy-order"
        main={
          <>
            {o.owner.toUpperCase()}
            {o.ownerKind === 'agent' && <AiBadge />} WANTS {o.qty} {GRADE[o.grade]} AT {coins(o.priceMilli)} EACH
          </>
        }
        sub={`${vsToday(o.priceMilli, o.grade, market)}. YOU HAVE ${farm.crate[o.grade]}. OPEN TILL DAY ${o.expiresDay}.`}
        button={
          <button className="btn red" data-ui="fill-buy" disabled={n <= 0} onClick={click(() => void send({ t: 'fillOrder', orderId: o.id, qty: n }))}>
            {n > 0 ? `SELL ${n} FOR ${coins(n * o.priceMilli)}` : `NO ${GRADE[o.grade]}`}
          </button>
        }
      />
    );
  });
  return (
    <Column>{rows.length === 0 ? <Empty>NO BUYER WANTS EGGS RIGHT NOW. THE BUYERS POST NEW ORDERS WHEN A DAY CLOSES.</Empty> : <Paged fill gap={6} ui="market-buy-orders" items={rows} />}</Column>
  );
}

// ---- YOUR ORDERS ----------------------------------------------------------------------------------

function YourOrdersTab({ farm, market, send, onTab }: TabProps) {
  const click = useClick();
  const rows = farm.orders.map((o) => (
    <OrderRow
      key={o.id}
      order={o.id}
      ui="your-order"
      main={`YOU SELL ${o.qty} ${GRADE[o.grade]} AT ${coins(o.priceMilli)} EACH`}
      sub={`${vsToday(o.priceMilli, o.grade, market)}. OPEN TILL DAY ${o.expiresDay}.`}
      button={
        <button className="btn" data-ui="cancel-order" onClick={click(() => void send({ t: 'cancelOrder', orderId: o.id }))}>
          CANCEL
        </button>
      }
    />
  ));
  return (
    <Column title={`${farm.orders.length} OF ${ECONOMY.orders.maxOpenPerFarm} ORDERS OPEN`}>
      {rows.length === 0 ? (
        <div className="col" style={{ gap: 6, alignItems: 'flex-start' }}>
          <Empty>NO OPEN ORDERS. POST ONE AT YOUR OWN PRICE ON THE SELL TAB.</Empty>
          <button className="btn" data-ui="to-sell" onClick={click(() => onTab('sell'))}>
            GO TO SELL
          </button>
        </div>
      ) : (
        <Paged fill gap={6} ui="market-your-orders" items={rows} />
      )}
    </Column>
  );
}

// ---- TRADE ----------------------------------------------------------------------------------------

function TradeTab({ farm, market, send, wide, onTab }: TabProps) {
  const click = useClick();
  // the book is the same for everyone: the farm's own orders are the ones it lists as its own
  const mineIds = useMemo(() => new Set(farm.orders.map((o) => o.id)), [farm.orders]);
  const offers = market.book.filter((o) => o.side === 'sell' && !mineIds.has(o.id));
  const offerRows = offers.map((o) => {
    const n = Math.min(o.qty, Math.floor(farm.cashMilli / Math.max(1, o.priceMilli)));
    return (
      <OrderRow
        key={o.id}
        order={o.id}
        ui="trade-offer"
        main={
          <>
            {o.owner.toUpperCase()}
            {o.ownerKind === 'agent' && <AiBadge />} SELLS {o.qty} {GRADE[o.grade]} AT {coins(o.priceMilli)} EACH
          </>
        }
        sub={`${vsToday(o.priceMilli, o.grade, market)}. OPEN TILL DAY ${o.expiresDay}.`}
        button={
          <button className="btn sky" data-ui="buy-offer" disabled={n <= 0} onClick={click(() => void send({ t: 'fillOrder', orderId: o.id, qty: n }))}>
            {n > 0 ? `BUY ${n} FOR ${coins(n * o.priceMilli)}` : 'TOO DEAR'}
          </button>
        }
      />
    );
  });
  const own = (o: OrderView) => (
    <span key={o.id} style={{ lineHeight: '9px' }} data-ui="trade-mine">
      {farm.name.toUpperCase()} SELLS {o.qty} {GRADE[o.grade]} AT {coins(o.priceMilli)} EACH
    </span>
  );
  const ownRows = [
    ...farm.orders.map(own),
    <span key="note" style={{ lineHeight: '9px', color: '#8b5a2b' }}>
      {farm.orders.length ? 'OTHER FARMS AND THE AI BUYERS SEE THESE AND CAN BUY THEM.' : 'YOU HAVE NO OFFERS OUT. POST ONE AT YOUR OWN PRICE ON THE SELL TAB.'}
    </span>,
    <button key="manage" className="btn" style={{ alignSelf: 'flex-start' }} data-ui="to-your-orders" onClick={click(() => onTab(farm.orders.length ? 'mine' : 'sell'))}>
      {farm.orders.length ? 'YOUR ORDERS' : 'GO TO SELL'}
    </button>,
  ];
  const offerList = offerRows.length ? offerRows : [<Empty key="none">NO OTHER FARM IS OFFERING EGGS RIGHT NOW.</Empty>];
  if (!wide) return <Paged fill gap={6} ui="market-trade" items={[<H3 key="t1">OFFERS FROM OTHER FARMS</H3>, ...offerList, <H3 key="t2">YOUR OFFERS OUT</H3>, ...ownRows]} />;
  return (
    <>
      <Column title="OFFERS FROM OTHER FARMS">
        <Paged fill gap={6} ui="market-offers" items={offerList} />
      </Column>
      <Column title="YOUR OFFERS OUT" width={200}>
        <Paged fill gap={6} ui="market-my-offers" items={ownRows} />
      </Column>
    </>
  );
}

// ---- HEN AUCTION ----------------------------------------------------------------------------------

function AuctionTab({ farm, send }: TabProps) {
  const click = useClick();
  const hens = farm.shop.filter((h) => h.source === 'auction');
  const room = coopCapacity(farm.coops.map((c) => c.kind));
  const tiles = hens.map((h) => (
    <div
      key={h.id}
      className="col"
      data-ui="auction-hen"
      title={[h.body, h.eyes, h.comb, h.accessory].join(' ').toUpperCase()}
      style={{ width: 84, gap: 2, alignItems: 'center', background: '#e3cc96', padding: 2 }}
    >
      <HenArt hen={h} box={{ w: 40, h: 40 }} />
      <span>LAYS {Math.round(h.layingTrait * 100)}%</span>
      <span>{h.ageDays} DAYS OLD</span>
      <button className="btn red" data-ui="auction-buy" disabled={farm.cashMilli < h.priceMilli} onClick={click(() => void send({ t: 'buyHen', henId: h.id }))}>
        BUY {(h.priceMilli / 1000).toFixed(0)}
      </button>
    </div>
  ));
  return (
    <Column ui="auction-head" title={`${hens.length} HEN${hens.length === 1 ? '' : 'S'} AT AUCTION. YOUR COOPS: ${farm.hens.length} OF ${room} PLACES TAKEN.`}>
      {tiles.length === 0 ? <Empty>NO HENS AT AUCTION. WHEN A FARM GOES BUST, ITS HENS COME HERE.</Empty> : <Paged fill cell="auto" gap={4} ui="auction-grid" items={tiles} />}
    </Column>
  );
}

// ---- FARMS ----------------------------------------------------------------------------------------

function FarmsTab({ farm, market, wide, side }: TabProps) {
  const v = useViewport();
  const { audio } = useServices();
  const signs = (
    <button
      className="col"
      data-tour="farms"
      data-ui="market-signs"
      style={{ gap: 4, border: 0, padding: 0, background: 'transparent', font: 'inherit', textAlign: 'left', color: 'inherit', cursor: 'inherit', flex: 'none', width: wide ? side : undefined }}
      onClick={() => uiEvents.emit({ kind: 'tapped', what: 'farms' })}
    >
      <H3>THE AI FARMS&apos; SIGNS</H3>
      <span className="row" style={{ gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }} data-ui="rival-signs">
        {rivalSigns(market).map((r) => (
          <span key={r.sign} className="col" style={{ alignItems: 'center', gap: 2 }} title={r.name}>
            <SheetSprite id={r.sign} row={r.bust ? 'tip-over' : 'sway'} play={r.bust ? 'once' : 'loop'} size={v.p} box={{ w: 52, h: 36 }} />
            <span style={{ color: r.bust ? '#b8321f' : '#2a160c' }}>{r.bust ? 'BUST' : 'TRADING'}</span>
          </span>
        ))}
      </span>
      <span style={{ lineHeight: '10px', color: '#8b5a2b' }}>A FARM THAT RUNS OUT OF COINS GOES BUST. ITS SIGN FALLS AND ITS HENS GO TO THE HEN AUCTION.</span>
    </button>
  );
  // each farm opens its public profile; its best badges sit beside its name
  const rows = market.ranking.map((r, i) => (
    <button
      key={`${r.farmId}-${i}`}
      className="row spread"
      data-ui="ranking-row"
      data-farm={r.farmId}
      title={`${r.name}: public profile`}
      style={{ opacity: r.bust ? 0.6 : 1, width: '100%', gap: 6, alignItems: 'flex-start', border: 0, padding: 0, background: 'transparent', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer' }}
      onClick={() => {
        uiSound(audio, 'click');
        openPublicProfile(r.farmId, 'market');
      }}
    >
      <span style={{ flex: 1, minWidth: 0, lineHeight: '9px', color: r.name === farm.name ? '#2f6f9e' : undefined }}>
        {i + 1}. {r.name.toUpperCase()}
        {r.kind !== 'player' && <AiBadge />}
        {r.name === farm.name ? ' (YOU)' : ''}
      </span>
      <BadgeRow badges={r.badges} max={3} />
      <span style={{ flex: 'none' }}>{r.bust ? 'BUST' : `${r.hens} HENS, ${coins(r.cashMilli)}`}</span>
    </button>
  ));
  return (
    <>
      {signs}
      <Column title="FARMS ON THE STREET">
        <Paged fill gap={3} ui="ranking" items={rows} />
      </Column>
    </>
  );
}
