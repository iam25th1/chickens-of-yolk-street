// WebSocket client. Reconnects with backoff; after each welcome it resends unanswered actions
// with their original request ids, and the server answers duplicates without applying them.
import { PROTOCOL_VERSION, isCrash, type ActionMessage, type ServerMessage } from '@coys/shared';
import { events, game } from '../state/game';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type Action = DistributiveOmit<ActionMessage, 'rid'>;
export type Ack = Extract<ServerMessage, { t: 'ack' }>;

export class GameSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closed = false;
  private welcomed = false;
  private readonly pending = new Map<string, { msg: ActionMessage; resolve: (a: Ack) => void }>();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly session: string) {}

  connect(): void {
    this.closed = false;
    game.set({ status: 'connecting' });
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, session: this.session }));
    ws.onmessage = (e) => this.handle(JSON.parse(String(e.data)) as ServerMessage);
    ws.onclose = (e) => {
      this.welcomed = false;
      if (this.pinger) clearInterval(this.pinger);
      if (this.closed) return;
      if (e.code === 4401) return game.set({ status: 'unauthenticated' });
      if (e.code === 4000) return game.set({ status: 'offline' });
      game.set({ status: 'offline' });
      const delay = Math.min(8000, 500 * 2 ** this.attempt++);
      this.retry = setTimeout(() => this.connect(), delay);
    };
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.pinger) clearInterval(this.pinger);
    this.ws?.close();
  }

  /** Sends an action; resolves with the server's answer, even across a reconnect. */
  send(action: Action): Promise<Ack> {
    const rid = crypto.randomUUID();
    const msg = { ...action, rid } as ActionMessage;
    return new Promise((resolve) => {
      this.pending.set(rid, { msg, resolve });
      if (this.welcomed) this.ws?.send(JSON.stringify(msg));
    });
  }

  private handle(m: ServerMessage): void {
    const before = game.get();
    switch (m.t) {
      case 'welcome':
        this.attempt = 0;
        this.welcomed = true;
        game.set({
          status: 'online',
          playerName: m.name,
          farm: m.farm,
          market: m.market,
          clock: m.clock,
          offset: m.clock.serverNow - Date.now(),
        });
        for (const p of this.pending.values()) this.ws?.send(JSON.stringify(p.msg));
        this.pinger = setInterval(() => this.ws?.send(JSON.stringify({ t: 'ping', n: Date.now() })), 20_000);
        break;
      case 'farm':
        game.set({ farm: m.farm });
        break;
      case 'market': {
        game.set({ market: m.market });
        const was = before.market ? isCrash(before.market.multiplier) : false;
        const now = isCrash(m.market.multiplier);
        if (was !== now) events.emit({ kind: 'crash', on: now });
        break;
      }
      case 'clock':
        game.set({ clock: m.clock, offset: m.clock.serverNow - Date.now() });
        if (before.clock && m.clock.day > before.clock.day) events.emit({ kind: 'newDay', day: m.clock.day });
        break;
      case 'event':
        events.emit(m.event);
        break;
      case 'ack': {
        const p = this.pending.get(m.rid);
        this.pending.delete(m.rid);
        if (!m.ok) events.emit({ kind: 'refused', code: m.code, message: m.message });
        p?.resolve(m);
        break;
      }
      case 'error':
        if (m.code === 'unauthenticated') game.set({ status: 'unauthenticated' });
        break;
      case 'ledger':
        game.set({ ledger: m.days });
        break;
      case 'pong':
        break;
    }
  }
}
