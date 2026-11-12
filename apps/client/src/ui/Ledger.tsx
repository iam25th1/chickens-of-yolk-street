// The ledger: day-by-day profit, contracts and debts, the on-chain receipt for each settled day, and
// each hen's certificate receipt.
import { useEffect } from 'react';
import type { FarmState, LedgerDay } from '@coys/shared';
import { useServices } from '../app/services';
import type { Action } from '../net/socket';
import { game } from '../state/game';
import { useStore } from '../state/store';
import { Modal } from './Modal';
import { MILESTONE_TEXT } from './HowToPlay';

const coins = (milli: number): string => (milli / 1000).toFixed(2);

/** A day's machine work in one line: what the hopper saved, the grader and clerk added, the conveyor carried. */
function machineLine(m: NonNullable<LedgerDay['machines']>): string {
  const parts: string[] = [];
  if (m.hopper?.milli) parts.push(`HOPPER -10%: SAVED ${coins(m.hopper.milli)}`);
  if (m.grader?.milli) parts.push(`GRADER +${coins(m.grader.milli)}`);
  if (m.clerk?.milli) parts.push(`CLERK +${coins(m.clerk.milli)}`);
  if (m.cart?.units) parts.push(`CART ${m.cart.units} EGGS`);
  if (m.conveyor?.units) parts.push(`BELT ${m.conveyor.units} EGGS, ${m.conveyor.saved} SAVED`);
  return parts.join(', ');
}

export function LedgerPanel({ farm, send, onClose }: { farm: FarmState; send: (a: Action) => Promise<boolean>; onClose: () => void }) {
  const { audio } = useServices();
  const days = useStore(game, (s) => s.ledger);
  const explorer = useStore(game, (s) => s.market?.explorer ?? null);
  const season = useStore(game, (s) => s.market?.season ?? '');
  useEffect(() => {
    void send({ t: 'getLedger' });
    audio.play('13-tray', { volume: 0.5 });
  }, [send, audio]);
  return (
    <Modal title={season ? `LEDGER, SEASON ${season.toUpperCase()}` : 'LEDGER'} onClose={onClose} w={400} h={300}>
      <span style={{ lineHeight: '10px', color: '#8b5a2b', display: 'block', marginBottom: 4 }} data-tour="ledger-days">
        EACH DAY CLOSES WITH A RECEIPT: WHAT CAME IN, WHAT WENT OUT, AND THE DAY&apos;S RECORD ON NEAR.
      </span>
      <div className="row spread" style={{ color: '#8b5a2b', marginBottom: 4 }}>
        <span style={{ width: 40 }}>DAY</span>
        <span style={{ width: 60, textAlign: 'right' }}>IN</span>
        <span style={{ width: 60, textAlign: 'right' }}>OUT</span>
        <span style={{ width: 60, textAlign: 'right' }}>NET</span>
        <span style={{ width: 90, textAlign: 'right' }}>RECEIPT</span>
      </div>
      <div className="col" style={{ gap: 3, maxHeight: 120, overflowY: 'auto' }}>
        {!days && <span>OPENING THE BOOKS</span>}
        {days?.map((d) => (
          <div key={d.day} className="col" style={{ gap: 1 }}>
          <div className="row spread">
            <span style={{ width: 40 }}>{d.day}</span>
            <span style={{ width: 60, textAlign: 'right' }}>{coins(d.incomeMilli)}</span>
            <span style={{ width: 60, textAlign: 'right' }}>{coins(d.costMilli)}</span>
            <span style={{ width: 60, textAlign: 'right' }} className={d.netMilli >= 0 ? 'up' : 'down'}>
              {coins(d.netMilli)}
            </span>
            <span style={{ width: 90, textAlign: 'right' }}>
              {d.settlement?.txHash && explorer ? (
                <a href={`${explorer}${d.settlement.txHash}`} target="_blank" rel="noreferrer" style={{ color: '#2f6f9e' }}>
                  ON-CHAIN RECEIPT
                </a>
              ) : (
                <span style={{ color: '#b8743a' }}>{d.settlement?.status === 'noop' ? 'LOCAL ONLY' : d.settlement?.status === 'failed' ? 'RETRYING' : 'PENDING'}</span>
              )}
            </span>
          </div>
          {d.machines && Object.keys(d.machines).length > 0 && (
            <span style={{ color: '#2f6f9e', paddingLeft: 40, lineHeight: '9px' }}>{machineLine(d.machines)}</span>
          )}
          </div>
        ))}
      </div>
      <div className="col" style={{ gap: 3, marginTop: 6 }}>
        <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
          CONTRACTS AND DEBTS
        </span>
        {farm.contracts.length === 0 && farm.debts.length === 0 && <span>NONE OPEN</span>}
        {farm.contracts.map((k) => (
          <span key={k.id}>
            {k.agentName.toUpperCase()}: {k.qtyPerDay} {k.grade === 'any' ? 'EGGS' : k.grade.toUpperCase()} A DAY AT {coins(k.priceMilli)}, {k.daysLeft} DAYS LEFT, {k.misses} MISSED
          </span>
        ))}
        {farm.debts.map((d) => (
          <span key={d.id}>
            {d.agentName.toUpperCase()}: {coins(d.dueMilli)} DUE DAY {d.dueDay} ({d.status.toUpperCase()})
          </span>
        ))}
        <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: '4px 0 0' }}>
          FOUNDING HEN CERTIFICATES
        </span>
        {farm.hens.filter((h) => h.mintTx).length === 0 && <span>NONE YET: FOUNDING HENS ARE WON AT MILESTONES</span>}
        {farm.hens
          .filter((h) => h.mintTx)
          .map((h) => (
            <span key={h.id} className="row spread">
              <span>
                {h.founding?.number ? `FOUNDING HEN #${h.founding.number}` : `HEN-${h.id.slice(0, 8).toUpperCase()}`} DAY {h.mintDay ?? '?'}
              </span>
              {explorer && h.mintTx ? (
                <a href={`${explorer}${h.mintTx}`} target="_blank" rel="noreferrer" style={{ color: '#2f6f9e' }}>
                  RECEIPT
                </a>
              ) : null}
            </span>
          ))}
        <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: '4px 0 0' }} data-ui="milestones">
          MILESTONES
        </span>
        <span style={{ lineHeight: '10px', color: farm.standing.good ? '#2f6f9e' : '#b8321f' }}>
          {farm.standing.good ? 'IN GOOD STANDING: EACH MILESTONE GIVES ONE CHANCE AT A FOUNDING HEN.' : `NOT IN GOOD STANDING (${farm.standing.reasons.join(', ').toUpperCase()}): MILESTONES WAIT.`}
        </span>
        {farm.milestones.map((m) => (
          <span key={m.id} className="row spread">
            <span>{MILESTONE_TEXT[m.id]}</span>
            <span>{m.state === 'open' ? 'TO DO' : m.state === 'won' ? `WON DAY ${m.day}` : `TRIED DAY ${m.day}`}</span>
          </span>
        ))}
      </div>
    </Modal>
  );
}
