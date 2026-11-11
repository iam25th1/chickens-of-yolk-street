// Session tokens: base64url(JSON {p: playerId, e: expiry}) + "." + base64url(HMAC-SHA256).
// Issued by the server after login; the client keeps one to reconnect without logging in again.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionSigner {
  sign(playerId: string, ttlMs?: number): string;
  verify(token: string): string | null;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createSessionSigner(secret: string, now: () => number = Date.now): SessionSigner {
  const mac = (payload: string): string => createHmac('sha256', secret).update(payload).digest('base64url');
  return {
    sign(playerId, ttlMs = DEFAULT_TTL_MS) {
      const payload = Buffer.from(JSON.stringify({ p: playerId, e: now() + ttlMs })).toString('base64url');
      return `${payload}.${mac(payload)}`;
    },
    verify(token) {
      const [payload, sig] = token.split('.');
      if (!payload || !sig) return null;
      const expected = Buffer.from(mac(payload));
      const given = Buffer.from(sig);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      try {
        const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { p?: unknown; e?: unknown };
        if (typeof body.p !== 'string' || typeof body.e !== 'number' || body.e < now()) return null;
        return body.p;
      } catch {
        return null;
      }
    },
  };
}
