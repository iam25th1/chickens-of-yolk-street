// Cards that open when the player clicks something on the farm: a hen, the crate, a machine.
import { ECONOMY, UNLOCK_IDS, type FarmState, type HenView, type MarketState, type UnlockId } from '@coys/shared';
import { useServices } from '../app/services';
import type { Action } from '../net/socket';
import { henLayers } from '../pixi/farm/HenActor';
import { SellCard } from './Cards';
import { Panel, UNLOCK_TEXT } from './Panels';
import { SheetSprite } from './SheetSprite';

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

/** How a hen lays compared with an ordinary one, in words. */
function layingWords(trait: number): string {
  const pct = Math.round((trait - 1) * 100);
  if (Math.abs(pct) < 3) return 'LAYS LIKE AN ORDINARY HEN';
  return pct > 0 ? `LAYS ${pct}% MORE THAN AN ORDINARY HEN` : `LAYS ${-pct}% LESS THAN AN ORDINARY HEN`;
}

export function HenPanel({ hen, onClose }: { hen: HenView; onClose: () => void }) {
  const { assets } = useServices();
  const traits = [WORDS[hen.body], WORDS[hen.eyes], WORDS[hen.comb], WORDS[hen.accessory]].filter(Boolean);
  const chain = hen.chainOwner
    ? `ON NEAR TESTNET AS NFT HEN-${hen.id.slice(0, 8).toUpperCase()}, HELD BY ${hen.chainOwner.toUpperCase()}`
    : 'NOT ON CHAIN YET: SHE IS MINTED AS AN NFT AT A DAY CLOSE, ONCE YOUR FARM HAS A WALLET';
  return (
    <Panel title="YOUR HEN" x={170} y={70} w={300} h={196} onClose={onClose}>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <img alt="" className="sprite" width={64} height={64} style={{ background: '#e3cc96', flex: 'none' }} src={assets.henPortrait(henLayers(hen), 2)} />
        <div className="col" style={{ gap: 5 }}>
          {traits.map((t) => (
            <span key={t}>{t}</span>
          ))}
          <span>{layingWords(hen.layingTrait)}</span>
          <span>
            {hen.ageDays} {hen.ageDays === 1 ? 'DAY' : 'DAYS'} OLD
          </span>
        </div>
      </div>
      <p style={{ marginTop: 10, lineHeight: '10px', color: '#8b5a2b' }}>{chain}</p>
    </Panel>
  );
}

export function SellPanel({ farm, market, send, onClose }: { farm: FarmState; market: MarketState; send: (a: Action) => Promise<boolean>; onClose: () => void }) {
  return (
    <Panel title="THE CRATE" x={244} y={60} w={152} h={232} onClose={onClose}>
      <div style={{ position: 'relative', height: 186 }}>
        <SellCard farm={farm} market={market} send={send} />
      </div>
    </Panel>
  );
}

export function MachinePanel({ unlock, farm, onShop, onClose }: { unlock: UnlockId; farm: FarmState; onShop: () => void; onClose: () => void }) {
  const t = UNLOCK_TEXT[unlock];
  const next = UNLOCK_IDS.find((u) => !farm.unlocks.includes(u));
  return (
    <Panel title={t.name} x={180} y={90} w={280} h={150} onClose={onClose}>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <SheetSprite id={t.sprite} row={t.row} zoom={unlock === 'conveyor' ? 2 : 0.5} />
        <div className="col" style={{ gap: 5 }}>
          <span>WHAT IT DOES: {t.effect}</span>
          <span>{farm.unlocks.includes(unlock) ? 'WORKING ON YOUR FARM' : `COSTS ${ECONOMY.unlocks[unlock].price} COINS`}</span>
          <span>{next ? `NEXT MACHINE: ${UNLOCK_TEXT[next].name}, ${ECONOMY.unlocks[next].price} COINS` : 'EVERY MACHINE IS BUILT'}</span>
        </div>
      </div>
      {next && (
        <button className="btn red" style={{ marginTop: 10 }} onClick={onShop}>
          SEE MACHINES IN THE SHOP
        </button>
      )}
    </Panel>
  );
}
