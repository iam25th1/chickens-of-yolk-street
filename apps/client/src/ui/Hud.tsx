import { animate, stagger } from 'animejs';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ECONOMY, coopCapacity, feedGramsPerHenDay, type FarmState } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { motion } from '../motion/ui';
import { dayElapsed, events, game, gameTime } from '../state/game';
import { useStore } from '../state/store';
import { SheetSprite, flapRect } from './SheetSprite';

/** A number that counts to its new value and pops when it goes up. */
export function Counter({ value, format = (v) => String(Math.round(v)), id }: { value: number; format?: (v: number) => string; id?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  const [text, setText] = useState(format(value));
  useEffect(() => {
    const from = shown.current;
    if (from === value) return;
    shown.current = value;
    const run = motion.count(from, value, 700, (v) => setText(format(v)));
    if (value > from && el.current) motion.pop(el.current, 1.3);
    return () => {
      run.pause();
      setText(format(value));
    };
    // format is a stable formatter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <span ref={el} id={id} className="value" style={{ display: 'inline-block' }}>
      {text}
    </span>
  );
}

/** One split-flap cell: flips through the flip frames, then lands on the new character. */
function FlapChar({ ch }: { ch: string }) {
  const { assets } = useServices();
  const [shown, setShown] = useState(ch);
  const [flip, setFlip] = useState(-1);
  useEffect(() => {
    if (ch === shown) return;
    const box = { f: 0 };
    const run = animate(box, {
      f: [0, 3.99],
      duration: 220,
      ease: 'linear',
      onUpdate: () => setFlip(Math.floor(box.f)),
      onComplete: () => {
        setFlip(-1);
        setShown(ch);
      },
    });
    return () => {
      run.pause();
    };
  }, [ch, shown]);
  const url = assets.url('33-split-flap');
  const atlas = assets.atlasSize('33-split-flap');
  const size = `${atlas.w}px ${atlas.h}px`;
  const src = flip >= 0 ? { x: flip * 64, y: 288 } : flapRect(shown);
  const rect = src ? assets.regionRect('33-split-flap', src.x, src.y, 64, 96) : null;
  if (!rect) return <span style={{ width: 8, height: 12, display: 'inline-block', background: '#3a1f10' }} />;
  return (
    <span
      className="sprite"
      style={{ display: 'inline-block', width: 8, height: 12, backgroundImage: `url(${url})`, backgroundSize: size, backgroundPosition: `${-rect.x}px ${-rect.y}px` }}
    />
  );
}

export function SplitFlap({ text }: { text: string }) {
  return (
    <span style={{ display: 'inline-flex', gap: 1 }} aria-label={text}>
      {[...text].map((c, i) => (
        <FlapChar key={i} ch={c} />
      ))}
    </span>
  );
}

function Stat({ icon, children, title }: { icon: string; children: ReactNode; title: string }) {
  return (
    <div className="stat" title={title} data-tip={title.toUpperCase()} tabIndex={0}>
      <SheetSprite id="32-icons" row={icon} />
      {children}
    </div>
  );
}

/** Laid today and still on the ground (the hens drop them through the day; click one to collect it). */
export function groundEggs(farm: FarmState): number {
  const now = dayElapsed();
  return farm.layPlan.filter((e) => !e.collected && !e.broken && e.atMs <= now).length;
}

/** One truth for eggs: on the ground to collect, and in the crate ready to sell. */
function EggStats({ farm }: { farm: FarmState }) {
  const [ground, setGround] = useState(() => groundEggs(farm));
  useEffect(() => {
    setGround(groundEggs(farm));
    const t = setInterval(() => setGround(groundEggs(farm)), 500);
    return () => clearInterval(t);
  }, [farm]);
  const crate = farm.crate.white + farm.crate.cream + farm.crate.brown + farm.crate.golden;
  return (
    <>
      <Stat icon="egg" title="Eggs on the ground: click them to collect">
        <span className="stat-label">COLLECT</span>
        <Counter value={ground} />
      </Stat>
      <Stat icon="egg" title="Eggs in the crate: ready to sell">
        <span className="stat-label">SELL</span>
        <Counter value={crate} />
      </Stat>
    </>
  );
}

const pad = (n: number, w: number) => String(Math.max(0, Math.floor(n))).padStart(w, '0');

function DayClock() {
  const clock = useStore(game, (s) => s.clock);
  const [time, setTime] = useState(gameTime());
  useEffect(() => {
    const t = setInterval(() => setTime(gameTime()), 500);
    return () => clearInterval(t);
  }, []);
  const minute = Math.floor(time.m / 10) * 10;
  return (
    <div className="stat" title="Day and time" data-tip="DAY AND TIME: AT MIDNIGHT THE DAY CLOSES AND THE MARKET SETTLES" tabIndex={0}>
      <SplitFlap text={`DAY${pad(clock?.day ?? 1, 3)}`} />
      <SheetSprite id="32-icons" row="clock" frame={Math.floor(time.h / 6) % 4} />
      <SplitFlap text={`${pad(time.h, 2)}.${pad(minute, 2)}`} />
    </div>
  );
}

export const coins = (milli: number): string => (milli / 1000).toFixed(2);

export function TopBar({ farm, onShop, onSettings, onMarket, onLedger }: { farm: FarmState; onShop: () => void; onSettings: () => void; onMarket: () => void; onLedger: () => void }) {
  const { audio } = useServices();
  const capacity = coopCapacity(farm.coops.map((c) => c.kind));
  const feed = farm.feedGrams.cheap + farm.feedGrams.standard + farm.feedGrams.premium;
  const days = farm.hens.length ? feed / (farm.hens.length * feedGramsPerHenDay()) : 0;
  const button = (row: string, label: string, onClick: () => void) => (
    <button
      className="btn"
      style={{ height: 18, padding: '0 2px' }}
      aria-label={label}
      title={label}
      data-tip={label.toUpperCase()}
      onMouseEnter={() => uiSound(audio, 'hover')}
      onClick={() => {
        uiSound(audio, 'click');
        onClick();
      }}
    >
      <SheetSprite id="32-icons" row={row} />
    </button>
  );
  return (
    <div className="topbar">
      <Stat icon="cash" title="Coins to spend">
        <Counter id="cash-counter" value={farm.cashMilli} format={(v) => coins(Math.round(v))} />
      </Stat>
      <EggStats farm={farm} />
      <Stat icon="hen" title="Hens, and room in your coops">
        <span className={farm.hens.length > capacity ? 'down' : ''}>
          {farm.hens.length}/{capacity}
        </span>
      </Stat>
      <Stat icon="feed" title="Days of feed left for your hens">
        <span className={days < 2 ? 'down' : ''}>{days.toFixed(1)}D</span>
      </Stat>
      <div className="spacer" style={{ flex: 1 }} />
      <DayClock />
      {button('market', 'Market board: prices and rivals', onMarket)}
      {button('ledger', 'Ledger: your days in coins', onLedger)}
      {button('shop', 'Shop: hens, feed, coops, machines', onShop)}
      {button('settings', 'Settings', onSettings)}
    </div>
  );
}

/** Live prices scrolling along the bottom. Drops and shudders when the market crashes. */
export function Ticker({ extra = [] }: { extra?: string[] }) {
  const market = useStore(game, (s) => s.market);
  const track = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const crash = market?.crash ?? false;
  const prev = market?.history.at(-2)?.multiplier ?? ECONOMY.market.openingMultiplier;
  const up = (market?.multiplier ?? 1) >= prev;
  const items = market
    ? [
        ...(['white', 'cream', 'brown', 'golden'] as const).map((g) => `${g.toUpperCase()} ${(market.pricesMilli[g] / 1000).toFixed(2)}`),
        `PRICES AT ${Math.round(market.multiplier * 100)}%`,
        `SUPPLY TODAY ${market.supplyToday}`,
        `FARMS ${market.farms.players + market.farms.agents}${market.farms.bust ? ` BUST ${market.farms.bust}` : ''}`,
        ...extra,
      ]
    : ['OPENING THE MARKET'];
  const text = items.join('|');

  useEffect(() => {
    if (!track.current) return;
    const half = track.current.scrollWidth / 2;
    const run = motion.scroll(track.current, half);
    return () => {
      run.pause();
    };
  }, [text]);

  useEffect(() => {
    if (crash && strip.current) motion.crash(strip.current);
  }, [crash]);

  // a bust sends a price wave along the ticker
  useEffect(
    () =>
      events.on((e) => {
        if (e.kind !== 'rivalBust' || !track.current) return;
        animate(track.current.querySelectorAll('.ticker-item'), { translateY: [0, -4, 2, 0], duration: 520, delay: stagger(45), ease: 'outQuad' });
      }),
    [],
  );

  const row = (key: string) => (
    <div key={key} style={{ display: 'flex', gap: 16 }}>
      {items.map((t, i) => (
        <span key={i} className="ticker-item">
          <span className={i === 4 ? (up ? 'up' : 'down') : ''}>{t}</span>
          {i === 4 && <span className={up ? 'up' : 'down'}>{up ? '+' : '-'}</span>}
        </span>
      ))}
    </div>
  );
  return (
    <div ref={strip} className={`ticker ${crash ? 'crash' : ''}`} aria-live="polite">
      <div ref={track} className="ticker-track" style={{ gap: 16 }}>
        {row('a')}
        {row('b')}
      </div>
    </div>
  );
}
