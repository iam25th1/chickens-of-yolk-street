// Badge and milestone announcements: small toasts in the toast corner (the band above the goal
// tracker), the one place no card, tour step or panel ever covers at any window size. One line of
// title and one short line, the badge (or the ticket) at its small size. They never block input: only
// the toast itself takes a tap, which opens the profile on the badges (or the mint) tab. One at a
// time, each about 3.5 s (the clock stops while the pointer is on it), sliding in and settling with
// anime.js; while a full page covers the corner they wait.
import { useEffect, useRef, useState } from 'react';
import { BADGE_BY_ID, ECONOMY, type BadgeLevel, type MilestoneId } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { animate } from 'animejs';
import { events } from '../state/game';
import { createStore } from '../state/store';
import { openModal, type ProfileTab } from '../state/ui';
import { LEVEL_COLOUR, LEVEL_LABEL } from './Badge';
import { SheetSprite } from './SheetSprite';

export interface Announcement {
  key: number;
  kind: 'badge' | 'milestone';
  title: string;
  line: string;
  badge?: { id: string; level: BadgeLevel; icon: string };
  /** The profile tab a tap opens. */
  tab: ProfileTab;
}

/** How long one shows (ms, while not hovered), and the pause before the next. */
export const ANNOUNCE_MS = 3500;
const GAP_MS = 250;

/** Short milestone names, for a toast's one-line title. */
export const MILESTONE_SHORT: Record<MilestoneId, string> = {
  'full-coop': 'FULL COOPS',
  'good-week': `${ECONOMY.feathers.goodDays} GOOD DAYS`,
  'eggs-sold': `${ECONOMY.feathers.eggsSold} EGGS SOLD`,
  'haggles-won': `${ECONOMY.feathers.hagglesWon} HAGGLES WON`,
  'all-machines': 'ALL FIVE MACHINES',
  'outlast-rival': 'OUTLASTED A RIVAL',
  'top-three': `A TOP ${ECONOMY.feathers.topRank} FARM`,
};

/** The queue: the one showing first. */
export const announcements = createStore<{ queue: Announcement[] }>({ queue: [] });
let seq = 0;

export function announce(a: Omit<Announcement, 'key'>): void {
  announcements.set((s) => ({ queue: [...s.queue, { ...a, key: ++seq }] }));
}

const done = (key: number) => announcements.set((s) => ({ queue: s.queue.filter((a) => a.key !== key) }));

/** Badges earned and milestone rolls become announcements (the farm screen listens while it is open). */
export function listenForAnnouncements(): () => void {
  return events.on((e) => {
    if (e.kind === 'badgeEarned') {
      const def = BADGE_BY_ID.get(e.badge);
      if (!def) return;
      announce({ kind: 'badge', title: `BADGE: ${def.name}`, line: `${LEVEL_LABEL[e.level]}. TAP TO SEE YOUR BADGES`, badge: { id: e.badge, level: e.level, icon: def.icon }, tab: 'badges' });
    } else if (e.kind === 'milestoneRoll') {
      announce({
        kind: 'milestone',
        title: `MILESTONE: ${MILESTONE_SHORT[e.milestone]}`,
        line: e.won ? `FEATHER TICKET WON. ${e.left} OF ${ECONOMY.feathers.maxSupply} LEFT` : `NO TICKET THIS TIME (${Math.round(e.odds * 100)}% A ROLL)`,
        tab: 'mint',
      });
    }
  });
}

/** The toast showing now, in the toast corner (drawn by the toast area, above its text toasts). */
export function AnnounceToast({ a }: { a: Announcement }) {
  const { audio } = useServices();
  const el = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false);
  const left = useRef(ANNOUNCE_MS);

  // in: a short slide from the left that settles (nothing flashy), and a quiet chime
  useEffect(() => {
    if (el.current) animate(el.current, { translateX: [-14, 0], opacity: [0, 1], duration: 260, ease: 'outBack(1.2)' });
    audio.play(a.kind === 'badge' ? '18-stamp' : '17-card', { volume: 0.35 });
  }, [a.key, audio, a.kind]);

  // the clock runs only while the pointer is off it; then out, and the next
  useEffect(() => {
    if (hover) return;
    const started = Date.now();
    const t = setTimeout(() => {
      const node = el.current;
      if (!node) return done(a.key);
      animate(node, { translateX: [0, -10], opacity: [1, 0], duration: 200, ease: 'inQuad', onComplete: () => setTimeout(() => done(a.key), GAP_MS) });
    }, left.current);
    return () => {
      clearTimeout(t);
      left.current = Math.max(400, left.current - (Date.now() - started));
    };
  }, [hover, a.key]);

  return (
    <button
      ref={el}
      key={a.key}
      className="announce"
      data-ui="announce"
      data-kind={a.kind}
      data-badge={a.badge?.id}
      role="status"
      title={`${a.title}. ${a.line}`}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={() => {
        uiSound(audio, 'click');
        done(a.key);
        openModal({ kind: 'profile', tab: a.tab });
      }}
    >
      {/* the badge's icon at its small size, ringed in its tier's colour (the ticket for a milestone) */}
      <span className="announce-icon" aria-hidden="true" style={{ boxShadow: `0 0 0 1px var(--ink), 0 0 0 2px ${a.badge ? LEVEL_COLOUR[a.badge.level] : LEVEL_COLOUR.gold}` }}>
        <SheetSprite id="x-badge-icons" row={a.badge?.icon ?? 'ticket'} zoom={1} />
      </span>
      <span className="col" style={{ gap: 2, minWidth: 0, alignItems: 'flex-start' }}>
        <span className="announce-title" data-ui="announce-title">
          {a.title}
        </span>
        <span className="announce-line">{a.line}</span>
      </span>
    </button>
  );
}
