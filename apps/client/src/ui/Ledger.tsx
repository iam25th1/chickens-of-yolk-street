// The ledger: day-by-day profit, contracts and debts, the on-chain receipt for each settled day, and
// the farm's Feathers and milestones, in tabs; each list is paged to fit (never a scrollbar).
import { useEffect, useState } from 'react';
import type { FarmState, LedgerDay } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import type { Action } from '../net/socket';
import { game } from '../state/game';
import { useStore } from '../state/store';
import { Modal } from './Modal';
import { MILESTONE_TEXT } from './HowToPlay';
import { Paged } from './Paged';

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

type LedgerTab = 'days' | 'contracts' | 'feathers' | 'milestones';

const LEDGER_TABS: [LedgerTab, string][] = [
  ['days', 'DAYS'],
  ['contracts', 'CONTRACTS'],
  ['feathers', 'FEATHERS'],
  ['milestones', 'MILESTONES'],
];

export function LedgerPanel({ farm, send, onClose }: { farm: FarmState; send: (a: Action) => Promise<boolean>; onClose: () => void }) {
  const { audio } = useServices();
  const days = useStore(game, (s) => s.ledger);
  const explorer = useStore(game, (s) => s.market?.explorer ?? null);
  const season = useStore(game, (s) => s.market?.season ?? '');
  const [tab, setTab] = useState<LedgerTab>('days');
  useEffect(() => {
    void send({ t: 'getLedger' });
    audio.play('13-tray', { volume: 0.5 });
  }, [send, audio]);
  // one block per day, paged to fit
  const dayRows = (days ?? []).map((d) => (
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
            // days settle together, ten to a call: the receipt names its range
            <a href={`${explorer}${d.settlement.txHash}`} target="_blank" rel="noreferrer" style={{ color: '#2f6f9e' }} title="On-chain receipt">
              {d.settlement.first && d.settlement.last && d.settlement.last > d.settlement.first ? `DAYS ${d.settlement.first}-${d.settlement.last}` : 'ON-CHAIN RECEIPT'}
            </a>
          ) : (
            <span style={{ color: '#b8743a' }}>
              {d.settlement?.status === 'noop' ? 'LOCAL ONLY' : d.settlement?.status === 'failed' ? 'RETRYING' : d.settlement?.status === 'batched' ? 'IN A BATCH' : 'PENDING'}
            </span>
          )}
        </span>
      </div>
      {d.machines && Object.keys(d.machines).length > 0 && <span style={{ color: '#2f6f9e', paddingLeft: 40, lineHeight: '9px' }}>{machineLine(d.machines)}</span>}
    </div>
  ));
  const contracts = [
    ...farm.contracts.map((k) => (
      <span key={k.id}>
        {k.agentName.toUpperCase()}: {k.qtyPerDay} {k.grade === 'any' ? 'EGGS' : k.grade.toUpperCase()} A DAY AT {coins(k.priceMilli)}, {k.daysLeft} DAYS LEFT, {k.misses} MISSED
      </span>
    )),
    ...farm.debts.map((d) => (
      <span key={d.id}>
        {d.agentName.toUpperCase()}: {coins(d.dueMilli)} DUE DAY {d.dueDay} ({d.status.toUpperCase()})
      </span>
    )),
  ];
  const tickets = farm.tickets.map((t) => (
    <span key={t.id} className="row spread" style={{ gap: 6 }}>
      <span style={{ lineHeight: '9px' }}>
        {t.status === 'minted' && t.number
          ? `FEATHER #${String(t.number).padStart(3, '0')} (${(t.grade ?? '').toUpperCase().replace('-', ' ')}) DAY ${t.mintDay ?? '?'}`
          : t.status === 'queued'
            ? `TICKET (${MILESTONE_TEXT[t.milestone]}): ${t.mint?.state === 'waiting' ? 'ITS MINT WAITS' : 'MINTING ON NEAR TESTNET'}`
            : `TICKET (${MILESTONE_TEXT[t.milestone]}): HELD, MINT IT IN THE FEATHER MINT`}
      </span>
      {explorer && t.mintTx ? (
        <a href={`${explorer}${t.mintTx}`} target="_blank" rel="noreferrer" style={{ color: '#2f6f9e' }}>
          RECEIPT
        </a>
      ) : null}
    </span>
  ));
  const milestones = [
    <span key="standing" style={{ lineHeight: '10px', color: farm.standing.good ? '#2f6f9e' : '#b8321f' }}>
      {farm.standing.good ? 'IN GOOD STANDING: EACH MILESTONE GIVES ONE CHANCE AT A FEATHER TICKET.' : `NOT IN GOOD STANDING (${farm.standing.reasons.join(', ').toUpperCase()}): MILESTONES WAIT.`}
    </span>,
    ...farm.milestones.map((m) => (
      <span key={m.id} className="row spread" style={{ gap: 6 }}>
        <span>{MILESTONE_TEXT[m.id]}</span>
        <span>{m.state === 'open' ? 'TO DO' : m.state === 'won' ? `WON DAY ${m.day}` : `TRIED DAY ${m.day}`}</span>
      </span>
    )),
  ];
  const heading = (text: string, ui?: string) => (
    <span className="panel-title small" style={{ fontSize: 8, lineHeight: '8px', margin: 0 }} data-ui={ui}>
      {text}
    </span>
  );
  return (
    <Modal title={season ? `LEDGER, SEASON ${season.toUpperCase()}` : 'LEDGER'} onClose={onClose} w={400} h={300}>
      <div className="tabs">
        {LEDGER_TABS.map(([id, label]) => (
          <button
            key={id}
            className={`btn ${tab === id ? 'red' : ''}`}
            data-tour={`ledger-${id}`}
            onClick={() => {
              uiSound(audio, 'click');
              setTab(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'days' && (
        <div className="col" style={{ gap: 4 }}>
          <span style={{ lineHeight: '10px', color: '#8b5a2b', display: 'block' }} data-ui="ledger-intro">
            EACH DAY CLOSES WITH A RECEIPT: WHAT CAME IN, WHAT WENT OUT, AND THE DAY&apos;S RECORD ON NEAR.
          </span>
          <div className="row spread" style={{ color: '#8b5a2b' }}>
            <span style={{ width: 40 }}>DAY</span>
            <span style={{ width: 60, textAlign: 'right' }}>IN</span>
            <span style={{ width: 60, textAlign: 'right' }}>OUT</span>
            <span style={{ width: 60, textAlign: 'right' }}>NET</span>
            <span style={{ width: 90, textAlign: 'right' }}>RECEIPT</span>
          </div>
          {days ? <Paged items={dayRows} ui="ledger-day-list" /> : <span>OPENING THE BOOKS</span>}
        </div>
      )}
      {tab === 'contracts' && (
        <div className="col" style={{ gap: 4 }}>
          {heading('CONTRACTS AND DEBTS')}
          {contracts.length ? <Paged items={contracts} /> : <span>NONE OPEN</span>}
        </div>
      )}
      {tab === 'feathers' && (
        <div className="col" style={{ gap: 4 }}>
          {heading('FEATHERS AND TICKETS', 'ledger-feathers')}
          {tickets.length ? <Paged items={tickets} /> : <span>NONE YET: FEATHER TICKETS ARE WON AT MILESTONES</span>}
        </div>
      )}
      {tab === 'milestones' && (
        <div className="col" style={{ gap: 4 }}>
          {heading('MILESTONES', 'milestones')}
          <Paged items={milestones} />
        </div>
      )}
    </Modal>
  );
}
