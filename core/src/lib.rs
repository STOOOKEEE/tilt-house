//! Tilt House rules shared by the `house` contract and the fast-forward simulator: games, rake,
//! pool (LP) math, the dealers' pricing and rent rules, the floor (seats, rent) and the jackpot. Pure Rust, no chain dependency, so the live
//! game and the simulation run the same code.
//!
//! Amounts are integer base units (`u128`); they serialize to JSON as decimal strings.

pub mod blackjack;
pub mod dealer_rules;
pub mod dice;
pub mod floor;
pub mod jackpot;
pub mod pool;
pub mod rng;
pub mod roulette;
pub mod session;

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

pub use blackjack::{
    bj_deal, bj_double, bj_gross, bj_hit, bj_stand, bj_total, bj_wager, BjError, BjMove, BjState,
    BjStrategy,
};
pub use dealer_rules::{
    rent_bid, reprice, Offer, Reason, RentAction, RentDecision, RentReason, RivalOffer, Stats,
    Temperament,
};
pub use dice::{dice_gross, dice_roll, DiceBet};
pub use floor::{
    can_set_temperament, cooldown_until, validate_new_table, BidOutcome, EvictReason, Floor,
    FloorError, FloorView, RentOutcome, Seat,
};
pub use jackpot::{draw_jackpot, jackpot_hit, JACKPOT_ODDS_UNIT, MIN_JACKPOT};
pub use pool::{Pool, PoolError, FLOOR_SHARES_PER_UNIT, SHARES_PER_UNIT};
pub use rng::Rng;
pub use roulette::{roulette_gross, roulette_spin, RouletteBet};

/// Basis points per unit.
pub const BP: u128 = 10_000;

#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    BorshSerialize,
    BorshDeserialize,
    Serialize,
    Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Game {
    Dice,
    Roulette,
    Blackjack,
}

/// What the player chose for a round. Blackjack has no choice at the deal.
/// JSON: `{"dice": {"chance_bp": 5000, "over": true}}`, `{"roulette": "red"}`, `"blackjack"`.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Bet {
    Dice(DiceBet),
    Roulette(RouletteBet),
    Blackjack,
}

impl Bet {
    pub fn game(&self) -> Game {
        match self {
            Self::Dice(_) => Game::Dice,
            Self::Roulette(_) => Game::Roulette,
            Self::Blackjack => Game::Blackjack,
        }
    }

    pub fn is_valid(&self) -> bool {
        match self {
            Self::Dice(bet) => bet.is_valid(),
            Self::Roulette(bet) => bet.is_valid(),
            Self::Blackjack => true,
        }
    }
}

/// Roulette's own edge: the zero, 1/37 = 270.27 bp (rounded down).
pub const ROULETTE_BASE_EDGE_BP: u16 = 270;

/// House edge of this blackjack against perfect play without split, in bp (rounded to nearest).
/// Computed exactly by `BjStrategy::optimal(0)` and checked by simulation in `tests/edges.rs`
/// (`blackjack_base_edge`).
pub const BLACKJACK_BASE_EDGE_BP: u16 = 117;

/// The game's own edge before the dealer's rake, in bp.
pub fn base_edge_bp(game: Game) -> u16 {
    match game {
        // Dice pays fair; its whole edge is the rake.
        Game::Dice => 0,
        Game::Roulette => ROULETTE_BASE_EDGE_BP,
        Game::Blackjack => BLACKJACK_BASE_EDGE_BP,
    }
}

/// Same function under the name used in the plan.
pub const BASE_EDGE_BP: fn(Game) -> u16 = base_edge_bp;

/// Rake range `(min, max)` in bp that keeps the total edge against a perfect player in
/// [100, 500] bp, for every bet the game allows. Proven by `tests/edges.rs` (`total_edge_bounds`).
/// The maxima keep ~5 bp below 500 so integer rounding (always in the pool's favour, at most two
/// base units per round) cannot push a bet over the cap, provided the minimum bet is at least
/// 0.01 USDC (10 000 base units, where two units are 2 bp).
pub fn rake_bounds(game: Game) -> (u16, u16) {
    match game {
        // Total edge = rake (or less, see `apply_rake`, never under 200 bp then).
        Game::Dice => (100, 495),
        // Total edge = 270.27 + rake × 36/37: 270 to 494 bp.
        Game::Roulette => (0, 230),
        // Total edge = 116.8 + rake × ~0.97 (exact play under each rake): 117 to 495 bp.
        Game::Blackjack => (0, 389),
    }
}

/// Pays a gross amount minus the dealer's rake. The rake is `rake_bp` of the gross payout, taken
/// only on winning rounds (`gross > stake`) and only out of the gain: it never touches the stake,
/// pushes or losses. Rounded up (in the pool's favour).
///
/// Why of the gross and not of the gain: dice lets the player pick any chance from 1 % to 98 %;
/// a cut of the gain is worth `rake × (1 − chance)` of the stake, so no single rake could keep
/// both a 98 % bet above 1 % edge and a 1 % bet under 5 %. A cut of the gross is worth exactly
/// `rake` for every chance. When the cut would exceed the gain (a 98 % dice bet at a rake above
/// 200 bp), the win just returns the stake, and the edge is `10000 − chance` ≥ 200 bp.
///
/// `stake` is the total wagered on the round (for a doubled blackjack hand, see `bj_wager`).
pub fn apply_rake(gross: u128, stake: u128, rake_bp: u16) -> u128 {
    if gross <= stake {
        return gross;
    }
    let gain = gross - stake;
    let cut = gross
        .checked_mul(u128::from(rake_bp))
        .map(|scaled| scaled.div_ceil(BP))
        // Only reachable with absurd amounts: take the whole gain rather than risk paying too much.
        .unwrap_or(gain);
    gross - cut.min(gain)
}

