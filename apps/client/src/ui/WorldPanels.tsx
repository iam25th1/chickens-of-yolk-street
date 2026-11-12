// Cards that open when the player clicks something on the farm (a hen, the crate, a machine), and
// the certificate moment when a day close records one of the player's hens on NEAR.
import { useEffect } from 'react';
import { ECONOMY, UNLOCK_IDS, type FarmState, type HenView, type MarketState, type UnlockId } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import type { Action } from '../net/socket';
import { CardStamp, SellCard } from './Cards';
import { Modal } from './Modal';
import { HenArt, MachineArt, UNLOCK_TEXT } from './Panels';

const WORDS: Record<string, string> = {
  cream: 'CREAM FEATHERS',
  brown: 'BROWN FEATHERS',
  black: 'BLACK FEATHERS',
  sleepy: 'SLEEPY EYES',
  wild: 'WILD EYES',
  default: '',
  spiky: 'SPIKY COMB',
  mohawk: 'MOHAWK COMB',
  nub: 'LITTLE NUB COMB',
  tophat: 'TOP HAT',
  bowtie: 'BOW TIE',
  shades: 'SHADES',
  none: '',
};

export const traitWords = (hen: HenView): string[] => [WORDS[hen.body], WORDS[hen.eyes], WORDS[hen.comb], WORDS[hen.accessory]].filter((w): w is string => Boolean(w));

/** How a hen lays compared with an ordinary one, in words. */
export function layingWords(trait: number): string {
  const pct = Math.round((trait - 1) * 100);
  if (Math.abs(pct) < 3) return 'LAYS LIKE AN ORDINARY HEN';
  return pct > 0 ? `LAYS ${pct}% MORE THAN AN ORDINARY HEN` : `LAYS ${-pct}% LESS THAN AN ORDINARY HEN`;
}

/** Her certificate, in plain words: recorded on NEAR (with the receipt), pending, or not kept on chain here. */
function certificateWords(hen: HenView, minting: MarketState['minting']): string {
  if (hen.chainOwner) return `CERTIFICATE HEN-${hen.id.slice(0, 8).toUpperCase()}: RECORDED ON NEAR ON DAY ${hen.mintDay ?? '?'}. SHE IS YOURS FOR GOOD.`;
  if (minting === 'paused') return 'CERTIFICATE PENDING: RECORDING ON NEAR IS PAUSED FOR NOW. SHE LAYS JUST THE SAME.';
  if (minting === 'off') return 'THIS GAME DOES NOT RECORD HENS ON NEAR.';
  return 'CERTIFICATE PENDING: AT A DAY CLOSE SHE IS RECORDED ON NEAR AS YOURS FOR GOOD.';
}

export function HenPanel({ hen, market, onClose }: { hen: HenView; market: MarketState; onClose: () => void }) {
  return (
    <Modal title="YOUR HEN" onClose={onClose} w={340} h={210}>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <div style={{ background: '#e3cc96', padding: 4, flex: 'none' }}>
          <HenArt hen={hen} scale={2} box={{ w: 72, h: 72 }} />
        </div>
        <div className="col" style={{ gap: 5 }}>
          {traitWords(hen).map((t) => (
            <span key={t}>{t}</span>
          ))}
          <span>{layingWords(hen.layingTrait)}</span>
          <span>
            {hen.ageDays} {hen.ageDays === 1 ? 'DAY' : 'DAYS'} OLD
          </span>
        </div>
      </div>
      <p style={{ marginTop: 10, lineHeight: '10px', color: '#8b5a2b' }} data-tour="hen-certificate">
        {certificateWords(hen, market.minting)}
      </p>
      {hen.mintTx && market.explorer && (
        <a href={`${market.explorer}${hen.mintTx}`} target="_blank" rel="noreferrer" style={{ color: '#2f6f9e' }}>
          SEE HER RECEIPT
        </a>
      )}
    </Modal>
  );
}

