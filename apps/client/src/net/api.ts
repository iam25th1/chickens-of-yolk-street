import type { ClockState, MarketState } from '@coys/shared';

export interface ServerConfigView {
  protocol: number;
  privyAppId: string | null;
  devLogin: boolean;
  /** A local recording server (DEMO_MODE): /?demo=new or /?demo=<farm name> signs straight in. */
  demoSession?: boolean;
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
  loginDemo: (farm: string) => post<LoginResult>('/api/login/demo', { farm }),
  loginDev: (name: string, deviceId: string) => post<LoginResult>('/api/login/dev', name ? { name, deviceId } : { deviceId }),
  /** Email sign-in: the access token, and only the hash of the email name (never the email). */
  loginPrivy: (accessToken: string, nameGuard: { sha256: string; len: number } | null) =>
    post<LoginResult>('/api/login/privy', nameGuard ? { accessToken, nameGuard } : { accessToken }),
};

/** The email-name guard: SHA-256 (hex) of the email name's letters and digits, lower case, and their count. */
export async function nameGuardFor(emailName: string): Promise<{ sha256: string; len: number } | null> {
  const letters = emailName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (letters.length < 3 || letters.length > 64 || !globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(letters));
  return { sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''), len: letters.length };
}

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
