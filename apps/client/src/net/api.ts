import type { ClockState, MarketState } from '@coys/shared';

export interface ServerConfigView {
  protocol: number;
  privyAppId: string | null;
  devLogin: boolean;
  /** A local recording server (DEMO_MODE): /?demo=new or /?demo=<farm name> signs straight in. */
  demoSession?: boolean;
  /** PLAY starts a guest farm with no sign-in. */
  guestPlay?: boolean;
}

/** What each farm would bring, when an account that already has a farm signs in from a guest session. */
export interface FarmChoiceView {
  name: string;
  cashMilli: number;
  hens: number;
  land: number;
  badges: number;
  tickets: number;
  days: number;
}

/** The account already has a farm: the player picks which farm to keep. */
export interface ChooseFarm {
  choose: { guest: FarmChoiceView; account: FarmChoiceView };
}

/** Too many new guest farms from this address today ('ip'), or on the street this hour ('hour'). */
export class GuestLimitError extends Error {
  constructor(readonly limit: 'ip' | 'hour') {
    super('sign in to start another farm');
  }
}

/** A guest session: the server keeps it in an HttpOnly cookie, so the page holds no token at all. */
export const GUEST_SESSION = 'guest';

export interface LoginResult {
  session: string;
  playerId: string;
  name: string;
  /** Signed in from a guest session: the guest farm came along. */
  carried?: boolean;
}

async function post<T>(path: string, body: unknown): Promise<T | ChooseFarm> {
  // same origin: the guest cookie goes along, so a sign-in can carry the guest farm into the account
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 409) {
    const b = (await res.json()) as Partial<ChooseFarm> & { error?: string };
    if (b.error === 'choose' && b.choose) return { choose: b.choose };
  }
  if (res.status === 429) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; limit?: 'ip' | 'hour' };
    if (b.error === 'guest_limit') throw new GuestLimitError(b.limit === 'hour' ? 'hour' : 'ip');
    throw new Error('Too many tries. Wait a moment.');
  }
  if (!res.ok) throw new Error(`Sign-in failed (${res.status})`);
  return (await res.json()) as T;
}

/** A sign-in that never asks to choose (no guest farm can be in play). */
const signedIn = async (r: Promise<LoginResult | ChooseFarm>): Promise<LoginResult> => {
  const v = await r;
  if ('choose' in v) throw new Error('Sign-in failed (choose)');
  return v;
};

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
  loginDemo: (farm: string) => signedIn(post<LoginResult>('/api/login/demo', { farm })),
  /** PLAY: the guest farm in this browser's guest cookie, or a new one (GuestLimitError past the limits). */
  loginGuest: async (): Promise<{ name: string }> => {
    const v = await post<{ guest: true; name: string }>('/api/login/guest', {});
    if ('choose' in v) throw new Error('PLAY failed');
    return v;
  },
  loginDev: (name: string, deviceId: string, keep?: 'guest' | 'account') =>
    post<LoginResult>('/api/login/dev', { ...(name ? { name } : {}), deviceId, ...(keep ? { keep } : {}) }),
  /** Email sign-in: the access token, and only the hash of the email name (never the email). */
  loginPrivy: (accessToken: string, nameGuard: { sha256: string; len: number } | null, keep?: 'guest' | 'account') =>
    post<LoginResult>('/api/login/privy', { accessToken, ...(nameGuard ? { nameGuard } : {}), ...(keep ? { keep } : {}) }),
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
