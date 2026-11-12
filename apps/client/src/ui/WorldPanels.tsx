// Cards that open when the player clicks something on the farm (a hen, the crate, a machine).
import { ECONOMY, UNLOCK_IDS, type FarmState, type HenView, type MarketState, type UnlockId } from '@coys/shared';
import type { Action } from '../net/socket';
import { SellCard } from './Cards';
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

/** Every hen is an ordinary hen: hens are never minted. Feathers, won as tickets at milestones, are. */
export const HEN_CHAIN_LINE = 'AN ORDINARY HEN: HENS ARE NEVER MINTED. FEATHERS ARE: WIN A TICKET AT A MILESTONE AND REDEEM IT ON THE MINT PAGE (BETA, NEAR TEST NETWORK).';

export function HenPanel({ hen, onClose }: { hen: HenView; onClose: () => void }) {
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
        {HEN_CHAIN_LINE}
      </p>
    </Modal>
  );
}

export function SellPanel({ farm, market, send, onClose }: { farm: FarmState; market: MarketState; send: (a: Action) => Promise<boolean>; onClose: () => void }) {
  return (
    <Modal title="THE CRATE" onClose={onClose} w={300} h={226}>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <SellCard farm={farm} market={market} send={send} tour="sell-modal" />
        <span className="col" style={{ gap: 6 }}>
          <span style={{ lineHeight: '10px' }}>COLLECTED EGGS WAIT HERE. SELL THEM AT TODAY&apos;S PRICE, WHICH THE WHOLE STREET&apos;S SELLING SETS.</span>
          {farm.unlocks.includes('grader') && <span style={{ color: '#2f6f9e', lineHeight: '10px' }}>THE GRADER ADDS +10% TO EVERY EGG (IN THE PRICES SHOWN).</span>}
          {farm.unlocks.includes('clerk') && <span style={{ color: '#2f6f9e', lineHeight: '10px' }}>THE SALES CLERK ADDS +5% TO THE TOTAL.</span>}
        </span>
      </div>
    </Modal>
  );
}

const c2 = (milli: number): string => (milli / 1000).toFixed(2);

/** What a machine did today, in plain words. */
export function machineToday(unlock: UnlockId, farm: FarmState): string {
  const m = farm.machines?.[unlock];
  const n = m?.units ?? 0;
  switch (unlock) {
    case 'conveyor':
      return `TODAY IT CARRIED ${n} EGG${n === 1 ? '' : 'S'} TO THE CRATE AND KEPT ${m?.saved ?? 0} FROM CRACKING.`;
    case 'grader':
      return `TODAY IT GRADED ${n} EGG${n === 1 ? '' : 'S'} FOR ${c2(m?.milli ?? 0)} MORE COINS.`;
    case 'cart':
      return n ? `TODAY IT DELIVERED ${n} EGGS FOR ${c2(m?.milli ?? 0)} COINS.` : 'NO DELIVERY YET TODAY: IT TAKES YOUR CONTRACT EGGS AT DUSK.';
    case 'hopper':
      return n ? `TODAY IT POURED ${n} BAG${n === 1 ? '' : 'S'} AND SAVED ${c2(m?.milli ?? 0)} COINS.` : 'NO POURING TODAY: THE TROUGH IS FULL ENOUGH.';
    case 'clerk':
      return `TODAY IT TOOK ${n} OFFER${n === 1 ? '' : 'S'} AND ADDED ${c2(m?.milli ?? 0)} COINS TO YOUR SALES.`;
  }
}

export function MachinePanel({ unlock, farm, send, onShop, onClose }: { unlock: UnlockId; farm: FarmState; send: (a: Action) => Promise<boolean>; onShop: () => void; onClose: () => void }) {
  const t = UNLOCK_TEXT[unlock];
  const next = UNLOCK_IDS.find((u) => !farm.unlocks.includes(u));
  const owned = farm.unlocks.includes(unlock);
  const listCap = ECONOMY.feed.tiers[farm.feedTier].bagPrice;
  const cap = farm.hopperCapMilli > 0 ? farm.hopperCapMilli / 1000 : listCap;
  return (
    <Modal title={t.name} onClose={onClose} w={340} h={210}>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <div style={{ width: 40, display: 'flex', justifyContent: 'center', flex: 'none' }}>
          <MachineArt unlock={unlock} />
        </div>
        <div className="col" style={{ gap: 5 }} data-tour="machine-saves">
          <span style={{ lineHeight: '10px' }}>{t.saves}</span>
          <span>{owned ? 'WORKING ON YOUR FARM' : `COSTS ${ECONOMY.unlocks[unlock].price} COINS`}</span>
          {owned && (
            <span style={{ lineHeight: '10px', color: '#2f6f9e' }} data-tour="machine-today">
              {machineToday(unlock, farm)}
            </span>
          )}
          {owned && unlock === 'hopper' && (
            <span className="row" style={{ gap: 3 }}>
              <span>POURS UP TO {cap.toFixed(0)} A BAG</span>
              <button className="btn" aria-label="Lower the cap" onClick={() => void send({ t: 'setHopperCap', cap: Math.max(1, cap - 5) })}>
                -
              </button>
              <button className="btn" aria-label="Raise the cap" onClick={() => void send({ t: 'setHopperCap', cap: Math.min(1000, cap + 5) })}>
                +
              </button>
            </span>
          )}
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
