//! Single-zero roulette (pockets 0..=36), one bet per spin. Pays 35:1 on a number, 2:1 on a dozen
//! or column, 1:1 on the even-money bets; the zero loses every outside bet, which is the game's
//! own 1/37 ≈ 2.70 % edge.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::rng::Rng;

pub const POCKETS: u32 = 37;

const RED: [u8; 18] = [
    1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
];

/// JSON: `"red"`, `{"straight": 17}`, `{"dozen": 2}`, `{"column": 3}`…
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum RouletteBet {
    /// One number, 0..=36.
    Straight(u8),
    Red,
    Black,
    Odd,
    Even,
    /// 1..=18.
    Low,
    /// 19..=36.
    High,
    /// 1: 1..=12, 2: 13..=24, 3: 25..=36.
    Dozen(u8),
    /// 1: 1, 4, 7…; 2: 2, 5, 8…; 3: 3, 6, 9…
    Column(u8),
}

impl RouletteBet {
    pub fn is_valid(&self) -> bool {
        match *self {
            Self::Straight(n) => n <= 36,
            Self::Dozen(d) | Self::Column(d) => (1..=3).contains(&d),
            _ => true,
        }
    }

    /// Winnings per unit staked, on top of the stake returned.
    pub fn payout_multiple(&self) -> u128 {
        match self {
            Self::Straight(_) => 35,
            Self::Dozen(_) | Self::Column(_) => 2,
            _ => 1,
        }
    }

    pub fn wins(&self, pocket: u8) -> bool {
        if pocket == 0 {
            return *self == Self::Straight(0);
        }
        match *self {
            Self::Straight(n) => n == pocket,
            Self::Red => RED.contains(&pocket),
            Self::Black => pocket <= 36 && !RED.contains(&pocket),
            Self::Odd => pocket % 2 == 1,
            Self::Even => pocket % 2 == 0,
            Self::Low => pocket <= 18,
            Self::High => (19..=36).contains(&pocket),
            Self::Dozen(d) => (pocket - 1) / 12 + 1 == d,
            Self::Column(c) => (pocket - 1) % 3 + 1 == c,
        }
    }
}

pub fn roulette_spin(rng: &mut Rng) -> u8 {
    rng.below(POCKETS) as u8
}

/// Gross paid on a win (stake included). Saturates so an absurd stake is simply uncoverable.
pub fn roulette_win_gross(stake: u128, bet: &RouletteBet) -> u128 {
    stake.saturating_mul(bet.payout_multiple() + 1)
}

/// Gross payout (stake included) for `pocket`, before rake. Bets are validated when placed; an
/// invalid bet or pocket here voids the round (stake back).
pub fn roulette_gross(stake: u128, bet: &RouletteBet, pocket: u8) -> u128 {
    if !bet.is_valid() || u32::from(pocket) >= POCKETS {
        return stake;
    }
    if bet.wins(pocket) {
        roulette_win_gross(stake, bet)
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_bets() -> Vec<RouletteBet> {
        use RouletteBet::*;
        let mut bets = vec![Red, Black, Odd, Even, Low, High];
        bets.extend((0..=36).map(Straight));
        bets.extend((1..=3).map(Dozen));
        bets.extend((1..=3).map(Column));
        bets
    }

    #[test]
    fn payouts() {
        use RouletteBet::*;
        assert_eq!(roulette_gross(10, &Straight(17), 17), 360);
        assert_eq!(roulette_gross(10, &Straight(0), 0), 360);
        assert_eq!(roulette_gross(10, &Straight(17), 18), 0);
        assert_eq!(roulette_gross(10, &Red, 1), 20);
        assert_eq!(roulette_gross(10, &Black, 2), 20);
        assert_eq!(roulette_gross(10, &Red, 2), 0);
        assert_eq!(roulette_gross(10, &Dozen(2), 13), 30);
        assert_eq!(roulette_gross(10, &Dozen(2), 25), 0);
        assert_eq!(roulette_gross(10, &Column(3), 36), 30);
        assert_eq!(roulette_gross(10, &Column(1), 34), 30);
        assert_eq!(roulette_gross(10, &Low, 18), 20);
        assert_eq!(roulette_gross(10, &High, 19), 20);
        assert_eq!(roulette_gross(10, &Even, 36), 20);
    }

    #[test]
    fn zero_loses_every_outside_bet() {
        for bet in all_bets()
            .into_iter()
            .filter(|b| *b != RouletteBet::Straight(0))
        {
            assert_eq!(roulette_gross(10, &bet, 0), 0, "{bet:?}");
        }
    }

    /// Every bet returns exactly 36/37 of the stake over the 37 pockets: the 2.70 % base edge.
    #[test]
    fn every_bet_returns_36_of_37() {
        for bet in all_bets() {
            let total: u128 = (0..37).map(|p| roulette_gross(1, &bet, p)).sum();
            assert_eq!(total, 36, "{bet:?}");
        }
    }

    #[test]
    fn red_and_black_split_the_non_zero_pockets() {
        let red = (1..=36).filter(|&p| RouletteBet::Red.wins(p)).count();
        let black = (1..=36).filter(|&p| RouletteBet::Black.wins(p)).count();
        assert_eq!((red, black), (18, 18));
    }

    #[test]
    fn invalid_bet_or_pocket_voids() {
        use RouletteBet::*;
        for bet in [Straight(37), Dozen(0), Dozen(4), Column(0), Column(4)] {
            assert!(!bet.is_valid());
            assert_eq!(roulette_gross(10, &bet, 1), 10);
        }
        assert_eq!(roulette_gross(10, &Red, 37), 10);
    }

    #[test]
    fn json_shape() {
        assert_eq!(
            serde_json::to_string(&RouletteBet::Red).unwrap(),
            r#""red""#
        );
        assert_eq!(
            serde_json::to_string(&RouletteBet::Straight(17)).unwrap(),
            r#"{"straight":17}"#
        );
        let bet: RouletteBet = serde_json::from_str(r#"{"dozen":2}"#).unwrap();
        assert_eq!(bet, RouletteBet::Dozen(2));
    }
}
