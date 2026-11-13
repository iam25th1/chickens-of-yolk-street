// A badge: its frame (the tier's row of x-badge-frames, or the locked row) with its icon from
// x-badge-icons drawn on top, centred (8,8 art pixels in), both at the same whole zoom. A locked badge
// shows the locked frame and its icon dimmed; a secret badge not yet earned shows the mystery icon.
// The frame's frames 1 to 3 are a glint, played once for the unlock moment. Until the badge sheets
// are packed nothing is drawn but a plain square in the tier's colour, so layouts hold their size.
import { useEffect, useState } from 'react';
import { BADGE_BY_ID, BADGE_FRAME_SHEET, BADGE_ICON_SHEET, type BadgeDef, type BadgeLevel, type BadgeMark } from '@coys/shared';
import { useServices } from '../app/services';
import { SheetSprite } from './SheetSprite';

/** Badge frames and icons, in art pixels. */
const FRAME = 32;
const ICON = 16;

export const LEVEL_LABEL: Record<BadgeLevel, string> = { bronze: 'BRONZE', silver: 'SILVER', gold: 'GOLD', plain: 'EARNED' };
/** The tiers' colours (UI, for the plain stand-in and the small row's bar). */
export const LEVEL_COLOUR: Record<BadgeLevel | 'locked', string> = { bronze: '#b8743a', silver: '#a9a296', gold: '#f2c94c', plain: '#5c9e3a', locked: '#8b5a2b' };

/** Re-renders when the asset store loads more art (the badge sheets may arrive after the page). */
function useArt(): (id: string) => boolean {
  const { assets } = useServices();
  const [, bump] = useState(0);
  useEffect(() => assets.onChange(() => bump((n) => n + 1)), [assets]);
  return (id) => assets.has(id);
}

export function Badge({
  id,
  level,
  zoom = 1,
  glint = false,
  onGlintDone,
  ui,
}: {
  id: string;
  /** The level held; null for a locked badge. */
  level: BadgeLevel | null;
  /** UI pixels per art pixel (whole). */
  zoom?: number;
  /** Plays the frame's glint once (the unlock moment). */
  glint?: boolean;
  onGlintDone?: () => void;
  ui?: string;
}) {
  const has = useArt();
  const def: BadgeDef | undefined = BADGE_BY_ID.get(id);
  const z = Math.max(1, Math.round(zoom));
  const size = FRAME * z;
  const earned = level !== null;
  const secret = !earned && (def?.secret ?? false);
  const icon = secret ? 'mystery' : (def?.icon ?? 'mystery');
  const art = has(BADGE_FRAME_SHEET) && has(BADGE_ICON_SHEET);
  return (
    <span
      className="badge"
      data-ui={ui}
      data-badge={id}
      data-level={level ?? 'locked'}
      aria-label={secret ? 'A secret badge' : `${def?.name ?? id}${earned ? `, ${LEVEL_LABEL[level]}` : ', locked'}`}
      style={{ position: 'relative', display: 'inline-block', width: size, height: size, flex: 'none' }}
    >
      {art ? (
        <>
          <SheetSprite id={BADGE_FRAME_SHEET} row={level ?? 'locked'} frame={0} play={glint ? 'once' : false} onDone={onGlintDone} zoom={z} style={{ position: 'absolute', left: 0, top: 0 }} />
          <SheetSprite id={BADGE_ICON_SHEET} row={icon} zoom={z} style={{ position: 'absolute', left: ((FRAME - ICON) / 2) * z, top: ((FRAME - ICON) / 2) * z, opacity: earned ? 1 : 0.4 }} />
        </>
      ) : (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 2 * z,
            background: earned ? '#f6e7c1' : '#e3cc96',
            boxShadow: `0 0 0 ${z}px #2a160c, inset 0 0 0 ${2 * z}px ${LEVEL_COLOUR[level ?? 'locked']}`,
            opacity: earned ? 1 : 0.6,
          }}
        />
      )}
    </span>
  );
}

/**
 * The profile's icon for the top bar (16 art pixels, as the bar's other icons): the badge icons'
 * rank, or a small medal drawn in the UI's colours until the badge sheets are packed.
 */
export function ProfileIcon() {
  const has = useArt();
  if (has(BADGE_ICON_SHEET)) return <SheetSprite id={BADGE_ICON_SHEET} row="rank" zoom={1} />;
  return (
    <span aria-hidden="true" style={{ position: 'relative', display: 'inline-block', width: ICON, height: ICON, flex: 'none' }}>
      <span style={{ position: 'absolute', left: 5, top: 1, width: 2, height: 5, background: '#b8321f' }} />
      <span style={{ position: 'absolute', left: 9, top: 1, width: 2, height: 5, background: '#2f6f9e' }} />
      <span style={{ position: 'absolute', left: 4, top: 6, width: 8, height: 8, background: '#f2c94c', boxShadow: '0 0 0 1px #2a160c' }} />
    </span>
  );
}

/** A farm's best few badges in a small row: icons only (16 art pixels), each over a bar in its tier's colour. */
export function BadgeRow({ badges, max = 3, ui }: { badges: BadgeMark[]; max?: number; ui?: string }) {
  const has = useArt();
  const art = has(BADGE_ICON_SHEET);
  if (!badges.length) return null;
  return (
    <span className="row" style={{ gap: 2, flex: 'none', alignItems: 'flex-end' }} data-ui={ui}>
      {badges.slice(0, max).map((b) => {
        const def = BADGE_BY_ID.get(b.id);
        return (
          <span key={b.id} className="col" style={{ gap: 1, alignItems: 'center' }} data-badge={b.id} data-level={b.level} title={def ? `${def.name} (${LEVEL_LABEL[b.level]})` : b.id}>
            {art ? <SheetSprite id={BADGE_ICON_SHEET} row={def?.icon ?? 'mystery'} zoom={1} /> : <span style={{ width: ICON - 2, height: ICON - 2, margin: 1, display: 'block', background: '#f6e7c1', boxShadow: '0 0 0 1px #2a160c' }} />}
            <span style={{ width: ICON, height: 2, display: 'block', background: LEVEL_COLOUR[b.level] }} />
          </span>
        );
      })}
    </span>
  );
}
