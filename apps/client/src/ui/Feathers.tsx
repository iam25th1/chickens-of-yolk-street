// The Feathers (beta) in the UI: a Feather card (its grade's Spawn card frame, its feather in the
// window, its number in the nameplate), the unminted card (the empty frame with a dark hen
// silhouette and the number only), the reveal moment when a day close mints one of the player's
// Feathers, and the mint page: supply, grades, the provenance hash and contract, the player's
// tickets with Redeem, each grade's estimated odds, recent mints and all 777 slots.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ECONOMY, FEATHER_GRADES, RARITIES, type FarmState, type FeatherGrade, type FeatherSlot, type MarketState, type MilestoneId, type MintPageData, type Rarity } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { juice } from '../motion/juice';
import type { Action } from '../net/socket';
import { CardStamp } from './Cards';
import { MILESTONE_TEXT } from './HowToPlay';
import { Modal } from './Modal';
import { HenArt } from './Panels';
import { SheetSprite } from './SheetSprite';

export const GRADE_LABEL: Record<FeatherGrade, string> = { fluff: 'FLUFF', plume: 'PLUME', quill: 'QUILL', 'golden-quill': 'GOLDEN QUILL' };
/** The card frame each grade wears: Fluff common, Plume rare, Quill epic, Golden Quill legendary. */
export const FRAME_OF: Record<FeatherGrade, 'common' | 'rare' | 'epic' | 'legendary'> = { fluff: 'common', plume: 'rare', quill: 'epic', 'golden-quill': 'legendary' };
export const RARITY_LABEL: Record<Rarity, string> = { legendary: 'LEGENDARY', epic: 'EPIC', rare: 'RARE', common: 'COMMON' };
export const featherNo = (n: number): string => `#${String(n).padStart(3, '0')}`;
export const PLANNED = 'PLANNED TO HATCH INTO A FOUNDING HEN AT MAINNET LAUNCH.';

/** The window's paper, behind the art (the frames leave it clear). */
const PAPER = '#f4e4bd';
const UNMINTED_PAPER = '#d8c79e';
/** A plain hen for the unminted silhouette. */
const SILHOUETTE = { id: 'silhouette', body: 'cream', eyes: 'default', comb: 'default', accessory: 'none', layingTrait: 1, ageDays: 0 } as const;

/** Card art in art pixels: 48 x 68, the window at (8, 8) 32 x 48, the nameplate at (10, 58) 28 x 7. */
const CARD = { w: 48, h: 68, win: { x: 8, y: 8, w: 32, h: 48 }, plate: { x: 10, y: 58, w: 28, h: 7 } };

function Plate({ n, z }: { n: number; z: number }) {
  if (z < 2) return null;
  const p = CARD.plate;
  return (
    <span className="feather-plate" style={{ left: p.x * z, top: p.y * z, width: p.w * z, height: p.h * z, lineHeight: `${p.h * z}px` }}>
      {featherNo(n)}
    </span>
  );
}

/** A minted Feather's card. z: UI pixels per art pixel (whole). */
export function FeatherCard({ grade, number, z = 1, row = 'float', play = true }: { grade: FeatherGrade; number: number; z?: number; row?: 'float' | 'shine'; play?: boolean }) {
  const w = CARD.win;
  return (
    <div className="feather-card" data-ui="feather-card" data-grade={grade} style={{ width: CARD.w * z, height: CARD.h * z }} title={`FEATHER ${featherNo(number)}: ${GRADE_LABEL[grade]}`}>
      <div style={{ position: 'absolute', left: w.x * z, top: w.y * z, width: w.w * z, height: w.h * z, background: PAPER }} />
      <SheetSprite id={`x-feather-${grade}`} row={row} play={play ? 'loop' : false} zoom={z} style={{ position: 'absolute', left: w.x * z, top: w.y * z }} />
      <SheetSprite id={`x-founders-frame-${FRAME_OF[grade]}`} row="plate" zoom={z} style={{ position: 'absolute', left: 0, top: 0 }} />
      <Plate n={number} z={z} />
    </div>
  );
}

/** A number not minted yet: the empty frame with a dark hen silhouette and the number only. */
export function UnmintedCard({ number, z = 1 }: { number: number; z?: number }) {
  const w = CARD.win;
  return (
    <div className="feather-card" data-ui="unminted-card" style={{ width: CARD.w * z, height: CARD.h * z }} title={`${featherNo(number)}: NOT MINTED YET`}>
      <div style={{ position: 'absolute', left: w.x * z, top: w.y * z, width: w.w * z, height: w.h * z, background: UNMINTED_PAPER }} />
      <div className="silhouette" style={{ position: 'absolute', left: w.x * z, top: w.y * z, width: w.w * z, height: w.h * z }}>
        <HenArt hen={SILHOUETTE} scale={z} box={{ w: w.w * z, h: w.h * z - 4 * z }} />
      </div>
      <SheetSprite id="x-founders-frame-unminted" row="plate" zoom={z} style={{ position: 'absolute', left: 0, top: 0 }} />
      <Plate n={number} z={z} />
    </div>
  );
}

