// The ledger: day-by-day profit, contracts and debts, and the on-chain receipt for each settled day.
import { useEffect } from 'react';
import type { FarmState } from '@coys/shared';
import { useServices } from '../app/services';
import type { Action } from '../net/socket';
import { game } from '../state/game';
import { useStore } from '../state/store';
import { Panel } from './Panels';

const coins = (milli: number): string => (milli / 1000).toFixed(2);

export function LedgerPanel({ farm, send, onClose }: { farm: FarmState; send: (a: Action) => Promise<boolean>; onClose: () => void }) {
  const { audio } = useServices();
  const days = useStore(game, (s) => s.ledger);
  const explorer = useStore(game, (s) => s.market?.explorer ?? null);
  useEffect(() => {
    void send({ t: 'getLedger' });
    audio.play('13-tray', { volume: 0.5 });
  }, [send, audio]);
  return (
    <Panel title="LEDGER" x={60} y={40} w={384} h={286} onClose={onClose}>
      <div className="row spread" style={{ color: '#8b5a2b', marginBottom: 4 }}>
        <span style={{ width: 40 }}>DAY</span>
        <span style={{ width: 60, textAlign: 'right' }}>IN</span>
        <span style={{ width: 60, textAlign: 'right' }}>OUT</span>
        <span style={{ width: 60, textAlign: 'right' }}>NET</span>
        <span style={{ width: 90, textAlign: 'right' }}>RECEIPT</span>
      </div>
      <div className="col" style={{ gap: 3, height: 150, overflowY: 'auto' }}>
        {!days && <span>OPENING THE BOOKS</span>}
        {days?.map((d) => (
          <div key={d.day} className="row spread">
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
        ))}
      </div>
      <div className="col" style={{ gap: 3, marginTop: 6 }}>
        <span className="panel-title" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }}>
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
      </div>
    </Panel>
  );
}
