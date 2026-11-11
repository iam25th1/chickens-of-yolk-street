// The desk in the card tray: today's cards (reopen any open one), standing contracts with their
// delivery button, feed credit owed, and the sales clerk's floor.
import { ECONOMY, type CardView, type FarmState } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import type { Action } from '../net/socket';
import { CARD_TITLE } from './cast';

const coins = (milli: number): string => (milli / 1000).toFixed(2);

export function Desk({ farm, send, onOpen }: { farm: FarmState; send: (a: Action) => Promise<boolean>; onOpen: (card: CardView) => void }) {
  const { audio } = useServices();
  const open = farm.cards.filter((c) => c.status === 'open');
  const closed = farm.cards.filter((c) => c.status !== 'open');
  const hasClerk = farm.unlocks.includes('clerk');
  const click = (fn: () => void) => () => {
    uiSound(audio, 'click');
    fn();
  };
  return (
    <div className="col" style={{ position: 'absolute', left: 6, top: 186, width: 122, height: 130, overflowY: 'auto', gap: 3, color: '#f6e7c1' }}>
      <span className="display small" style={{ fontSize: 8, lineHeight: '8px', color: '#f2c94c' }}>
        TODAY {farm.cards.length}/{ECONOMY.cards.maxPerDay} CARDS
      </span>
      {open.map((c) => (
        <button key={c.id} className="btn" style={{ justifyContent: 'space-between', width: '100%' }} onMouseEnter={() => uiSound(audio, 'hover')} onClick={click(() => onOpen(c))}>
          <span>{CARD_TITLE[c.kind].split(' ')[0]}</span>
          <span>{c.from.split(' ').slice(-1)[0]?.toUpperCase()}</span>
        </button>
      ))}
      {closed.slice(-3).map((c) => (
        <span key={c.id} style={{ color: c.status === 'won' || c.status === 'accepted' ? '#8fd36a' : '#e3cc96' }}>
          {CARD_TITLE[c.kind].split(' ')[0]} {c.status.toUpperCase()}
        </span>
      ))}
      {farm.contracts.map((k) => (
        <div key={k.id} className="col" style={{ gap: 2 }}>
          <span>
            {k.agentName.split(' ').slice(-1)[0]?.toUpperCase()} {k.qtyPerDay}/DAY {coins(k.priceMilli)} {k.daysLeft}D
          </span>
          <button className="btn red" disabled={k.deliveredToday} onClick={click(() => void send({ t: 'deliverContract', contractId: k.id }))}>
            {k.deliveredToday ? 'DELIVERED' : farm.unlocks.includes('cart') ? 'CART AT DUSK' : 'DELIVER'}
          </button>
        </div>
      ))}
      {farm.debts
        .filter((d) => d.status !== 'paid')
        .map((d) => (
          <span key={d.id} style={{ color: d.status === 'defaulted' ? '#ff8a6a' : '#f6e7c1' }}>
            OWE {coins(d.dueMilli)} DAY {d.dueDay}
          </span>
        ))}
      {hasClerk && (
        <div className="row" style={{ gap: 2 }}>
          <span>CLERK X{farm.clerkFloor.toFixed(2)}</span>
          <button className="btn" onClick={click(() => void send({ t: 'setClerkFloor', floor: Math.max(ECONOMY.clerk.minFloor, Math.round((farm.clerkFloor - 0.05) * 100) / 100) }))}>
            -
          </button>
          <button className="btn" onClick={click(() => void send({ t: 'setClerkFloor', floor: Math.min(ECONOMY.clerk.maxFloor, Math.round((farm.clerkFloor + 0.05) * 100) / 100) }))}>
            +
          </button>
        </div>
      )}
    </div>
  );
}
