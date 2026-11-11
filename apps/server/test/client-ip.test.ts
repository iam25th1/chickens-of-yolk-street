import { describe, expect, it } from 'vitest';
import { clientIp } from '../src/net/server';

const req = (remoteAddress: string | undefined, cf?: string) =>
  ({ socket: { remoteAddress }, headers: cf === undefined ? {} : { 'cf-connecting-ip': cf } }) as unknown as Parameters<typeof clientIp>[0];

describe('client address for rate limits', () => {
  it('behind a tunnel on loopback, CF-Connecting-IP names the visitor', () => {
    expect(clientIp(req('127.0.0.1', '203.0.113.9'))).toBe('203.0.113.9');
    expect(clientIp(req('::1', '2001:db8::7'))).toBe('2001:db8::7');
    expect(clientIp(req('::ffff:127.0.0.1', ' 198.51.100.4 '))).toBe('198.51.100.4');
  });

  it('ignores the header from anywhere but loopback, and anything that is not an address', () => {
    expect(clientIp(req('198.51.100.20', '203.0.113.9'))).toBe('198.51.100.20');
    expect(clientIp(req('127.0.0.1', 'not-an-ip'))).toBe('127.0.0.1');
    expect(clientIp(req('127.0.0.1', '203.0.113.9, 10.0.0.1'))).toBe('127.0.0.1');
    expect(clientIp(req('127.0.0.1'))).toBe('127.0.0.1');
    expect(clientIp(req(undefined, '203.0.113.9'))).toBe('unknown');
  });
});
