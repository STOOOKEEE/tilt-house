//! Blackjack, one hand: infinite shoe, blackjack pays 3:2, dealer stands on every 17, no hole card
//! (the dealer draws after the player and a dealer blackjack takes everything, doubles included),
//! hit / stand / double on the first two cards, no split, no surrender.
//!
//! Cards are ranks 1..=13 (ace = 1, jack/queen/king = 11/12/13), so the table can show them.
//! Each step uses the randomness of its own VRF request: `bj_deal`, then `bj_hit`/`bj_double`/
//! `bj_stand` until `done`.

use std::fmt;

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::rng::Rng;

const TWENTY_ONE: u8 = 21;
const DEALER_STANDS_ON: u8 = 17;
const RANKS: u32 = 13;

#[derive(
    Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
pub struct BjState {
    pub player: Vec<u8>,
    pub dealer: Vec<u8>,
    pub doubled: bool,
    pub done: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BjError {
    /// The hand is over.
    Done,
    /// Doubling is only allowed on the first two cards.
    NotFirstTwoCards,
}

impl fmt::Display for BjError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Done => "the hand is over",
            Self::NotFirstTwoCards => "double is only allowed on the first two cards",
        })
    }
}

impl std::error::Error for BjError {}

fn draw(rng: &mut Rng) -> u8 {
    rng.below(RANKS) as u8 + 1
}

/// Points of a rank: ace 1 (counted as 11 by `bj_total` when it fits), faces 10.
pub fn card_value(rank: u8) -> u8 {
    rank.min(10)
}

/// Best total of a hand and whether it is soft (an ace counted as 11).
pub fn bj_total(cards: &[u8]) -> (u8, bool) {
    let hard: u32 = cards.iter().map(|&c| u32::from(card_value(c))).sum();
    let has_ace = cards.contains(&1);
    let soft = has_ace && hard + 10 <= u32::from(TWENTY_ONE);
    let total = if soft { hard + 10 } else { hard };
    (total.min(u32::from(u8::MAX)) as u8, soft)
}

fn is_natural(cards: &[u8]) -> bool {
    cards.len() == 2 && bj_total(cards).0 == TWENTY_ONE
}

/// Two cards to the player, one to the dealer. A player blackjack ends the hand at once: the
/// dealer only draws the one card that could tie it.
pub fn bj_deal(rng: &mut Rng) -> BjState {
    let mut state = BjState {
        player: vec![draw(rng), draw(rng)],
        dealer: vec![draw(rng)],
        ..BjState::default()
    };
    if is_natural(&state.player) {
        state.dealer.push(draw(rng));
        state.done = true;
    }
    state
}

/// One more card. A bust ends the hand; reaching 21 stands automatically.
pub fn bj_hit(state: &mut BjState, rng: &mut Rng) -> Result<(), BjError> {
    ensure_playing(state)?;
    state.player.push(draw(rng));
    finish_if_settled(state, rng);
    Ok(())
}

/// Doubles the stake, takes exactly one card, then the dealer plays (unless the player busts).
pub fn bj_double(state: &mut BjState, rng: &mut Rng) -> Result<(), BjError> {
    ensure_playing(state)?;
    if state.player.len() != 2 {
        return Err(BjError::NotFirstTwoCards);
    }
    state.doubled = true;
    state.player.push(draw(rng));
    if bj_total(&state.player).0 > TWENTY_ONE {
        state.done = true;
    } else {
        dealer_plays(state, rng);
    }
    Ok(())
}

pub fn bj_stand(state: &mut BjState, rng: &mut Rng) -> Result<(), BjError> {
    ensure_playing(state)?;
    dealer_plays(state, rng);
    Ok(())
}

fn ensure_playing(state: &BjState) -> Result<(), BjError> {
    if state.done {
        Err(BjError::Done)
    } else {
        Ok(())
    }
}

fn finish_if_settled(state: &mut BjState, rng: &mut Rng) {
    match bj_total(&state.player).0 {
        t if t > TWENTY_ONE => state.done = true,
        TWENTY_ONE => dealer_plays(state, rng),
        _ => {}
    }
}

fn dealer_plays(state: &mut BjState, rng: &mut Rng) {
    while bj_total(&state.dealer).0 < DEALER_STANDS_ON {
        state.dealer.push(draw(rng));
    }
    state.done = true;
}

/// Total amount the player has at risk: the stake, twice it after a double.
pub fn bj_wager(state: &BjState, stake: u128) -> u128 {
    if state.doubled {
        stake.saturating_mul(2)
    } else {
        stake
    }
}

