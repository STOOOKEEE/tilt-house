//! # How an NPC plays poker (docs/poker-rules.md)
//!
//! Poker tables can seat house bots, always labeled as such. This file is all they decide; the
//! server passes in their own random numbers (`&mut Rng`), so the same draws give the same play.
//! A bot sees exactly what a human sees: the public table (`HandView`) and its two hole cards.
//!
//! **Seats (anti-bumhunting).** Bots never pick tables or chase weak players: they only fill empty
//! seats so a lone human has a game, and they make room as soon as a human wants a seat
//! (`npc_seats_change`).
//! - No human at the table: every bot leaves.
//! - With humans: bots fill up to `TARGET_PLAYERS` players, never into a seat a human needs; a
//!   bot over that count leaves when the hand ends.
//!
//! **Styles.** Three personalities (`Style::of` maps the NPC gamblers' personas), from the classic
//! chart of starting hands:
//! - *Tight*: plays few hands (the top two tiers), bets its strong hands, rarely bluffs.
//! - *Loose*: plays many hands (four tiers), calls a lot, bluffs a little.
//! - *Aggressive*: plays three tiers but raises instead of calling and bluffs more.
//!
//! **Before the flop.** Each starting hand has a tier from 1 (aces, kings, queens, jacks, ace-king)
//! to 5 (the rest; `preflop_tier`). Unraised pot: open-raise to 3 big blinds with a good enough
//! tier, else check the big blind or fold (loose bots also limp). Raised pot: re-raise to 3× the
//! bet with the best tiers, call with the next ones if the price is at most a quarter of the
//! stack, fold the rest.
//!
//! **After the flop.** The bot estimates its equity (its share of the pot if all cards were
//! dealt now) by dealing the unseen cards at random `EQUITY_SAMPLES` times against every live
//! opponent (`equity_bp`). Facing a bet, it compares that equity with the pot odds (the call over
//! the pot after calling): raise when far ahead, call when the price is right, fold otherwise.
//! With nothing to call, it bets two thirds of the pot with a strong hand, sometimes bluffs half
//! the pot, else checks. Thresholds are for heads-up; with more opponents they shrink in
//! proportion, since a fair share of the pot is smaller.
//!
//! Whatever it wants, the bot only ever returns a legal action: sizes are clamped into the raise
//! range, a raise it may not make becomes a call (or a check), and it never folds when checking
//! is free.

use crate::gambler_rules::Persona;
use crate::poker::{evaluate, Card, HandView, Legal, PokerAction, Street, MAX_SEATS};
use crate::{Rng, BP};

/// Players a table aims for once a human sits: enough for a lively game, with seats to spare.
pub const TARGET_PLAYERS: u8 = 4;
/// Random deals per equity estimate: ±3.5 % at worst (one standard deviation), plenty for a bot.
pub const EQUITY_SAMPLES: u32 = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Style {
    Tight,
    Loose,
    Aggressive,
}

impl Style {
    pub const ALL: [Self; 3] = [Self::Tight, Self::Loose, Self::Aggressive];

    /// The table manners of an NPC gambler: bargain hunters and regulars play tight, tourists
    /// loose, whales and thrill seekers aggressive.
    pub fn of(persona: Persona) -> Self {
        match persona {
            Persona::BargainHunter | Persona::Regular => Self::Tight,
            Persona::Tourist => Self::Loose,
            Persona::Whale | Persona::ThrillSeeker => Self::Aggressive,
        }
    }
}

/// How a style plays, in tiers and bp of equity.
struct Params {
    /// Open-raise an unraised pot with tiers up to this.
    open_tier: u8,
    /// Call a raise (or limp, for loose bots) with tiers up to this.
    call_tier: u8,
    /// Re-raise a raise with tiers up to this.
    reraise_tier: u8,
    /// Postflop heads-up equity to bet for value.
    value_bp: u32,
    /// Postflop heads-up equity to raise a bet.
    raise_bp: u32,
    /// Added to the pot odds before calling (negative: calls light).
    call_margin_bp: i64,
    /// Chance to bluff when checked to.
    bluff_bp: u32,
    /// Chance to raise instead of just calling or checking a strong-enough hand.
    aggression_bp: u32,
}

