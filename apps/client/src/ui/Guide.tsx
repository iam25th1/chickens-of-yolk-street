// The guide in the farm's corner. On a first run it walks the core loop by doing it: collect an
// egg, sell, buy feed, answer a card; each step ends when the player does the thing. After that it
// tracks the goal chain (each goal pays coins) and offers a hint when the farm needs something.
import { useEffect, useRef, useState } from 'react';
import { coopCapacity, feedGramsPerHenDay, type FarmState, type GoalId } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import type { Action } from '../net/socket';
import { dayElapsed, events } from '../state/game';
import { useStore } from '../state/store';
import { finishTour, tour } from '../state/tour';
import { uiFx } from './FxLayer';
import { groundEggs } from './Hud';
import { SheetSprite } from './SheetSprite';

const STEPS: { title: string; text: string; done: (e: { kind: string; auto?: boolean }) => boolean }[] = [
  { title: 'COLLECT AN EGG', text: 'YOUR HENS LAY THROUGH THE DAY. CLICK AN EGG ON THE GROUND TO PUT IT IN YOUR CRATE.', done: (e) => e.kind === 'collected' },
  { title: 'SELL YOUR EGGS', text: 'CLICK THE CRATE BY THE PATH, OR USE THE SELL CARD. PRICES MOVE WITH HOW MANY EGGS THE WHOLE STREET SELLS.', done: (e) => e.kind === 'sold' },
  { title: 'BUY FEED', text: 'CLICK THE TROUGH. YOUR HENS EAT AT DAWN: NO FEED MEANS NO EGGS TOMORROW.', done: (e) => e.kind === 'feedBought' },
  { title: 'ANSWER A CARD', text: 'RIVALS, SUPPLIERS AND BUYERS SEND CARDS TO YOUR DESK. OPEN ONE AND ACCEPT, COUNTER OR DECLINE.', done: (e) => e.kind === 'cardResolved' && !e.auto },
];

export const GOAL_TEXT: Record<GoalId, string> = {
  collect: 'COLLECT YOUR FIRST EGGS',
  sell: 'SELL A CRATE OF EGGS',
  coop: 'FILL YOUR COOP WITH HENS',
  haggle: "WIN A HAGGLE: COUNTER A BUYER'S OFFER",
  machine: 'BUY YOUR FIRST MACHINE',
  rival: 'OUTLAST A RIVAL FARM',
};

/** The one thing the farm needs most right now, if anything. */
function hint(farm: FarmState): string | null {
  const feed = farm.feedGrams.cheap + farm.feedGrams.standard + farm.feedGrams.premium;
  const days = farm.hens.length ? feed / (farm.hens.length * feedGramsPerHenDay()) : 99;
  if (days < 1) return 'THE FEED IS RUNNING OUT: CLICK THE TROUGH TO BUY MORE.';
  const crate = farm.crate.white + farm.crate.cream + farm.crate.brown + farm.crate.golden;
  if (crate >= 30) return 'YOUR CRATE IS FILLING UP: CLICK THE CRATE TO SELL.';
  const now = dayElapsed();
  if (farm.cards.some((c) => c.status === 'open' && c.arriveAtMs <= now - 20_000)) return 'A CARD IS WAITING ON YOUR DESK: CLICK IT TO ANSWER.';
  if (groundEggs(farm) >= 6) return 'EGGS ARE PILING UP ON THE GROUND: CLICK THEM TO COLLECT.';
  if (farm.hens.length > coopCapacity(farm.coops.map((c) => c.kind))) return 'TOO MANY HENS FOR YOUR COOPS: CLICK A COOP TO BUILD OR UPGRADE.';
  return null;
}

export function Guide({ farm, send }: { farm: FarmState; send: (a: Action) => Promise<boolean> }) {
  const { audio } = useServices();
  const t = useStore(tour, (s) => s);
  const box = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);
  const [busy, setBusy] = useState(false);

  // tour steps end when the player does the thing; goals pay with a burst of coins
  useEffect(
    () =>
      events.on((e) => {
        const cur = tour.get();
        if (cur.active && STEPS[cur.step]?.done(e as { kind: string; auto?: boolean })) {
          audio.play('19-haggle-win', { volume: 0.5 });
          if (cur.step + 1 >= STEPS.length) {
            finishTour();
            uiFx.emit({ kind: 'toast', text: 'YOU KNOW THE LOOP. FOLLOW THE GOALS FOR COINS.' });
          } else tour.set({ step: cur.step + 1 });
        }
        if (e.kind === 'goalClaimed') {
          const r = box.current?.getBoundingClientRect();
          const scale = box.current ? box.current.getBoundingClientRect().width / box.current.offsetWidth : 1;
          const ui = box.current?.closest('.ui')?.getBoundingClientRect();
          if (r && ui) uiFx.emit({ kind: 'coins', from: { x: (r.left - ui.left) / scale + 40, y: (r.top - ui.top) / scale }, count: 6 });
          uiFx.emit({ kind: 'toast', text: `GOAL DONE: +${(e.rewardMilli / 1000).toFixed(0)} COINS` });
          audio.play('15-kaching');
        }
      }),
    [audio],
  );

  // hints and the egg count change with the clock, not only with server updates
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (t.active) {
    const step = STEPS[t.step] ?? STEPS[0];
    if (!step) return null;
    return (
      <div ref={box} className="guide panel" role="status" aria-label="How to play">
        <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
          <SheetSprite id="x-hen-portrait" row="talk" play="loop" zoom={1} />
          <div className="col" style={{ gap: 3, flex: 1 }}>
            <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
              {t.step + 1} OF {STEPS.length}: {step.title}
            </span>
            <span style={{ lineHeight: '10px' }}>{step.text}</span>
          </div>
          <button
            className="btn"
            onClick={() => {
              uiSound(audio, 'back');
              finishTour();
            }}
          >
            SKIP
          </button>
        </div>
      </div>
    );
  }

  const goal = farm.goals.find((g) => g.state !== 'claimed');
  const h = hint(farm);
  if (!goal && !h) return null;
  const index = goal ? farm.goals.indexOf(goal) : -1;
  return (
    <div ref={box} className="guide" role="status" aria-label="Goals and hints">
      {h && (
        <div className="hint" data-tip={h}>
          ! {h}
        </div>
      )}
      {goal && (
        <div className="goal panel">
          <div className="row spread" style={{ gap: 6 }}>
            <div className="col" style={{ gap: 3 }}>
              <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
                GOAL {index + 1} OF {farm.goals.length}
              </span>
              <span>{GOAL_TEXT[goal.id]}</span>
            </div>
            {goal.state === 'ready' ? (
              <button
                className="btn red"
                disabled={busy}
                onClick={() => {
                  uiSound(audio, 'click');
                  setBusy(true);
                  void send({ t: 'claimGoal', goal: goal.id }).finally(() => setBusy(false));
                }}
              >
                CLAIM +{(goal.rewardMilli / 1000).toFixed(0)}
              </button>
            ) : (
              <span className="chip">+{(goal.rewardMilli / 1000).toFixed(0)} COINS</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
