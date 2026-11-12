// The market board, over the town square, as one modal with tabs. BOARD: today's prices by grade,
// how much the whole street has sold against what it needs (a glut sinks tomorrow's price, scarcity
// lifts it), and the farms ranked, bust ones with their hens at auction. ORDERS: sell into a buyer's
// order, buy a neighbour's eggs, or post your own price. TRADES: recent big trades and the cast.
import { useEffect, useState } from 'react';
import { EGG_GRADES, type EggGrade, type FarmState, type MarketState } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import type { Action } from '../net/socket';
import { uiEvents, type MarketTab } from '../state/ui';
import { SplitFlap } from './Hud';
import { Modal } from './Modal';

const coins = (milli: number): string => (milli / 1000).toFixed(2);

export function MarketBoard({
  farm,
  market,
  send,
  tab,
  onTab,
  onClose,
}: {
  farm: FarmState;
  market: MarketState;
  send: (a: Action) => Promise<boolean>;
  tab: MarketTab;
  onTab: (t: MarketTab) => void;
  onClose: () => void;
}) {
  const { audio } = useServices();
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
        {(['board', 'orders', 'trades'] as const).map((t) => (
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
        <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
          <div className="col" style={{ width: 200, gap: 4, flex: 'none' }}>
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
            <button
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
            </button>
          </div>
          <button
            className="col"
            data-tour="farms"
            style={{ flex: 1, minWidth: 0, gap: 2, border: 0, padding: 0, background: 'transparent', font: 'inherit', textAlign: 'left', color: 'inherit', cursor: 'inherit' }}
            onClick={() => uiEvents.emit({ kind: 'tapped', what: 'farms' })}
          >
            <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
              FARMS ON THE STREET
            </span>
            {market.ranking.map((r, i) => (
              <span key={`${r.name}-${i}`} className="row spread" style={{ opacity: r.bust ? 0.6 : 1, width: '100%' }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {i + 1}. {r.name.toUpperCase()}
                </span>
                <span>{r.bust ? 'BUST' : `${r.hens} HENS`}</span>
              </span>
            ))}
            <span style={{ lineHeight: '10px', color: '#8b5a2b', marginTop: 4 }}>A FARM THAT RUNS OUT OF COINS GOES BUST. ITS HENS GO TO AUCTION IN THE SHOP.</span>
          </button>
        </div>
      )}
      {tab === 'orders' && (
        <div className="col" style={{ gap: 4 }}>
          <div className="col" style={{ gap: 2 }}>
            {buys.slice(0, 6).map((o) => (
              <div key={o.id} className="row spread">
                <span>
                  {o.owner.split(' ').slice(-1)[0]?.toUpperCase()} BUYS {o.qty} {o.grade.toUpperCase()} AT {coins(o.priceMilli)}
                </span>
                <button className="btn" disabled={farm.crate[o.grade] <= 0} onClick={click(() => void send({ t: 'fillOrder', orderId: o.id, qty: Math.min(o.qty, farm.crate[o.grade]) }))}>
                  SELL
                </button>
              </div>
            ))}
            {sells.slice(0, 4).map((o) => (
              <div key={o.id} className="row spread">
                <span>
                  {o.owner.split(' ')[0]?.toUpperCase()} SELLS {o.qty} {o.grade.toUpperCase()} AT {coins(o.priceMilli)}
                </span>
                <button className="btn sky" disabled={farm.cashMilli < o.priceMilli} onClick={click(() => void send({ t: 'fillOrder', orderId: o.id, qty: Math.min(o.qty, Math.floor(farm.cashMilli / o.priceMilli)) }))}>
                  BUY
                </button>
              </div>
            ))}
            {mine.map((o) => (
              <div key={o.id} className="row spread">
                <span style={{ color: '#2f6f9e' }}>
                  YOU SELL {o.qty} {o.grade.toUpperCase()} AT {coins(o.priceMilli)}
                </span>
                <button className="btn" onClick={click(() => void send({ t: 'cancelOrder', orderId: o.id }))}>
                  X
                </button>
              </div>
            ))}
            {buys.length + sells.length + mine.length === 0 && <span>NO OPEN ORDERS</span>}
          </div>
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
        <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
          <div className="col" style={{ flex: 1, gap: 2 }}>
            <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
              BIG TRADES
            </span>
            {market.trades.length === 0 && <span>QUIET SO FAR</span>}
            {market.trades.slice(0, 12).map((t, i) => (
              <span key={i}>
                {t.seller.split(' ')[0]?.toUpperCase()} {t.qty} {t.grade.toUpperCase()} TO {t.buyer.split(' ').slice(-1)[0]?.toUpperCase()} {coins(t.totalMilli)}
              </span>
            ))}
          </div>
          <div className="col" style={{ width: 190, gap: 2, flex: 'none' }}>
            <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
              THE CAST
            </span>
            {market.agents.map((a) => (
              <div key={a.id} className="row spread" style={{ opacity: a.status === 'bust' ? 0.5 : 1 }}>
                <span>{a.name.toUpperCase().slice(0, 18)}</span>
                <span>{a.status === 'bust' ? 'BUST' : coins(a.cashMilli)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
