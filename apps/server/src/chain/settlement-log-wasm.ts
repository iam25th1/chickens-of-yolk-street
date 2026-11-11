// The settlement log contract: the smallest NEAR contract that accepts a call. It exports one
// method, record_day, with an empty body. The day's settlement JSON travels as the call's
// arguments, which NEAR stores with the transaction, so the batch is on chain and readable in any
// explorer without the contract keeping state (no storage staking, no upgrade surface).
//
// Equivalent WAT:
//   (module
//     (type (func))
//     (func (type 0))
//     (memory 1)
//     (export "memory" (memory 0))
//     (export "record_day" (func 0)))
//
// Hand-assembled so the repo needs no Rust or WASM toolchain; test/settlement.test.ts compiles
// and runs it with WebAssembly to prove the bytes are valid.

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const name = (s: string): number[] => [s.length, ...ascii(s)];
const section = (id: number, body: number[]): number[] => [id, body.length, ...body];

export const SETTLEMENT_LOG_METHOD = 'record_day';

export function settlementLogWasm(): Uint8Array {
  return Uint8Array.from([
    ...[0x00, 0x61, 0x73, 0x6d], // magic: \0asm
    ...[0x01, 0x00, 0x00, 0x00], // version 1
    ...section(1, [0x01, 0x60, 0x00, 0x00]), // types: one func type () -> ()
    ...section(3, [0x01, 0x00]), // functions: one, of type 0
    ...section(5, [0x01, 0x00, 0x01]), // memory: one, min 1 page, no max
    ...section(7, [0x02, ...name('memory'), 0x02, 0x00, ...name(SETTLEMENT_LOG_METHOD), 0x00, 0x00]), // exports
    ...section(10, [0x01, 0x02, 0x00, 0x0b]), // code: one body, no locals, end
  ]);
}
