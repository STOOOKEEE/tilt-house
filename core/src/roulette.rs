//! Single-zero roulette (pockets 0..=36). Pays 35:1 on a number, 17:1 on a split, 11:1 on a street,
//! 8:1 on a corner, 5:1 on a six line, 2:1 on a dozen or column, 1:1 on the even-money bets; the
//! zero loses every outside bet. Every bet returns 36/37 of its stake: the game's own 2.70 % edge.
//! One spin may settle several bets at once (`RouletteSpot`s, see `Bet::RouletteSpots`).
//!
//! Layout: rows of three across the felt (1 2 3, 4 5 6 … 34 35 36), the zero above the first row.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::apply_rake;
use crate::rng::Rng;

pub const POCKETS: u32 = 37;

const RED: [u8; 18] = [
    1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
];

/// JSON: `"red"`, `{"straight": 17}`, `{"split": [7, 10]}`, `{"corner": 7}`, `{"dozen": 2}`…
/// Variants are only ever appended: the borsh index of a bet is in every hashed round.
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
    /// Two adjacent numbers, smaller first: side by side in a row (7, 8), one row apart (7, 10), or
    /// the zero with 1, 2 or 3.
    Split(u8, u8),
    /// A row of three, by its first number: 1, 4 … 34.
    Street(u8),
    /// Four numbers meeting at a corner, by the smallest: n, n+1, n+3, n+4 (n not in the right column).
    Corner(u8),
    /// Two adjacent rows, by the first number: 1, 4 … 31 (n..=n+5).
    SixLine(u8),
}

impl RouletteBet {
    pub fn is_valid(&self) -> bool {
        match *self {
            Self::Straight(n) => n <= 36,
            Self::Dozen(d) | Self::Column(d) => (1..=3).contains(&d),
            Self::Split(a, b) => {
                a < b && b <= 36 && ((a == 0 && b <= 3) || b - a == 3 || (b - a == 1 && a % 3 != 0))
            }
            Self::Street(n) => n % 3 == 1 && n <= 34,
            Self::Corner(n) => (1..=32).contains(&n) && n % 3 != 0,
            Self::SixLine(n) => n % 3 == 1 && n <= 31,
            _ => true,
        }
    }

    /// Winnings per unit staked, on top of the stake returned.
    pub fn payout_multiple(&self) -> u128 {
        match self {
            Self::Straight(_) => 35,
            Self::Split(..) => 17,
            Self::Street(_) => 11,
            Self::Corner(_) => 8,
            Self::SixLine(_) => 5,
            Self::Dozen(_) | Self::Column(_) => 2,
            _ => 1,
        }
    }