export function SellPanel({ farm, market, send, onClose }: { farm: FarmState; market: MarketState; send: (a: Action) => Promise<boolean>; onClose: () => void }) {
  return (
    <Modal title="THE CRATE" onClose={onClose} w={300} h={226}>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <SellCard farm={farm} market={market} send={send} tour="sell-modal" />
        <span style={{ lineHeight: '10px' }}>COLLECTED EGGS WAIT HERE. SELL THEM AT TODAY&apos;S PRICE, WHICH THE WHOLE STREET&apos;S SELLING SETS.</span>
      </div>
    </Modal>
  );
}

export function MachinePanel({ unlock, farm, onShop, onClose }: { unlock: UnlockId; farm: FarmState; onShop: () => void; onClose: () => void }) {
  const t = UNLOCK_TEXT[unlock];
  const next = UNLOCK_IDS.find((u) => !farm.unlocks.includes(u));
  return (
    <Modal title={t.name} onClose={onClose} w={320} h={170}>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <div style={{ width: 40, display: 'flex', justifyContent: 'center', flex: 'none' }}>
          <MachineArt unlock={unlock} />
        </div>
        <div className="col" style={{ gap: 5 }} data-tour="machine-saves">
          <span style={{ lineHeight: '10px' }}>{t.saves}</span>
          <span>{farm.unlocks.includes(unlock) ? 'WORKING ON YOUR FARM' : `COSTS ${ECONOMY.unlocks[unlock].price} COINS`}</span>
          <span>{next ? `NEXT MACHINE: ${UNLOCK_TEXT[next].name}, ${ECONOMY.unlocks[next].price} COINS` : 'EVERY MACHINE IS BUILT'}</span>
        </div>
      </div>
      {next && (
        <button className="btn red" style={{ marginTop: 10 }} onClick={onShop}>
          SEE MACHINES IN THE SHOP
        </button>
      )}
    </Modal>
  );
}

/** The certificate moment: her portrait and traits, a stamp, and one plain line with the receipt. */
export function CertificatePanel({ hen, txHash, day, market, onLedger, onClose }: { hen: HenView; txHash: string; day: number; market: MarketState; onLedger: () => void; onClose: () => void }) {
  const { audio } = useServices();
  useEffect(() => {
    audio.play('19-haggle-win', { volume: 0.6 });
    audio.play('18-stamp', { delayMs: 420 });
  }, [audio]);
  return (
    <Modal title="A HEN FOR GOOD" onClose={onClose} w={300} h={250} className="certificate">
      <div className="col" style={{ alignItems: 'center', gap: 6 }}>
        <div style={{ position: 'relative', width: 128, height: 88, display: 'flex', justifyContent: 'center' }}>
          <div style={{ background: '#e3cc96', padding: 4 }}>
            <HenArt hen={hen} scale={2} box={{ w: 72, h: 72 }} />
          </div>
          <div style={{ position: 'absolute', left: 0, top: -100 }}>
            <CardStamp row="accepted" onDone={() => undefined} />
          </div>
        </div>
        <span className="panel-title small" style={{ margin: 0 }}>
          HEN-{hen.id.slice(0, 8).toUpperCase()}
        </span>
        <span>{traitWords(hen).join(', ') || 'A CLASSIC HEN'}</span>
        <span>{layingWords(hen.layingTrait)}</span>
        <p className="meaning">SHE IS NOW PERMANENTLY YOURS ON NEAR. HER RECEIPT IS IN THE LEDGER FOR DAY {day}.</p>
        <div className="row" style={{ gap: 6 }}>
          <button
            className="btn red"
            onClick={() => {
              uiSound(audio, 'click');
              onLedger();
            }}
          >
            OPEN THE LEDGER
          </button>
          {market.explorer && (
            <a className="btn" href={`${market.explorer}${txHash}`} target="_blank" rel="noreferrer">
              RECEIPT
            </a>
          )}
        </div>
      </div>
    </Modal>
  );
}
