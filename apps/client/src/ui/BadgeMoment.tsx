// The badge unlock moment: when the server says a badge (or a higher level of one) is earned, it pops
// in at the top of the farm: the badge slams down (a stamp, a beat of hitstop and a small shake, which
// reduce motion turns off), its frame glints once, and a win sting plays, with its name, level and
// what earned it. Unlocks queue: one moment at a time, each for a few seconds (shorter while more
// wait). It only shows: clicks pass through it, so it never stands in the way of what is under it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { BADGE_BY_ID, badgeText, type BadgeLevel } from '@coys/shared';
import { useServices } from '../app/services';
import { useViewport } from '../app/Stage';
import { juice } from '../motion/juice';
import { motion } from '../motion/ui';
import { events } from '../state/game';
import { Badge, LEVEL_LABEL } from './Badge';

interface Earned {
  key: number;
  badge: string;
  level: BadgeLevel;
}

/** How long a moment stays (ms; shorter while others wait), and the pause before the next. */
const SHOW_MS = 3000;
const QUEUED_MS = 1600;
const GAP_MS = 250;

export function BadgeMoments() {
  const { audio } = useServices();
  const v = useViewport();
  const queue = useRef<Earned[]>([]);
  const seq = useRef(0);
  const [now, setNow] = useState<Earned | null>(null);
  const [glint, setGlint] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const stamp = useRef<HTMLSpanElement>(null);
  const busy = useRef(false);

  const next = useCallback(() => {
    const e = queue.current.shift() ?? null;
    busy.current = e !== null;
    setGlint(false);
    setNow(e);
  }, []);

  useEffect(
    () =>
      events.on((e) => {
        if (e.kind !== 'badgeEarned' || !BADGE_BY_ID.has(e.badge)) return;
        queue.current.push({ key: ++seq.current, badge: e.badge, level: e.level });
        if (!busy.current) next();
      }),
    [next],
  );

  // the moment: in, the slam with its thump, the glint and the sting, then out and the next one
  useEffect(() => {
    if (!now) return;
    if (panel.current) motion.enter(panel.current);
    const timers = [
      setTimeout(() => {
        if (stamp.current) motion.pop(stamp.current, 3);
        audio.play('18-stamp');
      }, 120),
      setTimeout(() => {
        juice.hitstop(70);
        juice.shake(3, 220);
        setGlint(true);
        audio.play('19-haggle-win', { volume: 0.7 });
      }, 300),
      setTimeout(
        () => {
          if (panel.current) motion.leave(panel.current, () => setTimeout(next, GAP_MS));
          else next();
        },
        queue.current.length ? QUEUED_MS : SHOW_MS,
      ),
    ];
    return () => timers.forEach(clearTimeout);
  }, [now, audio, next]);

  if (!now) return null;
  const def = BADGE_BY_ID.get(now.badge);
  if (!def) return null;
  const world = v.zones.world;
  const width = Math.min(280, Math.floor(world.w) - 12);
  return (
    <div
      ref={panel}
      key={now.key}
      className="panel zone"
      role="status"
      data-ui="badge-moment"
      data-badge={now.badge}
      data-level={now.level}
      style={{ left: Math.round(world.x + (world.w - width) / 2), top: world.y + 6, width, zIndex: 45, padding: 7, boxSizing: 'border-box', pointerEvents: 'none' }}
    >
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <span ref={stamp} style={{ display: 'inline-block', flex: 'none' }}>
          <Badge id={now.badge} level={now.level} zoom={2} glint={glint} onGlintDone={() => setGlint(false)} ui="badge-moment-badge" />
        </span>
        <span className="col" style={{ gap: 2, minWidth: 0, flex: 1 }}>
          <span className="panel-title small" style={{ fontSize: 8, lineHeight: '9px', margin: 0, color: '#b8321f' }}>
            BADGE EARNED
          </span>
          <span style={{ lineHeight: '9px' }} data-ui="badge-moment-name">
            {def.name}: {LEVEL_LABEL[now.level]}
          </span>
          <span style={{ lineHeight: '9px' }}>{badgeText(def, now.level)}</span>
        </span>
      </div>
    </div>
  );
}
