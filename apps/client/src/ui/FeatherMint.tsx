// The Feather Mint (/mint): a page of its own, open to anyone without entering the farm (signing in
// is needed only to mint). In order: the hero line; your tickets and grade with MINT; the Feathers
// left of 777 and by grade; each grade's odds of a hen (estimates that lock at the reveal); the
// recent mints with their farms and grades; all 777 in pages that fit the window (filters: grade,
// minted, not minted, mine); the provenance hash and the contract at the foot. Every part fits the
// window at every size (paged, never scrolled). Pressing MINT plays the minting moment (MintMoment).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ECONOMY, FEATHER_GRADES, GUEST_MINT_TEXT, RARITIES, type FarmState, type FeatherGrade, type MarketState, type MintPageData, type Rarity } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { useViewport } from '../app/Stage';
import { motion } from '../motion/ui';
import { FeatherCard, GRADE_LABEL, UnmintedCard, featherNo } from './Feathers';
import { Paged } from './Paged';

export const MINT_HERO = 'EARN TICKETS ON YOUR FARM. MINT A FEATHER. EACH FEATHER IS PLANNED TO HATCH INTO ONE OF 777 FOUNDING HENS AT MAINNET LAUNCH.';

type Filter = 'all' | 'minted' | 'unminted' | 'mine';
const RARITY_KEY: Record<Rarity, string> = { legendary: 'L', epic: 'E', rare: 'R', common: 'C' };
const pct = (x: number): string => (x >= 0.1 ? `${Math.round(x * 100)}%` : `${(x * 100).toFixed(1)}%`);

/** The public mint data (GET /api/feathers), loaded again when the market's Feather count moves, and every 15 s on its own. */
export function useMintData(market: MarketState | null, extra: unknown = null): { data: MintPageData | null; failed: boolean; reload: () => void } {
  const [data, setData] = useState<MintPageData | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/feathers');
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as MintPageData);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, market?.feathers.minted, market?.feathers.tickets, extra]);
  useEffect(() => {
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);
  return { data, failed, reload: () => void load() };
}

