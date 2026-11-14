// The player's profile: a page of its own over the farm (like the Feather Mint), private to the
// player, in tabs: OVERVIEW (the farm, its sign, days played, coins, net worth, rank and its history,
// good standing, and the street's farms, each opening its public profile), EGGS (laid, collected,
// broken and sold, by grade, with a chart), MONEY (coins in and out by kind, profit each day, the best
// and worst day), FLOCK (the hens, their looks, laying and ages), MACHINES (condition, effect, work,
// repairs and breakdowns), MARKET (contracts, haggles, orders, share, rivals outlasted), MINT (tickets,
// Feathers and milestones) and BADGES (earned and locked; secret ones hidden until earned). Every tab
// fits the window at every size: its blocks are paged, never scrolled.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TOUR_BAND, useCardRect } from '../state/overlays';
import { tour } from '../state/tour';
import { useStore } from '../state/store';
import {
  BADGES,
  BADGE_BY_ID,
  BADGE_CATEGORIES,
  BADGE_RULES,
  ECONOMY,
  EGG_GRADES,
  FEATHER_GRADES,
  UNLOCK_IDS,
  badgeText,
  coopCapacity,
  crowdingFactor,
  henLayingRate,
  nextLevel,
  thresholdOf,
  type BadgeCategory,
  type BadgeView,
  type FarmState,
  type MarketState,
  type ProfileData,
} from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { useViewport } from '../app/Stage';
import { motion } from '../motion/ui';
import { PROFILE_TABS, uiEvents, type ProfileTab } from '../state/ui';
import { Badge, BadgeRow, LEVEL_LABEL } from './Badge';
import { BarChart, LineChart, PALETTE, SignedChart } from './Charts';
import { GRADE_LABEL, featherNo } from './Feathers';
import { MILESTONE_TEXT } from './HowToPlay';
import { Paged } from './Paged';
import { UNLOCK_TEXT } from './Panels';
import { FarmRankRow } from './PublicProfile';
import { SheetSprite } from './SheetSprite';

const coins = (milli: number): string => (milli / 1000).toFixed(2);
const whole = (milli: number): string => String(Math.round(milli / 1000));
const pct = (x: number): string => `${Math.round(x * 100)}%`;

export const PROFILE_TAB_LABEL: Record<ProfileTab, string> = {
  overview: 'OVERVIEW',
  eggs: 'EGGS',
  money: 'MONEY',
  flock: 'FLOCK',
  machines: 'MACHINES',
  market: 'MARKET',
  mint: 'MINT',
  badges: 'BADGES',
};

const CATEGORY_LABEL: Record<BadgeCategory, string> = {
  eggs: 'EGGS',
  market: 'MARKET',
  haggling: 'HAGGLING',
  contracts: 'CONTRACTS',
  flock: 'FLOCK',
  machines: 'MACHINES',
  rivals: 'RIVALS',
  feathers: 'FEATHERS',
  days: 'DAYS',
  fun: 'FUN',
};

/** Ledger kinds by name; the ones every farm has come first in the money tab. */
const KIND_LABEL: Record<string, string> = {
  sale: 'EGG SALES',
  goal: 'GOAL REWARDS',
  'hens sold': 'HENS SOLD',
  feed: 'FEED',
  hens: 'HENS',
  coop: 'COOPS',
  unlock: 'MACHINES',
  land: 'LAND',
  repair: 'REPAIRS',
  'feather-fee': 'MINT FEES',
  penalty: 'PENALTIES',
  'credit repaid': 'FEED CREDIT',
  purchase: 'EGGS BOUGHT',
};
const COST_KINDS = ['feed', 'hens', 'coop', 'unlock', 'repair', 'feather-fee'];

const h3 = (text: string, ui?: string) => (
  <h3 className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }} data-ui={ui}>
    {text}
  </h3>
);

