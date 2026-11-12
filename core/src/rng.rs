//! Deterministic random numbers from a 32-byte seed (the VRF output of one round step).
//!
//! The seed is already uniform and unpredictable, so the generator only has to stretch it into a
//! few draws without bias: xoshiro256** seeded through splitmix64, which never yields the
//! all-zero state that would make xoshiro output only zeros.

#[derive(Clone, Debug)]
pub struct Rng {
    state: [u64; 4],
}

impl Rng {
    pub fn new(seed: [u8; 32]) -> Self {
        let mut state = [0u64; 4];
        for (index, word) in state.iter_mut().enumerate() {
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&seed[index * 8..index * 8 + 8]);
            *word = u64::from_le_bytes(bytes);
        }
        let mut mix = state[0]
            ^ state[1].rotate_left(16)
            ^ state[2].rotate_left(32)
            ^ state[3].rotate_left(48);
        for (i, word) in state.iter_mut().enumerate() {
            // Mixing each word with a running splitmix sequence keeps all 256 seed bits relevant.
            *word ^= splitmix64(&mut mix).wrapping_add(i as u64);
        }
        Self { state }
    }

    fn next_u64(&mut self) -> u64 {
        let [s0, s1, s2, s3] = &mut self.state;
        let result = s1.wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = *s1 << 17;
        *s2 ^= *s0;
        *s3 ^= *s1;
        *s1 ^= *s2;
        *s0 ^= *s3;
        *s2 ^= t;
        *s3 = s3.rotate_left(45);
        result
    }

    fn next_u32(&mut self) -> u32 {
        (self.next_u64() >> 32) as u32
    }

    /// Uniform integer in `0..n`, without modulo bias (rejection sampling).
    ///
    /// Panics if `n == 0`: asking for a draw from an empty range is a programming error.
    pub fn below(&mut self, n: u32) -> u32 {
        assert!(n > 0, "Rng::below(0)");
        // Values under `threshold` would make some results more likely than others.
        let threshold = n.wrapping_neg() % n;
        loop {
            let x = self.next_u32();
            if x >= threshold {
                return x % n;
            }
        }
    }
}

fn splitmix64(x: &mut u64) -> u64 {
    *x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_draws() {
        let mut a = Rng::new([7; 32]);
        let mut b = Rng::new([7; 32]);
        for _ in 0..100 {
            assert_eq!(a.below(1000), b.below(1000));
        }
    }

    #[test]
    fn different_seeds_differ() {
        let mut a = Rng::new([0; 32]);
        let mut seed = [0; 32];
        seed[31] = 1;
        let mut b = Rng::new(seed);
        let same = (0..64)
            .filter(|_| a.below(1 << 30) == b.below(1 << 30))
            .count();
        assert!(same < 4);
    }

    #[test]
    fn zero_seed_is_not_degenerate() {
        let mut rng = Rng::new([0; 32]);
        let draws: Vec<u32> = (0..16).map(|_| rng.below(u32::MAX)).collect();
        assert!(draws.iter().any(|&d| d != 0));
    }

    #[test]
    fn below_one_is_zero() {
        let mut rng = Rng::new([3; 32]);
        assert!((0..100).all(|_| rng.below(1) == 0));
    }

    #[test]
    #[should_panic]
    fn below_zero_panics() {
        Rng::new([3; 32]).below(0);
    }

    /// Chi-square smoke test on 1e6 draws: with 37 buckets (36 degrees of freedom), the 99.9 %
    /// critical value is 67.98.
    #[test]
    fn below_is_uniform_chi_square() {
        const BUCKETS: u32 = 37;
        const DRAWS: u32 = 1_000_000;
        let mut rng = Rng::new(*b"tilt-house chi-square smoke test");
        let mut counts = [0u64; BUCKETS as usize];
        for _ in 0..DRAWS {
            counts[rng.below(BUCKETS) as usize] += 1;
        }
        let expected = f64::from(DRAWS) / f64::from(BUCKETS);
        let chi2: f64 = counts
            .iter()
            .map(|&c| (c as f64 - expected).powi(2) / expected)
            .sum();
        assert!(chi2 < 67.98, "chi2 = {chi2}");
    }

    /// A range that is not a power of two and close to 2^32 is where modulo bias would show.
    #[test]
    fn below_large_range_has_no_modulo_bias() {
        let n = 3 * (1u32 << 30); // with a plain modulo, values >= 2^30 would come out half as often as smaller ones
        let mut rng = Rng::new([9; 32]);
        let high = (0..200_000).filter(|_| rng.below(n) >= 1 << 31).count();
        // Expected 1/3 of draws; a biased modulo would give 1/4.
        assert!((63_000..70_000).contains(&high), "high = {high}");
    }
}
