// The Feathers (beta) in the UI: a Feather card (its grade's Spawn card frame, its feather in the
// window, its number in the nameplate), the unminted card (the empty frame with a dark hen
// silhouette and the number only), and the reveal when a mint the player did not watch (a catch-up
// at a day close) lands. The Feather Mint itself is FeatherMint.tsx; the minting moment MintMoment.tsx.
import { useEffect, useState } from 'react';
import { ECONOMY, type FeatherGrade, type MarketState, type MilestoneId, type Rarity } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { juice } from '../motion/juice';
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
  txHash: string | null;
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
              THE MINT
            </button>
            {market.explorer && reveal.txHash && (
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
