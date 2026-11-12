//! The reveal draw, reproducible by anyone from the seed and the snapshot.
//!
//! Every Feather number 1 to 777 has a grade (an unminted number counts as Fluff). The draw:
//!
//! 1. A random stream: value i is the first 8 bytes (big-endian) of sha256("{seed}|{i}"), i = 0, 1, 2, ...
//! 2. The numbers are shuffled (Fisher-Yates, from the last position down, swap with the value mod
//!    (position + 1)), so no number is favoured by where it sits.
//! 3. In that order each number draws a rarity from the hens still left: rarity r has weight
//!    `GRADE_WEIGHTS[grade][r] * left[r]`; the value mod the total picks one; that rarity's count
//!    drops by one. The counts start at 7 Legendary, 70 Epic, 200 Rare and 500 Common and the
//!    numbers equal the hens, so the draw always ends at exactly 7/70/200/500.
//! 4. Within each rarity the hens of founders.json (in file order) are shuffled with the same
//!    stream and handed to that rarity's numbers in number order.
//!
//! The weights are the game's grade weights doubled so they are whole numbers (Plume's 1.5 becomes 3).

/// Hens of each rarity, in order: Legendary, Epic, Rare, Common.
pub const RARITY_COUNTS: [u32; 4] = [7, 70, 200, 500];
pub const TOTAL: usize = 777;

/// Weight toward each rarity (Legendary, Epic, Rare, Common) per grade (Fluff, Plume, Quill, Golden Quill), doubled.
pub const GRADE_WEIGHTS: [[u64; 4]; 4] = [[2, 2, 2, 2], [4, 4, 3, 2], [8, 6, 4, 2], [16, 10, 6, 2]];

pub struct Stream<'a> {
    seed: &'a str,
    i: u64,
    hash: fn(&[u8]) -> Vec<u8>,
}

impl<'a> Stream<'a> {
    pub fn new(seed: &'a str, hash: fn(&[u8]) -> Vec<u8>) -> Self {
        Self { seed, i: 0, hash }
    }

