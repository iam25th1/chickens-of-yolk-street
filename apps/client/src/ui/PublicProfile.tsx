// A farm's public profile, for anyone: its name, its sign, its place on the street, a small row of
// its badges and a few headline numbers, read from GET /api/profile/:farmId (a whitelist the server
// keeps: no coins, orders, wallet or anything from sign-in). It opens from the farms ranking (each
// row is a FarmRankRow) and from the player's own profile (PUBLIC VIEW).
import { useEffect, useState } from 'react';
import { BADGES, type PublicProfile, type RivalRank } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { useViewport } from '../app/Stage';
import { openModal } from '../state/ui';
import { AiBadge } from './AiBadge';
import { Badge, BadgeRow, LEVEL_LABEL } from './Badge';
import { LOOK } from './cast';
import { Modal } from './Modal';
import { Paged } from './Paged';
import { SheetSprite } from './SheetSprite';

/** Opens a farm's public profile (from any ranking). */
export function openPublicProfile(farmId: string): void {
  openModal({ kind: 'publicProfile', farmId, back: null });
}

/** The sign a farm stands behind: a player's farm sign, or its rival's own. */
const signOf = (kind: PublicProfile['kind']): string => (kind === 'player' ? '17-sign-farm' : (LOOK[kind].sign ?? '17-sign-farm'));

/** One farm in a ranking: its place, name (with the AI tag), its best few badges; tapping it opens its public profile. */
export function FarmRankRow({ rank, farm, mine = false, onOpen }: { rank: number; farm: RivalRank; mine?: boolean; onOpen?: () => void }) {
  const { audio } = useServices();
  return (
    <button
      className="row spread"
      data-ui="street-farm"
      data-farm={farm.farmId}
      style={{ gap: 6, width: '100%', border: 0, padding: '1px 2px', background: mine ? '#e3cc96' : 'transparent', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer', opacity: farm.bust ? 0.6 : 1, alignItems: 'center' }}
      onClick={() => {
        uiSound(audio, 'click');
        (onOpen ?? (() => openPublicProfile(farm.farmId)))();
      }}
    >
      <span style={{ flex: '1 1 auto', minWidth: 0, lineHeight: '9px' }}>
        {rank}. {farm.name.toUpperCase()}
        {farm.kind !== 'player' && <AiBadge />}
      </span>
      <BadgeRow badges={farm.badges} max={3} />
      <span style={{ flex: 'none' }}>{farm.bust ? 'BUST' : `${farm.hens} HENS`}</span>
    </button>
  );
}

export function PublicProfileModal({ farmId, onClose }: { farmId: string; onClose: () => void }) {
  const { audio } = useServices();
  const v = useViewport();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setProfile(null);
    setFailed(false);
    fetch(`/api/profile/${encodeURIComponent(farmId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { profile: PublicProfile };
        if (live) setProfile(body.profile);
      })
      .catch(() => live && setFailed(true));
    audio.play('13-tray', { volume: 0.4 });
    return () => {
      live = false;
    };
  }, [farmId, audio]);
  const p = profile;
  const stats: [string, string | number][] = p
    ? [
        ['PLACE ON THE STREET', p.bust ? 'BUST' : p.rank ? `${p.rank} OF ${p.farms}` : '-'],
        ['DAYS ON THE STREET', p.daysOnStreet],
        ['HENS', p.hens],
        ['EGGS SOLD', p.eggsSold],
        ['HAGGLES WON', p.hagglesWon],
        ['RIVALS OUTLASTED', p.rivalsOutlasted],
        ['BADGES', `${p.badgeCount} OF ${BADGES.length}`],
      ]
    : [];
  const items = p
    ? [
        <div key="who" className="row" style={{ gap: 8, alignItems: 'flex-end' }} data-ui="public-identity">
          <SheetSprite id={signOf(p.kind)} row={p.bust ? 'tip-over' : 'sway'} play={p.bust ? 'once' : 'loop'} size={v.p} box={{ w: 52, h: 36 }} />
          <span className="col" style={{ gap: 2, minWidth: 0 }}>
            <span className="panel-title small" style={{ fontSize: 8, lineHeight: '9px', margin: 0 }} data-ui="public-name">
              {p.name.toUpperCase()}
              {p.kind !== 'player' && <AiBadge />}
            </span>
            <span style={{ lineHeight: '9px' }}>{p.kind === 'player' ? 'A PLAYER FARM' : 'AN AI FARM: AN AGENT MAKES ITS EVERY CHOICE'}</span>
          </span>
        </div>,
        <div key="stats" className="col" style={{ gap: 2 }} data-ui="public-stats">
          {stats.map(([label, value]) => (
            <div key={label} className="row spread" style={{ gap: 6 }}>
              <span>{label}</span>
              <span>{value}</span>
            </div>
          ))}
        </div>,
        <div key="badges" className="col" style={{ gap: 3 }} data-ui="public-badges">
          <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
            BADGES
          </span>
          {p.badges.length ? (
            <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
              {p.badges.slice(0, 6).map((b) => (
                <span key={b.id} title={`${BADGES.find((x) => x.id === b.id)?.name ?? b.id} (${LEVEL_LABEL[b.level]})`}>
                  <Badge id={b.id} level={b.level} />
                </span>
              ))}
            </span>
          ) : (
            <span>{p.kind === 'player' ? 'NONE YET.' : 'AI FARMS DO NOT EARN BADGES.'}</span>
          )}
        </div>,
      ]
    : [<span key="wait">{failed ? 'THIS FARM COULD NOT BE FOUND.' : 'WALKING OVER TO THEIR FARM'}</span>];
  return (
    <Modal title="FARM PROFILE" onClose={onClose} w={320} h={300}>
      <div data-ui="public-profile" data-farm={farmId} data-loaded={p ? '1' : '0'}>
        <Paged gap={6} items={items} ui="public-pages" />
      </div>
    </Modal>
  );
}
