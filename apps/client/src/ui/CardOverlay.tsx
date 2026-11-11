// The card overlay. A card slides in with an overshoot and a paper swoosh; the agent's portrait
// talks with its voice babble while its line types out; the player answers. A counter opens a
// haggle (up to three rounds). Outcomes play the agent's expression and slam a stamp; a haggle
// win flips the card to gold with a hitstop and confetti, a fail sends the agent walking.
import { animate, createTimeline } from 'animejs';
import { useEffect, useRef, useState } from 'react';
import { ECONOMY, type CardChoice, type CardOutcome, type CardView } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { juice } from '../motion/juice';
import type { Action } from '../net/socket';
import { CARD_ART, CARD_TITLE, CARD_UNIT, CHOICE_LABEL, LOOK } from './cast';
import { SheetSprite } from './SheetSprite';

export function Portrait({ sheet, row, loop, onDone }: { sheet: string; row: string; loop: boolean; onDone?: () => void }) {
  const { assets } = useServices();
  const [i, setI] = useState(0);
  const names = assets.frameRects(sheet, row);
  useEffect(() => {
    setI(0);
    let k = 0;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      timer = setTimeout(() => {
        if (k + 1 >= names.length) {
          if (!loop) return onDone?.();
          k = 0;
        } else k++;
        setI(k);
        step();
      }, names[k]?.ms || 120);
    };
    step();
    return () => clearTimeout(timer);
    // names are stable per sheet and row
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, row, loop]);
  return <SheetSprite id={sheet} row={row} frame={Math.min(i, names.length - 1)} zoom={assets.grid(sheet) / 4} />;
}

const coins = (milli: number): string => (milli / 1000).toFixed(2);
const agentSells = (c: CardView): boolean => c.kind === 'feed-deal' || c.kind === 'credit-terms';

function terms(c: CardView): string[] {
  const lines: string[] = [];
  if (c.offerMilli) lines.push(`${coins(c.offerMilli)} / ${CARD_UNIT[c.kind]}`);
  if (c.qty) lines.push(`${c.qty} ${c.kind === 'standing-contract' ? 'A DAY' : CARD_UNIT[c.kind] ? `${CARD_UNIT[c.kind]}S` : ''}`);
  if (c.grade) lines.push(c.grade === 'any' ? 'ANY GRADE' : c.grade.toUpperCase());
  if (c.tier) lines.push(`${c.tier.toUpperCase()} FEED`);
  if (c.days) lines.push(`${c.days} DAYS`);
  if (c.kind !== 'glut-warning' && c.offerMilli && c.qty) lines.push(`TOTAL ${coins(c.offerMilli * c.qty * (c.kind === 'standing-contract' ? (c.days ?? 1) : 1))}`);
  return lines;
}

export interface OverlayResult {
  outcome: CardOutcome;
  totalMilli: number;
}

