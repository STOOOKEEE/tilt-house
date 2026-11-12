//! `web/src/near/poker-vectors.json`: what the browser's replay of a poker hand must rebuild
//! (`poker-rules.test.ts`), produced by `core_rules::poker`: decks, hand values, settlements and
//! whole scripted hands (legal moves before each action, result, history hash, session rounds).
//! Fails when the file drifts from the Rust code; `TILT_WRITE_VECTORS=1` rewrites it.

use core_rules::poker::{
    deck_for, deck_seed, evaluate, settle_hand, Card, Hand, HandStart, PokerAction, SeatStart,
    SettleSeat, TableConfig,
};
use core_rules::session::sha256;
use serde_json::{json, Value};

const PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../web/src/near/poker-vectors.json"
);
const BB: u128 = 100_000;

fn seed(byte: u8) -> [u8; 32] {
    [byte; 32]
}

fn cards(text: &str) -> Vec<Card> {
    text.split_whitespace()
        .map(|c| c.parse().unwrap())
        .collect()
}

fn start(hand: u64, button: u8, seats: &[(u8, u128, u16)], hand_seed: &[u8; 32]) -> HandStart {
    HandStart {
        table: "poker-demo".to_string(),
        hand,
        config: TableConfig::standard(BB),
        button,
        seats: seats
            .iter()
            .map(|&(seat, stack, rake_bp)| SeatStart {
                seat,
                player: format!("p{seat}.testnet"),
                stack,
                client_seed: format!("seed-{seat}-{hand}"),
                rake_bp,
            })
            .collect(),
        hand_seed_hash: sha256(hand_seed),
    }
}

/// Plays `script` in turn order (each action by whoever is to act) and records everything.
fn scripted(name: &str, start: HandStart, hand_seed: [u8; 32], script: &[PokerAction]) -> Value {
    let seats: Vec<u8> = start.seats.iter().map(|s| s.seat).collect();
    let mut hand = Hand::new(start, hand_seed).unwrap();
    let mut legals = Vec::new();
    for &action in script {
        let seat = hand
            .to_act()
            .unwrap_or_else(|| panic!("{name}: nobody to act"));
        legals.push(serde_json::to_value(hand.legal().unwrap()).unwrap());
        hand.act(seat, action)
            .unwrap_or_else(|e| panic!("{name}: {action:?} by {seat}: {e}"));
    }
    assert!(hand.is_done(), "{name}: script does not finish the hand");
    let history = hand.history().unwrap();
    let rounds: Vec<Value> = seats
        .iter()
        .map(|&seat| {
            let round = hand.round_for(seat, 7).unwrap();
            json!({ "round": round, "borsh": hex::encode(borsh::to_vec(&round).unwrap()) })
        })
        .collect();
    json!({
        "name": name,
        "history": history,
        "history_hash": hex::encode(history.hash()),
        "deck": hand_deck(&history.start, &history.hand_seed),
        "holes": seats.iter().map(|&s| hand.hole(s).unwrap()).collect::<Vec<_>>(),
        "legals": legals,
        "result": hand.result().unwrap(),
        "rounds": rounds,
    })
}

fn hand_deck(start: &HandStart, hand_seed: &[u8; 32]) -> Vec<String> {
    let seeds: Vec<&str> = start.seats.iter().map(|s| s.client_seed.as_str()).collect();
    deck_for(hand_seed, &seeds)
        .iter()
        .map(ToString::to_string)
        .collect()
}

fn hands() -> Vec<Value> {
    use PokerAction::*;
    let three = [
        (0, 2_000_000, 300),
        (1, 2_000_000, 250),
        (3, 2_000_000, 400),
    ];
    let checks = |n| vec![Check; n];
    let mut down = vec![Call, Call, Check];
    down.extend(checks(9));
    vec![
        scripted(
            "fold preflop, no flop no drop",
            start(1, 0, &three, &seed(1)),
            seed(1),
            &[RaiseTo(300_000), Fold, Fold],
        ),
        scripted(
            "checked down to a showdown",
            start(2, 1, &three, &seed(2)),
            seed(2),
            &down,
        ),
        scripted(
            "short all-in makes a side pot",
            start(
                3,
                0,
                &[(0, 500_000, 300), (2, 2_000_000, 300), (4, 3_000_000, 300)],
                &seed(3),
            ),
            seed(3),
            &[
                AllIn,
                Call,
                Call,
                Check,
                Check,
                RaiseTo(400_000),
                Call,
                Check,
                Check,
            ],
        ),
        scripted(
            "short all-in raise does not reopen",
            start(
                4,
                0,
                &[(0, 2_000_000, 200), (1, 2_000_000, 200), (2, 450_000, 200)],
                &seed(4),
            ),
            seed(4),
            &[
                RaiseTo(300_000),
                Call,
                AllIn,
                Call,
                Call,
                Check,
                Check,
                Check,
                Check,
                Check,
                Check,
            ],
        ),
        scripted(
            "heads-up with a re-raise",
            start(5, 5, &[(2, 1_500_000, 100), (5, 2_500_000, 100)], &seed(5)),
            seed(5),
            &[
                Call,
                Check,
                RaiseTo(200_000),
                RaiseTo(600_000),
                Call,
                Check,
                Check,
                Check,
                Check,
            ],
        ),
    ]
}

