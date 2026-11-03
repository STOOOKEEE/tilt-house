//! Dice: roll 0..10000, the player picks a win chance and a side. Pays fair (stake × 10000 /
//! chance) before the dealer's rake, so dice has no base edge of its own.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::rng::Rng;

/// Rolls are uniform in `0..ROLL_RANGE`; chances are expressed in the same unit (basis points).
pub const ROLL_RANGE: u32 = 10_000;
pub const MIN_CHANCE_BP: u16 = 100;
pub const MAX_CHANCE_BP: u16 = 9_800;

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
pub struct DiceBet {
    /// Win chance in basis points, `MIN_CHANCE_BP..=MAX_CHANCE_BP`.
    pub chance_bp: u16,
    /// `false`: win when the roll is under `chance_bp`; `true`: win when it is at or above
    /// `10000 - chance_bp`.
    pub over: bool,
}

impl DiceBet {
    pub fn is_valid(&self) -> bool {
        (MIN_CHANCE_BP..=MAX_CHANCE_BP).contains(&self.chance_bp)
    }

    pub fn wins(&self, roll: u32) -> bool {
        let chance = u32::from(self.chance_bp);
        if self.over {
            roll >= ROLL_RANGE - chance
        } else {
            roll < chance
        }
    }
}

pub fn dice_roll(rng: &mut Rng) -> u32 {
    rng.below(ROLL_RANGE)
}

/// Gross paid on a win, rounded down (rounding favours the pool). Saturates instead of
/// overflowing, so an absurd stake gets an uncoverable worst case and is refused.
pub fn dice_win_gross(stake: u128, chance_bp: u16) -> u128 {
    stake.saturating_mul(u128::from(ROLL_RANGE)) / u128::from(chance_bp.max(1))
}

/// Fair gross payout (stake included) for `roll`, before rake. Bets are validated when placed;
/// an invalid bet or roll here voids the round (stake back) rather than guessing an outcome.
pub fn dice_gross(stake: u128, bet: &DiceBet, roll: u32) -> u128 {
    if !bet.is_valid() || roll >= ROLL_RANGE {
        return stake;
    }
    if bet.wins(roll) {
        dice_win_gross(stake, bet.chance_bp)
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UNDER_50: DiceBet = DiceBet {
        chance_bp: 5_000,
        over: false,
    };
    const OVER_50: DiceBet = DiceBet {
        chance_bp: 5_000,
        over: true,
    };

    #[test]
    fn under_and_over_boundaries() {
        assert_eq!(dice_gross(100, &UNDER_50, 4_999), 200);
        assert_eq!(dice_gross(100, &UNDER_50, 5_000), 0);
        assert_eq!(dice_gross(100, &OVER_50, 4_999), 0);
        assert_eq!(dice_gross(100, &OVER_50, 5_000), 200);
        assert_eq!(dice_gross(100, &OVER_50, 9_999), 200);
    }

    #[test]
    fn extreme_chances_pay_fair() {
        let one_pct = DiceBet {
            chance_bp: 100,
            over: false,
        };
        assert_eq!(dice_gross(1_000_000, &one_pct, 99), 100_000_000);
        assert_eq!(dice_gross(1_000_000, &one_pct, 100), 0);
        let max = DiceBet {
            chance_bp: 9_800,
            over: true,
        };
        assert_eq!(dice_gross(980_000, &max, 200), 1_000_000);
        assert_eq!(dice_gross(980_000, &max, 199), 0);
    }

    #[test]
    fn payout_rounds_down() {
        let third = DiceBet {
            chance_bp: 3_000,
            over: false,
        };
        assert_eq!(dice_gross(10, &third, 0), 33);
    }

    #[test]
    fn exact_win_count_matches_chance() {
        for bet in [
            UNDER_50,
            OVER_50,
            DiceBet {
                chance_bp: 137,
                over: true,
            },
            DiceBet {
                chance_bp: 9_800,
                over: false,
            },
        ] {
            let wins = (0..ROLL_RANGE).filter(|&r| bet.wins(r)).count();
            assert_eq!(wins, usize::from(bet.chance_bp));
        }
    }

    #[test]
    fn invalid_bet_or_roll_voids() {
        for chance_bp in [0, 99, 9_801, u16::MAX] {
            let bet = DiceBet {
                chance_bp,
                over: false,
            };
            assert!(!bet.is_valid());
            assert_eq!(dice_gross(500, &bet, 0), 500);
        }
        assert_eq!(dice_gross(500, &UNDER_50, ROLL_RANGE), 500);
    }

    #[test]
    fn roll_in_range() {
        let mut rng = Rng::new([1; 32]);
        assert!((0..10_000).all(|_| dice_roll(&mut rng) < ROLL_RANGE));
    }
}
