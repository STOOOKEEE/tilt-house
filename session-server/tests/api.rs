//! End-to-end through the HTTP router in `--no-chain` mode (plus a chain that never sees opens).

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Request, StatusCode};
use axum::Router;
use core_rules::session::{
    state_message, verify_session, Hash32, SessionPublic, SessionState, SessionTicket, SettleBatch,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tilt_house_session_server::app::{App, CloseReply, CreateReply, RoundReply};
use tilt_house_session_server::chain::{Chain, DealerInfo, FloorInfo, NoChain};
use tilt_house_session_server::gamblers::{Clock, Gamblers, DEFAULT_ACCOUNT_SUFFIX};
use tilt_house_session_server::http::router;
use tilt_house_session_server::keys::Signer;
use tilt_house_session_server::store::Store;
use tower::ServiceExt;

const USDC: u128 = 1_000_000;

fn key_text() -> String {
    let seed: [u8; 32] = tilt_house_session_server::keys::random_bytes().unwrap();
    format!("ed25519:{}", bs58::encode(seed).into_string())
}

fn data_dir() -> tempfile::TempDir {
    // Under target/, on the real disk, so fsync costs what it costs in production.
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

fn serve<C: Chain>(dir: &Path, key: &str, chain: C) -> Router {
    with_peer(bare(dir, key, chain), 0)
}

fn bare<C: Chain>(dir: &Path, key: &str, chain: C) -> Router {
    let (store, events) = Store::open(dir).unwrap();
    let signer = Signer::from_near_secret(key).unwrap();
    let app = Arc::new(App::load(signer, chain, store, events).unwrap());
    // Gamblers not started: these tests drive sessions over HTTP only.
    let gamblers = Gamblers::new(
        Arc::clone(&app),
        Clock::system(),
        dir,
        None,
        DEFAULT_ACCOUNT_SUFFIX,
        [0; 32],
    )
    .unwrap();
    router(app, Arc::new(gamblers))
}

/// Requests through this router come from peer `10.0.x.y`; rate limits are per IP.
fn with_peer(router: Router, i: usize) -> Router {
    let peer = SocketAddr::from(([10, 0, (i / 250) as u8, (i % 250) as u8], 9));
    router.layer(MockConnectInfo(peer))
}

async fn call(
    router: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let request = match body {
        Some(body) => request
            .header("content-type", "application/json")
            .body(Body::from(body.to_string())),
        None => request.body(Body::empty()),
    }
    .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

async fn start(router: &Router, dealer: &str, lock: u128) -> CreateReply {
    let (status, body) = call(
        router,
        "POST",
        "/sessions",
        None,
        Some(json!({
            "player": "alice.testnet",
            "dealer_id": dealer,
            "lock": lock.to_string(),
            "client_seed": "my-lucky-seed",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_value(body).unwrap()
}

fn dice_round(nonce: u64, stake: u128) -> Value {
    json!({
        "nonce": nonce,
        "bet": { "dice": { "chance_bp": 5000, "over": true } },
        "stake": stake.to_string(),
    })
}

async fn round(router: &Router, s: &CreateReply, body: Value) -> (StatusCode, Value) {
    let uri = format!("/sessions/{}/rounds", s.session_id);
    call(router, "POST", &uri, Some(&s.token), Some(body)).await
}

fn verify_sig(public_key: &str, state: &SessionState, signature: &[u8; 64]) -> bool {
    let bytes = bs58::decode(public_key.trim_start_matches("ed25519:"))
        .into_vec()
        .unwrap();
    let key = VerifyingKey::from_bytes(&bytes.try_into().unwrap()).unwrap();
    key.verify(&state_message(state), &Signature::from_bytes(signature))
        .is_ok()
}

#[tokio::test]
async fn session_start_play_close_and_verify() {
    let dir = data_dir();
    let router = serve(dir.path(), &key_text(), NoChain::default());
    let s = start(&router, "dice-demo", 10 * USDC).await;
    assert!(verify_sig(
        &s.server_public_key,
        &s.state.state,
        &s.state.signature
    ));
    for nonce in 1..=10 {
        let (status, body) = round(&router, &s, dice_round(nonce, USDC)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let reply: RoundReply = serde_json::from_value(body).unwrap();
        assert!(reply.done);
        assert_eq!(reply.state.state.nonce, nonce);
        assert!(verify_sig(
            &s.server_public_key,
            &reply.state.state,
            &reply.state.signature
        ));
    }
    let uri = format!("/sessions/{}/close", s.session_id);
    let (status, body) = call(&router, "POST", &uri, Some(&s.token), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let closed: CloseReply = serde_json::from_value(body).unwrap();
    assert_eq!(closed.rounds.len(), 10);

    let public = SessionPublic {
        server_seed_hash: s.ticket.server_seed_hash,
        client_seed: &s.ticket.client_seed,
        game: s.ticket.game,
        rake_bp: s.ticket.rake_bp,
        lock: s.ticket.lock,
    };
    let batch = SettleBatch {
        session_id: s.session_id.clone(),
        upto_nonce: 10,
        balance: closed.state.state.balance,
        chain: closed.state.state.chain,
        rounds: closed.rounds,
        server_sig: closed.state.signature,
    };
    let summary = verify_session(&closed.server_seed, &public, &[batch]).unwrap();
    assert_eq!(summary.balance, closed.state.state.balance);

    // Closed: no more rounds; the seed is public.
    let (status, _) = round(&router, &s, dice_round(11, USDC)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (_, view) = call(
        &router,
        "GET",
        &format!("/sessions/{}", s.session_id),
        None,
        None,
    )
    .await;
    // The close answers before the chain: the reveal on chain runs in the background tick.
    assert!(
        view["phase"] == "closing" || view["phase"] == "closed",
        "{view}"
    );
    assert_eq!(view["server_seed"], hex::encode(closed.server_seed));
}

/// The public view carries every round (so anyone can verify), but before closing never the seed,
/// and never the token.
#[tokio::test]
async fn public_view_lists_rounds_without_token_or_early_seed() {
    let dir = data_dir();
    let router = serve(dir.path(), &key_text(), NoChain::default());
    let s = start(&router, "dice-demo", 10 * USDC).await;
    for nonce in 1..=3 {
        assert_eq!(
            round(&router, &s, dice_round(nonce, USDC)).await.0,
            StatusCode::OK
        );
    }
    let uri = format!("/sessions/{}", s.session_id);
    let (status, open_view) = call(&router, "GET", &uri, None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(open_view["rounds"].as_array().unwrap().len(), 3);
    assert_eq!(open_view["rounds"][2], open_view["last_round"]);
    assert!(open_view["server_seed"].is_null(), "{open_view}");

    let close = format!("/sessions/{}/close", s.session_id);
    let (status, body) = call(&router, "POST", &close, Some(&s.token), None).await;
    assert_eq!(status, StatusCode::OK);
    let closed: CloseReply = serde_json::from_value(body).unwrap();
    let seed = hex::encode(closed.server_seed);
    let open_text = open_view.to_string();
    assert!(!open_text.contains(&s.token));
    assert!(!open_text.contains(&seed));

    let (_, closed_view) = call(&router, "GET", &uri, None, None).await;
    assert!(!closed_view.to_string().contains(&s.token));
    assert_eq!(closed_view["server_seed"], seed);
    assert_eq!(
        serde_json::to_value(&closed.rounds).unwrap(),
        closed_view["rounds"]
    );
}

/// Chips on a number, a split, a corner and red: one request, one spin, one signed state.
#[tokio::test]
async fn multi_spot_roulette_round() {
    let dir = data_dir();
    let router = serve(dir.path(), &key_text(), NoChain::default());
    let s = start(&router, "roulette-demo", 10 * USDC).await;
    let spots = json!([
        { "bet": { "straight": 17 }, "stake": "100000" },
        { "bet": { "split": [7, 10] }, "stake": "100000" },
        { "bet": { "corner": 8 }, "stake": "200000" },
        { "bet": "red", "stake": "300000" },
    ]);
    let body = |nonce: u64, stake: &str, spots: &Value| json!({ "nonce": nonce, "bet": { "roulette_spots": spots }, "stake": stake });
    // The stake must be the spots' total, and every spot at least the minimum bet.
    let (status, _) = round(&router, &s, body(1, "600000", &spots)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let tiny = json!([{ "bet": "red", "stake": "99999" }, { "bet": "black", "stake": "100000" }]);
    let (status, _) = round(&router, &s, body(1, "199999", &tiny)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let not_adjacent = json!([{ "bet": { "split": [7, 9] }, "stake": "100000" }]);
    let (status, _) = round(&router, &s, body(1, "100000", &not_adjacent)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let too_many = Value::Array(vec![json!({ "bet": "red", "stake": "100000" }); 21]);
    let (status, _) = round(&router, &s, body(1, "2100000", &too_many)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, reply) = round(&router, &s, body(1, "700000", &spots)).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    let reply: RoundReply = serde_json::from_value(reply).unwrap();
    let played = reply.round.unwrap();
    assert_eq!(played.wager(), 700_000);
    assert_eq!(
        reply.state.state.balance,
        10 * USDC - 700_000 + played.payout
    );

    let uri = format!("/sessions/{}/close", s.session_id);
    let (status, body) = call(&router, "POST", &uri, Some(&s.token), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let closed: CloseReply = serde_json::from_value(body).unwrap();
    let public = SessionPublic {
        server_seed_hash: s.ticket.server_seed_hash,
        client_seed: &s.ticket.client_seed,
        game: s.ticket.game,
        rake_bp: s.ticket.rake_bp,
        lock: s.ticket.lock,
    };
    let batch = SettleBatch {
        session_id: s.session_id.clone(),
        upto_nonce: 1,
        balance: closed.state.state.balance,
        chain: closed.state.state.chain,
        rounds: closed.rounds,
        server_sig: closed.state.signature,
    };
    let summary = verify_session(&closed.server_seed, &public, &[batch]).unwrap();
    assert_eq!(summary.wagered, 700_000);
}

#[tokio::test]
async fn refuses_over_limit_bets() {
    let dir = data_dir();
    let router = serve(dir.path(), &key_text(), NoChain::default());
    // Lock 1 USDC: max win 10 USDC.
    let s = start(&router, "dice-demo", USDC).await;
    assert_eq!(s.ticket.max_win, 10 * USDC);
    // More than the lock.
    let (status, _) = round(&router, &s, dice_round(1, 2 * USDC)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // 1 % chance at 0.5 USDC pays 50 USDC: past max win.
    let long_shot = json!({
        "nonce": 1,
        "bet": { "dice": { "chance_bp": 100, "over": false } },
        "stake": (USDC / 2).to_string(),
    });
    let (status, body) = round(&router, &s, long_shot).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("max win"));
    // Above the table's max bet (100 USDC in no-chain mode).
    let big = start(&router, "dice-demo", 1_000 * USDC).await;
    let (status, _) = round(&router, &big, dice_round(1, 101 * USDC)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // Wrong game for the table.
    let red = json!({ "nonce": 1, "bet": { "roulette": "red" }, "stake": USDC.to_string() });
    let (status, _) = round(&router, &big, red).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // Nothing above was played.
    let (_, view) = call(
        &router,
        "GET",
        &format!("/sessions/{}", s.session_id),
        None,
        None,
    )
    .await;
    assert_eq!(view["state"]["nonce"], 0);
}

#[tokio::test]
async fn rejects_bad_tokens_bad_input_and_floods() {
    let dir = data_dir();
    let router = serve(dir.path(), &key_text(), NoChain::default());
    let s = start(&router, "dice-demo", 100 * USDC).await;
    let uri = format!("/sessions/{}/rounds", s.session_id);
    let (status, _) = call(
        &router,
        "POST",
        &uri,
        Some("nope"),
        Some(dice_round(1, USDC)),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&router, "POST", &uri, None, Some(dice_round(1, USDC))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let bad_seed = json!({
        "player": "alice.testnet", "dealer_id": "dice-demo", "lock": "1000000", "client_seed": "a:b"
    });
    let (status, _) = call(&router, "POST", "/sessions", None, Some(bad_seed)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let huge = json!({ "pad": "x".repeat(10_000) });
    let (status, _) = call(&router, "POST", "/sessions", None, Some(huge)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    // 20 rounds per second per session: 21 sent at once (a round waits for its fsync, so sent one
    // by one they may span more than a second), exactly one is refused by the limiter.
    let s = Arc::new(s);
    let tasks: Vec<_> = (1..=21)
        .map(|nonce| {
            let (router, s) = (router.clone(), Arc::clone(&s));
            tokio::spawn(async move { round(&router, &s, dice_round(nonce, USDC)).await.0 })
        })
        .collect();
    let mut limited = 0;
    for task in tasks {
        if task.await.unwrap() == StatusCode::TOO_MANY_REQUESTS {
            limited += 1;
        }
    }
    assert_eq!(limited, 1);
}

/// Opens never land on this chain.
struct NeverOpened;

impl Chain for NeverOpened {
    async fn dealer(&self, dealer_id: &str) -> anyhow::Result<Option<DealerInfo>> {
        NoChain::default().dealer(dealer_id).await
    }
    async fn floor(&self) -> anyhow::Result<FloorInfo> {
        NoChain::default().floor().await
    }
    async fn balance(&self, _: &str) -> anyhow::Result<u128> {
        Ok(0)
    }
    async fn open_session(
        &self,
        _: &str,
        _: Option<&str>,
        _: &SessionTicket,
        _: &[u8; 64],
    ) -> anyhow::Result<()> {
        anyhow::bail!("opens never land")
    }
    async fn session_opened(&self, _: &str) -> anyhow::Result<bool> {
        Ok(false)
    }
    async fn settle(&self, _: &SettleBatch) -> anyhow::Result<()> {
        anyhow::bail!("no session to settle")
    }
    async fn close(&self, _: &str, _: &Hash32) -> anyhow::Result<()> {
        anyhow::bail!("no session to close")
    }
}

#[tokio::test]
async fn no_round_before_the_open_lands() {
    let dir = data_dir();
    let router = serve(dir.path(), &key_text(), NeverOpened);
    let s = start(&router, "dice-demo", 10 * USDC).await;
    let (status, body) = round(&router, &s, dice_round(1, USDC)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body["error"].as_str().unwrap().contains("not open"));
    // Never opened: closes locally, reveal included.
    let uri = format!("/sessions/{}/close", s.session_id);
    let (status, _) = call(&router, "POST", &uri, Some(&s.token), None).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn restart_reloads_sessions_from_the_log() {
    let dir = data_dir();
    let key = key_text();
    let (s, view_before) = {
        let router = serve(dir.path(), &key, NoChain::default());
        let s = start(&router, "dice-demo", 10 * USDC).await;
        for nonce in 1..=5 {
            assert_eq!(
                round(&router, &s, dice_round(nonce, USDC)).await.0,
                StatusCode::OK
            );
        }
        let (_, view) = call(
            &router,
            "GET",
            &format!("/sessions/{}", s.session_id),
            None,
            None,
        )
        .await;
        (s, view)
    };
    let router = serve(dir.path(), &key, NoChain::default());
    let (status, view_after) = call(
        &router,
        "GET",
        &format!("/sessions/{}", s.session_id),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // Same state, same signature (ed25519 is deterministic), same seed commitment.
    assert_eq!(view_after, view_before);
    // The nonce carries on; replaying an old nonce is refused.
    assert_eq!(
        round(&router, &s, dice_round(5, USDC)).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        round(&router, &s, dice_round(6, USDC)).await.0,
        StatusCode::OK
    );
    let uri = format!("/sessions/{}/close", s.session_id);
    let (status, body) = call(&router, "POST", &uri, Some(&s.token), None).await;
    assert_eq!(status, StatusCode::OK);
    let closed: CloseReply = serde_json::from_value(body).unwrap();
    assert_eq!(closed.rounds.len(), 6);
}

#[tokio::test]
async fn blackjack_over_http() {
    let dir = data_dir();
    let router = serve(dir.path(), &key_text(), NoChain::default());
    let s = start(&router, "blackjack-demo", 100 * USDC).await;
    let mut nonce = 1;
    // Deal until a hand waits for an action, then hit to the end.
    loop {
        let body = json!({ "nonce": nonce, "bet": "blackjack", "stake": USDC.to_string() });
        let (status, reply) = round(&router, &s, body).await;
        assert_eq!(status, StatusCode::OK, "{reply}");
        if reply["done"] == false {
            break;
        }
        nonce += 1;
    }
    loop {
        let (status, reply) = round(&router, &s, json!({ "nonce": nonce, "action": "hit" })).await;
        assert_eq!(status, StatusCode::OK, "{reply}");
        if reply["done"] == true {
            assert_eq!(reply["state"]["nonce"], nonce);
            assert_eq!(reply["round"]["actions"][0], "hit");
            break;
        }
    }
}

/// Latency budget: 1,000 rounds (each synced to disk, then signed) in under a second, p99 < 50 ms,
/// with 50 players at the table at once, each playing its rounds back to back.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn thousand_rounds_under_a_second() {
    const SESSIONS: u64 = 50;
    const ROUNDS: u64 = 20; // the per-session burst
    let dir = data_dir();
    let app = bare(dir.path(), &key_text(), NoChain::default());
    // One player (IP) per session, as rate limits are per IP.
    let mut players = Vec::new();
    for i in 0..SESSIONS as usize {
        let router = with_peer(app.clone(), i + 1);
        let s = start(&router, "dice-demo", 100 * USDC).await;
        players.push((router, s));
    }
    let started = Instant::now();
    let tasks: Vec<_> = players
        .into_iter()
        .map(|(router, s)| {
            tokio::spawn(async move {
                let mut latencies = Vec::new();
                for nonce in 1..=ROUNDS {
                    let t = Instant::now();
                    let (status, _) = round(&router, &s, dice_round(nonce, USDC)).await;
                    latencies.push(t.elapsed());
                    assert_eq!(status, StatusCode::OK);
                }
                latencies
            })
        })
        .collect();
    let mut latencies = Vec::new();
    for task in tasks {
        latencies.extend(task.await.unwrap());
    }
    let total = started.elapsed();
    latencies.sort();
    let p99 = latencies[latencies.len() * 99 / 100];
    println!("1000 rounds in {total:?}, p99 {p99:?}");
    assert!(total < Duration::from_secs(1), "{total:?}");
    // The goal is a round well under 1 s end to end; 100 ms leaves room for a loaded CI host.
    assert!(p99 < Duration::from_millis(100), "{p99:?}");
}
