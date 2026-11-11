// The card tray: selling the crate, buying feed, and the glut warning when the market crashes.
// Every price shown is display only; the server prices the action when it arrives.
import { useEffect, useRef, useState } from 'react';
import { ECONOMY, FEED_TIERS, eggPrice, feedBagPrice, saleValue, type FarmState, type FeedTier, type MarketState } from '@coys/shared';
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

const GRADE_SHORT = { white: 'WHT', cream: 'CRM', brown: 'BRN', golden: 'GLD' } as const;

export function SellCard({ farm, market, send }: { farm: FarmState; market: MarketState; send: Send }) {
  const { audio } = useServices();
  const [busy, setBusy] = useState(false);
  const total = farm.crate.white + farm.crate.cream + farm.crate.brown + farm.crate.golden;
  const value = saleValue(farm.crate, market.multiplier, farm.unlocks);
  return (
    <Card id="29-card-bulk-order" title="SELL THE CRATE" top={4}>
      {(['white', 'cream', 'brown', 'golden'] as const).map((g) => (
        <div key={g} className="row spread">
          <span>
            {GRADE_SHORT[g]} X{farm.crate[g]}
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

export function FeedCard({ farm, send }: { farm: FarmState; send: Send }) {
  const { audio } = useServices();
  const [tier, setTier] = useState<FeedTier>(farm.feedTier);
  const [bags, setBags] = useState(1);
  const price = feedBagPrice(tier, farm.unlocks) * bags;
  const short: Record<FeedTier, string> = { cheap: 'CHEAP', standard: 'STD', premium: 'PREM' };
  return (
    <Card id="29-card-feed-deal" title="FEED BAGS" top={140}>
      <div className="row" style={{ gap: 2 }}>
        {FEED_TIERS.map((t) => (
          <button
            key={t}
            className={`chip ${t === tier ? 'on' : ''}`}
            style={{ border: 0, font: 'inherit', cursor: 'inherit' }}
            onMouseEnter={() => uiSound(audio, 'hover')}
            onClick={() => {
              uiSound(audio, 'click');
              setTier(t);
              if (t !== farm.feedTier) void send({ t: 'setFeedTier', tier: t });
            }}
          >
            {short[t]}
          </button>
        ))}
      </div>
      <div className="row spread">
        <span>LAYS X{ECONOMY.feed.tiers[tier].laying.toFixed(2)}</span>
        <span>{(farm.feedGrams[tier] / 1000).toFixed(0)}KG</span>
      </div>
      <div className="row spread">
        <button className="btn" style={{ padding: '0 4px' }} onClick={() => setBags(Math.max(1, bags - 1))} aria-label="Fewer bags">
          -
        </button>
        <span>
          {bags} X {ECONOMY.feed.bagKg}KG
        </span>
        <button
          className="btn"
          style={{ padding: '0 4px' }}
          onClick={() => setBags(Math.min(ECONOMY.limits.maxBagsPerPurchase, bags + 1))}
          aria-label="More bags"
        >
          +
        </button>
      </div>
      <button
        className="btn"
        disabled={farm.cashMilli < price * 1000}
        onMouseEnter={() => uiSound(audio, 'hover')}
        onClick={() => {
          uiSound(audio, 'click');
          void send({ t: 'buyFeed', tier, bags });
        }}
      >
        BUY {price.toFixed(0)}
      </button>
    </Card>
  );
}

export function GlutCard({ market }: { market: MarketState }) {
  return (
    <Card id="29-card-glut-warning" title="GLUT WARNING" top={72} z={3}>
      <span>TOO MANY EGGS ON THE STREET.</span>
      <span className="big" style={{ color: '#b8321f' }}>
        X{market.multiplier.toFixed(2)}
      </span>
      <span>HOLD YOUR CRATE OR SELL INTO THE DIP.</span>
    </Card>
  );
}
