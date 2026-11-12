// The reveal draw in TypeScript, step for step the same as contracts/founding-hens/src/draw.rs, so
// anyone can reproduce the mainnet reveal from the announced seed and the Feather snapshot.
//
// 1. Stream value i: the first 8 bytes (big-endian) of sha256("{seed}|{i}").
// 2. Shuffle the 777 numbers (Fisher-Yates from the last position, swap with value mod (pos + 1)).
// 3. In that order each number draws a rarity: weight GRADE_WEIGHTS[grade][r] x hens of r left,
//    value mod the total picks; that rarity's count drops by one. Always 7/70/200/500.
// 4. Per rarity, founders.json's hens of that rarity (file order) are shuffled with the stream and
//    handed to that rarity's numbers in number order.
import { createHash } from 'node:crypto';

export const TOTAL = 777;
export const RARITY_COUNTS = [7, 70, 200, 500] as const;
/** The game's grade weights doubled to whole numbers: Fluff, Plume, Quill, Golden Quill x Legendary, Epic, Rare, Common. */
export const GRADE_WEIGHTS = [
  [2n, 2n, 2n, 2n],
  [4n, 4n, 3n, 2n],
  [8n, 6n, 4n, 2n],
  [16n, 10n, 6n, 2n],
] as const;

export class Stream {
  private i = 0;
  constructor(private readonly seed: string) {}
  next(): bigint {
    const h = createHash('sha256').update(`${this.seed}|${this.i++}`).digest();
    return h.readBigUInt64BE(0);
  }
  below(n: number): number {
    return Number(this.next() % BigInt(n));
  }
}

/** Rarity (0 Legendary to 3 Common) for each number (index 0 is number 1); grades are 0 to 3. */
export function drawRarities(stream: Stream, grades: number[]): number[] {
  if (grades.length !== TOTAL) throw new Error('one grade per Feather number');
  const order = Array.from({ length: TOTAL }, (_, i) => i);
  for (let pos = TOTAL - 1; pos >= 1; pos--) {
    const j = stream.below(pos + 1);
    [order[pos], order[j]] = [order[j] as number, order[pos] as number];
  }
  const left = [...RARITY_COUNTS].map(BigInt);
  const out = new Array<number>(TOTAL).fill(0);
  for (const idx of order) {
    const w = GRADE_WEIGHTS[Math.min(3, grades[idx] ?? 0)] ?? GRADE_WEIGHTS[0];
    const parts = [0, 1, 2, 3].map((r) => (w[r] ?? 0n) * (left[r] ?? 0n));
    const total = parts.reduce((s, p) => s + p, 0n);
    let x = stream.next() % total;
    let pick = 3;
    for (let r = 0; r < 4; r++) {
      const p = parts[r] ?? 0n;
      if (x < p) {
        pick = r;
        break;
      }
      x -= p;
    }
    left[pick] = (left[pick] ?? 0n) - 1n;
    out[idx] = pick;
  }
  return out;
}

/** Which founders.json hen (index) each number gets; founderRarity[k] is hen k's rarity (0 to 3). */
export function assignHens(stream: Stream, rarities: number[], founderRarity: number[]): number[] {
  const out = new Array<number>(rarities.length).fill(0);
  for (let r = 0; r < 4; r++) {
    const hens = founderRarity.flatMap((x, k) => (x === r ? [k] : []));
    for (let pos = hens.length - 1; pos >= 1; pos--) {
      const j = stream.below(pos + 1);
      [hens[pos], hens[j]] = [hens[j] as number, hens[pos] as number];
    }
    let next = 0;
    rarities.forEach((rr, idx) => {
      if (rr === r) out[idx] = hens[next++] ?? -1;
    });
  }
  return out;
}
