import { describe, expect, it } from 'vitest';
import { assertTestnetId, assertTestnetRpc } from '../lib/testnet';

describe('the testnet deploy guard', () => {
  it('accepts testnet names and implicit ids', () => {
    for (const id of ['coys-game.testnet', 'play.coys-game.testnet', 'bakery1.play.coys-game.testnet', 'a'.repeat(64)]) {
      expect(() => assertTestnetId(id)).not.toThrow();
    }
  });

  it('refuses mainnet and anything that is not a testnet name', () => {
    expect(() => assertTestnetId('coys-game.near')).toThrow(/mainnet/);
    expect(() => assertTestnetId('near')).toThrow(/mainnet/);
    expect(() => assertTestnetId('play.coys-game.near')).toThrow(/mainnet/);
    for (const id of ['coys-game', 'coys-game.testnet.near', 'Coys.testnet', 'evil.testnet.example', '']) {
      expect(() => assertTestnetId(id)).toThrow();
    }
  });

  it('refuses a mainnet RPC', () => {
    expect(() => assertTestnetRpc('https://rpc.mainnet.near.org')).toThrow(/not a testnet endpoint/);
    expect(() => assertTestnetRpc('https://test.rpc.fastnear.com')).not.toThrow();
  });
});
