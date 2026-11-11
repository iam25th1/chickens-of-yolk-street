// The card tray: selling the crate, and the glut warning when the market crashes. Feed lives in the shop.
// Every price shown is display only; the server prices the action when it arrives.
import { useEffect, useRef, useState } from 'react';
import { eggPrice, saleValue, type FarmState, type MarketState } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { motion } from '../motion/ui';
import type { Action } from '../net/socket';
import { SheetSprite } from './SheetSprite';

type Send = (a: Action) => Promise<boolean>;

function Card({ id, title, top, children, z = 1 }: { id: string; title: string; top: number; children: React.ReactNode; z?: number }) {
  const { audio } = useServices();
  const el = useRef<HTMLDivElement>(null);
  const [shine, setShine] = useState(false);
  useEffect(() => {
    if (el.current) motion.enter(el.current, top / 4);
    audio.play('17-card', { volume: 0.5, delayMs: top / 2, minGapMs: 80 });
  }, [audio, top]);
  return (
    <div
      ref={el}
      className="card"
      style={{ top, zIndex: z }}
      onMouseEnter={() => {
        setShine(true);
        if (el.current) motion.pop(el.current, 1.03);
      }}
      onMouseLeave={() => setShine(false)}
    >
      <SheetSprite id={id} row={shine ? 'shine' : 'flutter'} play={shine ? 'loop' : false} style={{ position: 'absolute', left: 0, top: 0 }} />
      <div className="card-title">{title}</div>
      <div className="card-body">{children}</div>
    </div>
  );
}

export const GRADE_NAME = { white: 'WHITE', cream: 'CREAM', brown: 'BROWN', golden: 'GOLDEN' } as const;

export function SellCard({ farm, market, send }: { farm: FarmState; market: MarketState; send: Send }) {
  const { audio } = useServices();
  const [busy, setBusy] = useState(false);
  const total = farm.crate.white + farm.crate.cream + farm.crate.brown + farm.crate.golden;
  const value = saleValue(farm.crate, market.multiplier, farm.unlocks);
  return (
    <Card id="29-card-bulk-order" title="SELL THE CRATE" top={4}>
      <div className="row spread" style={{ color: '#8b5a2b' }}>
        <span>IN CRATE</span>
        <span>EACH</span>
      </div>
      {(['white', 'cream', 'brown', 'golden'] as const).map((g) => (
        <div key={g} className="row spread">
          <span>
            {farm.crate[g]} {GRADE_NAME[g]}
          </span>
          <span>{eggPrice(g, market.multiplier, farm.unlocks).toFixed(2)}</span>
        </div>
      ))}
      <div className="row spread" style={{ borderTop: '1px solid #8b5a2b', paddingTop: 3 }}>
        <span>TOTAL</span>
        <span>{value.toFixed(2)}</span>
      </div>
      <button
        className="btn red"
        disabled={total === 0 || busy}
        onMouseEnter={() => uiSound(audio, 'hover')}
        onClick={() => {
          uiSound(audio, 'click');
          setBusy(true);
          void send({ t: 'sell', items: { ...farm.crate } }).finally(() => setBusy(false));
        }}
      >
        SELL {total} EGGS
      </button>
    </Card>
  );
}

export function GlutCard({ market }: { market: MarketState }) {
  return (
    <Card id="29-card-glut-warning" title="GLUT WARNING" top={72} z={3}>
      <span>TOO MANY EGGS ON THE STREET.</span>
      <span>PRICES ARE AT</span>
      <span className="big" style={{ color: '#b8321f' }}>
        {Math.round(market.multiplier * 100)}%
      </span>
      <span>HOLD YOUR CRATE OR SELL INTO THE DIP.</span>
    </Card>
  );
}
