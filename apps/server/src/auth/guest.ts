// The guest session: a server-signed cookie (HttpOnly, Secure, SameSite=Lax), never a token in the
// page's storage. It holds the guest player's random id and an expiry, signed with a key derived from
// SESSION_SECRET (so a guest cookie and a signed-in session token can never stand in for each other).
// Visitors' addresses are only ever kept as a keyed hash, for the guest limits.
import { createHmac } from 'node:crypto';
import { createSessionSigner, type SessionSigner } from './session';

export const GUEST_COOKIE = 'coys_guest';
/** How long a guest cookie lasts (it is renewed each time PLAY opens the farm). */
export const GUEST_COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const derive = (secret: string, purpose: string): string => createHmac('sha256', secret).update(purpose).digest('hex');

export interface GuestAuth {
  signer: SessionSigner;
  /** A keyed hash of a visitor's address (hex): the guest limits count these, never the address. */
  ipHash(ip: string): string;
}

export function createGuestAuth(secret: string, now: () => number = Date.now): GuestAuth {
  const ipKey = derive(secret, 'coys guest address');
  return {
    signer: createSessionSigner(derive(secret, 'coys guest cookie'), now),
    ipHash: (ip) => createHmac('sha256', ipKey).update(ip).digest('hex'),
  };
}

/** One cookie's value from a Cookie header, or null. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** The Set-Cookie value that keeps a guest session (or, with null, ends it). */
export function guestCookie(token: string | null): string {
  const value = token ?? '';
  const age = token ? Math.floor(GUEST_COOKIE_TTL_MS / 1000) : 0;
  return `${GUEST_COOKIE}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
}