function Stat({ label, value, tone, ui }: { label: string; value: ReactNode; tone?: 'up' | 'down'; ui?: string }) {
  return (
    <div className="row spread" style={{ gap: 6, alignItems: 'flex-start' }} data-ui={ui}>
      <span style={{ flex: '1 1 auto', minWidth: 0, lineHeight: '9px' }}>{label}</span>
      <span className={tone} style={{ flex: 'none', lineHeight: '9px', textAlign: 'right' }}>
        {value}
      </span>
    </div>
  );
}

/** A titled block of lines, one paged item. */
function Block({ title, children, ui }: { title: string; children: ReactNode; ui?: string }) {
  return (
    <section className="col" style={{ gap: 2 }} data-ui={ui}>
      {h3(title)}
      {children}
    </section>
  );
}

const dayRange = (p: ProfileData): { first?: string; last?: string } => {
  const a = p.days[0];
  const b = p.days.at(-1);
  return a && b ? { first: `DAY ${a.day}`, last: `DAY ${b.day}` } : {};
};

export function ProfilePage({
  farm,
  market,
  profile,
  tab,
  onTab,
  onPublic,
  onMint,
  onClose,
  onSave,
}: {
  farm: FarmState;
  market: MarketState;
  /** The profile as last sent (null while the first one is on its way). */
  profile: ProfileData | null;
  tab: ProfileTab;
  onTab: (t: ProfileTab) => void;
  /** Opens a farm's public profile (this farm's own, or one from the street). */
  onPublic: (farmId: string) => void;
  onMint: () => void;
  onClose: () => void;
  /** A guest farm: sign in to save it. */
  onSave?: () => void;
}) {
  const { audio } = useServices();
  const v = useViewport();
  const wide = !v.portrait;
  // a full page to the overlay manager: while the tour is on it keeps a band free at its foot, where
  // the tour's strip sits (it is laid out that way from the start, so nothing has to shrink)
  const page = useRef<HTMLDivElement>(null);
  useCardRect(page, 'page');
  const dock = useStore(tour, (s) => (s.active ? TOUR_BAND : 0));
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-ui="profile-page"]');
    if (el) motion.enter(el);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const click = (fn: () => void) => () => {
    uiSound(audio, 'click');
    fn();
  };

  const p = profile && profile.farmId === farm.farmId ? profile : null;
  const content = p ? tabContent(tab, p, farm, market, onPublic, onMint, wide) : null;
  return (
    <div
      className="panel"
      data-ui="profile-page"
      data-tab={tab}
      ref={page}
      style={{ left: 4, top: 4, width: v.uiW - 8, height: v.uiH - 8 - dock, display: 'flex', flexDirection: 'column', gap: 4, boxSizing: 'border-box', padding: 7, zIndex: 30 }}
    >
      <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 className="panel-title" style={{ margin: 0, flex: '1 1 160px', minWidth: 0, overflowWrap: 'anywhere' }} data-ui="profile-name">
          {farm.name.toUpperCase()}
        </h2>
        {farm.guest && onSave && (
          <button className="btn red" data-ui="profile-save" onClick={click(onSave)}>
            SAVE THIS FARM
          </button>
        )}
        <button className="btn" data-ui="profile-public" onClick={click(() => onPublic(farm.farmId))}>
          PUBLIC VIEW
        </button>
        <button className="btn" data-ui="profile-close" data-tour="close" onClick={click(onClose)}>
          BACK TO THE FARM
        </button>
      </div>
      <div className="row" style={{ gap: 3, flexWrap: 'wrap', flex: 'none' }} data-ui="profile-tabs">
        {PROFILE_TABS.map((t) => (
          <button
            key={t}
            className={`btn ${t === tab ? 'red' : ''}`}
            data-tour={`profile-${t}`}
            data-ui="profile-tab"
            onClick={click(() => {
              onTab(t);
              uiEvents.emit({ kind: 'tab', modal: 'profile', tab: t });
            })}
          >
            {PROFILE_TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: wide ? 'row' : 'column', gap: 10 }} data-ui={`profile-tab-${tab}`}>
        {!content ? (
          <span data-ui="profile-loading">LOADING YOUR PROFILE</span>
        ) : 'custom' in content ? (
          content.custom
        ) : wide ? (
          <>
            <div className="col" style={{ flex: '1 1 0', minWidth: 0, minHeight: 0 }}>
              <Paged fill gap={6} items={content.left} resetKey={tab} ui="profile-left" />
            </div>
            <div className="col" style={{ flex: '1 1 0', minWidth: 0, minHeight: 0 }}>
              <Paged fill gap={6} items={content.right} resetKey={tab} ui="profile-right" />
            </div>
          </>
        ) : (
          <div className="col" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
            <Paged fill gap={6} items={[...content.left, ...content.right]} resetKey={tab} ui="profile-left" />
          </div>
        )}
      </div>
    </div>
  );
}

type Content = { left: ReactNode[]; right: ReactNode[] } | { custom: ReactNode };

function tabContent(tab: ProfileTab, p: ProfileData, farm: FarmState, market: MarketState, onPublic: (id: string) => void, onMint: () => void, wide: boolean): Content {
  switch (tab) {
    case 'overview':
      return overview(p, farm, market, onPublic);
    case 'eggs':
      return eggs(p);
    case 'money':
      return money(p);
    case 'flock':
      return flock(p, farm);
    case 'machines':
      return machines(p, farm);
    case 'market':
      return marketTab(p);
    case 'mint':
      return mint(p, farm, onMint);
    case 'badges':
      return { custom: <BadgesTab badges={p.badges} wide={wide} /> };
  }
}

function overview(p: ProfileData, farm: FarmState, market: MarketState, onPublic: (id: string) => void): Content {
  const earned = p.badges.filter((b) => b.level !== null);
  const range = dayRange(p);
  const worst = Math.max(2, ...p.days.map((d) => d.farms));
  const left: ReactNode[] = [
    <section key="who" className="row" style={{ gap: 8, alignItems: 'flex-end' }} data-ui="profile-identity">
      <SheetSprite id="17-sign-farm" row="sway" play="loop" box={{ w: 52, h: 36 }} />
      <span className="col" style={{ gap: 2, minWidth: 0 }}>
        <span style={{ lineHeight: '9px' }}>DAY {p.day}: {p.daysPlayed} DAY{p.daysPlayed === 1 ? '' : 'S'} ON THE STREET</span>
        <span style={{ lineHeight: '9px', color: farm.standing.good ? PALETTE.grass : PALETTE.barn }} data-ui="profile-standing">
          {farm.standing.good ? 'IN GOOD STANDING' : `NOT IN GOOD STANDING: ${farm.standing.reasons.join(', ').toUpperCase()}`}
        </span>
      </span>
    </section>,
    <Block key="numbers" title="YOUR FARM NOW" ui="profile-numbers">
      <Stat label="COINS" value={coins(p.cashMilli)} />
      <Stat label="NET WORTH" value={coins(p.netWorthMilli)} ui="profile-net-worth" />
      <span style={{ lineHeight: '9px', color: PALETTE.wood }}>
        COINS {whole(p.netWorth.cashMilli)}, HENS {whole(p.netWorth.hensMilli)}, COOPS {whole(p.netWorth.coopsMilli)}, MACHINES {whole(p.netWorth.machinesMilli)}
        {p.netWorth.landMilli > 0 ? `, LAND ${whole(p.netWorth.landMilli)}` : ''}
      </span>
      <Stat label="RANK ON THE STREET" value={p.rank ? `${p.rank} OF ${p.farms}` : 'BUST'} ui="profile-rank" />
      <Stat label="DAYS IN GOOD STANDING" value={p.goodDays} />
    </Block>,
    <Block key="badges" title={`BADGES: ${earned.length} OF ${BADGES.length}`} ui="profile-badge-summary">
      {earned.length ? <BadgeRow badges={earned.map((b) => ({ id: b.id, level: b.level ?? 'plain' }))} max={8} /> : <span>NONE YET. THE BADGES TAB SHOWS WHAT EARNS THEM.</span>}
    </Block>,
  ];
  const right: ReactNode[] = [
    <LineChart key="rank" ui="chart-rank" caption="RANK EACH DAY (TOP IS FIRST)" points={p.days.map((d) => ({ key: d.day, value: d.rank }))} best={1} worst={worst} {...range} />,
    <BarChart key="worth" ui="chart-worth" caption="NET WORTH EACH DAY" bars={p.days.map((d) => ({ key: d.day, value: Math.max(0, d.netWorthMilli) }))} fmt={whole} colour={PALETTE.sky} {...range} />,
    ...(p.days.some((d) => d.estimated) ? [<span key="est" style={{ lineHeight: '9px', color: PALETTE.wood }}>DAYS BEFORE THE PROFILE WAS KEPT ARE ESTIMATED FROM THE LEDGER.</span>] : []),
    h3('THE STREET: TAP A FARM FOR ITS PROFILE', 'profile-street'),
    ...market.ranking.map((r, i) => <FarmRankRow key={r.farmId} rank={i + 1} farm={r} mine={r.farmId === farm.farmId} onOpen={() => onPublic(r.farmId)} />),
  ];
  return { left, right };
}

function eggs(p: ProfileData): Content {
  const range = dayRange(p);
  const t = p.eggs.totals;
  const table = (
    <table key="grades" className="mint-table" data-ui="profile-egg-table">
      <thead>
        <tr>
          <th />
          <th>LAID</th>
          <th>COLLECTED</th>
          <th>BROKEN</th>
          <th>SOLD</th>
        </tr>
      </thead>
      <tbody>
        {EGG_GRADES.map((g) => (
          <tr key={g}>
            <td>{g.toUpperCase()}</td>
            <td>{p.eggs.laid[g]}</td>
            <td>{p.eggs.collected[g]}</td>
            <td>{p.eggs.broken[g]}</td>
            <td>{p.eggs.sold[g]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  const left: ReactNode[] = [
    <Block key="by-grade" title="BY GRADE" ui="profile-eggs-grades">
      {table}
      <span style={{ lineHeight: '9px', color: PALETTE.wood }}>
        {p.eggs.since === null
          ? 'LAID, COLLECTED AND BROKEN COUNT FROM YOUR FIRST DAY CLOSE.'
          : `LAID, COLLECTED (BY HAND OR BELT) AND BROKEN SINCE DAY ${p.eggs.since}; SOLD OVER THE SEASON. EGGS LEFT ON THE GROUND GO TO THE CRATE AT MIDNIGHT.`}
      </span>
    </Block>,
    <Block key="season" title="THIS SEASON" ui="profile-eggs-season">
      <Stat label="INTO THE CRATE" value={t.collected} />
      <Stat label="PICKED UP BY HAND" value={t.picked} />
      <Stat label="LAID" value={t.laid} />
      <Stat label="CRACKED" value={t.broken} />
      <Stat label="SOLD" value={t.sold} />
      <Stat label="GOLDEN EGGS" value={t.golden} />
    </Block>,
  ];
  const right: ReactNode[] = [
    <BarChart key="laid" ui="chart-laid" caption="LAID EACH DAY (GREEN) AND CRACKED (RED)" bars={p.days.map((d) => ({ key: d.day, value: Math.max(0, (d.laid ?? 0) - (d.broken ?? 0)), over: d.broken ?? 0 }))} overColour={PALETTE.barn} {...range} />,
    <BarChart key="sold" ui="chart-sold" caption="SOLD EACH DAY" bars={p.days.map((d) => ({ key: d.day, value: d.sold }))} colour={PALETTE.straw} {...range} />,
  ];
  return { left, right };
}

function money(p: ProfileData): Content {
  const range = dayRange(p);
  const kinds = Object.entries(p.money.byKind);
  const income = kinds.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const costs = [...COST_KINDS.map((k) => [k, p.money.byKind[k] ?? 0] as [string, number]), ...kinds.filter(([k, v]) => v < 0 && !COST_KINDS.includes(k))];
  const label = (k: string) => KIND_LABEL[k] ?? k.toUpperCase();
  const totalIn = income.reduce((s, [, v]) => s + v, 0);
  const totalOut = costs.reduce((s, [, v]) => s + Math.min(0, v), 0);
  const left: ReactNode[] = [
    <Block key="in" title="COINS IN THIS SEASON" ui="profile-revenue">
      {income.length ? income.map(([k, v]) => <Stat key={k} label={label(k)} value={coins(v)} tone="up" />) : <span>NOTHING YET.</span>}
      <Stat label="ALL IN" value={coins(totalIn)} />
    </Block>,
    <Block key="out" title="COINS OUT THIS SEASON" ui="profile-costs">
      {costs.map(([k, v]) => (
        <Stat key={k} label={label(k)} value={coins(-Math.min(0, v))} tone={v < 0 ? 'down' : undefined} />
      ))}
      <Stat label="ALL OUT" value={coins(-totalOut)} />
    </Block>,
  ];
  const right: ReactNode[] = [
    <SignedChart key="profit" ui="chart-profit" caption="PROFIT EACH DAY" bars={p.days.map((d) => ({ key: d.day, value: d.profitMilli }))} fmt={whole} {...range} />,
    <Block key="best" title="BEST AND WORST DAY" ui="profile-best-day">
      <Stat label={p.money.best ? `BEST: DAY ${p.money.best.day}` : 'BEST'} value={p.money.best ? coins(p.money.best.profitMilli) : 'NONE YET'} tone="up" />
      <Stat label={p.money.worst ? `WORST: DAY ${p.money.worst.day}` : 'WORST'} value={p.money.worst ? coins(p.money.worst.profitMilli) : 'NONE YET'} tone={p.money.worst && p.money.worst.profitMilli < 0 ? 'down' : undefined} />
      <Stat label="IN THE BLACK THIS SEASON" value={coins(totalIn + totalOut)} tone={totalIn + totalOut >= 0 ? 'up' : 'down'} />
    </Block>,
  ];
  return { left, right };
}

function flock(p: ProfileData, farm: FarmState): Content {
  const cap = coopCapacity(farm.coops.map((c) => c.kind));
  const crowding = crowdingFactor(farm.hens.length, cap);
  const rate = (h: FarmState['hens'][number]) => henLayingRate({ feedMultiplier: farm.fedToday, trait: h.layingTrait, ageDays: h.ageDays, crowding });
  const total = farm.hens.reduce((s, h) => s + rate(h), 0);
  const oldest = farm.hens.reduce((m, h) => Math.max(m, h.ageDays), 0);
  const avgTrait = farm.hens.length ? farm.hens.reduce((s, h) => s + h.layingTrait, 0) / farm.hens.length : 0;
  const seen = new Set(p.flock.traitsSeen);
  const left: ReactNode[] = [
    <Block key="flock" title="YOUR FLOCK" ui="profile-flock">
      <Stat label="HENS" value={`${farm.hens.length} OF ${cap} ROOM`} tone={farm.hens.length > cap ? 'down' : undefined} />
      <Stat label="EGGS A DAY AT TODAY'S FEED" value={total.toFixed(1)} />
      <Stat label="AVERAGE LAYING TRAIT" value={avgTrait ? `x${avgTrait.toFixed(2)}` : '-'} />
      <Stat label="OLDEST HEN" value={`${oldest} DAYS`} />
      <Stat label="BOUGHT AT AUCTION" value={p.flock.auctionHens} />
      {farm.hens.length > cap && <span className="down">OVER ROOM: CROWDED HENS LAY LESS.</span>}
    </Block>,
    <Block key="looks" title={`LOOKS SEEN: ${BADGE_RULES.traits.filter((x) => seen.has(x)).length} OF ${BADGE_RULES.traits.length}`} ui="profile-looks">
      <span style={{ lineHeight: '9px' }}>{BADGE_RULES.traits.map((x) => `${x.split(':')[1]?.toUpperCase()}${seen.has(x) ? '' : ' (NOT YET)'}`).join(', ')}</span>
    </Block>,
  ];
  const right: ReactNode[] = [
    h3('EACH HEN: LOOKS, EGGS A DAY, AGE', 'profile-hens'),
    ...farm.hens.map((h, i) => (
      <span key={h.id} className="row spread" style={{ gap: 6 }} data-ui="profile-hen">
        <span style={{ flex: '1 1 auto', minWidth: 0, lineHeight: '9px' }}>
          {i + 1}. {h.body.toUpperCase()}, {h.eyes.toUpperCase()} EYES, {h.comb.toUpperCase()} COMB{h.accessory !== 'none' ? `, ${h.accessory.toUpperCase()}` : ''}
        </span>
        <span style={{ flex: 'none' }}>
          {rate(h).toFixed(2)} / {h.ageDays}D
        </span>
      </span>
    )),
    ...(farm.hens.length ? [] : [<span key="none">NO HENS. THE SHOP SELLS THEM.</span>]),
  ];
  return { left, right };
}

function machines(p: ProfileData, farm: FarmState): Content {
  const left: ReactNode[] = UNLOCK_IDS.map((u) => {
    const s = farm.machineState[u];
    const w = p.machines.work[u];
    return (
      <Block key={u} title={UNLOCK_TEXT[u].name} ui={`profile-machine-${u}`}>
        {s ? (
          <>
            <Stat label="CONDITION" value={s.broken ? 'BROKEN' : pct(s.condition)} tone={s.broken || s.condition < ECONOMY.wear.hintBelow ? 'down' : undefined} />
            <Stat label="EFFECT NOW" value={pct(s.effect)} />
            <Stat label="WORK THIS SEASON" value={w ? `${w.units}${w.saved ? `, ${w.saved} SAVED` : ''}${w.milli ? `, ${coins(w.milli)} COINS` : ''}` : 'NONE YET'} />
          </>
        ) : (
          <span style={{ lineHeight: '9px', color: PALETTE.wood }}>NOT BOUGHT: {UNLOCK_TEXT[u].effect}.</span>
        )}
      </Block>
    );
  });
  const right: ReactNode[] = [
    <Block key="care" title="REPAIRS AND BREAKDOWNS" ui="profile-repairs">
      <Stat label="REPAIRS PAID" value={p.machines.repairs} />
      <Stat label="REPAIRS IN A ROW BEFORE A BREAKDOWN" value={`${p.machines.repairStreak} (BEST ${p.machines.bestRepairStreak})`} />
      <Stat label="BREAKDOWNS" value={p.machines.breakdowns} tone={p.machines.breakdowns ? 'down' : undefined} />
      <Stat label="DAYS WITHOUT A BREAKDOWN" value={p.machines.daysNoBreakdown} />
    </Block>,
  ];
  return { left, right };
}

function marketTab(p: ProfileData): Content {
  const m = p.market;
  const left: ReactNode[] = [
    <Block key="contracts" title="CONTRACTS" ui="profile-contracts">
      <Stat label="TAKEN" value={m.contractsTaken} />
      <Stat label="FINISHED WITHOUT A MISS" value={m.contractsKept} />
      <Stat label="DAYS DELIVERED" value={m.deliveries} />
      <Stat label="DAYS MISSED" value={m.contractMisses} tone={m.contractMisses ? 'down' : undefined} />
      <Stat label="DELIVERED IN A ROW" value={`${m.deliveryStreak} (BEST ${m.bestDeliveryStreak})`} />
    </Block>,
    <Block key="haggles" title="HAGGLES" ui="profile-haggles">
      <Stat label="WON" value={m.hagglesWon} tone="up" />
      <Stat label="LOST (THEY WALKED)" value={m.hagglesLost} tone={m.hagglesLost ? 'down' : undefined} />
    </Block>,
  ];
  const right: ReactNode[] = [
    <Block key="selling" title="SELLING" ui="profile-selling">
      <Stat label="EGGS SOLD" value={m.eggsSold} />
      <Stat label="BUYER ORDERS FILLED" value={m.ordersFilled} />
      <Stat label="BIG TRADES" value={m.bigTrades} />
      <Stat label="SHARE OF THE STREET, LAST DAY" value={`${m.sharePct}%`} />
      <Stat label="BEST DAY'S SHARE" value={`${m.bestSharePct}%`} />
    </Block>,
    <Block key="rivals" title="RIVALS" ui="profile-rivals">
      <Stat label="RIVAL FARMS OUTLASTED" value={m.rivalsOutlasted} />
      <Stat label="RANK ON THE STREET" value={p.rank ? `${p.rank} OF ${p.farms}` : 'BUST'} />
    </Block>,
  ];
  return { left, right };
}

function mint(p: ProfileData, farm: FarmState, onMint: () => void): Content {
  const left: ReactNode[] = [
    <Block key="tickets" title={`FEATHER TICKETS: ${p.mint.ticketsWon} WON`} ui="profile-tickets">
      {farm.tickets.length === 0 && <span style={{ lineHeight: '9px' }}>NONE YET. EACH MILESTONE GIVES ONE ROLL ({pct(ECONOMY.feathers.odds)}) WHILE YOU ARE IN GOOD STANDING.</span>}
      {farm.tickets.map((t) => (
        <span key={t.id} style={{ lineHeight: '9px' }}>
          {MILESTONE_TEXT[t.milestone]}: {t.status === 'minted' ? `FEATHER ${featherNo(t.number ?? 0)}, ${t.grade ? GRADE_LABEL[t.grade] : ''}` : t.status === 'queued' ? 'MINTING' : 'TO MINT'}
        </span>
      ))}
      <button className="btn red" style={{ alignSelf: 'flex-start' }} data-ui="profile-open-mint" onClick={onMint}>
        OPEN THE FEATHER MINT
      </button>
    </Block>,
    <Block key="feathers" title="FEATHERS MINTED" ui="profile-feathers">
      {FEATHER_GRADES.map((g) => (
        <Stat key={g} label={GRADE_LABEL[g]} value={p.mint.minted[g]} />
      ))}
      <Stat label="GRADE IF MINTED NOW" value={`${GRADE_LABEL[farm.score.grade]} (SCORE ${Math.round(farm.score.score * 100)})`} />
    </Block>,
  ];
  const right: ReactNode[] = [
    h3(`MILESTONES: ${p.mint.milestones} OF ${farm.milestones.length} REACHED`, 'profile-milestones'),
    ...farm.milestones.map((m) => (
      <Stat key={m.id} label={MILESTONE_TEXT[m.id]} value={m.state === 'open' ? 'NOT YET' : m.state === 'won' ? `WON, DAY ${m.day}` : `ROLLED, DAY ${m.day}`} tone={m.state === 'won' ? 'up' : undefined} />
    )),
  ];
  return { left, right };
}

/** The badges tab: a summary, filters, the chosen badge's details, and every badge in a grid that pages. */
function BadgesTab({ badges, wide }: { badges: BadgeView[]; wide: boolean }) {
  const { audio } = useServices();
  const [cat, setCat] = useState<BadgeCategory | 'all' | 'earned'>('all');
  const byId = useMemo(() => new Map(badges.map((b) => [b.id, b])), [badges]);
  const shown = BADGES.filter((b) => (cat === 'all' ? true : cat === 'earned' ? byId.get(b.id)?.level : b.category === cat));
  const [pick, setPick] = useState<string>(() => badges.find((b) => b.level !== null)?.id ?? BADGES[0]?.id ?? '');
  const earned = badges.filter((b) => b.level !== null);
  const count = (l: string) => earned.filter((b) => b.level === l).length;
  const chip = (id: BadgeCategory | 'all' | 'earned', label: string) => (
    <button
      key={id}
      className={`btn ${cat === id ? 'red' : ''}`}
      data-ui="badge-filter"
      onClick={() => {
        uiSound(audio, 'click');
        setCat(id);
      }}
    >
      {label}
    </button>
  );
  const sel = BADGE_BY_ID.get(pick);
  const held = byId.get(pick);
  const next = sel ? nextLevel(sel, held?.level ?? null) : null;
  const hidden = sel?.secret && !held?.level;
  const detail = sel && (
    <div className="row" style={{ gap: 8, alignItems: 'flex-start' }} data-ui="badge-detail">
      <Badge id={sel.id} level={held?.level ?? null} zoom={2} />
      <span className="col" style={{ gap: 2, minWidth: 0, flex: 1 }}>
        <span className="panel-title small" style={{ fontSize: 8, lineHeight: '9px', margin: 0 }} data-ui="badge-detail-name">
          {hidden ? 'A SECRET BADGE' : sel.name}
        </span>
        <span style={{ lineHeight: '9px' }}>{held?.level ? `${LEVEL_LABEL[held.level]} ON DAY ${held.earnedDay ?? '-'}` : 'LOCKED'}</span>
        <span style={{ lineHeight: '9px' }}>{hidden ? 'KEEP FARMING: IT SHOWS ITSELF WHEN YOU EARN IT.' : badgeText(sel, next ?? held?.level ?? 'plain')}</span>
        {!hidden && next && <span style={{ lineHeight: '9px', color: PALETTE.sky }}>{`${Math.min(held?.progress ?? 0, thresholdOf(sel, next))} OF ${thresholdOf(sel, next)} FOR ${next === 'plain' ? 'IT' : LEVEL_LABEL[next]}`}</span>}
      </span>
    </div>
  );
  const cells = shown.map((b) => {
    const h = byId.get(b.id);
    const secret = b.secret && !h?.level;
    return (
      <button
        key={b.id}
        className="col"
        data-ui="badge-cell"
        data-badge={b.id}
        data-level={h?.level ?? 'locked'}
        style={{ width: 72, height: 62, gap: 2, alignItems: 'center', border: 0, padding: 0, background: pick === b.id ? '#e3cc96' : 'transparent', font: 'inherit', color: 'inherit', cursor: 'pointer' }}
        onClick={() => {
          uiSound(audio, 'click');
          setPick(b.id);
        }}
      >
        <Badge id={b.id} level={h?.level ?? null} />
        <span style={{ lineHeight: '8px', height: 16, textAlign: 'center' }}>{secret ? '???' : b.name}</span>
        <span style={{ lineHeight: '8px', color: h?.level ? PALETTE.grass : PALETTE.wood }}>{h?.level ? LEVEL_LABEL[h.level] : 'LOCKED'}</span>
      </button>
    );
  });
  const summary = (
    <span style={{ lineHeight: '9px' }} data-ui="badge-summary">
      {earned.length} OF {BADGES.length} EARNED: {count('gold')} GOLD, {count('silver')} SILVER, {count('bronze')} BRONZE AND {count('plain')} MORE. JUST FOR SHOW: THEY CHANGE NOTHING IN THE GAME.
    </span>
  );
  const filters = (
    <div className="row" style={{ gap: 3, flexWrap: 'wrap' }} data-ui="badge-filters">
      {chip('all', 'ALL')}
      {chip('earned', 'EARNED')}
      {BADGE_CATEGORIES.map((c) => chip(c, CATEGORY_LABEL[c]))}
    </div>
  );
  const grid = cells.length ? <Paged fill cell={{ w: 72, h: 62 }} gap={3} items={cells} resetKey={cat} label={`${cells.length}`} ui="badge-grid" /> : <span>NONE HERE YET.</span>;
  return wide ? (
    <>
      <div className="col" style={{ width: 210, flex: 'none', gap: 6, minHeight: 0 }}>
        {summary}
        {filters}
        {detail}
      </div>
      <div className="col" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        {grid}
      </div>
    </>
  ) : (
    <div className="col" style={{ flex: 1, minWidth: 0, minHeight: 0, gap: 5 }}>
      {summary}
      {filters}
      {detail}
      {grid}
    </div>
  );
}
