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
import { ANNOUNCE_WAIT_MS, AnnounceToast, announcements } from './Announce';
import { drawnToasts, toasts, uiFx } from './FxLayer';
import { groundEggs } from './Hud';

export const GOAL_TEXT: Record<GoalId, string> = {
  collect: 'COLLECT YOUR FIRST EGGS',
  sell: 'SELL A CRATE OF EGGS',
  coop: 'FILL YOUR COOP WITH HENS',
  haggle: "WIN A HAGGLE: COUNTER A BUYER'S OFFER",
  machine: 'BUY YOUR FIRST MACHINE',
  rival: 'OUTLAST A RIVAL FARM',
};

/** Where a warning points on the farm: the thing to tap (its card fixes the cause). */
export type WarnTarget = { kind: 'feed' } | { kind: 'crate' } | { kind: 'machine'; unlock: UnlockId } | { kind: 'coop'; coopId: string };

export interface Warning {
  /** Stable while the cause lasts (a new key is new news). */
  key: string;
  text: string;
  /** The farm object it belongs to; none: the toast corner says it once. */
  target: WarnTarget | null;
}

/**
 * What the farm needs now. A warning tied to something on the farm shows as a small "!" bubble over
 * it (ui/WarnBubbles.tsx), gone as soon as the cause is fixed; the others are said once in the toast
 * corner. Nothing is drawn across the farm.
 */
export function warnings(farm: FarmState): Warning[] {
  const out: Warning[] = [];
  const feed = farm.feedGrams.cheap + farm.feedGrams.standard + farm.feedGrams.premium;
  const days = farm.hens.length ? feed / (farm.hens.length * feedGramsPerHenDay()) : 99;
  if (days < 1) out.push({ key: 'feed', text: 'FEED IS RUNNING OUT: TAP THE TROUGH TO BUY MORE.', target: { kind: 'feed' } });
  const machines = Object.entries(farm.machineState ?? {}) as [UnlockId, MachineView][];
  for (const [unlock, m] of machines) {
    if (m.broken) out.push({ key: `broken-${unlock}`, text: `YOUR ${MACHINE_NAME[unlock]} BROKE DOWN: TAP IT TO REPAIR IT.`, target: { kind: 'machine', unlock } });
    else if (m.condition < ECONOMY.wear.hintBelow) out.push({ key: `worn-${unlock}`, text: `YOUR ${MACHINE_NAME[unlock]} IS WORN (${Math.round(m.condition * 100)}%): REPAIR IT FROM ITS CARD.`, target: { kind: 'machine', unlock } });
  }
  const crate = farm.crate.white + farm.crate.cream + farm.crate.brown + farm.crate.golden;
  if (crate >= 30) out.push({ key: 'crate', text: 'YOUR CRATE IS FILLING UP: SELL IT FROM THE CRATE CARD.', target: { kind: 'crate' } });
  const coop = farm.coops[0];
  if (coop && farm.hens.length > coopCapacity(farm.coops.map((c) => c.kind))) out.push({ key: 'coop', text: 'TOO MANY HENS FOR YOUR COOPS: TAP A COOP TO BUILD MORE ROOM.', target: { kind: 'coop', coopId: coop.id } });
  const now = dayElapsed();
  if (farm.cards.some((c) => c.status === 'open' && c.arriveAtMs <= now - 20_000)) out.push({ key: 'card', text: 'A CARD IS WAITING: OPEN IT FROM THE CARD LIST.', target: null });
  if (groundEggs(farm) >= 6) out.push({ key: 'eggs', text: 'EGGS ARE PILING UP: TAP THEM TO COLLECT.', target: null });
  return out;
}

/** The farm's most pressing warning, if any (for tests and the guide's text). */
export function hint(farm: FarmState): string | null {
  return warnings(farm)[0]?.text ?? null;
}

/** Hints and news, newest nearest the tracker: whole messages (wrapped, never cut), as many as fit. */
export function ToastArea({ farm, rect, offline = false, covered = false }: { farm: FarmState; rect: Rect; offline?: boolean; covered?: boolean }) {
  const list = useStore(toasts, (s) => s.list);
  // a badge or milestone announcement takes the corner when no news waits, or once it has waited
  // ANNOUNCE_WAIT_MS (news first, but neither starves); it waits while a full page covers the corner
  const showing = useStore(announcements, (s) => s.queue[0] ?? null);
  const since = useStore(announcements, (s) => s.since);
  const [shownKey, setShownKey] = useState<number | null>(null);
  const turn = showing !== null && (shownKey === showing.key || list.length === 0 || Date.now() - since >= ANNOUNCE_WAIT_MS);
  const now = covered || !turn ? null : showing;
  useEffect(() => setShownKey(now?.key ?? null), [now?.key]);
  const [, tick] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  // hints change with the clock, not only with server updates
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  // reconnecting is a line in the corner (nothing is drawn across the farm); the other warnings are
  // bubbles on the farm or said once as news (below)
  const h = now ? null : offline ? 'RECONNECTING TO THE MARKET' : null;
  const said = useRef(new Set<string>());
  const loose = warnings(farm)
    .filter((w) => !w.target)
    .map((w) => w.key)
    .join(',');
  useEffect(() => {
    const keys = new Set(loose ? loose.split(',') : []);
    for (const w of warnings(farm)) if (!w.target && !said.current.has(w.key)) uiFx.emit({ kind: 'toast', text: w.text, tone: 'bad' });
    said.current = keys;
    // said once each time the cause appears
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loose]);
  // the announcement's two lines take the corner while it shows
  const lines = now ? 0 : Math.max(1, Math.floor((rect.h + 2) / 16));
  const [fit, setFit] = useState(lines);
  const room = Math.max(0, Math.min(fit, lines) - (h ? 1 : 0));
  const shown = room ? list.slice(-room) : [];
  // news counts its time only while it is drawn
  useEffect(() => {
    drawnToasts.clear();
    for (const t of shown) drawnToasts.add(t.id);
  });
  useEffect(() => () => drawnToasts.clear(), []);
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
        <div className="toast bad" role="status" data-ui="toast" title={h}>
          {h}
        </div>
      )}
    </div>
  );
}

export function Tracker({ farm, rect, send }: { farm: FarmState; rect: Rect; send: (a: Action) => Promise<boolean> }) {
  const farmRef = useRef(farm);
  farmRef.current = farm;
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
        // the last goal: said once, and the tracker goes for good
        if (!farmRef.current.goals.some((g) => g.state !== 'claimed' && g.id !== e.goal)) {
          uiFx.emit({ kind: 'toast', tone: 'good', text: 'EVERY GOAL DONE. KEEP YOUR FARM ON TOP OF THE STREET.' });
        }
      }),
    [audio, rect.x, rect.y],
  );

  const goal = farm.goals.find((g) => g.state !== 'claimed');
  const index = goal ? farm.goals.indexOf(goal) : -1;
  // every goal done: no bar (the last claim said so once, as news)
  if (!goal) return null;
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
