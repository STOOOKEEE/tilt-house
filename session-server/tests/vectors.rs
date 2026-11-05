//! `web/src/near/session-vectors.json`: the protocol bytes the browser must rebuild
//! (`session-client.test.ts`), produced by `core_rules::session` with a fixed seed and key. Fails
//! when the file drifts from the Rust code; `TILT_WRITE_VECTORS=1` rewrites it.

use core_rules::session::{
    chain_step, replay_round, server_seed_hash, state_message, step_seed, ticket_message, BjAction,
    CompactRound, Hash32, SessionPublic, SessionState, SessionTicket,
};
use core_rules::{Bet, DiceBet, Game, Rng, RouletteBet, RouletteSpot};
use serde_json::{json, Value};
use tilt_house_session_server::keys::Signer;

const SEED: Hash32 = [7; 32];
const KEY_SEED: [u8; 32] = [9; 32];
const CLIENT: &str = "lucky-seven";
const USDC: u128 = 1_000_000;
const LOCK: u128 = 10 * USDC;
const RAKE_BP: u16 = 100;
const PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../web/src/near/session-vectors.json"
);

/// One session's rounds: a bet, its stake and, for blackjack, the moves after the deal.
type Plays = Vec<(Bet, u128, Vec<BjAction>)>;

fn dice(chance_bp: u16, over: bool) -> Bet {
    Bet::Dice(DiceBet { chance_bp, over })
}

fn spots(list: &[(RouletteBet, u128)]) -> Bet {
    Bet::RouletteSpots(
        list.iter()
            .map(|&(bet, stake)| RouletteSpot { bet, stake })
            .collect(),
    )
}

fn sessions() -> Vec<(Game, Plays)> {
    use RouletteBet::*;
    let single = |bet, stake| (bet, stake, Vec::new());
    vec![
        (
            Game::Dice,
            vec![
                single(dice(5_000, true), USDC),
                single(dice(100, false), USDC / 10),
                single(dice(9_800, false), 2 * USDC),
            ],
        ),
        (
            Game::Roulette,
            vec![
                single(Bet::Roulette(Red), USDC),
                single(Bet::Roulette(Straight(17)), USDC / 10),
                single(Bet::Roulette(Dozen(2)), USDC / 2),
            ],
        ),
        (
            Game::Blackjack,
            vec![
                (Bet::Blackjack, USDC, vec![BjAction::Hit]),
                (Bet::Blackjack, USDC, vec![BjAction::Double]),
                (Bet::Blackjack, USDC / 2, vec![BjAction::Hit]),
            ],
        ),
        // Every inside bet, then several chips settled by one spin.
        (
            Game::Roulette,
            vec![
                single(Bet::Roulette(Split(7, 10)), USDC / 10),
                single(Bet::Roulette(Split(0, 2)), USDC / 10),
                single(Bet::Roulette(Street(13)), USDC / 5),
                single(Bet::Roulette(Corner(8)), USDC / 10),
                single(Bet::Roulette(SixLine(31)), USDC / 10),
                single(
                    spots(&[
                        (Straight(17), USDC / 10),
                        (Split(7, 10), USDC / 5),
                        (Corner(8), USDC / 10),
                        (Red, 3 * USDC / 10),
                        (Dozen(1), USDC / 5),
                    ]),
                    9 * USDC / 10,
                ),
                single(
                    spots(&[
                        (Black, USDC / 2),
                        (SixLine(1), USDC / 5),
                        (Street(34), USDC / 10),
                        (Corner(29), USDC / 10),
                    ]),
                    9 * USDC / 10,
                ),
            ],
        ),
    ]
}

fn signed(signer: &Signer, state: &SessionState) -> Value {
    json!({
        "state": state,
        "signature": hex::encode(signer.sign(&state_message(state))),
    })
}

fn session_vectors(signer: &Signer, index: usize, game: Game, plays: &Plays) -> Value {
    let ticket = SessionTicket {
        session_id: format!("s-{index}"),
        player: "alice.testnet".into(),
        dealer_id: "ada".into(),
        game,
        lock: LOCK,
        server_seed_hash: server_seed_hash(&SEED),
        client_seed: CLIENT.into(),
        rake_bp: RAKE_BP,
        max_bet: 5 * USDC,
        max_win: 10 * LOCK,
        expires_at: 1_762_190_000,
    };
    let public = SessionPublic {
        server_seed_hash: ticket.server_seed_hash,
        client_seed: CLIENT,
        game,
        rake_bp: RAKE_BP,
        lock: LOCK,
    };
    let mut state = SessionState {
        session_id: ticket.session_id.clone(),
        nonce: 0,
        balance: LOCK,
        chain: ticket.server_seed_hash,
    };
    let mut states = vec![signed(signer, &state)];
    let mut rounds: Vec<CompactRound> = Vec::new();
    for (bet, stake, actions) in plays {
        let nonce = state.nonce + 1;
        let round = replay_round(&SEED, &public, nonce, bet, *stake, actions).unwrap();
        state.nonce = nonce;
        state.balance = state.balance - round.wager() + round.payout;
        state.chain = chain_step(&state.chain, &round);
        let mut entry = signed(signer, &state);
        entry["round_borsh"] = hex::encode(borsh::to_vec(&round).unwrap()).into();
        states.push(entry);
        rounds.push(round);
    }
    json!({
        "ticket": ticket,
        "ticket_message": hex::encode(ticket_message(&ticket)),
        "ticket_signature": hex::encode(signer.sign(&ticket_message(&ticket))),
        "rounds": rounds,
        "states": states,
    })
}

fn vectors() -> Value {
    let key = format!("ed25519:{}", bs58::encode(KEY_SEED).into_string());
    let signer = Signer::from_near_secret(&key).unwrap();
    let mut rng = Rng::new(SEED);
    let sessions: Vec<Value> = sessions()
        .iter()
        .enumerate()
        .map(|(i, (game, plays))| session_vectors(&signer, i, *game, plays))
        .collect();
    json!({
        "client_seed": CLIENT,
        "rng_below_10000": (0..8).map(|_| rng.below(10_000)).collect::<Vec<_>>(),
        "server_public_key_hex": hex::encode(signer.verifying_key().to_bytes()),
        "server_seed": hex::encode(SEED),
        "step_seed_1_0": hex::encode(step_seed(&SEED, CLIENT, 1, 0)),
        "step_seed_1_2": hex::encode(step_seed(&SEED, CLIENT, 1, 2)),
        "sessions": sessions,
    })
}

#[test]
fn web_vectors_match_the_rust_protocol() {
    let text = serde_json::to_string_pretty(&vectors()).unwrap() + "\n";
    if std::env::var_os("TILT_WRITE_VECTORS").is_some() {
        std::fs::write(PATH, &text).unwrap();
    }
    let on_disk = std::fs::read_to_string(PATH).unwrap();
    assert!(
        on_disk == text,
        "{PATH} is stale: rerun with TILT_WRITE_VECTORS=1"
    );
}
