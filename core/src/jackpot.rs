//! # The jackpot (docs/floor.md, rule 7)
//!
//! One global pot, fed by rent only. Every settled round may win all of it, with probability
//! `stake / JACKPOT_ODDS_UNIT` (capped at 1): a 1 USDC bet has a 1 in 2 000 chance.
//!
//! The draw uses the round's own last VRF output, so no extra randomness request is needed. The
//! game's `Rng` stretches that output with xoshiro, so reusing its bytes directly would tie the
//! jackpot to the cards or the roll. Instead the jackpot reads `sha256(output || JACKPOT_DOMAIN)`:
//! a hash under its own domain is independent of every draw the game makes from the raw output.
//!
//! Amounts are USDC base units (6 decimals).

use sha2::{Digest, Sha256};

/// Stake that would win the jackpot for sure: 2 000 USDC. Odds scale linearly below it.
pub const JACKPOT_ODDS_UNIT: u128 = 2_000_000_000;

/// The pot only drops once it holds 10 USDC; smaller wins are skipped (the pot keeps growing).
pub const MIN_JACKPOT: u128 = 10_000_000;

/// Domain separator: keeps the jackpot draw apart from the game's draws on the same output.
pub const JACKPOT_DOMAIN: &[u8] = b"tilt-house/jackpot";

/// Whether a round of `stake` with this last VRF output hits the jackpot. Ignores the pot size.
pub fn jackpot_hit(vrf_output: &[u8; 32], stake: u128) -> bool {
    let digest = Sha256::new()
        .chain_update(vrf_output)
        .chain_update(JACKPOT_DOMAIN)
        .finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    // Modulo bias is below 2^-96 (2^128 is not a multiple of the odds unit): negligible.
    u128::from_le_bytes(bytes) % JACKPOT_ODDS_UNIT < stake
}

/// Settles the jackpot for one round: returns what the player wins (the whole pot, which drops
/// to 0) or 0. Never pays a pot under `MIN_JACKPOT`.
pub fn draw_jackpot(pot: &mut u128, vrf_output: &[u8; 32], stake: u128) -> u128 {
    if *pot < MIN_JACKPOT || !jackpot_hit(vrf_output, stake) {
        return 0;
    }
    std::mem::take(pot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Rng;

    const USDC: u128 = 1_000_000;

    fn output(rng: &mut Rng) -> [u8; 32] {
        let mut out = [0u8; 32];
        for byte in &mut out {
            *byte = rng.below(256) as u8;
        }
        out
    }

    #[test]
    fn stake_sets_the_odds() {
        let out = [7u8; 32];
        assert!(!jackpot_hit(&out, 0));
        assert!(jackpot_hit(&out, JACKPOT_ODDS_UNIT));
        assert!(jackpot_hit(&out, u128::MAX));
    }

    /// 1 USDC at 1/2000, over 400 000 outputs: about 200 hits.
    #[test]
    fn hit_rate_matches_the_odds() {
        let mut rng = Rng::new(*b"jackpot hit rate test seed 00001");
        let draws = 400_000;
        let hits = (0..draws)
            .filter(|_| jackpot_hit(&output(&mut rng), USDC))
            .count();
        // Expected 200, sd ≈ 14: ±5 sd.
        assert!((130..=270).contains(&hits), "{hits}");
    }

    /// Property: a drop never pays below `MIN_JACKPOT`, and pays the whole pot or nothing.
    #[test]
    fn never_pays_below_min() {
        let mut rng = Rng::new(*b"jackpot minimum property seed 01");
        for _ in 0..50_000 {
            let start = u128::from(rng.below(2 * MIN_JACKPOT as u32));
            let mut pot = start;
            let stake = JACKPOT_ODDS_UNIT * u128::from(rng.below(2));
            let won = draw_jackpot(&mut pot, &output(&mut rng), stake);
            assert!(won == 0 || won >= MIN_JACKPOT);
            assert!((won == 0 && pot == start) || (won == start && pot == 0));
        }
    }

    #[test]
    fn draw_takes_the_pot() {
        let out = [1u8; 32];
        let mut pot = MIN_JACKPOT;
        assert_eq!(draw_jackpot(&mut pot, &out, JACKPOT_ODDS_UNIT), MIN_JACKPOT);
        assert_eq!(pot, 0);
        let mut small = MIN_JACKPOT - 1;
        assert_eq!(draw_jackpot(&mut small, &out, JACKPOT_ODDS_UNIT), 0);
        assert_eq!(small, MIN_JACKPOT - 1);
    }
}
