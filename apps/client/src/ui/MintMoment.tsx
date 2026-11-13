// The minting moment: the ticket drops into the press, the press squashes down with a thump
// (hitstop, shake, sound), and stamps the card out face down; then the live stages: SENT TO NEAR
// when the mint goes out and CONFIRMED when NEAR testnet has it, with its receipt. Confirmed, the
// card flips to the Feather and a stamp lands. A Quill or a Golden Quill gets the bigger show
// (confetti, a sparkle, a harder shake). If the mint does not go through, the ticket is not used:
// the coins come back and the moment says so, with RETRY. A mint that has to wait says why.
import { useEffect, useRef, useState } from 'react';
import { ECONOMY, type FeatherGrade } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { juice } from '../motion/juice';
import { motion } from '../motion/ui';
import { events } from '../state/game';
import { CardStamp } from './Cards';
import { FeatherCard, GRADE_LABEL, UnmintedCard, featherNo } from './Feathers';
import { Modal } from './Modal';
import { SheetSprite } from './SheetSprite';

type Press = 'ticket-in' | 'press' | 'card-out' | 'idle';
type Chain = 'redeeming' | 'sent' | 'confirmed' | 'waiting' | 'failed';

export interface MintMomentProps {
  ticketId: string;
  explorer: string | null;
  onRetry: (ticketId: string) => void;
  onLedger: () => void;
  onClose: () => void;
}