fn settlements() -> Vec<Value> {
    let x = evaluate(&cards("As Ad Kc Qh 9s 4d 2c"));
    let y = evaluate(&cards("Ks Kd Qc Jh 9s 4d 2c"));
    let seat = |seat, committed, folded, value| SettleSeat {
        seat,
        committed,
        folded,
        value,
    };
    let cases = vec![
        // Odd chips of a three-way split go to the first winners left of the button.
        (
            vec![
                seat(3, 101, false, Some(x)),
                seat(0, 101, false, Some(x)),
                seat(1, 101, false, Some(x)),
            ],
            0,
            0,
            false,
        ),
        (
            vec![
                seat(1, 1_000, false, Some(y)),
                seat(2, 400, false, Some(x)),
                seat(4, 1_000, true, None),
            ],
            500,
            300,
            true,
        ),
        (
            vec![
                seat(0, 250, false, Some(x)),
                seat(1, 900, false, Some(y)),
                seat(2, 900, false, Some(y)),
            ],
            250,
            1_000,
            true,
        ),
        (
            vec![seat(0, 5_000, false, None), seat(1, 300, true, None)],
            500,
            100,
            true,
        ),
    ];
    cases
        .into_iter()
        .map(|(seats, rake_bp, rake_cap, flop_seen)| {
            let input: Vec<Value> = seats
                .iter()
                .map(|s| json!({ "seat": s.seat, "committed": s.committed.to_string(), "folded": s.folded, "value": s.value }))
                .collect();
            let settlement = settle_hand(&seats, rake_bp, rake_cap, flop_seen).unwrap();
            json!({
                "seats": input,
                "rake_bp": rake_bp,
                "rake_cap": rake_cap.to_string(),
                "flop_seen": flop_seen,
                "settlement": settlement,
            })
        })
        .collect()
}

fn vectors() -> Value {
    let evaluations: Vec<Value> = [
        "As 2d 3c 4h 5s Kd Kc",
        "5h 4h 3h 2h Ah Kd Kc",
        "9c 9d 9h 4s 4d 4c 2h",
        "Ts Js Qs Ks 2s Ad Kd",
        "Ad Kd Qc Jh Tc 9s 2c",
        "7c 7d 7h 7s 2c 3d Ah",
        "8c 8d 5h 5s 2c 2d Ah",
        "Ac Qd 9h 7s 5c 4d 2h",
        "Kc Kd 9h 7s 5c 4d 2h",
        "Qc Qd Qh 7s 5c 4d 2h",
    ]
    .iter()
    .map(|text| {
        let value = evaluate(&cards(text));
        json!({ "cards": text, "value": value, "category": value.category() })
    })
    .collect();
    let seeds = ["alice-1", "bob-1", "npc-carol-1"];
    json!({
        "deck_seed": {
            "hand_seed": hex::encode(seed(9)),
            "client_seeds": seeds,
            "deck_seed": hex::encode(deck_seed(&seed(9), &seeds)),
            "deck": deck_for(&seed(9), &seeds).iter().map(ToString::to_string).collect::<Vec<_>>(),
        },
        "evaluations": evaluations,
        "settlements": settlements(),
        "hands": hands(),
    })
}

#[test]
fn web_poker_vectors_match_core() {
    let expected = vectors();
    if std::env::var_os("TILT_WRITE_VECTORS").is_some() {
        std::fs::write(PATH, serde_json::to_string_pretty(&expected).unwrap() + "\n").unwrap();
    }
    // Compared as values: `cargo test --workspace` turns on serde_json's `preserve_order` (feature
    // unification), which changes key order in the text but not the vectors.
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(PATH).unwrap()).unwrap();
    assert!(
        on_disk == expected,
        "{PATH} is stale: rerun with TILT_WRITE_VECTORS=1"
    );
}