export function FeatherMint({
  farm,
  market,
  onMint,
  onSignIn,
  onClose,
  closeLabel,
}: {
  /** The signed-in player's farm, or null on the open page (then MINT asks to sign in). */
  farm: FarmState | null;
  market: MarketState | null;
  /** Mints one held ticket (the farm plays the minting moment). */
  onMint: ((ticketId: string) => void) | null;
  onSignIn: (() => void) | null;
  onClose: () => void;
  closeLabel: string;
}) {
  const { audio } = useServices();
  const v = useViewport();
  const { data, failed } = useMintData(market, farm?.tickets.map((t) => `${t.id}:${t.status}`).join(','));
  const [filter, setFilter] = useState<Filter>('all');
  const [grade, setGrade] = useState<FeatherGrade | 'any'>('any');
  const fee = ECONOMY.feathers.redeemFee;
  const wide = !v.portrait;

  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-ui="mint-page"]');
    if (el) motion.enter(el);
  }, []);
  // Escape leaves, as from a modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mine = useMemo(() => new Set((farm?.tickets ?? []).flatMap((t) => (t.number && t.status === 'minted' ? [t.number] : []))), [farm?.tickets]);
  const slots = useMemo(() => new Map((data?.slots ?? []).map((s) => [s.number, s])), [data]);
  const numbers = useMemo(() => {
    const all = Array.from({ length: ECONOMY.feathers.maxSupply }, (_, i) => i + 1);
    return all.filter((n) => {
      const s = slots.get(n);
      if (filter === 'minted' && !s) return false;
      if (filter === 'unminted' && s) return false;
      if (filter === 'mine' && !mine.has(n)) return false;
      if (grade !== 'any' && s?.grade !== grade) return false;
      return true;
    });
  }, [slots, filter, grade, mine]);

  const click = (fn: () => void) => () => {
    uiSound(audio, 'click');
    fn();
  };
  const chip = (label: string, active: boolean, onClick: () => void, ui?: string) => (
    <button key={label} className={`btn ${active ? 'red' : ''}`} data-ui={ui} onClick={click(onClick)}>
      {label}
    </button>
  );
  const h3 = (text: string) => (
    <h3 className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
      {text}
    </h3>
  );

  // 2. your tickets and grade, with MINT
  const held = farm?.tickets.filter((t) => t.status === 'held') ?? [];
  const going = farm?.tickets.filter((t) => t.status === 'queued') ?? [];
  const mintedMine = farm?.tickets.filter((t) => t.status === 'minted') ?? [];
  const tickets: ReactNode = (
    <section key="tickets" className="col" style={{ gap: 3 }} data-ui="mint-tickets" data-tour="mint-tickets">
      {h3('YOUR TICKETS')}
      {!farm ? (
        <>
          <span style={{ lineHeight: '10px' }}>SIGN IN TO MINT THE TICKETS YOUR FARM HAS WON. ANYONE CAN WATCH THE MINT.</span>
          {onSignIn && (
            <button className="btn red" data-ui="mint-sign-in" style={{ alignSelf: 'flex-start' }} onClick={click(onSignIn)}>
              SIGN IN TO MINT
            </button>
          )}
        </>
      ) : (
        <>
          <span style={{ lineHeight: '10px' }} data-ui="mint-held">
            {held.length ? `${held.length} TICKET${held.length === 1 ? '' : 'S'} TO MINT.` : 'NO TICKET TO MINT.'} YOUR GRADE NOW: {GRADE_LABEL[farm.score.grade]} (SCORE {Math.round(farm.score.score * 100)}).
          </span>
          {farm.guest ? (
            <>
              {/* a guest's tickets are saved on the farm; the mint itself needs signing in (a wallet) */}
              <span style={{ lineHeight: '10px' }} data-ui="mint-guest">
                {GUEST_MINT_TEXT.toUpperCase()}
              </span>
              <button className="btn red" data-ui="mint-button" style={{ alignSelf: 'flex-start' }} disabled={!onSignIn} onClick={click(() => onSignIn?.())}>
                SIGN IN TO MINT
              </button>
            </>
          ) : (
            <button
              className="btn red"
              data-ui="mint-button"
              style={{ alignSelf: 'flex-start' }}
              disabled={!held.length || farm.cashMilli < fee * 1000 || !onMint}
              onClick={click(() => {
                const t = held[0];
                if (t && onMint) onMint(t.id);
              })}
            >
              MINT A FEATHER ({fee} COINS)
            </button>
          )}
          {going.map((t) => (
            <span key={t.id} style={{ lineHeight: '10px', color: '#2f6f9e' }} data-ui="mint-going">
              {t.number ? `FEATHER ${featherNo(t.number)}` : 'A FEATHER'}
              {t.grade ? ` (${GRADE_LABEL[t.grade]})` : ''}: {t.mint?.state === 'waiting' ? `WAITING. ${(t.mint.note ?? '').toUpperCase()}` : 'MINTING ON NEAR TESTNET'}
            </span>
          ))}
          {mintedMine.length > 0 && (
            <span style={{ lineHeight: '10px' }}>
              YOU HAVE MINTED {mintedMine.length} FEATHER{mintedMine.length === 1 ? '' : 'S'}: {mintedMine.map((t) => featherNo(t.number ?? 0)).join(', ')}.
            </span>
          )}
          {!held.length && !going.length && (
            <span style={{ lineHeight: '10px' }}>
              EACH MILESTONE GIVES ONE ROLL ({Math.round(ECONOMY.feathers.odds * 100)}%) FOR A TICKET WHILE YOUR FARM IS IN GOOD STANDING. A BETTER-RUN FARM MINTS A BETTER GRADE.
            </span>
          )}
        </>
      )}
    </section>
  );

  // 3. left of 777, and by grade
  const supply: ReactNode = (
    <section key="supply" className="col" style={{ gap: 3 }} data-ui="mint-supply">
      {h3('THE 777')}
      {data ? (
        <>
          <span className="panel-title" style={{ margin: 0 }} data-ui="mint-left">
            {data.left} LEFT OF {data.max}
          </span>
          <span style={{ lineHeight: '10px' }}>
            {data.minted} MINTED ON NEAR TESTNET{data.tickets ? `, ${data.tickets} TICKET${data.tickets === 1 ? '' : 'S'} WAITING` : ''}.
          </span>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }} data-ui="mint-by-grade">
            {FEATHER_GRADES.map((g) => (
              <span key={g}>
                {GRADE_LABEL[g]} {data.byGrade[g]}
              </span>
            ))}
          </div>
        </>
      ) : (
        <span>{failed ? 'THE MINT COULD NOT LOAD. TRYING AGAIN.' : 'LOADING THE MINT'}</span>
      )}
    </section>
  );

  // 4. each grade's odds of a hen at the reveal
  const odds: ReactNode = data ? (
    <section key="odds" className="col" style={{ gap: 3 }} data-ui="mint-odds">
      {h3('ODDS OF A HEN AT THE REVEAL')}
      <table className="mint-table" data-ui="mint-estimates">
        <thead>
          <tr>
            <th />
            {RARITIES.map((r) => (
              <th key={r}>{RARITY_KEY[r]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FEATHER_GRADES.map((g) => (
            <tr key={g}>
              <td>{GRADE_LABEL[g]}</td>
              {RARITIES.map((r) => (
                <td key={r}>{pct(data.estimates[g][r])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <span style={{ lineHeight: '10px' }}>
        L LEGENDARY ({data.rarityCounts.legendary}), E EPIC ({data.rarityCounts.epic}), R RARE ({data.rarityCounts.rare}), C COMMON ({data.rarityCounts.common}). ESTIMATES FROM THE FEATHERS MINTED SO FAR; THEY LOCK AT THE REVEAL.
      </span>
    </section>
  ) : null;

  // 5. recent mints, with their farms and grades
  const recent: ReactNode = data ? (
    <section key="recent" className="col" style={{ gap: 2 }} data-ui="mint-recent">
      {h3('RECENT MINTS')}
      {data.recent.length === 0 && <span>NONE YET.</span>}
      {data.recent.slice(0, 6).map((s) => (
        <span key={s.number} style={{ lineHeight: '10px' }}>
          {featherNo(s.number)} {GRADE_LABEL[s.grade]}, {s.farm.toUpperCase()}
        </span>
      ))}
    </section>
  ) : null;

  // 6. all 777
  const cells = numbers.map((n) => {
    const s = slots.get(n);
    return (
      <span key={n} className="col" style={{ alignItems: 'center', gap: 1 }} data-slot={n} data-minted={s ? '1' : '0'}>
        {s ? <FeatherCard grade={s.grade} number={n} z={1} play={false} /> : <UnmintedCard number={n} z={1} />}
        <span>{featherNo(n)}</span>
      </span>
    );
  });
  const grid = (
    <div className="col" style={{ flex: 1, minWidth: 0, minHeight: 0, gap: 3 }} data-ui="mint-all">
      {h3(`ALL ${ECONOMY.feathers.maxSupply}`)}
      <div className="row" style={{ gap: 3, flexWrap: 'wrap' }} data-ui="mint-filters">
        {chip('ALL', filter === 'all', () => setFilter('all'))}
        {chip('MINTED', filter === 'minted', () => setFilter('minted'))}
        {chip('NOT MINTED', filter === 'unminted', () => setFilter('unminted'))}
        {chip('MINE', filter === 'mine', () => setFilter('mine'))}
        {chip('ANY GRADE', grade === 'any', () => setGrade('any'))}
        {FEATHER_GRADES.map((g) => chip(GRADE_LABEL[g], grade === g, () => setGrade(g)))}
      </div>
      {cells.length === 0 ? <span>NONE HERE YET.</span> : <Paged fill cell="auto" gap={3} items={cells} resetKey={`${filter}|${grade}`} label={`${numbers.length}`} ui="mint-grid" />}
    </div>
  );

  const info = [tickets, supply, ...(odds ? [odds] : []), ...(recent ? [recent] : [])];
  return (
    <div
      className="panel"
      data-ui="mint-page"
      style={{ left: 4, top: 4, width: v.uiW - 8, height: v.uiH - 8, display: 'flex', flexDirection: 'column', gap: 4, boxSizing: 'border-box', padding: 7 }}
    >
      {/* 1. the hero line */}
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <h2 className="panel-title" style={{ margin: 0 }}>
          FEATHER MINT
        </h2>
        <span className="beta" aria-label="Beta">
          BETA
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn" data-ui="mint-close" onClick={click(onClose)}>
          {closeLabel}
        </button>
      </div>
      <p className="meaning" data-ui="mint-hero">
        {MINT_HERO}
      </p>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: wide ? 'row' : 'column', gap: 8 }}>
        {/* a wide window: the info in a column beside the grid; a tall one: above it, as tall as it needs up to about half */}
        {wide ? (
          <div className="col" style={{ width: Math.min(250, Math.floor(v.uiW * 0.4)), flex: 'none', minHeight: 0 }}>
            <Paged fill gap={6} ui="mint-info" items={info} />
          </div>
        ) : (
          <div className="col" style={{ flex: 'none' }} data-room={Math.floor((v.uiH - 90) / 2)}>
            <Paged gap={6} ui="mint-info" items={info} />
          </div>
        )}
        {grid}
      </div>
      {/* 7. the provenance and the contract */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }} data-ui="mint-provenance">
        <span style={{ wordBreak: 'break-all', lineHeight: '9px', flex: '1 1 260px' }} title={data?.provenance}>
          FOUNDERS PROVENANCE (SHA-256): {data?.provenance || 'NOT SET'}
        </span>
        {data?.contractUrl && (
          <a href={data.contractUrl} target="_blank" rel="noreferrer" style={{ color: '#2f6f9e' }} data-ui="mint-contract">
            CONTRACT {data.contract} ON NEAR TESTNET
          </a>
        )}
      </div>
    </div>
  );
}
