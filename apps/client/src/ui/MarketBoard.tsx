// The market board, over the town square: the ticker board with live prices by grade, rival farms
// ranked with their signs, the cast, recent big trades, and the order book (sell into a buyer's
// order, buy a neighbour's eggs, or post your own price).
import { useEffect, useRef, useState } from 'react';
import { EGG_GRADES, type EggGrade, type FarmState, type MarketState } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { motion } from '../motion/ui';
import type { Action } from '../net/socket';
import { LOOK } from './cast';
import { SplitFlap } from './Hud';
import { SheetSprite } from './SheetSprite';

const coins = (milli: number): string => (milli / 1000).toFixed(2);

function Board({ title, x, y, w, h, children }: { title: string; x: number; y: number; w: number; h: number; children: React.ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (el.current) motion.enter(el.current, x / 4);
  }, [x]);
  return (
    <div ref={el} className="panel" style={{ left: x, top: y, width: w, height: h, padding: 6 }}>
      <div className="panel-title" style={{ fontSize: 8, lineHeight: '8px', marginBottom: 4 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

export function MarketBoard({ farm, market, send, onBack }: { farm: FarmState; market: MarketState; send: (a: Action) => Promise<boolean>; onBack: () => void }) {
  const { assets, audio } = useServices();
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

  return (
    <div className="layer">
      <Board title={`TICKER BOARD  DAY ${market.day}`} x={10} y={30} w={190} h={118}>
        {EGG_GRADES.map((g) => (
          <div key={g} className="row spread" style={{ marginBottom: 3 }}>
            <span>{g.toUpperCase()}</span>
            <span className="row" style={{ gap: 3 }}>
              <SplitFlap text={coins(market.pricesMilli[g]).padStart(5, '0')} />
              <span className={up ? 'up' : 'down'}>{up ? '^' : 'v'}</span>
            </span>
          </div>
        ))}
        <div className="row spread">
          <span>MARKET X{market.multiplier.toFixed(2)}</span>
          <span>
            SOLD {market.supplyToday} OF {market.reference}
          </span>
        </div>
      </Board>

      <Board title="FARMS" x={430} y={30} w={200} h={150}>
        <div className="col" style={{ gap: 2, height: 124, overflowY: 'auto' }}>
          {market.ranking.map((r, i) => {
            const look = r.kind !== 'player' ? LOOK[r.kind] : null;
            return (
              <div key={`${r.name}-${i}`} className="row spread" style={{ opacity: r.bust ? 0.5 : 1 }}>
                <span className="row" style={{ gap: 3 }}>
                  {look?.sign ? (
                    <img alt="" className="sprite" width={24} height={16} src={assets.thumbnail(look.sign, r.bust ? 'tip-over' : 'sway', r.bust ? 3 : 0, 16)} />
                  ) : (
                    <SheetSprite id="32-icons" row="hen" divisor={16} />
                  )}
                  <span>
                    {i + 1}. {r.name.toUpperCase().slice(0, 16)}
                  </span>
                </span>
                <span>{r.bust ? 'BUST' : `${r.hens}H ${coins(r.cashMilli)}`}</span>
              </div>
            );
          })}
        </div>
      </Board>

      <Board title="THE CAST" x={430} y={186} w={200} h={70}>
        <div className="col" style={{ gap: 1, height: 46, overflowY: 'auto' }}>
          {market.agents.map((a) => (
            <div key={a.id} className="row spread" style={{ opacity: a.status === 'bust' ? 0.5 : 1 }}>
              <span>{a.name.toUpperCase().slice(0, 18)}</span>
              <span>{a.status === 'bust' ? 'BUST' : coins(a.cashMilli)}</span>
            </div>
          ))}
        </div>
      </Board>

      <Board title="BIG TRADES" x={10} y={154} w={190} h={102}>
        <div className="col" style={{ gap: 2, height: 78, overflowY: 'auto' }}>
          {market.trades.length === 0 && <span>QUIET SO FAR</span>}
          {market.trades.map((t, i) => (
            <span key={i}>
              {t.seller.split(' ')[0]?.toUpperCase()} {t.qty} {t.grade.toUpperCase()} TO {t.buyer.split(' ').slice(-1)[0]?.toUpperCase()} {coins(t.totalMilli)}
            </span>
          ))}
        </div>
      </Board>

      <Board title="ORDER BOOK" x={206} y={30} w={218} h={226}>
        <div className="col" style={{ gap: 2, height: 112, overflowY: 'auto' }}>
          {buys.slice(0, 6).map((o) => (
            <div key={o.id} className="row spread">
              <span>
                {o.owner.split(' ').slice(-1)[0]?.toUpperCase()} BUYS {o.qty} {o.grade.toUpperCase()} {coins(o.priceMilli)}
              </span>
              <button className="btn" disabled={farm.crate[o.grade] <= 0} onClick={click(() => void send({ t: 'fillOrder', orderId: o.id, qty: Math.min(o.qty, farm.crate[o.grade]) }))}>
                SELL
              </button>
            </div>
          ))}
          {sells.slice(0, 4).map((o) => (
            <div key={o.id} className="row spread">
              <span>
                {o.owner.split(' ')[0]?.toUpperCase()} SELLS {o.qty} {o.grade.toUpperCase()} {coins(o.priceMilli)}
              </span>
              <button className="btn sky" disabled={farm.cashMilli < o.priceMilli} onClick={click(() => void send({ t: 'fillOrder', orderId: o.id, qty: Math.min(o.qty, Math.floor(farm.cashMilli / o.priceMilli)) }))}>
                BUY
              </button>
            </div>
          ))}
          {mine.map((o) => (
            <div key={o.id} className="row spread">
              <span style={{ color: '#2f6f9e' }}>
                YOU SELL {o.qty} {o.grade.toUpperCase()} {coins(o.priceMilli)}
              </span>
              <button className="btn" onClick={click(() => void send({ t: 'cancelOrder', orderId: o.id }))}>
                X
              </button>
            </div>
          ))}
          {buys.length + sells.length + mine.length === 0 && <span>NO OPEN ORDERS</span>}
        </div>
        <div className="col" style={{ gap: 3, marginTop: 4, borderTop: '1px solid #8b5a2b', paddingTop: 4 }}>
          <span>POST A SELL ORDER AT YOUR PRICE</span>
          <div className="row" style={{ gap: 2 }}>
            {EGG_GRADES.map((g) => (
              <button key={g} className={`chip ${g === grade ? 'on' : ''}`} style={{ border: 0, font: 'inherit' }} onClick={() => setGrade(g)}>
                {g.slice(0, 3).toUpperCase()} {farm.crate[g]}
              </button>
            ))}
          </div>
          <div className="row spread">
            <button className="btn" onClick={() => setQty(Math.max(1, qty - 1))}>
              -
            </button>
            <span>{qty} EGGS</span>
            <button className="btn" onClick={() => setQty(qty + 1)}>
              +
            </button>
            <button className="btn" onClick={() => setPrice(Math.max(10, price - Math.round(market.pricesMilli[grade] * 0.05)))}>
              -
            </button>
            <span>{coins(price)}</span>
            <button className="btn" onClick={() => setPrice(price + Math.round(market.pricesMilli[grade] * 0.05))}>
              +
            </button>
          </div>
          <button className="btn red" disabled={farm.crate[grade] < qty} onClick={click(() => void send({ t: 'placeOrder', grade, qty, price: price / 1000 }))}>
            POST {qty} {grade.toUpperCase()} AT {coins(price)}
          </button>
        </div>
      </Board>

      <button className="btn red" style={{ position: 'absolute', left: 10, top: 262 }} onMouseEnter={() => uiSound(audio, 'hover')} onClick={click(onBack)}>
        BACK TO THE FARM
      </button>
    </div>
  );
}
