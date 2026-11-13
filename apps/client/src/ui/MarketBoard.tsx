// The market board, over the town square, as one modal with tabs. BOARD: today's prices by grade,
// how much the whole street has sold against what it needs (a glut sinks tomorrow's price, scarcity
// lifts it) and the Feathers left. FARMS: the farms ranked, bust ones with their hens at auction.
// ORDERS: sell into a buyer's order, buy a neighbour's eggs, or post your own price. TRADES: recent
// big trades and the cast, each agent with its latest public reason. Every AI farm and agent wears
// the AI tag. Every list is paged to fit (never a scrollbar).
import { useEffect, useState } from 'react';
import { EGG_GRADES, type EggGrade, type FarmState, type MarketState } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import type { Action } from '../net/socket';
import { uiEvents, type MarketTab } from '../state/ui';
import { useViewport } from '../app/Stage';
import { LOOK } from './cast';
import { AiBadge } from './AiBadge';
import { SplitFlap } from './Hud';
import { SheetSprite } from './SheetSprite';
import { Modal } from './Modal';
import { Paged } from './Paged';

const coins = (milli: number): string => (milli / 1000).toFixed(2);

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

export function MarketBoard({
  farm,
  market,
  send,
  tab,
  onTab,
  onFeathers,
  onClose,
}: {
  farm: FarmState;
  market: MarketState;
  onFeathers: () => void;
  send: (a: Action) => Promise<boolean>;
  tab: MarketTab;
  onTab: (t: MarketTab) => void;
  onClose: () => void;
}) {
  const { audio } = useServices();
  const v = useViewport();
  const [grade, setGrade] = useState<EggGrade>('brown');
  const [qty, setQty] = useState(5);
  const [price, setPrice] = useState(() => market.pricesMilli.brown);
  const prev = market.history.at(-1)?.multiplier ?? market.multiplier;
  const up = market.multiplier >= prev;
  const click = (fn: () => void) => () => {
    uiSound(audio, 'click');
    fn();
  };
  useEffect(() => setPrice(market.pricesMilli[grade]), [grade, market.pricesMilli]);
  const buys = market.book.filter((o) => o.side === 'buy');
  const sells = market.book.filter((o) => o.side === 'sell' && !o.mine);
  const mine = farm.orders;
  const share = market.reference ? Math.min(2, market.supplyToday / market.reference) : 0;

  return (
    <Modal title={`MARKET BOARD, DAY ${market.day}`} onClose={onClose} w={488} h={300}>
      <div className="tabs">
        {(['board', 'farms', 'orders', 'trades'] as const).map((t) => (
          <button
            key={t}
            className={`btn ${tab === t ? 'red' : ''}`}
            data-tour={`market-${t}`}
            onClick={click(() => {
              onTab(t);
              uiEvents.emit({ kind: 'tab', modal: 'market', tab: t });
            })}
          >
            {t.toUpperCase()}
          </button>
        ))}
      </div>
      {tab === 'board' && (
        <Paged
          gap={4}
          ui="board"
          style={{ maxWidth: 320 }}
          items={[
            <div key="prices" className="col" style={{ gap: 4 }}>
              <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
                TODAY&apos;S PRICE, ONE EGG
              </span>
              {EGG_GRADES.map((g) => (
                <div key={g} className="row spread" data-tour={g === 'white' ? 'prices' : undefined}>
                  <span>{g.toUpperCase()}</span>
                  <span className="row" style={{ gap: 3 }}>
                    <SplitFlap text={coins(market.pricesMilli[g]).padStart(5, '0')} />
                    <span className={up ? 'up' : 'down'}>{up ? '^' : 'v'}</span>
                  </span>
                </div>
              ))}
              <span>PRICES AT {Math.round(market.multiplier * 100)}% OF NORMAL</span>
            </div>,
            <button
              key="supply"
              className="col"
              data-tour="supply"
              style={{ gap: 3, border: 0, padding: 4, background: '#e3cc96', font: 'inherit', textAlign: 'left', color: 'inherit', cursor: 'inherit' }}
              onClick={() => uiEvents.emit({ kind: 'tapped', what: 'supply' })}
            >
              <span>
                STREET SOLD {market.supplyToday} OF {market.reference} IT NEEDS
              </span>
              <span style={{ position: 'relative', height: 6, background: '#f6e7c1', boxShadow: '0 0 0 1px #2a160c', display: 'block' }}>
                <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.round((share / 2) * 100)}%`, background: share > 1 ? '#b8321f' : '#5c9e3a' }} />
                <span style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: '#2a160c' }} />
              </span>
              <span style={{ lineHeight: '10px', color: '#7f2215' }}>
                {share > 1 ? 'TOO MANY EGGS: A GLUT. PRICES FALL TOMORROW.' : 'EGGS ARE SCARCE: PRICES RISE TOMORROW.'} PAST THE LINE IS A GLUT.
              </span>
            </button>,
            <button
              key="feathers"
              className="col"
              style={{ gap: 2, border: 0, padding: 0, background: 'transparent', font: 'inherit', textAlign: 'left', color: 'inherit', cursor: 'pointer' }}
              data-ui="feathers-left"
              onClick={onFeathers}
            >
              <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
                THE FEATHER MINT (BETA)
              </span>
              <span>
                {market.feathers.left} OF {market.feathers.max} LEFT TO MINT
              </span>
              <span style={{ lineHeight: '10px', color: '#8b5a2b' }}>
                {market.feathers.minted} MINTED ON NEAR TESTNET{market.feathers.tickets ? `, ${market.feathers.tickets} TICKET${market.feathers.tickets === 1 ? '' : 'S'} WAITING` : ''}. TICKETS ARE WON AT MILESTONES.
              </span>
              <span style={{ color: '#2f6f9e' }} data-ui="board-mint-link">
                OPEN THE MINT
              </span>
            </button>,
          ]}
        />
      )}
      {tab === 'farms' && (
        <div className="col" style={{ gap: 2 }}>
          <button
            className="col"
            data-tour="farms"
            style={{ gap: 2, border: 0, padding: 0, background: 'transparent', font: 'inherit', textAlign: 'left', color: 'inherit', cursor: 'inherit' }}
            onClick={() => uiEvents.emit({ kind: 'tapped', what: 'farms' })}
          >
            <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
              FARMS ON THE STREET
            </span>
            <span className="row" style={{ gap: 10, alignItems: 'flex-end' }} data-ui="rival-signs">
              {rivalSigns(market).map((r) => (
                <span key={r.sign} className="col" style={{ alignItems: 'center', gap: 2 }} title={r.name}>
                  <SheetSprite id={r.sign} row={r.bust ? 'tip-over' : 'sway'} play={r.bust ? 'once' : 'loop'} size={v.p} box={{ w: 52, h: 36 }} />
                  <span style={{ color: r.bust ? '#b8321f' : '#2a160c' }}>{r.bust ? 'BUST' : 'TRADING'}</span>
                </span>
              ))}
            </span>
            <span style={{ lineHeight: '10px', color: '#8b5a2b' }}>A FARM THAT RUNS OUT OF COINS GOES BUST. ITS HENS GO TO AUCTION IN THE SHOP.</span>
          </button>
          <Paged
            gap={2}
            ui="ranking"
            items={market.ranking.map((r, i) => (
              <span key={`${r.name}-${i}`} className="row spread" style={{ opacity: r.bust ? 0.6 : 1, width: '100%', gap: 6, alignItems: 'flex-start' }}>
                <span style={{ flex: 1, minWidth: 0, lineHeight: '9px' }}>
                  {i + 1}. {r.name.toUpperCase()}
                  {r.kind !== 'player' && <AiBadge />}
                </span>
                <span style={{ flex: 'none' }}>{r.bust ? 'BUST' : `${r.hens} HENS`}</span>
              </span>
            ))}
          />
        </div>
      )}
      {tab === 'orders' && (
        <div className="col" style={{ gap: 4 }}>
          {buys.length + sells.length + mine.length === 0 ? (
            <span>NO OPEN ORDERS</span>
          ) : (
            <Paged
              gap={2}
              ui="order-book"
              items={[
                ...buys.slice(0, 6).map((o) => (
                  <div key={o.id} className="row spread">
                    <span>
                      {o.owner.split(' ').slice(-1)[0]?.toUpperCase()}
                      {o.ownerKind === 'agent' && <AiBadge />} BUYS {o.qty} {o.grade.toUpperCase()} AT {coins(o.priceMilli)}
                    </span>
                    <button className="btn" disabled={farm.crate[o.grade] <= 0} onClick={click(() => void send({ t: 'fillOrder', orderId: o.id, qty: Math.min(o.qty, farm.crate[o.grade]) }))}>
                      SELL
                    </button>
                  </div>
                )),
                ...sells.slice(0, 4).map((o) => (
                  <div key={o.id} className="row spread">
                    <span>
                      {o.owner.split(' ')[0]?.toUpperCase()}
                      {o.ownerKind === 'agent' && <AiBadge />} SELLS {o.qty} {o.grade.toUpperCase()} AT {coins(o.priceMilli)}
                    </span>
                    <button className="btn sky" disabled={farm.cashMilli < o.priceMilli} onClick={click(() => void send({ t: 'fillOrder', orderId: o.id, qty: Math.min(o.qty, Math.floor(farm.cashMilli / o.priceMilli)) }))}>
                      BUY
                    </button>
                  </div>
                )),
                ...mine.map((o) => (
                  <div key={o.id} className="row spread">
                    <span style={{ color: '#2f6f9e' }}>
                      YOU SELL {o.qty} {o.grade.toUpperCase()} AT {coins(o.priceMilli)}
                    </span>
                    <button className="btn" onClick={click(() => void send({ t: 'cancelOrder', orderId: o.id }))}>
                      X
                    </button>
                  </div>
                )),
              ]}
            />
          )}
          <div className="col" style={{ gap: 3, borderTop: '1px solid #8b5a2b', paddingTop: 4 }}>
            <span>POST A SELL ORDER AT YOUR PRICE</span>
            <div className="row" style={{ gap: 2 }}>
              {EGG_GRADES.map((g) => (
                <button key={g} className={`chip ${g === grade ? 'on' : ''}`} style={{ border: 0, font: 'inherit' }} onClick={() => setGrade(g)}>
                  {g.slice(0, 3).toUpperCase()} {farm.crate[g]}
                </button>
              ))}
            </div>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn" onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Fewer eggs">
                -
              </button>
              <span>{qty} EGGS</span>
              <button className="btn" onClick={() => setQty(qty + 1)} aria-label="More eggs">
                +
              </button>
              <button className="btn" onClick={() => setPrice(Math.max(10, price - Math.round(market.pricesMilli[grade] * 0.05)))} aria-label="Lower price">
                -
              </button>
              <span>{coins(price)}</span>
              <button className="btn" onClick={() => setPrice(price + Math.round(market.pricesMilli[grade] * 0.05))} aria-label="Higher price">
                +
              </button>
              <button className="btn red" disabled={farm.crate[grade] < qty} onClick={click(() => void send({ t: 'placeOrder', grade, qty, price: price / 1000 }))}>
                POST {qty} AT {coins(price)}
              </button>
            </div>
          </div>
        </div>
      )}
      {tab === 'trades' && (
        <Paged
          gap={2}
          ui="trades"
          items={[
            <span key="big" className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
              BIG TRADES
            </span>,
            ...(market.trades.length === 0 ? [<span key="quiet">QUIET SO FAR</span>] : []),
            ...market.trades.slice(0, 12).map((t, i) => (
              <span key={`t${i}`}>
                {t.seller.split(' ')[0]?.toUpperCase()}
                {t.sellerAi && <AiBadge />} {t.qty} {t.grade.toUpperCase()} TO {t.buyer.split(' ').slice(-1)[0]?.toUpperCase()}
                {t.buyerAi && <AiBadge />} {coins(t.totalMilli)}
              </span>
            )),
            <span key="cast" className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0, paddingTop: 4 }}>
              THE CAST
            </span>,
            ...market.agents.map((a) => (
              <div key={a.id} className="col" style={{ opacity: a.status === 'bust' ? 0.5 : 1, gap: 1 }} data-ui="cast-agent">
                <div className="row spread" style={{ gap: 6 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {a.name.toUpperCase()}
                    <AiBadge />
                  </span>
                  <span style={{ flex: 'none' }}>{a.status === 'bust' ? 'BUST' : coins(a.cashMilli)}</span>
                </div>
                {/* its latest public reason: under 80 characters, wrapping inside the row */}
                {a.reason && (
                  <span style={{ lineHeight: '9px', color: '#8b5a2b', overflowWrap: 'anywhere' }} data-ui="cast-reason">
                    {a.reason.toUpperCase()}
                  </span>
                )}
              </div>
            )),
          ]}
        />
      )}
    </Modal>
  );
}