export interface RevealState {
  ticketId: string;
  number: number;
  grade: FeatherGrade;
  milestone: MilestoneId;
  txHash: string;
  day: number;
}

/**
 * The reveal moment: the unminted card flips to the Feather card, the feather shines, a stamp
 * lands, and the planned hatch is said in one line, with the receipt in the ledger. A Quill or a
 * Golden Quill gets the bigger show: confetti, a sparkle and a harder stamp.
 */
export function RevealPanel({ reveal, market, onLedger, onMintPage, onClose }: { reveal: RevealState; market: MarketState; onLedger: () => void; onMintPage: () => void; onClose: () => void }) {
  const { audio } = useServices();
  const [phase, setPhase] = useState<'closed' | 'turning' | 'open' | 'stamped'>('closed');
  const big = reveal.grade === 'quill' || reveal.grade === 'golden-quill';
  useEffect(() => {
    audio.play('17-card', { volume: 0.7 });
    const t1 = setTimeout(() => setPhase('turning'), 700);
    const t2 = setTimeout(() => {
      setPhase('open');
      audio.play(big ? '11-golden' : '08-egg-pop', { volume: 0.8 });
      if (big) juice.shake(reveal.grade === 'golden-quill' ? 7 : 4, 520);
    }, 920);
    const t3 = setTimeout(() => setPhase('stamped'), 1500);
    return () => [t1, t2, t3].forEach(clearTimeout);
  }, [audio, big, reveal.grade]);
  useEffect(() => {
    if (phase !== 'stamped') return;
    audio.play('18-stamp');
    juice.hitstop(big ? 140 : 70);
    juice.shake(big ? 6 : 2, big ? 420 : 220);
    if (big) audio.play('45-deal-closed', { delayMs: 240 });
  }, [audio, big, phase]);
  const z = 2;
  return (
    <Modal title="YOUR FEATHER" onClose={onClose} w={420} h={330} className="reveal" dismiss={phase === 'stamped'}>
      <div className="row" style={{ gap: 12, alignItems: 'center' }}>
        <div style={{ position: 'relative', width: CARD.w * z, height: CARD.h * z, flex: 'none' }}>
          <div className={`flip ${phase}`} data-ui="reveal-card">
            {phase === 'closed' || phase === 'turning' ? <UnmintedCard number={reveal.number} z={z} /> : <FeatherCard grade={reveal.grade} number={reveal.number} z={z} row={phase === 'open' ? 'shine' : 'float'} />}
          </div>
          {phase !== 'closed' && phase !== 'turning' && big && (
            <>
              <SheetSprite id="35-particles" row="confetti" play="once" zoom={2} style={{ position: 'absolute', left: -28, top: 4 }} />
              <SheetSprite id="35-particles" row="confetti" play="once" zoom={2} style={{ position: 'absolute', right: -28, top: 40 }} />
              {reveal.grade === 'golden-quill' && <SheetSprite id="35-particles" row="sparkle" play="loop" zoom={2} style={{ position: 'absolute', left: 30, top: -10 }} />}
            </>
          )}
          {phase === 'stamped' && (
            <div style={{ position: 'absolute', left: -16, top: -40, width: 128 }}>
              <CardStamp row="accepted" onDone={() => undefined} />
            </div>
          )}
        </div>
        <div className="col" style={{ gap: 6 }}>
          <span className="panel-title small" style={{ margin: 0 }} data-ui="feather-number">
            FEATHER {featherNo(reveal.number)} OF {ECONOMY.feathers.maxSupply}
          </span>
          <span className="panel-title small" style={{ margin: 0, color: '#2f6f9e' }}>
            {GRADE_LABEL[reveal.grade]}
          </span>
          <span>WON AT: {MILESTONE_TEXT[reveal.milestone]}</span>
          <p className="meaning" style={{ margin: 0 }} data-ui="planned-hatch">
            {PLANNED} BETA, ON NEAR&apos;S TEST NETWORK. RECEIPT IN THE LEDGER, DAY {reveal.day}.
          </p>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button
              className="btn red"
              onClick={() => {
                uiSound(audio, 'click');
                onLedger();
              }}
            >
              LEDGER
            </button>
            <button
              className="btn"
              onClick={() => {
                uiSound(audio, 'click');
                onMintPage();
              }}
            >
              MINT PAGE
            </button>
            {market.explorer && (
              <a className="btn" href={`${market.explorer}${reveal.txHash}`} target="_blank" rel="noreferrer">
                RECEIPT
              </a>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

type Filter = 'all' | 'minted' | 'unminted' | 'mine';
const PAGE = 36;
const pct = (x: number): string => (x >= 0.1 ? `${Math.round(x * 100)}%` : `${(x * 100).toFixed(1)}%`);

/** The mint page. Its data is public (GET /api/feathers); the tickets are the player's own. */
export function MintPage({ farm, market, send, onClose }: { farm: FarmState; market: MarketState; send: (a: Action) => Promise<boolean>; onClose: () => void }) {
  const { audio } = useServices();
  const [data, setData] = useState<MintPageData | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [grade, setGrade] = useState<FeatherGrade | 'any'>('any');
  const [page, setPage] = useState(0);
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
  }, [load, market.feathers.minted, market.feathers.tickets, farm.tickets.length]);
  const mine = useMemo(() => new Set(farm.tickets.flatMap((t) => (t.number ? [t.number] : []))), [farm.tickets]);
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
  const pages = Math.max(1, Math.ceil(numbers.length / PAGE));
  const at = Math.min(page, pages - 1);
  const shown = numbers.slice(at * PAGE, at * PAGE + PAGE);
  const tab = (label: string, active: boolean, onClick: () => void) => (
    <button
      key={label}
      className={`btn ${active ? 'red' : ''}`}
      onClick={() => {
        uiSound(audio, 'click');
        onClick();
        setPage(0);
      }}
    >
      {label}
    </button>
  );
  const fee = ECONOMY.feathers.redeemFee;
  const held = farm.tickets.filter((t) => t.status === 'held');
  return (
    <Modal title="FEATHERS (BETA)" onClose={onClose} w={500} h={640} className="mint-page">
      <div className="col" style={{ gap: 8 }} data-ui="mint-page">
        <p style={{ margin: 0, lineHeight: '10px' }}>
          777 FEATHERS WILL EVER EXIST. EACH IS A CLAIM TICKET FOR ONE OF THE 777 FOUNDING HENS, PLANNED TO HATCH AT MAINNET LAUNCH. WIN A TICKET AT A MILESTONE; REDEEM IT HERE FOR {fee} COINS AND THE NEXT DAY CLOSE MINTS ITS FEATHER ON NEAR&apos;S TEST NETWORK, PAID BY THE GAME.
        </p>
        {failed && <span className="down">THE MINT PAGE COULD NOT LOAD. TRY AGAIN IN A MOMENT.</span>}
        {data && (
          <>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }} data-ui="mint-supply">
              <span className="panel-title small" style={{ margin: 0 }}>
                {data.minted} MINTED, {data.left} LEFT OF {data.max}
              </span>
              <span>
                {data.tickets} TICKET{data.tickets === 1 ? '' : 'S'} WAITING
              </span>
              {FEATHER_GRADES.map((g) => (
                <span key={g}>
                  {GRADE_LABEL[g]} {data.byGrade[g]}
                </span>
              ))}
            </div>
            <div className="col" style={{ gap: 2 }} data-ui="mint-provenance">
              <span title={data.provenance} style={{ wordBreak: 'break-all', lineHeight: '9px' }}>
                FOUNDERS PROVENANCE (SHA-256): {data.provenance || 'NOT SET'}
              </span>
              {data.contractUrl && (
                <a href={data.contractUrl} target="_blank" rel="noreferrer" style={{ color: '#2f6f9e' }}>
                  CONTRACT {data.contract} ON NEAR TESTNET
                </a>
              )}
            </div>
          </>
        )}

        <h3 className="panel-title small" style={{ margin: 0 }}>
          YOUR TICKETS
        </h3>
        <div className="col" style={{ gap: 4 }} data-ui="mint-tickets" data-tour="mint-tickets">
          {farm.tickets.length === 0 && <span>NO TICKETS YET. EACH MILESTONE GIVES ONE ROLL ({Math.round(ECONOMY.feathers.odds * 100)}%) WHILE YOUR FARM IS IN GOOD STANDING.</span>}
          {held.length > 0 && (
            <span style={{ color: '#2f6f9e', lineHeight: '9px' }} data-ui="mint-score">
              REDEEM NOW FOR A {GRADE_LABEL[farm.score.grade]}: MANAGEMENT SCORE {Math.round(farm.score.score * 100)} (GOOD DAYS {pct(farm.score.parts.goodDays)}, DELIVERIES {pct(farm.score.parts.delivery)}, HAGGLES {pct(farm.score.parts.haggles)}, PROFIT {pct(farm.score.parts.profit)}). TICKETS KEEP: A BETTER-RUN FARM REDEEMS A BETTER GRADE.
            </span>
          )}
          {farm.tickets.map((t) => (
            <div key={t.id} className="row" style={{ gap: 8, alignItems: 'center' }}>
              {t.status === 'minted' && t.grade && t.number ? <FeatherCard grade={t.grade} number={t.number} z={1} play={false} /> : <UnmintedCard number={t.number ?? 0} z={1} />}
              <span className="col" style={{ gap: 2 }}>
                <span>
                  TICKET FROM {MILESTONE_TEXT[t.milestone]}, DAY {t.day}
                </span>
                {t.status === 'held' && (
                  <button
                    className="btn red"
                    data-ui="redeem"
                    disabled={farm.cashMilli < fee * 1000}
                    onClick={() => {
                      uiSound(audio, 'click');
                      void send({ t: 'redeemTicket', ticketId: t.id }).then(() => load());
                    }}
                  >
                    REDEEM FOR {fee} COINS
                  </button>
                )}
                {t.status === 'queued' && t.grade && <span>REDEEMED AS A {GRADE_LABEL[t.grade]}: IT MINTS AT THE NEXT DAY CLOSE.</span>}
                {t.status === 'minted' && t.number && t.grade && (
                  <span>
                    FEATHER {featherNo(t.number)}, {GRADE_LABEL[t.grade]}, MINTED DAY {t.mintDay}
                    {t.mintTx && market.explorer && (
                      <>
                        {' '}
                        <a href={`${market.explorer}${t.mintTx}`} target="_blank" rel="noreferrer" style={{ color: '#2f6f9e' }}>
                          RECEIPT
                        </a>
                      </>
                    )}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>

        {data && (
          <>
            <h3 className="panel-title small" style={{ margin: 0 }}>
              EACH GRADE&apos;S ODDS OF A HEN (ESTIMATE)
            </h3>
            <table className="mint-table" data-ui="mint-estimates">
              <thead>
                <tr>
                  <th />
                  {RARITIES.map((r) => (
                    <th key={r}>
                      {RARITY_LABEL[r]} ({data.rarityCounts[r]})
                    </th>
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
            <span style={{ lineHeight: '9px' }}>
              AN ESTIMATE FROM THE {data.minted} FEATHERS MINTED SO FAR (NUMBERS NOT MINTED COUNT AS FLUFF), UNDER THE GRADE WEIGHTS. IT LOCKS AT THE PLANNED REVEAL, WHEN A SEED FROM A PUBLIC EVENT CHOSEN IN ADVANCE DRAWS EXACTLY 7 LEGENDARY, 70 EPIC, 200 RARE AND 500 COMMON HENS.
            </span>

            {data.recent.length > 0 && (
              <>
                <h3 className="panel-title small" style={{ margin: 0 }}>
                  RECENT MINTS
                </h3>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} data-ui="mint-recent">
                  {data.recent.map((s: FeatherSlot) => (
                    <span key={s.number} className="col" style={{ alignItems: 'center', gap: 1 }}>
                      <FeatherCard grade={s.grade} number={s.number} z={1} />
                      <span>{featherNo(s.number)}</span>
                    </span>
                  ))}
                </div>
              </>
            )}

            <h3 className="panel-title small" style={{ margin: 0 }}>
              ALL 777
            </h3>
            <div className="row" style={{ gap: 3, flexWrap: 'wrap' }} data-ui="mint-filters">
              {tab('ALL', filter === 'all', () => setFilter('all'))}
              {tab('MINTED', filter === 'minted', () => setFilter('minted'))}
              {tab('NOT MINTED', filter === 'unminted', () => setFilter('unminted'))}
              {tab('MINE', filter === 'mine', () => setFilter('mine'))}
              {tab('ANY GRADE', grade === 'any', () => setGrade('any'))}
              {FEATHER_GRADES.map((g) => tab(GRADE_LABEL[g], grade === g, () => setGrade(g)))}
            </div>
            <div className="mint-grid" data-ui="mint-grid">
              {shown.length === 0 && <span>NONE HERE YET.</span>}
              {shown.map((n) => {
                const s = slots.get(n);
                return (
                  <span key={n} className="col" style={{ alignItems: 'center', gap: 1 }} data-slot={n} data-minted={s ? '1' : '0'}>
                    {s ? <FeatherCard grade={s.grade} number={n} z={1} play={false} /> : <UnmintedCard number={n} z={1} />}
                    <span>{featherNo(n)}</span>
                  </span>
                );
              })}
            </div>
            <div className="row" style={{ gap: 6, alignItems: 'center' }} data-ui="mint-pager">
              <button className="btn" disabled={at === 0} onClick={() => setPage(at - 1)} aria-label="Previous page">
                {'<'}
              </button>
              <span>
                PAGE {at + 1} OF {pages} ({numbers.length})
              </span>
              <button className="btn" disabled={at >= pages - 1} onClick={() => setPage(at + 1)} aria-label="Next page">
                {'>'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
