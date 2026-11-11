import type { ClockState, MarketState } from '@coys/shared';

export interface ServerConfigView {
  protocol: number;
  privyAppId: string | null;
  devLogin: boolean;
}

export interface LoginResult {
  session: string;
  playerId: string;
  name: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(res.status === 429 ? 'Too many tries. Wait a moment.' : `Sign-in failed (${res.status})`);
  return (await res.json()) as T;
}

export const api = {
  async config(): Promise<ServerConfigView> {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`config: HTTP ${res.status}`);
    return (await res.json()) as ServerConfigView;
  },
  async market(): Promise<{ market: MarketState; clock: ClockState }> {
    const res = await fetch('/api/market');
    if (!res.ok) throw new Error(`market: HTTP ${res.status}`);
    return (await res.json()) as { market: MarketState; clock: ClockState };
  },
  loginDev: (name: string, deviceId: string) => post<LoginResult>('/api/login/dev', { name, deviceId }),
  loginPrivy: (accessToken: string, name?: string) =>
    post<LoginResult>('/api/login/privy', name ? { accessToken, name } : { accessToken }),
};

const SESSION_KEY = 'coys.session';
const DEVICE_KEY = 'coys.device';

export const sessionStore = {
  get(): string | null {
    try {
      return localStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  },
  set(token: string | null): void {
    try {
      if (token) localStorage.setItem(SESSION_KEY, token);
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      // storage blocked: the session lasts for this visit only
    }
  },
  deviceId(): string {
    try {
      const existing = localStorage.getItem(DEVICE_KEY);
      if (existing) return existing;
      const id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
      return id;
    } catch {
      return crypto.randomUUID();
    }
  },
};
