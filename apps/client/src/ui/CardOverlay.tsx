// A decision card, as one composed modal: the agent's portrait and line on top with what accepting
// means, the card art (upright, its text crisp) beside it, and the answers in one row below. The
// portrait talks with its voice babble while the line types out. A counter opens a haggle (up to
// three rounds). Outcomes play the agent's expression and slam a stamp on the card; a haggle win
// turns the card gold with a hitstop and confetti, a fail sends the agent away.
import { animate, createTimeline } from 'animejs';
import { useEffect, useRef, useState } from 'react';
import { ECONOMY, type CardChoice, type CardOutcome, type CardView } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { useViewport } from '../app/Stage';
import { juice } from '../motion/juice';
import type { Action } from '../net/socket';
import { CardStamp } from './Cards';
import { CARD_ART, CARD_TITLE, CARD_UNIT, CHOICE_LABEL, LOOK, acceptMeaning } from './cast';
import { Modal } from './Modal';
import { SheetSprite } from './SheetSprite';

/** A painted portrait in a 64x64 UI box, playing a row on its own clock. */
export function Portrait({ sheet, row, loop, onDone }: { sheet: string; row: string; loop: boolean; onDone?: () => void }) {
  const v = useViewport();
  return <SheetSprite id={sheet} row={row} play={loop ? 'loop' : 'once'} onDone={onDone} size={v.p} box={{ w: 64, h: 64 }} />;
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

  // arrival: the card slides in upright, paper swoosh
  useEffect(() => {
    if (cardEl.current) animate(cardEl.current, { translateX: { from: 48, to: 0, modifier: Math.round }, opacity: [0, 1], duration: 420, ease: 'outBack(1.4)' });
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
    setAsk(Math.round((card.offerMilli * (agentSells(card) ? 0.95 : 1.05)) / 10) * 10);
    setBusy(false);
  }, [haggleMood, card, audio]);

  // the outcome
  useEffect(() => {
    if (!result) return;
    const good = result.outcome === 'accepted' || result.outcome === 'won';
    if (look) setPortraitRow(good ? look.good : look.bad);
    setStamp(good ? (result.outcome === 'won' ? 'sold' : 'accepted') : 'declined');
    if (result.outcome === 'won') {
      // turn gold, freeze a beat, confetti, chime
      if (cardEl.current) {
        createTimeline()
          .add(cardEl.current, { scaleX: { to: 0, modifier: (v: number) => Math.round(v * 4) / 4 }, duration: 140, ease: 'inQuad', onComplete: () => setGold(true) })
          .add(cardEl.current, { scaleX: { to: 1, modifier: (v: number) => Math.round(v * 4) / 4 }, duration: 220, ease: 'outQuad' });
      }
      juice.hitstop(110);
      juice.shake(2, 200);
      setConfetti(Array.from({ length: 10 }, (_, i) => i));
      audio.play('19-haggle-win');
    } else if (result.outcome === 'failed') {
      audio.play('20-fail');
      if (portraitEl.current) animate(portraitEl.current, { translateX: { from: 0, to: -40, modifier: Math.round }, opacity: [1, 0], duration: 900, delay: 700, ease: 'inQuad' });
    } else if (good) {
      audio.play('18-stamp', { volume: 0.8 });
      if (result.totalMilli > 0) audio.play('15-kaching', { delayMs: 120, volume: 0.7 });
    } else audio.play('35-back', { volume: 0.6 });
    const t = setTimeout(onClose, 1700);
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
    <Modal title={`${card.from.toUpperCase()}: ${CARD_TITLE[card.kind]}`} onClose={onClose} w={444} h={268} dismiss={false}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
        <div className="col" style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <div ref={portraitEl} className="row" style={{ alignItems: 'flex-start', gap: 6 }}>
            {look ? <Portrait sheet={look.portrait} row={portraitRow} loop={talking || portraitRow === 'idle'} /> : <div style={{ width: 64, height: 64, flex: 'none' }} />}
            <span style={{ minHeight: 64, lineHeight: '10px' }}>{typed.toUpperCase()}</span>
          </div>
          {!result && <p className="meaning">{acceptMeaning(card)}</p>}
          {card.round > 0 && !result && <span style={{ color: '#8b5a2b' }}>ROUND {card.round} OF {ECONOMY.haggle.maxRounds}</span>}
        </div>
        <div
          ref={cardEl}
          className="card"
          data-ui="card-art"
          style={{ filter: gold ? 'sepia(1) saturate(4) hue-rotate(-12deg) brightness(1.08)' : undefined }}
        >
          <SheetSprite id={CARD_ART[card.kind]} row={gold ? 'shine' : 'flutter'} play={gold ? 'loop' : 'once'} style={{ position: 'absolute', left: 0, top: 0 }} />
          <div className="card-title">{CARD_TITLE[card.kind]}</div>
          <div className="card-body">
            {terms(card).map((l) => (
              <span key={l}>{l}</span>
            ))}
          </div>
          {stamp && <CardStamp row={stamp} key={`${stamp}-${card.round}-${result?.outcome ?? ''}`} onDone={() => undefined} />}
          {confetti.map((i) => (
            <Confetti key={i} i={i} />
          ))}
        </div>
      </div>
      {!result && (
        <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
          {canCounter && (
            <>
              <span className="chip">YOUR PRICE</span>
              <button className="btn" onClick={() => setAsk(Math.max(10, ask - step))} aria-label="Lower">
                -
              </button>
              <span className="chip on">{coins(ask)}</span>
              <button className="btn" onClick={() => setAsk(ask + step)} aria-label="Higher">
                +
              </button>
            </>
          )}
          {card.choices.map((c) => (
            <button
              key={c}
              data-tour={c === 'counter' ? 'counter' : `choice-${c}`}
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
      )}
    </Modal>
  );
}

function Confetti({ i }: { i: number }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const dx = (i - 5) * 12 + Math.round(Math.random() * 8);
    animate(el.current, {
      translateX: { from: 0, to: dx, modifier: Math.round },
      translateY: { from: 0, to: -40 - (i % 3) * 16, modifier: Math.round },
      opacity: [1, 1, 0],
      duration: 1100,
      ease: 'outQuad',
    });
  }, [i]);
  return (
    <div ref={el} style={{ position: 'absolute', left: 56, top: 80, zIndex: 3, pointerEvents: 'none' }}>
      <SheetSprite id="35-particles" row="confetti" play="once" />
    </div>
  );
}