/// Gross payout (wager included) of a finished hand, before rake; `stake` is the initial stake.
/// Blackjack pays 3:2 rounded down (rounding favours the pool).
///
/// Panics if the hand is not finished: settling a live hand is a caller bug, and a panic reverts
/// the whole call instead of paying a wrong amount.
pub fn bj_gross(state: &BjState, stake: u128) -> u128 {
    assert!(state.done, "bj_gross on an unfinished hand");
    let wager = bj_wager(state, stake);
    let (player, _) = bj_total(&state.player);
    if player > TWENTY_ONE {
        return 0;
    }
    let dealer_natural = is_natural(&state.dealer);
    if is_natural(&state.player) && !state.doubled {
        return if dealer_natural {
            wager
        } else {
            wager.saturating_mul(5) / 2
        };
    }
    if dealer_natural {
        return 0;
    }
    let (dealer, _) = bj_total(&state.dealer);
    if dealer > TWENTY_ONE || player > dealer {
        wager.saturating_mul(2)
    } else if player == dealer {
        wager
    } else {
        0
    }
}

// ---------------------------------------------------------------------------------------------
// Perfect play. Computed exactly (infinite shoe), used to prove the edge bounds against a
// perfect player and by the simulator's sharp players. Floats are fine here: this is analysis,
// never money.
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BjMove {
    Hit,
    Stand,
    Double,
}

/// Probability of drawing a card worth `value` points (1..=10).
fn value_probability(value: u8) -> f64 {
    if value == 10 {
        4.0 / 13.0
    } else {
        1.0 / 13.0
    }
}

fn best_total(hard: u8, has_ace: bool) -> u8 {
    if has_ace && hard + 10 <= TWENTY_ONE {
        hard + 10
    } else {
        hard
    }
}

const BUST: usize = 5;
const DEALER_BJ: usize = 6;

/// Dealer outcome probabilities for an upcard value: index 0..=4 for 17..=21, then bust,
/// then blackjack.
fn dealer_outcomes(up: u8) -> [f64; 7] {
    fn go(hard: u8, has_ace: bool, cards: u8, prob: f64, out: &mut [f64; 7]) {
        let total = best_total(hard, has_ace);
        if cards == 2 && total == TWENTY_ONE {
            out[DEALER_BJ] += prob;
        } else if total > TWENTY_ONE {
            out[BUST] += prob;
        } else if total >= DEALER_STANDS_ON {
            out[usize::from(total - DEALER_STANDS_ON)] += prob;
        } else {
            for v in 1..=10 {
                go(
                    hard + v,
                    has_ace || v == 1,
                    cards + 1,
                    prob * value_probability(v),
                    out,
                );
            }
        }
    }
    let mut out = [0.0; 7];
    go(up, up == 1, 1, 1.0, &mut out);
    out
}

/// Optimal hit/stand/double for these rules at a given rake (the rake shrinks wins, which can
/// shift close decisions).
pub struct BjStrategy {
    /// Indexed by `slot(up, hard, has_ace, first_two)`.
    moves: Vec<BjMove>,
    player_ev: f64,
}

const HARD_SLOTS: usize = 22;

fn slot(up: u8, hard: u8, has_ace: bool, first_two: bool) -> usize {
    ((usize::from(up) * HARD_SLOTS + usize::from(hard)) * 2 + usize::from(has_ace)) * 2
        + usize::from(first_two)
}

impl BjStrategy {
    pub fn optimal(rake_bp: u16) -> Self {
        let rake = f64::from(rake_bp) / 10_000.0;
        // Net results per unit wagered after rake (rake is taken from the gross of a win).
        let win = 1.0 - 2.0 * rake;
        let natural = 1.5 - 2.5 * rake;
        let mut moves = vec![BjMove::Stand; slot(11, 0, false, false)];
        let mut player_ev = 0.0;
        for up in 1..=10u8 {
            let dealer = dealer_outcomes(up);
            let stand = |total: u8| stand_ev(total, &dealer, win);
            // Value of a hand of three cards or more, by (hard total, has ace), playing optimally.
            let mut later = [[0.0f64; 2]; HARD_SLOTS];
            for hard in (2..=TWENTY_ONE).rev() {
                for has_ace in [false, true] {
                    let stand_value = stand(best_total(hard, has_ace));
                    let hit_value = hit_ev(hard, has_ace, &later);
                    let hit_better =
                        best_total(hard, has_ace) < TWENTY_ONE && hit_value > stand_value;
                    later[usize::from(hard)][usize::from(has_ace)] =
                        if hit_better { hit_value } else { stand_value };
                    moves[slot(up, hard, has_ace, false)] = if hit_better {
                        BjMove::Hit
                    } else {
                        BjMove::Stand
                    };
                }
            }
            for a in 1..=10u8 {
                for b in 1..=10u8 {
                    let hard = a + b;
                    let has_ace = a == 1 || b == 1;
                    let prob = value_probability(a) * value_probability(b) * value_probability(up);
                    if best_total(hard, has_ace) == TWENTY_ONE {
                        player_ev += prob * (1.0 - dealer[DEALER_BJ]) * natural;
                        continue;
                    }
                    let options = [
                        (BjMove::Stand, stand(best_total(hard, has_ace))),
                        (BjMove::Hit, hit_ev(hard, has_ace, &later)),
                        (BjMove::Double, 2.0 * double_ev(hard, has_ace, &stand)),
                    ];
                    let (best, value) =
                        options
                            .into_iter()
                            .fold(options[0], |best, o| if o.1 > best.1 { o } else { best });
                    moves[slot(up, hard, has_ace, true)] = best;
                    player_ev += prob * value;
                }
            }
        }
        Self { moves, player_ev }
    }