fn params(style: Style) -> Params {
    match style {
        Style::Tight => Params {
            open_tier: 2,
            call_tier: 2,
            reraise_tier: 1,
            value_bp: 6_000,
            raise_bp: 7_500,
            call_margin_bp: 500,
            bluff_bp: 200,
            aggression_bp: 1_000,
        },
        Style::Loose => Params {
            open_tier: 3,
            call_tier: 4,
            reraise_tier: 1,
            value_bp: 5_500,
            raise_bp: 8_000,
            call_margin_bp: -500,
            bluff_bp: 500,
            aggression_bp: 1_000,
        },
        Style::Aggressive => Params {
            open_tier: 4,
            call_tier: 3,
            reraise_tier: 2,
            value_bp: 5_000,
            raise_bp: 6_500,
            call_margin_bp: 0,
            bluff_bp: 1_500,
            aggression_bp: 4_000,
        },
    }
}

/// Starting-hand tier, 1 (best) to 5 (fold almost always).
pub fn preflop_tier(hole: [Card; 2]) -> u8 {
    let (high, low) = if hole[0].rank() >= hole[1].rank() {
        (hole[0].rank(), hole[1].rank())
    } else {
        (hole[1].rank(), hole[0].rank())
    };
    let suited = hole[0].suit() == hole[1].suit();
    // Ranks: 12 = ace, 11 = king, 10 = queen, 9 = jack, 8 = ten.
    const A: u8 = 12;
    const K: u8 = 11;
    const Q: u8 = 10;
    const J: u8 = 9;
    const T: u8 = 8;
    if high == low {
        return match high {
            J..=A => 1,
            7..=8 => 2,
            5..=6 => 3,
            _ => 4,
        };
    }
    let gap = high - low;
    match (high, low, suited) {
        (A, K, _) => 1,
        (A, Q, _) | (A, J, true) | (K, Q, true) => 2,
        (A, J, false)
        | (A, T, true)
        | (K, J, true)
        | (Q, J, true)
        | (J, T, true)
        | (K, Q, false) => 3,
        (A, _, true)
        | (A, T, false)
        | (K, J, false)
        | (Q, J, false)
        | (K, T, true)
        | (Q, T, true) => 4,
        // Suited connectors down to five-four.
        (_, _, true) if gap == 1 && low >= 3 => 4,
        _ => 5,
    }
}

/// Share of the pot `hole` would win, in bp, if the rest of the board and the opponents' cards
/// were dealt at random: `samples` deals, a tie with k others counting 1/(k+1).
pub fn equity_bp(
    hole: [Card; 2],
    board: &[Card],
    opponents: usize,
    samples: u32,
    rng: &mut Rng,
) -> u32 {
    if opponents == 0 || samples == 0 {
        return BP as u32;
    }
    let mut unseen: Vec<Card> = (0..52u8)
        .filter_map(Card::new)
        .filter(|c| !hole.contains(c) && !board.contains(c))
        .collect();
    let missing = 5usize.saturating_sub(board.len());
    let needed = missing + 2 * opponents;
    if needed > unseen.len() {
        return 0;
    }
    let mut total: u64 = 0;
    for _ in 0..samples {
        // Partial Fisher–Yates: the first `needed` cards become a random draw.
        for i in 0..needed {
            let j = i + rng.below((unseen.len() - i) as u32) as usize;
            unseen.swap(i, j);
        }
        let mut full_board = board.to_vec();
        full_board.extend(&unseen[..missing]);
        let mut mine = full_board.clone();
        mine.extend(hole);
        let my_value = evaluate(&mine);
        let mut ties = 0u64;
        let mut beaten = false;
        for k in 0..opponents {
            let at = missing + 2 * k;
            let mut theirs = full_board.clone();
            theirs.extend(&unseen[at..at + 2]);
            let value = evaluate(&theirs);
            if value > my_value {
                beaten = true;
                break;
            }
            ties += u64::from(value == my_value);
        }
        if !beaten {
            total += BP as u64 / (ties + 1);
        }
    }
    (total / u64::from(samples)) as u32
}

