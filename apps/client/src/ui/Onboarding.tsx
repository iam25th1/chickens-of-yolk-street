// First-run onboarding: three cards on the farm, told by the farm's own hen. Collecting, selling,
// then the decision cards the agents send. Each card swings in like an offer card; the hen's
// portrait talks while her line types out. Skippable at any step, and shown once per browser.
import { animate } from 'animejs';
import { useEffect, useRef, useState } from 'react';
import { uiSound, useServices } from '../app/services';
import { Portrait } from './CardOverlay';
import { SheetSprite } from './SheetSprite';

const SEEN_KEY = 'coys.onboarded';
const NARRATOR = 'x-hen-portrait';

interface Step {
  art: string;
  title: string;
  points: string[];
  line: string;
}

const STEPS: Step[] = [
  {
    art: '29-card-bulk-order',
    title: 'COLLECT',
    points: ['CLICK AN EGG', 'IT GOES IN THE CRATE', 'MISSED EGGS ARE PICKED UP AT NIGHT'],
    line: 'Morning, farmer! We lay all day. Click our eggs to fill the crate. Keep the trough full or we stop laying.',
  },
  {
    art: '29-card-premium-order',
    title: 'SELL',
    points: ['SELL THE CRATE', 'PRICE: BASE X MARKET', 'TOO MANY EGGS: A GLUT'],
    line: 'Sell the crate at the street price. Every farm\'s eggs set tomorrow\'s price: flood the street and it crashes.',
  },
  {
    art: '29-card-standing-contract',
    title: 'DECISION CARDS',
    points: ['ACCEPT', 'COUNTER: HAGGLE X3', 'DECLINE OR LATER'],
    line: 'Rivals, feed sellers and buyers are AI agents. Their offers land as cards. Accept, decline, or haggle up to three rounds.',
  },
];

export const onboardingSeen = (): boolean => {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true;
  }
};

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { assets, audio } = useServices();
  const [ready, setReady] = useState(() => assets.has(NARRATOR));
  const [i, setI] = useState(0);
  const [typed, setTyped] = useState('');
  const [talking, setTalking] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const cardEl = useRef<HTMLDivElement>(null);
  const portraitEl = useRef<HTMLDivElement>(null);
  const step = STEPS[i] ?? STEPS[0];

  // the hen's portrait is only needed here, so it loads on a first run only
  useEffect(() => {
    if (ready) return;
    let live = true;
    void assets.loadSprites([NARRATOR]).then(
      () => live && setReady(true),
      () => live && setReady(true),
    );
    return () => {
      live = false;
    };
  }, [assets, ready]);

  // each card swings in like an offer, with the paper swoosh
  useEffect(() => {
    if (!ready) return;
    if (cardEl.current) animate(cardEl.current, { translateX: [200, 0], rotate: [10, -2], duration: 480, ease: 'outBack(1.8)' });
    if (i === 0 && portraitEl.current) animate(portraitEl.current, { translateY: [30, 0], opacity: [0, 1], duration: 380, ease: 'outCubic' });
    audio.play('17-card', { volume: 0.7 });
  }, [i, ready, audio]);

  // the line types out while she talks
  useEffect(() => {
    if (!ready || !step) return;
    setTalking(true);
    const box = { n: 0 };
    const run = animate(box, {
      n: [0, step.line.length],
      duration: Math.min(2200, step.line.length * 22),
      ease: 'linear',
      onUpdate: () => setTyped(step.line.slice(0, Math.floor(box.n))),
      onComplete: () => {
        setTyped(step.line);
        setTalking(false);
      },
    });
    return () => {
      run.pause();
    };
  }, [i, ready, step]);

  const finish = () => {
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // storage blocked: it shows again next visit
    }
    if (root.current) animate(root.current, { opacity: [1, 0], duration: 240, ease: 'inQuad', onComplete: onDone });
    else onDone();
  };

  const next = () => {
    uiSound(audio, 'click');
    if (i + 1 >= STEPS.length) finish();
    else setI(i + 1);
  };

  if (!ready || !step) return null;
  return (
    <div ref={root} className="layer" style={{ zIndex: 45 }} role="dialog" aria-label="How to play">
      <div style={{ position: 'absolute', left: 0, top: 24, width: 508, height: 320, background: 'rgba(42, 22, 12, 0.6)' }} />
      <div ref={portraitEl} className="panel" style={{ left: 40, top: 92, width: 240, height: 128, zIndex: 46 }}>
        <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
          <Portrait sheet={NARRATOR} row={talking ? 'talk' : 'idle'} loop />
          <div className="col" style={{ gap: 4, width: 150 }}>
            <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
              YOUR HEN
            </span>
            <span style={{ minHeight: 56, lineHeight: '10px' }}>{typed.toUpperCase()}</span>
          </div>
        </div>
        <span style={{ color: '#8b5a2b' }}>
          {i + 1} OF {STEPS.length}
        </span>
      </div>

      <div ref={cardEl} key={step.title} style={{ position: 'absolute', left: 300, top: 60, width: 128, height: 176, zIndex: 46 }}>
        <SheetSprite id={step.art} row="flutter" play="once" style={{ position: 'absolute', left: 0, top: 0 }} />
        <div className="card-title">{step.title}</div>
        <div className="card-body">
          {step.points.map((p) => (
            <span key={p}>{p}</span>
          ))}
        </div>
      </div>

      <div className="row" style={{ position: 'absolute', left: 40, top: 240, gap: 6, zIndex: 46 }}>
        <button className="btn red" onMouseEnter={() => uiSound(audio, 'hover')} onClick={next}>
          {i + 1 >= STEPS.length ? 'START FARMING' : 'NEXT'}
        </button>
        <button
          className="btn"
          onClick={() => {
            uiSound(audio, 'back');
            finish();
          }}
        >
          SKIP
        </button>
      </div>
    </div>
  );
}