    /// Expected net result per unit of initial stake for a perfect player (negative = house edge).
    pub fn player_ev(&self) -> f64 {
        self.player_ev
    }

    pub fn decide(&self, state: &BjState) -> BjMove {
        let (total, _) = bj_total(&state.player);
        if state.done || total >= TWENTY_ONE || state.dealer.is_empty() {
            return BjMove::Stand;
        }
        let hard = state.player.iter().map(|&c| card_value(c)).sum::<u8>();
        let has_ace = state.player.contains(&1);
        let first_two = state.player.len() == 2 && !state.doubled;
        self.moves[slot(card_value(state.dealer[0]), hard, has_ace, first_two)]
    }
}

fn stand_ev(total: u8, dealer: &[f64; 7], win: f64) -> f64 {
    let mut ev = dealer[BUST] * win - dealer[DEALER_BJ];
    for (i, &p) in dealer[..BUST].iter().enumerate() {
        let dealer_total = DEALER_STANDS_ON + i as u8;
        ev += p * match total.cmp(&dealer_total) {
            std::cmp::Ordering::Greater => win,
            std::cmp::Ordering::Equal => 0.0,
            std::cmp::Ordering::Less => -1.0,
        };
    }
    ev
}

fn hit_ev(hard: u8, has_ace: bool, later: &[[f64; 2]; HARD_SLOTS]) -> f64 {
    (1..=10u8)
        .map(|v| {
            let next = hard + v;
            let value = if next > TWENTY_ONE {
                -1.0
            } else {
                later[usize::from(next)][usize::from(has_ace || v == 1)]
            };
            value_probability(v) * value
        })
        .sum()
}