export function CardOverlay({
  card,
  result,
  haggleMood,
  send,
  onClose,
}: {
  card: CardView;
  result: OverlayResult | null;
  haggleMood: 'warm' | 'firm' | 'cross' | null;
  send: (a: Action) => Promise<boolean>;
  onClose: () => void;
}) {
  const { audio } = useServices();
  const look = card.agentKind ? LOOK[card.agentKind] : null;
  const root = useRef<HTMLDivElement>(null);
  const cardEl = useRef<HTMLDivElement>(null);
  const portraitEl = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState('');
  const [talking, setTalking] = useState(true);
  const [ask, setAsk] = useState(() => Math.round((card.offerMilli * (agentSells(card) ? 0.9 : 1.1)) / 10) * 10);
  const [busy, setBusy] = useState(false);
  const [stamp, setStamp] = useState<string | null>(null);
  const [gold, setGold] = useState(false);
  const [confetti, setConfetti] = useState<number[]>([]);
  const [portraitRow, setPortraitRow] = useState('talk');

  // arrival: slide in with overshoot, paper swoosh
  useEffect(() => {
    if (cardEl.current) animate(cardEl.current, { translateX: [220, 0], rotate: [12, -2], duration: 520, ease: 'outBack(1.8)' });
    if (portraitEl.current) animate(portraitEl.current, { translateY: [30, 0], opacity: [0, 1], duration: 380, ease: 'outCubic' });
    audio.play('17-card', { volume: 0.8 });
  }, [audio]);

  // the line types out while the agent talks with its voice
  useEffect(() => {
    setTalking(true);
    setPortraitRow('talk');
    const box = { n: 0 };
    let last = 0;
    const run = animate(box, {
      n: [0, card.line.length],
      duration: Math.min(2400, card.line.length * 26),
      ease: 'linear',
      onUpdate: () => {
        const n = Math.floor(box.n);
        setTyped(card.line.slice(0, n));
        if (look && n - last >= 3) {
          last = n;
          audio.play(look.voice, { volume: 0.55, minGapMs: 70 });
        }
      },
      onComplete: () => {
        setTyped(card.line);
        setTalking(false);
        setPortraitRow('idle');
      },
    });
    return () => {
      run.pause();
    };
  }, [card.line, look, audio]);

  // a counter from the agent: stamp it
  useEffect(() => {
    if (!haggleMood) return;
    setStamp('counter');
    audio.play('30-stamp-thump', { volume: 0.7 });
    const sells = card.kind === 'feed-deal' || card.kind === 'credit-terms';
    setAsk(Math.round((card.offerMilli * (sells ? 0.95 : 1.05)) / 10) * 10);
    setBusy(false);
  }, [haggleMood, card.offerMilli, card.kind, audio]);

  // the outcome
  useEffect(() => {
    if (!result) return;
    const good = result.outcome === 'accepted' || result.outcome === 'won';
    if (look) setPortraitRow(good ? look.good : look.bad);
    setStamp(good ? (result.outcome === 'won' ? 'sold' : 'accepted') : 'declined');
    if (result.outcome === 'won') {
      // flip to gold, freeze a beat, confetti, chime
      if (cardEl.current) {
        createTimeline()
          .add(cardEl.current, { scaleX: [1, 0], duration: 140, ease: 'inQuad', onComplete: () => setGold(true) })
          .add(cardEl.current, { scaleX: [0, 1], duration: 220, ease: 'outBack(2)' });
      }
      juice.hitstop(110);
      juice.shake(2, 200);
      setConfetti(Array.from({ length: 10 }, (_, i) => i));
      audio.play('19-haggle-win');
    } else if (result.outcome === 'failed') {
      audio.play('20-fail');
      if (portraitEl.current) animate(portraitEl.current, { translateX: [0, -60], opacity: [1, 0], duration: 900, delay: 700, ease: 'inQuad' });
    } else if (good) {
      audio.play('18-stamp', { volume: 0.8 });
      if (result.totalMilli > 0) audio.play('15-kaching', { delayMs: 120, volume: 0.7 });
    } else audio.play('35-back', { volume: 0.6 });
    const t = setTimeout(() => {
      if (root.current) animate(root.current, { opacity: [1, 0], duration: 260, ease: 'inQuad', onComplete: onClose });
      else onClose();
    }, 1700);
    return () => clearTimeout(t);
  }, [result, look, audio, onClose]);

  const choose = (choice: CardChoice) => {
    if (busy || result) return;
    uiSound(audio, choice === 'decline' || choice === 'hold' ? 'back' : 'click');
    setBusy(true);
    void send(choice === 'counter' ? { t: 'respondCard', cardId: card.id, choice, ask: ask / 1000 } : { t: 'respondCard', cardId: card.id, choice }).then((ok) => {
      if (!ok) setBusy(false);
    });
  };

  const step = Math.max(10, Math.round(card.offerMilli * 0.02));
  const canCounter = card.choices.includes('counter') && card.round < ECONOMY.haggle.maxRounds;

  return (
    <div ref={root} className="layer" style={{ zIndex: 40 }}>
      <div style={{ position: 'absolute', left: 0, top: 24, width: 508, height: 320, background: 'rgba(42, 22, 12, 0.55)' }} />
      <div ref={portraitEl} className="panel" style={{ left: 40, top: 92, width: 240, height: 128, zIndex: 41 }}>
        <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
          {look ? <Portrait sheet={look.portrait} row={portraitRow} loop={talking || portraitRow === 'idle'} /> : <div style={{ width: 64, height: 64 }} />}
          <div className="col" style={{ gap: 4, width: 150 }}>
            <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
              {card.from.toUpperCase()}
            </span>
            <span style={{ minHeight: 56, lineHeight: '10px' }}>{typed.toUpperCase()}</span>
          </div>
        </div>
        {card.round > 0 && !result && <span style={{ color: '#8b5a2b' }}>ROUND {card.round} OF {ECONOMY.haggle.maxRounds}</span>}
      </div>

      <div ref={cardEl} style={{ position: 'absolute', left: 300, top: 60, width: 128, height: 176, zIndex: 41, filter: gold ? 'sepia(1) saturate(4) hue-rotate(-12deg) brightness(1.08)' : undefined }}>
        <SheetSprite id={CARD_ART[card.kind]} row={gold ? 'shine' : 'flutter'} play={gold ? 'loop' : 'once'} style={{ position: 'absolute', left: 0, top: 0 }} />
        <div className="card-title">{CARD_TITLE[card.kind]}</div>
        <div className="card-body">
          {terms(card).map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
        {stamp && <Stamp row={stamp} key={`${stamp}-${card.round}-${result?.outcome ?? ''}`} />}
      </div>

      {confetti.map((i) => (
        <Confetti key={i} i={i} />
      ))}

      {!result && (
        <div className="col" style={{ position: 'absolute', left: 40, top: 230, width: 400, zIndex: 41, gap: 6 }}>
          {canCounter && (
            <div className="row" style={{ gap: 4 }}>
              <span className="chip" style={{ color: '#2a160c' }}>
                YOUR PRICE
              </span>
              <button className="btn" onClick={() => setAsk(Math.max(10, ask - step))} aria-label="Lower">
                -
              </button>
              <span className="chip on">{coins(ask)}</span>
              <button className="btn" onClick={() => setAsk(ask + step)} aria-label="Higher">
                +
              </button>
            </div>
          )}
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {card.choices.map((c) => (
              <button
                key={c}
                className={`btn ${c === 'accept' || c === 'sellHens' || c === 'matchPrice' || c === 'sellNow' ? 'red' : c === 'counter' ? 'sky' : ''}`}
                disabled={busy || (c === 'counter' && !canCounter)}
                onMouseEnter={() => uiSound(audio, 'hover')}
                onClick={() => choose(c)}
              >
                {c === 'counter' ? `COUNTER ${coins(ask)}` : CHOICE_LABEL[c]}
              </button>
            ))}
            <button className="btn" onClick={onClose} disabled={busy}>
              LATER
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stamp({ row }: { row: string }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (el.current) animate(el.current, { scale: [2.6, 1], rotate: [-24, -8], opacity: [0, 1], duration: 200, ease: 'inQuad' });
  }, []);
  return (
    <div ref={el} style={{ position: 'absolute', left: 32, top: 110, opacity: 0 }}>
      <SheetSprite id="30-stamps" row={row} play="once" />
    </div>
  );
}

function Confetti({ i }: { i: number }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const dx = (i - 5) * 18 + Math.round(Math.random() * 10);
    animate(el.current, { translateX: [0, dx], translateY: [0, -60 - (i % 3) * 20, 40], opacity: [1, 1, 0], duration: 1100, ease: 'outQuad' });
  }, [i]);
  return (
    <div ref={el} style={{ position: 'absolute', left: 356, top: 120, zIndex: 42, pointerEvents: 'none' }}>
      <SheetSprite id="35-particles" row="confetti" play="once" />
    </div>
  );
}