export function MintMoment({ ticketId, explorer, onRetry, onLedger, onClose }: MintMomentProps) {
  const { audio } = useServices();
  const [press, setPress] = useState<Press>('ticket-in');
  const [chain, setChain] = useState<Chain>('redeeming');
  const [number, setNumber] = useState<number | null>(null);
  const [grade, setGrade] = useState<FeatherGrade | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [face, setFace] = useState<'down' | 'turning' | 'up' | 'stamped'>('down');
  const card = useRef<HTMLDivElement>(null);
  const out = press === 'idle';
  const big = grade === 'quill' || grade === 'golden-quill';

  // the chain's word on this ticket
  useEffect(
    () =>
      events.on((e) => {
        if (!('ticketId' in e) || e.ticketId !== ticketId) return;
        if (e.kind === 'ticketRedeemed') {
          setGrade(e.grade);
          setNumber(e.number);
        } else if (e.kind === 'mintSent') {
          setNumber(e.number);
          setGrade(e.grade);
          setChain((c) => (c === 'confirmed' ? c : 'sent'));
        } else if (e.kind === 'featherMinted') {
          setNumber(e.number);
          setGrade(e.grade);
          setTxHash(e.txHash);
          setChain('confirmed');
        } else if (e.kind === 'mintWaiting') {
          setNote(e.note);
          setChain('waiting');
        } else if (e.kind === 'mintFailed') {
          setNote(e.note);
          setChain('failed');
        }
      }),
    [ticketId],
  );

  // the press: ticket in, then the press with its thump, then the card out
  useEffect(() => {
    if (press === 'ticket-in') audio.play('17-card', { volume: 0.5 });
    if (press !== 'press') return;
    const t = setTimeout(() => {
      audio.play('18-stamp');
      audio.play('12-crate', { volume: 0.7 });
      juice.hitstop(90);
      juice.shake(4, 260);
    }, 160);
    return () => clearTimeout(t);
  }, [audio, press]);
  useEffect(() => {
    if (out && card.current) motion.enter(card.current);
  }, [out]);

  // confirmed (and the card out): the flip, then the stamp; once, its timers kept until unmount
  const flipped = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!out || chain !== 'confirmed' || flipped.current) return;
    flipped.current = true;
    timers.current.push(
      setTimeout(() => setFace('turning'), 350),
      setTimeout(() => {
        setFace('up');
        audio.play(big ? '11-golden' : '08-egg-pop', { volume: 0.8 });
        if (big) juice.shake(grade === 'golden-quill' ? 7 : 4, 520);
      }, 560),
      setTimeout(() => setFace('stamped'), 1150),
    );
  }, [audio, big, chain, grade, out]);
  useEffect(() => {
    if (face !== 'stamped') return;
    audio.play('18-stamp');
    juice.hitstop(big ? 140 : 70);
    juice.shake(big ? 6 : 2, big ? 420 : 220);
    if (big) audio.play('45-deal-closed', { delayMs: 240 });
  }, [audio, big, face]);
  // a failed mint stops the press: no card comes out
  useEffect(() => {
    if (chain !== 'failed') return;
    audio.play('20-fail', { volume: 0.6 });
    setPress('idle');
  }, [audio, chain]);

  const stage = (label: string, lit: boolean, ui: string) => (
    <span data-ui={ui} data-lit={lit ? '1' : '0'} style={{ color: lit ? '#2f6f9e' : '#a08860', lineHeight: '10px' }}>
      {lit ? '[X]' : '[ ]'} {label}
    </span>
  );
  const done = chain === 'confirmed' && face === 'stamped';
  const z = 2;
  return (
    <Modal title="MINTING YOUR FEATHER" onClose={onClose} w={440} h={300} className="reveal" dismiss={done || chain === 'failed' || chain === 'waiting'}>
      <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }} data-ui="mint-moment" data-chain={chain} data-face={face}>
        <SheetSprite
          id="x-mint-press"
          row={press}
          play={press === 'idle' ? 'loop' : 'once'}
          box={{ w: 86, h: 128 }}
          data-ui="mint-press"
          onDone={() => setPress((p) => (p === 'ticket-in' ? 'press' : p === 'press' ? 'card-out' : 'idle'))}
        />
        <div ref={card} style={{ position: 'relative', width: 48 * z, height: 68 * z, flex: 'none', visibility: out && chain !== 'failed' ? 'visible' : 'hidden' }}>
          <div className={`flip ${face === 'turning' ? 'turning' : ''}`} data-ui="mint-card">
            {face === 'down' || face === 'turning' || !grade || !number ? <UnmintedCard number={number ?? 0} z={z} /> : <FeatherCard grade={grade} number={number} z={z} row={face === 'up' ? 'shine' : 'float'} />}
          </div>
          {(face === 'up' || face === 'stamped') && big && (
            <>
              <SheetSprite id="35-particles" row="confetti" play="once" zoom={2} style={{ position: 'absolute', left: -28, top: 4 }} />
              <SheetSprite id="35-particles" row="confetti" play="once" zoom={2} style={{ position: 'absolute', right: -28, top: 40 }} />
              {grade === 'golden-quill' && <SheetSprite id="35-particles" row="sparkle" play="loop" zoom={2} style={{ position: 'absolute', left: 30, top: -10 }} />}
            </>
          )}
          {face === 'stamped' && (
            <div style={{ position: 'absolute', left: -16, top: -40, width: 128 }}>
              <CardStamp row="accepted" onDone={() => undefined} />
            </div>
          )}
        </div>
        <div className="col" style={{ gap: 4, flex: '1 1 150px', minWidth: 140 }}>
          {stage('TICKET IN', true, 'mint-stage-in')}
          {stage('PRESSED', chain !== 'failed' && (press === 'card-out' || out), 'mint-stage-pressed')}
          {/* the stages light in order: the chain may answer before the press is done */}
          {stage(`SENT TO NEAR${number ? `: FEATHER ${featherNo(number)}` : ''}`, out && (chain === 'sent' || chain === 'confirmed'), 'mint-stage-sent')}
          {stage('CONFIRMED', out && chain === 'confirmed', 'mint-stage-confirmed')}
          {chain === 'confirmed' && grade && number && (
            <span className="panel-title small" style={{ margin: 0, fontSize: 8, lineHeight: '10px' }} data-ui="mint-result">
              FEATHER {featherNo(number)} OF {ECONOMY.feathers.maxSupply}: {GRADE_LABEL[grade]}
            </span>
          )}
          {chain === 'confirmed' && explorer && txHash && (
            <a className="btn" href={`${explorer}${txHash}`} target="_blank" rel="noreferrer" data-ui="mint-receipt" style={{ alignSelf: 'flex-start' }}>
              RECEIPT ON THE EXPLORER
            </a>
          )}
          {chain === 'waiting' && (
            <span style={{ lineHeight: '10px' }} data-ui="mint-waiting">
              WAITING: {(note ?? '').toUpperCase()}. IT MINTS BY ITSELF AS SOON AS IT CAN.
            </span>
          )}
          {chain === 'failed' && (
            <span className="down" style={{ lineHeight: '10px' }} data-ui="mint-failed">
              THE MINT DID NOT GO THROUGH ({(note ?? '').toUpperCase()}). YOUR TICKET IS SAFE AND YOUR {ECONOMY.feathers.redeemFee} COINS ARE BACK.
            </span>
          )}
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {chain === 'failed' && (
              <button
                className="btn red"
                data-ui="mint-retry"
                onClick={() => {
                  uiSound(audio, 'click');
                  onRetry(ticketId);
                }}
              >
                RETRY
              </button>
            )}
            {done && (
              <button
                className="btn"
                onClick={() => {
                  uiSound(audio, 'click');
                  onLedger();
                }}
              >
                LEDGER
              </button>
            )}
            {(done || chain === 'failed' || chain === 'waiting') && (
              <button
                className="btn"
                data-ui="mint-moment-close"
                onClick={() => {
                  uiSound(audio, 'click');
                  onClose();
                }}
              >
                CLOSE
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