fn double_ev(hard: u8, has_ace: bool, stand: &dyn Fn(u8) -> f64) -> f64 {
    (1..=10u8)
        .map(|v| {
            let next = hard + v;
            let value = if next > TWENTY_ONE {
                -1.0
            } else {
                stand(best_total(next, has_ace || v == 1))
            };
            value_probability(v) * value
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hand(player: &[u8], dealer: &[u8], doubled: bool) -> BjState {
        BjState {
            player: player.to_vec(),
            dealer: dealer.to_vec(),
            doubled,
            done: true,
        }
    }

    #[test]
    fn totals() {
        assert_eq!(bj_total(&[1, 6]), (17, true));
        assert_eq!(bj_total(&[1, 6, 10]), (17, false));
        assert_eq!(bj_total(&[1, 1]), (12, true));
        assert_eq!(bj_total(&[13, 12, 11]), (30, false));
        assert_eq!(bj_total(&[1, 13]), (21, true));
        assert_eq!(bj_total(&[]), (0, false));
    }

    #[test]
    fn payouts() {
        // Natural pays 3:2, rounded down.
        assert_eq!(bj_gross(&hand(&[1, 12], &[9, 8], false), 10), 25);
        assert_eq!(bj_gross(&hand(&[1, 12], &[9, 8], false), 3), 7);
        // Natural against a dealer natural pushes.
        assert_eq!(bj_gross(&hand(&[1, 12], &[10, 1], false), 10), 10);
        // Dealer natural beats a three-card 21 and takes the double too (no hole card).
        assert_eq!(bj_gross(&hand(&[5, 6, 10], &[1, 10], true), 10), 0);
        // Regular win, push, loss, dealer bust, player bust.
        assert_eq!(bj_gross(&hand(&[10, 9], &[10, 8], false), 10), 20);
        assert_eq!(bj_gross(&hand(&[10, 8], &[10, 8], false), 10), 10);
        assert_eq!(bj_gross(&hand(&[10, 7], &[10, 8], false), 10), 0);
        assert_eq!(bj_gross(&hand(&[10, 2], &[10, 6, 9], false), 10), 20);
        assert_eq!(bj_gross(&hand(&[10, 2, 13], &[10, 6, 9], false), 10), 0);
        // Doubled win pays 4 × the initial stake, doubled push returns 2 ×.
        assert_eq!(bj_gross(&hand(&[5, 6, 10], &[10, 9], true), 10), 40);
        assert_eq!(bj_gross(&hand(&[5, 6, 9], &[10, 10], true), 10), 20);
    }

    #[test]
    #[should_panic]
    fn gross_of_unfinished_hand_panics() {
        let mut state = hand(&[10, 6], &[9], false);
        state.done = false;
        bj_gross(&state, 10);
    }

    #[test]
    fn hand_flow_respects_rules() {
        for seed in 0..2_000u32 {
            let mut bytes = [0u8; 32];
            bytes[..4].copy_from_slice(&seed.to_le_bytes());
            let mut rng = Rng::new(bytes);
            let mut state = bj_deal(&mut rng);
            assert_eq!(state.player.len(), 2);
            if state.done {
                assert!(is_natural(&state.player));
                assert_eq!(state.dealer.len(), 2);
                continue;
            }
            assert_eq!(state.dealer.len(), 1);
            match seed % 3 {
                0 => bj_double(&mut state, &mut rng).unwrap(),
                1 => bj_stand(&mut state, &mut rng).unwrap(),
                _ => {
                    while !state.done {
                        bj_hit(&mut state, &mut rng).unwrap();
                    }
                    assert_eq!(bj_double(&mut state, &mut rng), Err(BjError::Done));
                }
            }
            assert!(state.done);
            assert_eq!(bj_stand(&mut state, &mut rng), Err(BjError::Done));
            let player_busted = bj_total(&state.player).0 > 21;
            if player_busted {
                assert_eq!(state.dealer.len(), 1, "dealer does not play against a bust");
            } else {
                assert!(bj_total(&state.dealer).0 >= 17, "dealer stands on 17 only");
            }
            assert!(bj_gross(&state, 10) <= 40);
        }
    }

    #[test]
    fn double_only_on_first_two_cards() {
        let mut rng = Rng::new([5; 32]);
        let mut state = BjState {
            player: vec![2, 3],
            dealer: vec![10],
            ..BjState::default()
        };
        bj_hit(&mut state, &mut rng).unwrap();
        assert!(!state.done);
        assert_eq!(
            bj_double(&mut state, &mut rng),
            Err(BjError::NotFirstTwoCards)
        );
        assert!(!state.doubled);
    }

    #[test]
    fn hitting_21_stands_automatically() {
        // Find a seed whose first card is a 10-valued card, so 11 + it = 21.
        for seed in 0..=255u8 {
            let mut rng = Rng::new([seed; 32]);
            let mut state = BjState {
                player: vec![5, 6],
                dealer: vec![7],
                ..BjState::default()
            };
            bj_hit(&mut state, &mut rng).unwrap();
            if bj_total(&state.player).0 == 21 {
                assert!(state.done);
                assert!(bj_total(&state.dealer).0 >= 17);
                return;
            }
        }
        panic!("no seed drew a ten");
    }

    #[test]
    fn dealer_outcomes_sum_to_one() {
        for up in 1..=10 {
            let total: f64 = dealer_outcomes(up).iter().sum();
            assert!((total - 1.0).abs() < 1e-12);
        }
        assert!((dealer_outcomes(1)[DEALER_BJ] - 4.0 / 13.0).abs() < 1e-12);
        assert!((dealer_outcomes(10)[DEALER_BJ] - 1.0 / 13.0).abs() < 1e-12);
    }

    #[test]
    fn perfect_play_looks_like_basic_strategy() {
        let strategy = BjStrategy::optimal(0);
        let mv = |player: &[u8], up: u8| {
            strategy.decide(&BjState {
                player: player.to_vec(),
                dealer: vec![up],
                ..BjState::default()
            })
        };
        assert_eq!(mv(&[10, 6], 10), BjMove::Hit);
        assert_eq!(mv(&[10, 7], 10), BjMove::Stand);
        assert_eq!(mv(&[10, 3], 6), BjMove::Stand);
        assert_eq!(mv(&[6, 5], 6), BjMove::Double);
        assert_eq!(mv(&[10, 2], 2), BjMove::Hit);
        assert_eq!(mv(&[1, 7], 9), BjMove::Hit);
        assert_eq!(mv(&[5, 3, 6], 6), BjMove::Stand);
        assert_eq!(mv(&[10, 1], 6), BjMove::Stand);
    }
}
