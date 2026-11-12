// The crate's sell card (side panel, and the crate's own card on the farm) and the glut notice.
// Every price shown is display only; the server prices the action when it arrives. A sale slams
// the SOLD stamp onto the card that made it.
import { useEffect, useRef, useState } from 'react';
import { eggPrice, saleValue, type FarmState, type MarketState } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { juice, sizeShake } from '../motion/juice';
import { motion } from '../motion/ui';
import type { Action } from '../net/socket';
import { uiFx } from './FxLayer';
import { SheetSprite } from './SheetSprite';

type Send = (a: Action) => Promise<boolean>;

export const GRADE_NAME = { white: 'WHITE', cream: 'CREAM', brown: 'BROWN', golden: 'GOLDEN' } as const;

/** A stamp that slams onto its card, never tilted, in whole pixel steps. */
export function CardStamp({ row, coins, onDone }: { row: string; coins?: number; onDone: () => void }) {
  const { audio } = useServices();
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const tl = motion.stamp(
      el.current,
      () => {
        if (coins === undefined) return;
        juice.hitstop(coins >= 30 ? 140 : 80);
        juice.shake(sizeShake(coins), 260 + coins * 4);
        audio.play('18-stamp');
        audio.play('15-kaching', { delayMs: 90 });
        if (coins >= 30) audio.play('45-deal-closed', { delayMs: 250 });
      },
      onDone,
    );
    return () => {
      tl.pause();
    };
    // once per stamp
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={el} className="col" style={{ position: 'absolute', left: 0, top: 104, width: 128, alignItems: 'center', gap: 0, opacity: 0, pointerEvents: 'none', zIndex: 2 }}>
      <SheetSprite id="30-stamps" row={row} play="once" />
      {coins !== undefined && (
        <div className="display shadowed" style={{ color: '#f6e7c1', marginTop: -4 }}>
          +{coins.toFixed(2)}
        </div>
      )}
    </div>
  );
}

export function SellCard({ farm, market, send, tour }: { farm: FarmState; market: MarketState; send: Send; tour?: string }) {
  const { audio } = useServices();
  const [busy, setBusy] = useState(false);
  const [stamp, setStamp] = useState<{ id: number; coins: number } | null>(null);
  const mine = useRef(false);
  const total = farm.crate.white + farm.crate.cream + farm.crate.brown + farm.crate.golden;
  const value = saleValue(farm.crate, market.multiplier, farm.unlocks);
  useEffect(
    () =>
      uiFx.on((fx) => {
        if (fx.kind !== 'stamp' || !mine.current) return;
        mine.current = false;
        setStamp({ id: Date.now(), coins: fx.coins });
      }),
    [],
  );
  return (
    <div className="card" data-ui="sell-card">
      <SheetSprite id="29-card-bulk-order" row="flutter" style={{ position: 'absolute', left: 0, top: 0 }} />
      <div className="card-title">SELL THE CRATE</div>
      <div className="card-body">
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
          data-tour={tour}
          disabled={total === 0 || busy}
          onMouseEnter={() => uiSound(audio, 'hover')}
          onClick={() => {
            uiSound(audio, 'click');
            setBusy(true);
            mine.current = true;
            void send({ t: 'sell', items: { ...farm.crate } }).finally(() => setBusy(false));
          }}
        >
          SELL {total} EGGS
        </button>
      </div>
      {stamp && <CardStamp key={stamp.id} row="sold" coins={stamp.coins} onDone={() => setStamp(null)} />}
    </div>
  );
}

/** When the street is flooded: one plain block, never another card on top of the sell card. */
export function GlutNotice({ market }: { market: MarketState }) {
  return (
    <div className="glut" role="status">
      GLUT: TOO MANY EGGS ON THE STREET. PRICES AT {Math.round(market.multiplier * 100)}%. HOLD YOUR CRATE OR SELL INTO THE DIP.
    </div>
  );
}
