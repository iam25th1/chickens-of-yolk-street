import { describe, expect, it } from 'vitest';
import {
  NoopSettlement,
  assertTestnetConfig,
  createSettlementWriter,
  settlementDigest,
  type SettlementPayload,
} from '../src/chain/settlement';
import { SETTLEMENT_LOG_METHOD, settlementLogWasm } from '../src/chain/settlement-log-wasm';

// The server compiles without DOM types, so the WebAssembly global is typed here.
interface Desc {
  name: string;
  kind: string;
}
const wasm = (
  globalThis as unknown as {
    WebAssembly: {
      validate(b: Uint8Array): boolean;
      compile(b: Uint8Array): Promise<object>;
      instantiate(m: object): Promise<{ exports: Record<string, unknown> }>;
      Module: { exports(m: object): Desc[]; imports(m: object): Desc[] };
    };
  }
).WebAssembly;

describe('settlement log contract', () => {
  it('is a valid WebAssembly module exporting record_day and memory', async () => {
    const bytes = settlementLogWasm();
    expect(wasm.validate(bytes)).toBe(true);
    const mod = await wasm.compile(bytes);
    expect(wasm.Module.exports(mod)).toEqual([
      { name: 'memory', kind: 'memory' },
      { name: SETTLEMENT_LOG_METHOD, kind: 'function' },
    ]);
    expect(wasm.Module.imports(mod)).toEqual([]);
    const instance = await wasm.instantiate(mod);
    expect(() => (instance.exports[SETTLEMENT_LOG_METHOD] as () => void)()).not.toThrow();
  });
});

describe('settlement writer', () => {
  const payload: SettlementPayload = {
    game: 'chickens-of-yolk-street',
    v: 1,
    day: 3,
    closedAt: 0,
    supply: 10,
    multiplier: 1,
    nextMultiplier: 2.5,
    farms: [{ farm: 'f1', owner: 'player', account: null, netMilli: 1200 }],
    digest: settlementDigest([{ farm: 'f1', owner: 'player', account: null, netMilli: 1200 }]),
  };

  it('is a loud, recorded no-op without testnet credentials', async () => {
    const lines: string[] = [];
    const writer = createSettlementWriter({}, (l) => lines.push(l));
    expect(writer.mode).toBe('noop');
    expect(await writer.write(payload)).toEqual({ status: 'noop', txHash: null });
    expect(lines.join('\n')).toMatch(/NO-OP for day 3/);
    expect(new NoopSettlement('x', () => undefined).mode).toBe('noop');
  });

  it('refuses anything that is not testnet before loading a key', () => {
    const ok = { accountId: 'coys.testnet', privateKey: 'ed25519:abc', rpcUrl: 'https://test.rpc.fastnear.com', contractId: 'coys.testnet' };
    expect(() => assertTestnetConfig(ok)).not.toThrow();
    expect(() => assertTestnetConfig({ ...ok, accountId: 'coys.near' })).toThrow(/non-testnet/);
    expect(() => assertTestnetConfig({ ...ok, contractId: 'log.near' })).toThrow(/non-testnet/);
    expect(() => assertTestnetConfig({ ...ok, rpcUrl: 'https://rpc.mainnet.near.org' })).toThrow(/not a testnet/);
    expect(() => assertTestnetConfig({ ...ok, rpcUrl: 'https://free.rpc.fastnear.com' })).toThrow(/not a testnet/);
  });

  it('digest is stable for the same farms', () => {
    expect(settlementDigest(payload.farms)).toBe(payload.digest);
  });
});
