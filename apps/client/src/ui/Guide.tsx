// The guide zone, bottom left: the goal tracker on one line (each goal pays coins when claimed) and,
// stacked above it, the toast area: the one hint the farm needs most right now, then the news. The
// tour's step box keeps clear of both.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ECONOMY, coopCapacity, feedGramsPerHenDay, type FarmState, type GoalId, type MachineView, type UnlockId } from '@coys/shared';
import { MACHINE_NAME } from '../pixi/farm/FarmScene';
import { uiSound, useServices } from '../app/services';
import type { Rect } from '../app/viewport';
import type { Action } from '../net/socket';
import { dayElapsed, events } from '../state/game';
import { useStore } from '../state/store';
import { AnnounceToast, announcements } from './Announce';
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
  // a broken machine first, then the most worn one under the hint line
  const machines = Object.entries(farm.machineState ?? {}) as [UnlockId, MachineView][];
  const broken = machines.find(([, m]) => m.broken);
  if (broken) return `YOUR ${MACHINE_NAME[broken[0]]} BROKE DOWN: TAP IT TO REPAIR IT.`;
  const worn = machines.filter(([, m]) => m.condition < ECONOMY.wear.hintBelow).sort((a, b) => a[1].condition - b[1].condition)[0];
  if (worn) return `YOUR ${MACHINE_NAME[worn[0]]} IS WORN (${Math.round(worn[1].condition * 100)}%): REPAIR IT FROM ITS CARD.`;
  const crate = farm.crate.white + farm.crate.cream + farm.crate.brown + farm.crate.golden;
  if (crate >= 30) return 'YOUR CRATE IS FILLING UP: SELL IT FROM THE CRATE CARD.';
  const now = dayElapsed();
  if (farm.cards.some((c) => c.status === 'open' && c.arriveAtMs <= now - 20_000)) return 'A CARD IS WAITING: OPEN IT FROM THE CARD LIST.';
  if (groundEggs(farm) >= 6) return 'EGGS ARE PILING UP: TAP THEM TO COLLECT.';
  if (farm.hens.length > coopCapacity(farm.coops.map((c) => c.kind))) return 'TOO MANY HENS FOR YOUR COOPS: TAP A COOP TO BUILD MORE ROOM.';
  return null;
}

/** Hints and news, newest nearest the tracker: whole messages (wrapped, never cut), as many as fit. */
export function ToastArea({ farm, rect, offline = false, covered = false }: { farm: FarmState; rect: Rect; offline?: boolean; covered?: boolean }) {
  const list = useStore(toasts, (s) => s.list);
  // a badge or milestone announcement takes the corner first (it waits while a full page covers it)
  const showing = useStore(announcements, (s) => s.queue[0] ?? null);
  const now = covered ? null : showing;
  const [, tick] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  // hints change with the clock, not only with server updates
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const h = now ? null : offline ? 'RECONNECTING TO THE MARKET' : hint(farm);
  // the announcement's two lines take the corner while it shows
  const lines = now ? 0 : Math.max(1, Math.floor((rect.h + 2) / 16));
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
      {now && <AnnounceToast key={now.key} a={now} />}
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