/// Upper bound of `worst_case_payout / stake` over every valid bet of a game: what one bet can
/// cost the pool at most, per unit staked. Used to size `max_bet` and to decide if a table is open.
pub fn worst_case_multiple(game: Game) -> u128 {
    match game {
        // 1 % chance pays 100×.
        Game::Dice => BP / u128::from(dice::MIN_CHANCE_BP),
        // A number pays 35:1, stake included 36×.
        Game::Roulette => 36,
        // A doubled win: 2 × (2 × stake). A natural pays only 2.5×.
        Game::Blackjack => 4,
    }
}

/// Most the pool may have to pay for this bet (gross before rake, stake included); what it must
/// reserve while the round is open. A blackjack hand reserves the doubled win from the deal, so
/// doubling never needs new liquidity. A bet for another game or an invalid bet returns
/// `u128::MAX`, which no pool can cover, so it is refused.
pub fn worst_case_payout(game: Game, stake: u128, bet: &Bet) -> u128 {
    if bet.game() != game || !bet.is_valid() {
        return u128::MAX;
    }
    match bet {
        Bet::Dice(dice) => dice::dice_win_gross(stake, dice.chance_bp),
        Bet::Roulette(roulette) => roulette::roulette_win_gross(stake, roulette),
        Bet::Blackjack => stake.saturating_mul(worst_case_multiple(Game::Blackjack)),
    }
}

/// Serde helper: integer amounts as JSON decimal strings (`#[serde(with = "core_rules::amount_str")]`).
pub mod amount_str {
    use std::fmt::Display;
    use std::str::FromStr;

    use serde::{de, Deserialize, Deserializer, Serializer};

    pub fn serialize<T: Display, S: Serializer>(
        value: &T,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.collect_str(value)
    }

    pub fn deserialize<'de, T, D>(deserializer: D) -> Result<T, D::Error>
    where
        T: FromStr,
        T::Err: Display,
        D: Deserializer<'de>,
    {
        let text = String::deserialize(deserializer)?;
        text.parse().map_err(de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rake_only_on_wins_and_only_from_the_gain() {
        assert_eq!(apply_rake(0, 100, 300), 0);
        assert_eq!(apply_rake(100, 100, 300), 100);
        assert_eq!(apply_rake(200, 100, 300), 194);
        assert_eq!(apply_rake(200, 100, 0), 200);
        // Cut larger than the gain: the stake comes back, never less.
        assert_eq!(apply_rake(102, 100, 495), 100);
    }

    #[test]
    fn rake_rounds_up() {
        assert_eq!(apply_rake(3, 1, 100), 2);
        assert_eq!(apply_rake(20_001, 10_000, 100), 19_800);
    }

    #[test]
    fn rake_overflow_takes_the_gain() {
        assert_eq!(apply_rake(u128::MAX, 1, 500), 1);
    }

    #[test]
    fn worst_cases() {
        let dice = Bet::Dice(DiceBet {
            chance_bp: 100,
            over: false,
        });
        assert_eq!(worst_case_payout(Game::Dice, 10, &dice), 1_000);
        let half = Bet::Dice(DiceBet {
            chance_bp: 5_000,
            over: true,
        });
        assert_eq!(worst_case_payout(Game::Dice, 10, &half), 20);
        assert_eq!(
            worst_case_payout(Game::Roulette, 10, &Bet::Roulette(RouletteBet::Straight(7))),
            360
        );
        assert_eq!(
            worst_case_payout(Game::Roulette, 10, &Bet::Roulette(RouletteBet::Column(1))),
            30
        );
        assert_eq!(worst_case_payout(Game::Blackjack, 10, &Bet::Blackjack), 40);
    }

    #[test]
    fn mismatched_or_invalid_bets_are_uncoverable() {
        assert_eq!(
            worst_case_payout(Game::Dice, 10, &Bet::Blackjack),
            u128::MAX
        );
        let invalid = Bet::Dice(DiceBet {
            chance_bp: 50,
            over: false,
        });
        assert_eq!(worst_case_payout(Game::Dice, 10, &invalid), u128::MAX);
        assert_eq!(
            worst_case_payout(
                Game::Roulette,
                10,
                &Bet::Roulette(RouletteBet::Straight(40))
            ),
            u128::MAX
        );
    }

    #[test]
    fn worst_case_multiple_bounds_every_bet() {
        let stake = 1_000_003;
        for chance_bp in dice::MIN_CHANCE_BP..=dice::MAX_CHANCE_BP {
            let bet = Bet::Dice(DiceBet {
                chance_bp,
                over: false,
            });
            assert!(
                worst_case_payout(Game::Dice, stake, &bet)
                    <= stake * worst_case_multiple(Game::Dice)
            );
        }
        let straight = Bet::Roulette(RouletteBet::Straight(0));
        assert_eq!(
            worst_case_payout(Game::Roulette, stake, &straight),
            stake * worst_case_multiple(Game::Roulette)
        );
    }

    #[test]
    fn bet_json_shape() {
        let bet: Bet = serde_json::from_str(r#"{"dice":{"chance_bp":5000,"over":true}}"#).unwrap();
        assert_eq!(
            bet,
            Bet::Dice(DiceBet {
                chance_bp: 5_000,
                over: true
            })
        );
        assert_eq!(
            serde_json::to_string(&Bet::Blackjack).unwrap(),
            r#""blackjack""#
        );
        assert_eq!(
            serde_json::to_string(&Game::Roulette).unwrap(),
            r#""roulette""#
        );
    }
}