/// The bot's move. Call it only on the bot's turn (`view.legal` is its seat); without a legal
/// set it folds, which the hand refuses like any out-of-turn move.
pub fn decide(view: &HandView, hole: [Card; 2], style: Style, rng: &mut Rng) -> PokerAction {
    let Some(legal) = view.legal else {
        return PokerAction::Fold;
    };
    let p = params(style);
    let action = if view.street == Street::Preflop {
        preflop(view, &legal, hole, &p, rng)
    } else {
        postflop(view, &legal, hole, &p, rng)
    };
    debug_assert!(legal.allows(action), "{action:?} not in {legal:?}");
    action
}

fn preflop(
    view: &HandView,
    legal: &Legal,
    hole: [Card; 2],
    p: &Params,
    rng: &mut Rng,
) -> PokerAction {
    let tier = preflop_tier(hole);
    let bb = view.big_blind;
    let raised = view.current_bet > bb;
    let roll = rng.below(BP as u32);
    if !raised {
        if tier <= p.open_tier {
            return raise_to(legal, bb.saturating_mul(3));
        }
        if p.call_tier >= 4 && tier <= p.call_tier {
            return passive(legal);
        }
        return give_up(legal);
    }
    if tier <= p.reraise_tier || (tier <= p.call_tier && roll < p.aggression_bp / 4) {
        return raise_to(legal, view.current_bet.saturating_mul(3));
    }
    let affordable = legal.call <= (legal.stack / 4).max(bb);
    if tier <= p.call_tier && affordable {
        return passive(legal);
    }
    give_up(legal)
}

fn postflop(
    view: &HandView,
    legal: &Legal,
    hole: [Card; 2],
    p: &Params,
    rng: &mut Rng,
) -> PokerAction {
    let opponents = view
        .seats
        .iter()
        .filter(|s| s.seat != legal.seat && !s.folded)
        .count();
    let equity = equity_bp(hole, &view.board, opponents, EQUITY_SAMPLES, rng);
    // Heads-up thresholds scaled to the field: half the pot heads-up is a third three-handed.
    let scale = |threshold: u32| threshold * 2 / (opponents.max(1) as u32 + 1);
    let pot: u128 = view.pots.iter().map(|pot| pot.amount).sum();
    let roll = rng.below(BP as u32);
    if legal.can_check {
        if equity >= scale(p.value_bp) {
            return raise_to(legal, legal.call + pot * 2 / 3);
        }
        if roll < p.bluff_bp {
            return raise_to(legal, pot / 2);
        }
        return PokerAction::Check;
    }
    if equity >= scale(p.raise_bp) || (equity >= scale(p.value_bp) && roll < p.aggression_bp) {
        return raise_to(legal, view.current_bet + pot);
    }
    let odds_bp = (legal.call.saturating_mul(BP) / (pot + legal.call).max(1)) as i64;
    if i64::from(equity) >= odds_bp + p.call_margin_bp {
        return PokerAction::Call;
    }
    PokerAction::Fold
}

/// A bet or raise to `target`, clamped into the legal range; a call or check when raising is
/// not allowed.
fn raise_to(legal: &Legal, target: u128) -> PokerAction {
    match legal.raise {
        Some(range) => PokerAction::RaiseTo(target.clamp(range.min_to, range.max_to)),
        None => passive(legal),
    }
}

fn passive(legal: &Legal) -> PokerAction {
    if legal.can_check {
        PokerAction::Check
    } else {
        PokerAction::Call
    }
}

/// Fold, unless checking is free.
fn give_up(legal: &Legal) -> PokerAction {
    if legal.can_check {
        PokerAction::Check
    } else {
        PokerAction::Fold
    }
}