    pub fn wins(&self, pocket: u8) -> bool {
        // Offset from the bet's first number; wraps to a huge value below it, so no overflow.
        let from = |n: u8| pocket.wrapping_sub(n);
        match *self {
            Self::Straight(n) => n == pocket,
            Self::Split(a, b) => a == pocket || b == pocket,
            Self::Street(n) => from(n) < 3,
            Self::Corner(n) => matches!(from(n), 0 | 1 | 3 | 4),
            Self::SixLine(n) => from(n) < 6,
            // The zero loses every outside bet.
            _ if pocket == 0 => false,
            Self::Red => RED.contains(&pocket),
            Self::Black => pocket <= 36 && !RED.contains(&pocket),
            Self::Odd => pocket & 1 == 1,
            Self::Even => pocket & 1 == 0,
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

/// Most bets one spin may settle: a full felt of chips stays a small, cheap-to-verify round.
pub const MAX_SPOTS: usize = 20;

/// One chip stack of a multi-spot spin: a bet and what is on it.
/// JSON: `{"bet": {"split": [7, 10]}, "stake": "100000"}`.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
pub struct RouletteSpot {
    pub bet: RouletteBet,
    #[serde(with = "crate::amount_str")]
    pub stake: u128,
}

/// 1..=`MAX_SPOTS` spots, each a valid bet. Stakes are checked against the round's stake and the
/// table limits by `session::stake_is_valid`.
pub fn spots_are_valid(spots: &[RouletteSpot]) -> bool {
    (1..=MAX_SPOTS).contains(&spots.len()) && spots.iter().all(|spot| spot.bet.is_valid())
}

/// What the spots stake together, `None` on overflow.
pub fn spots_total(spots: &[RouletteSpot]) -> Option<u128> {
    spots
        .iter()
        .try_fold(0u128, |total, spot| total.checked_add(spot.stake))
}

/// What one spin pays the spots for `pocket`, after rake. Each spot is raked on its own, exactly as
/// if it were played alone, so spreading chips never changes the edge.
pub fn spots_payout(spots: &[RouletteSpot], pocket: u8, rake_bp: u16) -> u128 {
    spots.iter().fold(0, |paid, spot| {
        let gross = roulette_gross(spot.stake, &spot.bet, pocket);
        paid.saturating_add(apply_rake(gross, spot.stake, rake_bp))
    })
}

/// Most one spin can pay the spots, before rake: the best pocket, not the sum of every win (red
/// and black never both win).
pub fn spots_worst_gross(spots: &[RouletteSpot]) -> u128 {
    (0..POCKETS as u8)
        .map(|pocket| {
            spots
                .iter()
                .filter(|spot| spot.bet.wins(pocket))
                .fold(0u128, |gross, spot| {
                    gross.saturating_add(roulette_win_gross(spot.stake, &spot.bet))
                })
        })
        .max()
        .unwrap_or(0)
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

    /// Every valid inside bet other than a number, found by brute force over the arguments.
    fn inside_bets() -> Vec<RouletteBet> {
        use RouletteBet::*;
        let mut bets: Vec<RouletteBet> = (0..=40)
            .flat_map(|a| (0..=40).map(move |b| Split(a, b)))
            .collect();
        bets.extend((0..=40).flat_map(|n| [Street(n), Corner(n), SixLine(n)]));
        bets.retain(RouletteBet::is_valid);
        bets
    }

    fn covered(bet: &RouletteBet) -> Vec<u8> {
        (0..37).filter(|&p| bet.wins(p)).collect()
    }

    /// Number at (row, col) of the layout, rows 0..12 and columns 0..3.
    fn at(row: u8, col: u8) -> u8 {
        row * 3 + col + 1
    }

    fn sorted(mut sets: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
        sets.iter_mut().for_each(|set| set.sort_unstable());
        sets.sort();
        sets
    }

    /// Each kind of inside bet covers exactly the groups of adjacent cells of the layout, each
    /// group once: checked against the geometry, not against the bet's own formulas.
    #[test]
    fn inside_bets_cover_exactly_their_numbers() {
        use RouletteBet::*;
        let bets = inside_bets();
        let of_kind = |kind: fn(&RouletteBet) -> bool| -> Vec<Vec<u8>> {
            sorted(bets.iter().filter(|b| kind(b)).map(covered).collect())
        };

        let mut splits: Vec<Vec<u8>> = (1..=3).map(|n| vec![0, n]).collect();
        for row in 0..12 {
            for col in 0..3 {
                if col < 2 {
                    splits.push(vec![at(row, col), at(row, col + 1)]);
                }
                if row < 11 {
                    splits.push(vec![at(row, col), at(row + 1, col)]);
                }
            }
        }
        let streets = (0..12)
            .map(|r| (0..3).map(|c| at(r, c)).collect())
            .collect();
        let corners = (0..11)
            .flat_map(|r| {
                (0..2).map(move |c| vec![at(r, c), at(r, c + 1), at(r + 1, c), at(r + 1, c + 1)])
            })
            .collect();
        let six_lines = (0..11)
            .map(|r| (0..3).flat_map(|c| [at(r, c), at(r + 1, c)]).collect())
            .collect();

        assert_eq!(of_kind(|b| matches!(b, Split(..))), sorted(splits));
        assert_eq!(of_kind(|b| matches!(b, Street(_))), sorted(streets));
        assert_eq!(of_kind(|b| matches!(b, Corner(_))), sorted(corners));
        assert_eq!(of_kind(|b| matches!(b, SixLine(_))), sorted(six_lines));
        assert_eq!(bets.len(), 60 + 12 + 22 + 11);
    }

    #[test]
    fn inside_payouts() {
        use RouletteBet::*;
        assert_eq!(roulette_gross(10, &Split(7, 10), 10), 180);
        assert_eq!(roulette_gross(10, &Split(0, 2), 0), 180);
        assert_eq!(roulette_gross(10, &Street(7), 9), 120);
        assert_eq!(roulette_gross(10, &Corner(8), 12), 90);
        assert_eq!(roulette_gross(10, &Corner(8), 10), 0);
        assert_eq!(roulette_gross(10, &SixLine(31), 36), 60);
        assert_eq!(roulette_gross(10, &SixLine(31), 0), 0);
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
        for bet in all_bets().into_iter().chain(inside_bets()) {
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
        let invalid = [
            Straight(37),
            Dozen(0),
            Dozen(4),
            Column(0),
            Column(4),
            // Not adjacent, wrong order, off the felt.
            Split(7, 9),
            Split(3, 4),
            Split(10, 7),
            Split(7, 7),
            Split(0, 4),
            Split(34, 37),
            Split(255, 2),
            Street(0),
            Street(2),
            Street(37),
            Corner(0),
            Corner(3),
            Corner(33),
            Corner(255),
            SixLine(2),
            SixLine(34),
        ];
        for bet in invalid {
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
        let bet: RouletteBet = serde_json::from_str(r#"{"split":[7,10]}"#).unwrap();
        assert_eq!(bet, RouletteBet::Split(7, 10));
        assert_eq!(
            serde_json::to_string(&RouletteBet::SixLine(4)).unwrap(),
            r#"{"six_line":4}"#
        );
    }

    /// Rounds hashed before the inside bets existed must keep their bytes: variants are appended.
    #[test]
    fn borsh_indices_are_stable() {
        use RouletteBet::*;
        let golden: [(RouletteBet, &[u8]); 13] = [
            (Straight(17), &[0, 17]),
            (Red, &[1]),
            (Black, &[2]),
            (Odd, &[3]),
            (Even, &[4]),
            (Low, &[5]),
            (High, &[6]),
            (Dozen(2), &[7, 2]),
            (Column(3), &[8, 3]),
            (Split(7, 10), &[9, 7, 10]),
            (Street(4), &[10, 4]),
            (Corner(8), &[11, 8]),
            (SixLine(31), &[12, 31]),
        ];
        for (bet, bytes) in golden {
            assert_eq!(borsh::to_vec(&bet).unwrap(), bytes, "{bet:?}");
        }
    }

    fn random_spots(rng: &mut Rng) -> Vec<RouletteSpot> {
        let bets: Vec<RouletteBet> = all_bets().into_iter().chain(inside_bets()).collect();
        let count = rng.below(MAX_SPOTS as u32) as usize + 1;
        (0..count)
            .map(|_| RouletteSpot {
                bet: bets[rng.below(bets.len() as u32) as usize],
                stake: u128::from(rng.below(5_000_000)) + 100_000,
            })
            .collect()
    }

    /// Property: a spin of several spots pays exactly what the spots would pay alone on that
    /// pocket, and never more than its worst case.
    #[test]
    fn spots_pay_the_sum_of_their_singles() {
        let mut rng = Rng::new([3; 32]);
        for _ in 0..500 {
            let spots = random_spots(&mut rng);
            assert!(spots_are_valid(&spots));
            let rake = rng.below(231) as u16;
            let mut best = 0;
            for pocket in 0..37 {
                let singles: u128 = spots
                    .iter()
                    .map(|s| apply_rake(roulette_gross(s.stake, &s.bet, pocket), s.stake, rake))
                    .sum();
                assert_eq!(spots_payout(&spots, pocket, rake), singles);
                let gross: u128 = spots
                    .iter()
                    .map(|s| roulette_gross(s.stake, &s.bet, pocket))
                    .sum();
                best = best.max(gross);
            }
            assert_eq!(spots_worst_gross(&spots), best);
        }
    }

    #[test]
    fn spot_counts_and_totals() {
        let spot = RouletteSpot {
            bet: RouletteBet::Red,
            stake: 5,
        };
        assert!(!spots_are_valid(&[]));
        assert!(spots_are_valid(&[spot; MAX_SPOTS]));
        assert!(!spots_are_valid(&[spot; MAX_SPOTS + 1]));
        let bad = RouletteSpot {
            bet: RouletteBet::Corner(3),
            stake: 5,
        };
        assert!(!spots_are_valid(&[spot, bad]));
        assert_eq!(spots_total(&[spot, spot]), Some(10));
        let huge = RouletteSpot {
            bet: RouletteBet::Red,
            stake: u128::MAX,
        };
        assert_eq!(spots_total(&[huge, spot]), None);
        // Red and black on one spin: the worst case is one of them, not both.
        let black = RouletteSpot {
            bet: RouletteBet::Black,
            stake: 5,
        };
        assert_eq!(spots_worst_gross(&[spot, black]), 10);
    }
}
