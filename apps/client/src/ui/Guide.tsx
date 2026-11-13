// The guide zone, bottom left: the goal tracker on one line (each goal pays coins when claimed) and,
// stacked above it, the toast area: the one hint the farm needs most right now, then the news. While
// the tour runs, its step box takes the whole zone instead.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { coopCapacity, feedGramsPerHenDay, type FarmState, type GoalId } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import type { Rect } from '../app/viewport';
import type { Action } from '../net/socket';
import { dayElapsed, events } from '../state/game';
import { useStore } from '../state/store';
import { tour } from '../state/tour';
import { toasts, uiFx } from './FxLayer';
import { groundEggs } from './Hud';

export const GOAL_TEXT: Record<GoalId, string> = {
  collect: 'COLLECT YOUR FIRST EGGS',
  sell: 'SELL A CRATE OF EGGS',
  coop: 'FILL YOUR COOP WITH HENS',
  haggle: "WIN A HAGGLE: COUNTER A BUYER'S OFFER",
  machine: 'BUY YOUR FIRST MACHINE',
  rival: 'OUTLAST A RIVAL FARM',
};

/** The one thing the farm needs most right now, if anything. */
export function hint(farm: FarmState): string | null {
  const feed = farm.feedGrams.cheap + farm.feedGrams.standard + farm.feedGrams.premium;
  const days = farm.hens.length ? feed / (farm.hens.length * feedGramsPerHenDay()) : 99;
  if (days < 1) return 'FEED IS RUNNING OUT: TAP THE TROUGH TO BUY MORE.';
  const crate = farm.crate.white + farm.crate.cream + farm.crate.brown + farm.crate.golden;
  if (crate >= 30) return 'YOUR CRATE IS FILLING UP: SELL IT FROM THE CRATE CARD.';
  const now = dayElapsed();
  if (farm.cards.some((c) => c.status === 'open' && c.arriveAtMs <= now - 20_000)) return 'A CARD IS WAITING: OPEN IT FROM THE CARD LIST.';
  if (groundEggs(farm) >= 6) return 'EGGS ARE PILING UP: TAP THEM TO COLLECT.';
  if (farm.hens.length > coopCapacity(farm.coops.map((c) => c.kind))) return 'TOO MANY HENS FOR YOUR COOPS: TAP A COOP TO BUILD MORE ROOM.';
  return null;
}

/** Hints and news, newest nearest the tracker: whole messages (wrapped, never cut), as many as fit. */
export function ToastArea({ farm, rect, offline = false }: { farm: FarmState; rect: Rect; offline?: boolean }) {
  const list = useStore(toasts, (s) => s.list);
  const [, tick] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  // hints change with the clock, not only with server updates
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const h = offline ? 'RECONNECTING TO THE MARKET' : hint(farm);
  const lines = Math.max(1, Math.floor((rect.h + 2) / 16));
  const [fit, setFit] = useState(lines);
  const room = Math.max(0, Math.min(fit, lines) - (h ? 1 : 0));
  const shown = room ? list.slice(-room) : [];
  // a long message wraps and takes more room: keep only the newest that fit the zone (and try them
  // all again when a message comes or the zone changes)
  const newest = list[list.length - 1]?.id;
  useLayoutEffect(() => setFit(lines), [newest, lines, rect.w, h]);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight > el.clientHeight + 1 && fit > 1) setFit(fit - 1);
  }, [fit, newest, lines, rect.w, h]);
  return (
    <div ref={box} className="toasts zone" data-ui="toasts" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      {[...shown].reverse().map((t) => (
        <div key={t.id} className={`toast ${t.tone === 'bad' ? 'bad' : ''}`} role="status" data-ui="toast" title={t.text}>
          {t.text}
        </div>
      ))}
      {h && (
        <div className="hint" data-ui="toast" title={h}>
          ! {h}
        </div>
      )}
    </div>
  );
}

export function Tracker({ farm, rect, send }: { farm: FarmState; rect: Rect; send: (a: Action) => Promise<boolean> }) {
  const { audio } = useServices();
  const box = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const active = useStore(tour, (s) => s.active);

  useEffect(
    () =>
      events.on((e) => {
        if (e.kind !== 'goalClaimed') return;
        uiFx.emit({ kind: 'coins', from: { x: rect.x + 60, y: rect.y }, count: 6 });
        uiFx.emit({ kind: 'toast', text: `GOAL DONE: +${(e.rewardMilli / 1000).toFixed(0)} COINS` });
        audio.play('15-kaching');
      }),
    [audio, rect.x, rect.y],
  );

  if (active) return null;
  const goal = farm.goals.find((g) => g.state !== 'claimed');
  const index = goal ? farm.goals.indexOf(goal) : -1;
  return (
    <div ref={box} className="tracker zone" data-ui="tracker" role="status" aria-label="Goal" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      {goal ? (
        <>
          <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
            GOAL {index + 1}/{farm.goals.length}
          </span>
          <span className="goal-text" title={GOAL_TEXT[goal.id]}>
            {GOAL_TEXT[goal.id]}
          </span>
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
            <span className="chip">+{(goal.rewardMilli / 1000).toFixed(0)}</span>
          )}
        </>
      ) : (
        <span className="goal-text">EVERY GOAL DONE. KEEP YOUR FARM ON TOP OF THE STREET.</span>
      )}
    </div>
  );
}
