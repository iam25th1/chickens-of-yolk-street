// The side panel: the crate's sell card, the glut notice, waiting cards (a queue with a count; only
// one opens at a time, as a modal), and the desk: contracts with their delivery button, feed credit
// owed, recent answers and the sales clerk's floor.
import { ECONOMY, type CardView, type FarmState, type MarketState } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import type { Rect } from '../app/viewport';
import type { Action } from '../net/socket';
import { dayElapsed } from '../state/game';
import { GlutNotice, SellCard } from './Cards';
import { CARD_TITLE } from './cast';

const coins = (milli: number): string => (milli / 1000).toFixed(2);

/** Cards that have arrived and still wait for an answer. */
export function waitingCards(farm: FarmState): CardView[] {
  const now = dayElapsed();
  return farm.cards.filter((c) => c.status === 'open' && c.arriveAtMs <= now);
}

export function SidePanel({
  farm,
  market,
  rect,
  send,
  onOpen,
}: {
  farm: FarmState;
  market: MarketState;
  rect: Rect;
  send: (a: Action) => Promise<boolean>;
  onOpen: (card: CardView) => void;
}) {
  const { audio } = useServices();
  const waiting = waitingCards(farm);
  const closed = farm.cards.filter((c) => c.status !== 'open');
  const hasClerk = farm.unlocks.includes('clerk');
  const click = (fn: () => void) => () => {
    uiSound(audio, 'click');
    fn();
  };
  return (
    <div className="side zone" data-ui="side" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <SellCard farm={farm} market={market} send={send} tour="sell" />
      <div className="side-section" style={{ flex: 1, minWidth: 120 }}>
        {market.crash && <GlutNotice market={market} />}
        <div className="side-title">
          <span>CARDS WAITING</span>
          <span data-tour="card-count">{waiting.length}</span>
        </div>
        {waiting.length === 0 && <span style={{ color: '#e3cc96' }}>NONE RIGHT NOW</span>}
        {waiting.slice(0, 3).map((c, i) => (
          <button
            key={c.id}
            className={`btn ${i === 0 ? 'red' : ''}`}
            data-tour={i === 0 ? 'card-queue' : undefined}
            style={{ justifyContent: 'space-between', width: '100%' }}
            onMouseEnter={() => uiSound(audio, 'hover')}
            onClick={click(() => onOpen(c))}
          >
            <span>{CARD_TITLE[c.kind].split(' ')[0]}</span>
            <span>{c.from.split(' ').slice(-1)[0]?.toUpperCase()}</span>
          </button>
        ))}
        {waiting.length > 3 && <span style={{ color: '#e3cc96' }}>AND {waiting.length - 3} MORE</span>}
        <div className="col desk" style={{ gap: 3 }}>
          <span className="side-title">
            <span>TODAY</span>
            <span>
              {farm.cards.length}/{ECONOMY.cards.maxPerDay} CARDS
            </span>
          </span>
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
            <div className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
              <span>CLERK TAKES {Math.round(farm.clerkFloor * 100)}%+</span>
              <button className="btn" onClick={click(() => void send({ t: 'setClerkFloor', floor: Math.max(ECONOMY.clerk.minFloor, Math.round((farm.clerkFloor - 0.05) * 100) / 100) }))}>
                -
              </button>
              <button className="btn" onClick={click(() => void send({ t: 'setClerkFloor', floor: Math.min(ECONOMY.clerk.maxFloor, Math.round((farm.clerkFloor + 0.05) * 100) / 100) }))}>
                +
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