/// The seat rule: how many bots to call in (> 0) or send away when the hand ends (< 0).
/// `humans` counts seated humans plus those asking for a seat; `free_seats` the empty seats now.
/// No human: every bot leaves. Else bots fill up to `TARGET_PLAYERS` players, never more than
/// the empty seats, and never into a seat a human needs.
pub fn npc_seats_change(humans: usize, npcs: usize, free_seats: usize) -> isize {
    let seats = usize::from(MAX_SEATS);
    let wanted = if humans == 0 {
        0
    } else {
        usize::from(TARGET_PLAYERS)
            .saturating_sub(humans)
            .min(seats.saturating_sub(humans))
    };
    if wanted >= npcs {
        (wanted - npcs).min(free_seats) as isize
    } else {
        -((npcs - wanted) as isize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::poker::{Hand, HandStart, SeatStart, TableConfig};
    use crate::session::sha256;

    fn hole(text: &str) -> [Card; 2] {
        let cards: Vec<Card> = text
            .split_whitespace()
            .map(|c| c.parse().unwrap())
            .collect();
        [cards[0], cards[1]]
    }

    #[test]
    fn chart_tiers() {
        assert_eq!(preflop_tier(hole("As Ad")), 1);
        assert_eq!(preflop_tier(hole("Jc Jd")), 1);
        assert_eq!(preflop_tier(hole("Kd As")), 1);
        assert_eq!(preflop_tier(hole("Qs As")), 2);
        assert_eq!(preflop_tier(hole("Ks Qs")), 2);
        assert_eq!(preflop_tier(hole("Kd Qs")), 3);
        assert_eq!(preflop_tier(hole("9c 9d")), 2);
        assert_eq!(preflop_tier(hole("8c 8d")), 3);
        assert_eq!(preflop_tier(hole("2c 2d")), 4);
        assert_eq!(preflop_tier(hole("5s As")), 4);
        assert_eq!(preflop_tier(hole("8h 7h")), 4);
        assert_eq!(preflop_tier(hole("4h 3h")), 5);
        assert_eq!(preflop_tier(hole("7c 2d")), 5);
    }

    #[test]
    fn equity_orders_hands() {
        let mut rng = Rng::new([5; 32]);
        let aces = equity_bp(hole("As Ad"), &[], 1, 2_000, &mut rng);
        let trash = equity_bp(hole("7c 2d"), &[], 1, 2_000, &mut rng);
        assert!((8_100..=8_900).contains(&aces), "{aces}");
        assert!((2_900..=3_700).contains(&trash), "{trash}");
        // The nuts on the river cannot lose.
        let board: Vec<Card> = "Ts Js Qs 2d 3c"
            .split_whitespace()
            .map(|c| c.parse().unwrap())
            .collect();
        assert_eq!(equity_bp(hole("As Ks"), &board, 3, 200, &mut rng), 10_000);
        assert_eq!(equity_bp(hole("As Ks"), &board, 0, 200, &mut rng), 10_000);
    }

    /// Bots of every style play thousands of hands against each other: every move is legal and
    /// every hand ends.
    #[test]
    fn bots_only_make_legal_moves() {
        let mut rng = Rng::new(*b"poker npc legality test seed 001");
        for k in 0..400u32 {
            let players = 2 + rng.below(5) as u8;
            let mut hand_seed = [0u8; 32];
            hand_seed[..4].copy_from_slice(&k.to_le_bytes());
            let start = HandStart {
                table: "bots".into(),
                hand: u64::from(k),
                config: TableConfig::standard(100),
                button: rng.below(u32::from(players)) as u8,
                seats: (0..players)
                    .map(|seat| SeatStart {
                        seat,
                        player: format!("bot{seat}"),
                        stack: 50 + u128::from(rng.below(20_000)),
                        client_seed: format!("bot{seat}-{k}"),
                        rake_bp: 300,
                    })
                    .collect(),
                hand_seed_hash: sha256(&hand_seed),
            };
            let styles: Vec<Style> = (0..players)
                .map(|_| Style::ALL[rng.below(3) as usize])
                .collect();
            let mut hand = Hand::new(start, hand_seed).unwrap();
            let mut moves = 0;
            while let Some(seat) = hand.to_act() {
                let view = hand.view();
                let action = decide(
                    &view,
                    hand.hole(seat).unwrap(),
                    styles[usize::from(seat)],
                    &mut rng,
                );
                assert!(view.legal.unwrap().allows(action));
                hand.act(seat, action).unwrap();
                moves += 1;
                assert!(moves < 200);
            }
            assert!(hand.is_done());
        }
    }

    #[test]
    fn same_draws_same_decision() {
        let seed = [3u8; 32];
        let start = HandStart {
            table: "bots".into(),
            hand: 1,
            config: TableConfig::standard(100),
            button: 0,
            seats: (0..3)
                .map(|seat| SeatStart {
                    seat,
                    player: format!("bot{seat}"),
                    stack: 10_000,
                    client_seed: format!("s{seat}"),
                    rake_bp: 0,
                })
                .collect(),
            hand_seed_hash: sha256(&seed),
        };
        let mut hand = Hand::new(start, seed).unwrap();
        hand.act(0, PokerAction::Call).unwrap();
        hand.act(1, PokerAction::Call).unwrap();
        hand.act(2, PokerAction::Check).unwrap();
        let view = hand.view();
        let seat = hand.to_act().unwrap();
        let cards = hand.hole(seat).unwrap();
        for style in Style::ALL {
            let a = decide(&view, cards, style, &mut Rng::new([7; 32]));
            let b = decide(&view, cards, style, &mut Rng::new([7; 32]));
            assert_eq!(a, b);
        }
    }

    #[test]
    fn premium_hands_raise_and_trash_folds() {
        let seed = [3u8; 32];
        let start = HandStart {
            table: "bots".into(),
            hand: 1,
            config: TableConfig::standard(100),
            button: 0,
            seats: (0..3)
                .map(|seat| SeatStart {
                    seat,
                    player: format!("bot{seat}"),
                    stack: 10_000,
                    client_seed: format!("s{seat}"),
                    rake_bp: 0,
                })
                .collect(),
            hand_seed_hash: sha256(&seed),
        };
        let hand = Hand::new(start, seed).unwrap();
        let view = hand.view();
        for style in Style::ALL {
            let mut rng = Rng::new([1; 32]);
            assert_eq!(
                decide(&view, hole("As Ad"), style, &mut rng),
                PokerAction::RaiseTo(300)
            );
            assert_eq!(
                decide(&view, hole("7c 2d"), style, &mut rng),
                PokerAction::Fold
            );
        }
    }

    #[test]
    fn bots_only_fill_empty_seats() {
        // Nobody human: every bot goes.
        assert_eq!(npc_seats_change(0, 3, 3), -3);
        assert_eq!(npc_seats_change(0, 0, 6), 0);
        // A lone human gets three bots, limited by the free seats.
        assert_eq!(npc_seats_change(1, 0, 5), 3);
        assert_eq!(npc_seats_change(1, 0, 2), 2);
        assert_eq!(npc_seats_change(1, 3, 2), 0);
        // More humans: bots make room.
        assert_eq!(npc_seats_change(3, 3, 0), -2);
        assert_eq!(npc_seats_change(4, 2, 0), -2);
        // A human asking for a seat at a full table sends one bot away.
        assert_eq!(npc_seats_change(1 + 1, 5, 0), -3);
        assert_eq!(npc_seats_change(6, 0, 0), 0);
        for humans in 0..=6 {
            for npcs in 0..=6 - humans.min(6) {
                let free = 6usize.saturating_sub(humans + npcs);
                let change = npc_seats_change(humans, npcs, free);
                let after = (npcs as isize + change) as usize;
                assert!(change <= free as isize);
                assert!(humans + after <= 6 || change <= 0);
                if humans == 0 {
                    assert_eq!(after, 0);
                }
                assert!(humans + after <= usize::from(TARGET_PLAYERS).max(humans));
            }
        }
    }

    #[test]
    fn persona_styles() {
        assert_eq!(Style::of(Persona::Tourist), Style::Loose);
        assert_eq!(Style::of(Persona::Whale), Style::Aggressive);
        assert_eq!(Style::of(Persona::Regular), Style::Tight);
    }
}