    pub fn next(&mut self) -> u64 {
        let h = (self.hash)(format!("{}|{}", self.seed, self.i).as_bytes());
        self.i += 1;
        let mut b = [0u8; 8];
        b.copy_from_slice(&h[..8]);
        u64::from_be_bytes(b)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Rarity (0 Legendary to 3 Common) for each number, index 0 being number 1. `grades[i]` is 0..=3.
pub fn draw_rarities(stream: &mut Stream, grades: &[u8]) -> Vec<u8> {
    assert_eq!(grades.len(), TOTAL, "one grade per Feather number");
    let mut order: Vec<usize> = (0..TOTAL).collect();
    for pos in (1..TOTAL).rev() {
        let j = stream.below(pos as u64 + 1) as usize;
        order.swap(pos, j);
    }
    let mut left = RARITY_COUNTS;
    let mut out = vec![0u8; TOTAL];
    for idx in order {
        let w = GRADE_WEIGHTS[grades[idx].min(3) as usize];
        let total: u64 = (0..4).map(|r| w[r] * u64::from(left[r])).sum();
        let mut x = stream.below(total);
        let mut pick = 3;
        for r in 0..4 {
            let part = w[r] * u64::from(left[r]);
            if x < part {
                pick = r;
                break;
            }
            x -= part;
        }
        left[pick] -= 1;
        out[idx] = pick as u8;
    }
    out
}

/// Which founders.json hen (its index) each number gets. `founder_rarity[k]` is hen k's rarity.
pub fn assign_hens(stream: &mut Stream, rarities: &[u8], founder_rarity: &[u8]) -> Vec<u16> {
    let mut out = vec![0u16; rarities.len()];
    for r in 0..4u8 {
        let mut hens: Vec<u16> = founder_rarity.iter().enumerate().filter(|(_, x)| **x == r).map(|(k, _)| k as u16).collect();
        for pos in (1..hens.len()).rev() {
            let j = stream.below(pos as u64 + 1) as usize;
            hens.swap(pos, j);
        }
        let mut next = hens.into_iter();
        for (idx, rr) in rarities.iter().enumerate() {
            if *rr == r {
                out[idx] = next.next().unwrap_or(u16::MAX);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(b: &[u8]) -> Vec<u8> {
        near_sdk::env::sha256(b)
    }

    fn counts(r: &[u8]) -> [u32; 4] {
        let mut c = [0u32; 4];
        for x in r {
            c[*x as usize] += 1;
        }
        c
    }

    fn founders() -> Vec<u8> {
        let mut f = Vec::new();
        for (r, n) in RARITY_COUNTS.iter().enumerate() {
            f.extend(std::iter::repeat(r as u8).take(*n as usize));
        }
        f
    }

    #[test]
    fn always_exactly_7_70_200_500() {
        let mixes: [fn(usize) -> u8; 4] = [|_| 0, |i| (i % 4) as u8, |i| if i < 50 { 3 } else { 0 }, |i| if i % 7 == 0 { 2 } else { 1 }];
        for (s, mix) in mixes.iter().enumerate() {
            for seed in ["a", "near-mainnet:150000000:8xK", "zz"] {
                let grades: Vec<u8> = (0..TOTAL).map(mix).collect();
                let r = draw_rarities(&mut Stream::new(&format!("{seed}{s}"), sha), &grades);
                assert_eq!(counts(&r), RARITY_COUNTS);
            }
        }
    }

    #[test]
    fn the_same_seed_gives_the_same_draw() {
        let grades: Vec<u8> = (0..TOTAL).map(|i| (i % 4) as u8).collect();
        let a = draw_rarities(&mut Stream::new("seed", sha), &grades);
        let b = draw_rarities(&mut Stream::new("seed", sha), &grades);
        let c = draw_rarities(&mut Stream::new("seed2", sha), &grades);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn higher_grades_draw_more_high_rarity_hens() {
        // half Golden Quill, half Fluff: over several seeds Golden Quills hold most Legendaries
        let grades: Vec<u8> = (0..TOTAL).map(|i| if i % 2 == 0 { 3 } else { 0 }).collect();
        let (mut gold, mut fluff) = (0, 0);
        for s in 0..20 {
            let r = draw_rarities(&mut Stream::new(&format!("s{s}"), sha), &grades);
            for (i, x) in r.iter().enumerate() {
                if *x == 0 {
                    if i % 2 == 0 {
                        gold += 1
                    } else {
                        fluff += 1
                    }
                }
            }
        }
        assert!(gold > fluff * 3, "golden quills {gold} vs fluff {fluff}");
    }

    #[test]
    fn every_hen_goes_to_one_feather_of_her_rarity() {
        let grades: Vec<u8> = (0..TOTAL).map(|i| (i % 4) as u8).collect();
        let mut s = Stream::new("seed", sha);
        let r = draw_rarities(&mut s, &grades);
        let f = founders();
        let hens = assign_hens(&mut s, &r, &f);
        let mut seen = vec![false; TOTAL];
        for (idx, h) in hens.iter().enumerate() {
            assert_eq!(f[*h as usize], r[idx]);
            assert!(!seen[*h as usize]);
            seen[*h as usize] = true;
        }
    }

    #[test]
    fn a_known_vector() {
        // the server's TypeScript draw (apps/server/src/game/reveal.ts) checks the same vector
        let grades: Vec<u8> = (0..TOTAL).map(|i| (i % 4) as u8).collect();
        let mut s = Stream::new("coys-reveal-test", sha);
        assert_eq!(Stream::new("coys-reveal-test", sha).next(), {
            let h = sha(b"coys-reveal-test|0");
            u64::from_be_bytes([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]])
        });
        let r = draw_rarities(&mut s, &grades);
        let legendary: Vec<usize> = r.iter().enumerate().filter(|(_, x)| **x == 0).map(|(i, _)| i + 1).collect();
        assert_eq!(legendary, vec![200, 239, 332, 339, 367, 455, 665]);
    }
}
