//! Poker through the HTTP router in `--no-chain` mode (docs/poker-api.md): two humans and the
//! NPCs the seat rule calls in, at the demo table, on shortened clocks.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Request, StatusCode};
use axum::Router;
use core_rules::poker::{deck_for, replay_hand, verify_poker_round, Card, PokerAction};
use core_rules::session::{sha256, Hash32, SessionTicket, SettleBatch};
use core_rules::Game;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tilt_house_session_server::app::{App, CreateReply};
use tilt_house_session_server::chain::{Chain, ChainSession, DealerInfo, FloorInfo, NoChain};
use tilt_house_session_server::gamblers::{Clock, Gamblers, DEFAULT_ACCOUNT_SUFFIX};
use tilt_house_session_server::http::router;
use tilt_house_session_server::keys::Signer;
use tilt_house_session_server::poker::{
    HandPhase, HandRecord, Poker, PokerConfig, TableState, BIG_BLIND,
};
use tilt_house_session_server::poker_hands::HandLog;
use tilt_house_session_server::store::Store;
use tower::ServiceExt;

const TABLE: &str = "poker-demo";
const BUY_IN: u128 = 10_000_000;
/// Long enough for every test step; a stuck table fails the test instead of hanging it.
const PATIENCE: Duration = Duration::from_secs(30);

fn config() -> PokerConfig {
    PokerConfig {
        action: Duration::from_millis(500),
        seeding: Duration::from_millis(300),
        pause: Duration::from_millis(200),
        npc_think: Duration::from_millis(20),
        poll_hold: Duration::from_millis(200),
    }
}

fn serve(dir: &std::path::Path) -> Router {
    serve_on(dir, NoChain::default(), true)
}

/// `npcs` false: the `GAMBLERS=off` server, no lineup to borrow from.
fn serve_on<C: Chain>(dir: &std::path::Path, chain: C, npcs: bool) -> Router {
    let (store, events) = Store::open(dir).unwrap();
    let app = Arc::new(App::load(Signer::random().unwrap(), chain, store, events).unwrap());
    // Gamblers not started: all away, so the table can borrow them.
    let gamblers = if npcs {
        Gamblers::new(
            Arc::clone(&app),
            Clock::system(),
            dir,
            None,
            DEFAULT_ACCOUNT_SUFFIX,
            [0; 32],
        )
    } else {
        Gamblers::off(Arc::clone(&app), Clock::system(), dir)
    };
    let gamblers = Arc::new(gamblers.unwrap());
    let poker = Arc::new(Poker::new(
        Arc::clone(&app),
        Arc::clone(&gamblers),
        HandLog::open(dir).unwrap(),
        config(),
    ));
    router(app, gamblers, poker)
}

/// Requests through this router come from peer `10.0.0.i`: rate limits are per IP, and a
/// test polls as fast as a few real clients.
fn with_peer(router: &Router, i: u8) -> Router {
    router
        .clone()
        .layer(MockConnectInfo(SocketAddr::from(([10, 0, 0, i], 9))))
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
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

struct Human {
    session: CreateReply,
    /// Its own client address.
    router: Router,
}

impl Human {
    fn token(&self) -> &str {
        &self.session.token
    }
}

async fn sit(bare: &Router, peer: u8, player: &str) -> Human {
    let router = &with_peer(bare, peer);
    let (status, body) = call(
        router,
        "POST",
        "/sessions",
        None,
        Some(json!({
            "player": player,
            "dealer_id": TABLE,
            "lock": BUY_IN.to_string(),
            "client_seed": format!("{player}-seed"),
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let session: CreateReply = serde_json::from_value(body).unwrap();
    let (status, body) = call(
        router,
        "POST",
        &format!("/poker/tables/{TABLE}/join"),
        Some(&session.token),
        Some(json!({ "session_id": session.session_id })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["waiting"], true);
    Human {
        session,
        router: router.clone(),
    }
}

async fn state(router: &Router, token: Option<&str>) -> TableState {
    let (status, body) = call(
        router,
        "GET",
        &format!("/poker/tables/{TABLE}"),
        token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_value(body).unwrap()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Plan {
    /// Checks when free, calls small bets, folds to big ones.
    Passive,
    /// Never acts: the clock acts for it.
    Sleep,
    /// Leaves once dealt in, before acting.
    Leave,
}

/// What the humans saw during one hand.
#[derive(Default)]
struct Seen {
    /// Hole cards each human saw for itself, by seat.
    holes: HashMap<usize, [Card; 2]>,
    /// Whether the seat could check at its first turn the clock played.
    slept_facing_bet: Option<bool>,
    left: bool,
}

/// Plays the humans by their plans until hand `number` is over; checks privacy on every poll.
async fn play_hand(router: &Router, humans: &[(&Human, Plan)], number: u64) -> (HandRecord, Seen) {
    let mut seen = Seen::default();
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        assert!(
            tokio::time::Instant::now() < deadline,
            "hand {number} never ended"
        );
        // Asked before the state: a hand still being played then was being played here too.
        let uri = format!("/poker/tables/{TABLE}/hands/{number}");
        let (archived, _) = call(router, "GET", &uri, None, None).await;
        let public = state(router, None).await;
        assert!(
            public.you.is_none(),
            "an anonymous watcher has no private view"
        );
        let live = public.hand.as_ref().is_some_and(|h| {
            h.number == number && (h.to_act.is_some() || h.phase == HandPhase::Seeding)
        });
        // Nothing about a hand is archived before it ends.
        assert!(
            !live || archived == StatusCode::NOT_FOUND,
            "hand {number} archived while live"
        );
        if let Some(last) = public.last_hand.as_ref().filter(|h| h.number == number) {
            return ((**last).clone(), seen);
        }
        let mut views = Vec::new();
        for (human, plan) in humans {
            let view = state(&human.router, Some(human.token())).await;
            views.push((human, *plan, view));
        }
        // Privacy: before the hand's end, nobody's cards appear anywhere but in their owner's
        // `you.hole`.
        for (_, _, view) in &views {
            let live = view.hand.as_ref().is_some_and(|h| h.number == number);
            let over = view.last_hand.as_ref().is_some_and(|h| h.number >= number);
            if live && !over && view.hand.as_ref().is_some_and(|h| h.to_act.is_some()) {
                assert!(view.seats.iter().flatten().all(|s| s.cards.is_none()));
            }
        }
        let holes: Vec<_> = views
            .iter()
            .filter_map(|(_, _, v)| Some((v.you.as_ref()?.seat?, v.you.as_ref()?.hole?)))
            .collect();
        for (i, (seat_a, hole_a)) in holes.iter().enumerate() {
            for (seat_b, hole_b) in &holes[i + 1..] {
                assert_ne!(seat_a, seat_b);
                assert!(
                    hole_a.iter().all(|c| !hole_b.contains(c)),
                    "two seats see the same card"
                );
            }
        }
        for (human, plan, view) in views {
            let Some(hand) = view.hand.as_ref().filter(|h| h.number == number) else {
                continue;
            };
            let you = view.you.as_ref().expect("seated players see their view");
            let Some(seat) = you.seat else { continue };
            if let Some(hole) = you.hole {
                seen.holes.insert(seat, hole);
            }
            let uri = |what: &str| format!("/poker/tables/{TABLE}/{what}");
            if hand.phase == HandPhase::Seeding
                && hand.seats.contains(&seat)
                && !hand.seeds_in.contains(&seat)
            {
                let body =
                    json!({ "hand": number, "client_seed": format!("fresh-{seat}-{number}") });
                let (status, reply) = call(
                    router,
                    "POST",
                    &uri("seed"),
                    Some(human.token()),
                    Some(body),
                )
                .await;
                assert!(
                    status == StatusCode::OK || status == StatusCode::CONFLICT,
                    "{status} {reply}"
                );
            }
            match plan {
                Plan::Leave if hand.seats.contains(&seat) && !seen.left => {
                    let (status, reply) = call(
                        &human.router,
                        "POST",
                        &uri("leave"),
                        Some(human.token()),
                        None,
                    )
                    .await;
                    assert_eq!(status, StatusCode::OK, "{reply}");
                    assert_eq!(reply["left"], false, "in a hand: unseated when it ends");
                    seen.left = true;
                }
                Plan::Sleep => {
                    if let Some(legal) = you.legal.filter(|_| seen.slept_facing_bet.is_none()) {
                        seen.slept_facing_bet = Some(!legal.can_check);
                    }
                }
                Plan::Passive => {
                    if let Some(legal) = you.legal {
                        // Small calls only, so no human busts and the test runs its course.
                        let action = if legal.can_check {
                            PokerAction::Check
                        } else if legal.call <= 2 * BIG_BLIND {
                            PokerAction::Call
                        } else {
                            PokerAction::Fold
                        };
                        let body = json!({ "hand": number, "action": action });
                        let (status, reply) = call(
                            router,
                            "POST",
                            &uri("action"),
                            Some(human.token()),
                            Some(body),
                        )
                        .await;
                        // The clock may have moved on between the poll and the action.
                        assert!(
                            status == StatusCode::OK || status == StatusCode::CONFLICT,
                            "{status} {reply}"
                        );
                    }
                }
                Plan::Leave => {}
            }
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

/// The revealed hand replays: commitment, deck, results, chips, and each player's round.
async fn check_record(router: &Router, record: &HandRecord, seen: &Seen) {
    // The archive serves exactly the published record, and lists it.
    let uri = format!("/poker/tables/{TABLE}/hands/{}", record.number);
    let (status, archived) = call(router, "GET", &uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert_eq!(archived, serde_json::to_value(record).unwrap());
    let uri = format!(
        "/poker/tables/{TABLE}/hands?before={}&limit=1",
        record.number + 1
    );
    let (status, list) = call(router, "GET", &uri, None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list[0]["number"], record.number, "{list}");
    assert_eq!(sha256(&record.hand_seed), record.commitment);
    assert_eq!(record.history.hand_seed, record.hand_seed);
    assert_eq!(record.history.start.hand_seed_hash, record.commitment);
    assert_eq!(record.history.hash(), record.history_hash);
    let seeds: Vec<&str> = record
        .history
        .start
        .seats
        .iter()
        .map(|s| s.client_seed.as_str())
        .collect();
    assert_eq!(record.deck, deck_for(&record.hand_seed, &seeds).to_vec());
    let replayed = replay_hand(&record.history).unwrap();
    assert_eq!(replayed.result(), Some(&record.result));
    // Chips conserved: what went in comes out, less the rake.
    let staked: u128 = record.players.iter().map(|p| p.stake).sum();
    let paid: u128 = record.players.iter().map(|p| p.payout).sum();
    assert_eq!(staked, paid + record.result.rake, "chips conserved");
    for player in &record.players {
        assert_eq!(replayed.hole(player.seat as u8), Some(player.hole));
        if let Some(hole) = seen.holes.get(&player.seat) {
            assert_eq!(*hole, player.hole, "the owner saw its real cards");
        }
        let (status, view) = call(
            router,
            "GET",
            &format!("/sessions/{}", player.session_id),
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let Some(nonce) = player.nonce else {
            assert_eq!(
                player.stake, 0,
                "no round only for a player who put nothing in"
            );
            continue;
        };
        let round: core_rules::session::CompactRound =
            serde_json::from_value(view["rounds"][nonce as usize - 1].clone()).unwrap();
        assert_eq!((round.stake, round.payout), (player.stake, player.payout));
        verify_poker_round(&round, &record.history, &player.player).unwrap();
    }
}

async fn balance(router: &Router, session_id: &str) -> (u128, String) {
    let (_, view) = call(
        router,
        "GET",
        &format!("/sessions/{session_id}"),
        None,
        None,
    )
    .await;
    let balance = view["state"]["balance"].as_str().unwrap().parse().unwrap();
    (balance, view["phase"].as_str().unwrap().to_string())
}

#[tokio::test]
async fn two_humans_and_npcs_play_fair_private_hands() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let bare = serve(dir.path());
    let router = with_peer(&bare, 1);
    let (status, tables) = call(&router, "GET", "/poker/tables", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tables[0]["table_id"], TABLE, "{tables}");
    assert_eq!(tables[0]["big_blind"], "200000");

    let alice = sit(&bare, 2, "alice.testnet").await;
    let bob = sit(&bare, 3, "bob.testnet").await;
    // A seated session cannot be closed behind the table's back.
    let (status, _) = call(
        &router,
        "POST",
        &format!("/sessions/{}/close", alice.session.session_id),
        Some(alice.token()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    // Nor played as if it were a dice session.
    let (status, _) = call(
        &router,
        "POST",
        &format!("/sessions/{}/rounds", alice.session.session_id),
        Some(alice.token()),
        Some(json!({ "nonce": 1, "bet": { "poker": { "table": TABLE, "hand": 1 } }, "stake": "200000" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // Not your turn / not seated.
    let (status, _) = call(
        &router,
        "POST",
        &format!("/poker/tables/{TABLE}/action"),
        Some("not-a-token"),
        Some(json!({ "hand": 1, "action": "fold" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Hand 1: both humans play it out, the NPCs too.
    let mut number = 1;
    let (record, seen) = loop {
        let both = [(&alice, Plan::Passive), (&bob, Plan::Passive)];
        let (record, seen) = play_hand(&router, &both, number).await;
        let humans = record.players.iter().filter(|p| !p.npc).count();
        if humans == 2 && record.players.iter().any(|p| p.npc) {
            break (record, seen);
        }
        number += 1;
    };
    check_record(&router, &record, &seen).await;
    assert!(record.players.len() >= 3);
    for npc in record.players.iter().filter(|p| p.npc) {
        assert!(
            npc.player.starts_with("g-"),
            "NPCs play with their own accounts"
        );
    }
    let (status, view) = call(
        &router,
        "GET",
        &format!("/poker/tables/{TABLE}"),
        Some(alice.token()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // Bots are labeled: every lineup account at the table shows `npc: true`.
    for seat in view["seats"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| !s.is_null())
    {
        let bot = seat["player"].as_str().unwrap().starts_with("g-");
        assert_eq!(seat["npc"] == true, bot, "{seat}");
    }
    // The player's own signed state follows its session.
    let you = &view["you"];
    assert_eq!(you["session_id"], alice.session.session_id.as_str());
    assert!(you["state"]["signature"].is_string(), "{you}");

    // Next hand: Bob leaves in the middle of it; he folds at his turn and is stood up after.
    number += 1;
    let (bob_before, _) = balance(&router, &bob.session.session_id).await;
    let plans = [(&alice, Plan::Passive), (&bob, Plan::Leave)];
    let (record, seen) = play_hand(&router, &plans, number).await;
    assert!(seen.left);
    check_record(&router, &record, &seen).await;
    let bob_line = record
        .players
        .iter()
        .find(|p| p.player == "bob.testnet")
        .unwrap();
    let bob_seat = bob_line.seat as u8;
    assert!(record
        .history
        .actions
        .iter()
        .filter(|a| a.seat == bob_seat)
        .all(|a| a.action == PokerAction::Fold));
    let (bob_after, _) = balance(&router, &bob.session.session_id).await;
    assert_eq!(bob_after, bob_before - bob_line.stake + bob_line.payout);
    // Unseated at the end of the hand, then his session closes (settle + reveal by the tick).
    wait_closing(&router, &bob.session.session_id).await;
    let table = state(&router, Some(bob.token())).await;
    assert!(table.you.is_none(), "Bob is no longer seated");
    assert!(table
        .seats
        .iter()
        .flatten()
        .all(|s| s.player != "bob.testnet"));

    // Next hands: Alice sleeps, the clock checks or folds for her (until her turn comes: everyone
    // may fold to her big blind).
    let (alice_moves, seen) = loop {
        number += 1;
        let (record, seen) = play_hand(&router, &[(&alice, Plan::Sleep)], number).await;
        check_record(&router, &record, &seen).await;
        let alice_seat = record
            .players
            .iter()
            .find(|p| p.player == "alice.testnet")
            .map(|p| p.seat as u8)
            .unwrap();
        let moves: Vec<PokerAction> = record
            .history
            .actions
            .iter()
            .filter(|a| a.seat == alice_seat)
            .map(|a| a.action)
            .collect();
        if !moves.is_empty() {
            break (moves, seen);
        }
    };
    assert!(alice_moves
        .iter()
        .all(|a| matches!(a, PokerAction::Check | PokerAction::Fold)));
    if seen.slept_facing_bet == Some(true) {
        assert_eq!(
            alice_moves[0],
            PokerAction::Fold,
            "facing a bet, the clock folds"
        );
    }
    // Two timeouts in a row stand a player up; otherwise she leaves herself.
    if alice_moves.len() < 2 {
        let (status, _) = call(
            &router,
            "POST",
            &format!("/poker/tables/{TABLE}/leave"),
            Some(alice.token()),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    wait_closing(&router, &alice.session.session_id).await;
}

/// Waits until the session is closing or closed.
async fn wait_closing(router: &Router, session_id: &str) {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let phase = balance(router, session_id).await.1;
        if phase == "closing" || phase == "closed" {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "session {session_id} never closed"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn joins_are_checked() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let bare = serve(dir.path());
    let router = with_peer(&bare, 1);
    // A buy-in outside the table's range is refused at session creation.
    let (status, _) = call(
        &router,
        "POST",
        "/sessions",
        None,
        Some(json!({
            "player": "carol.testnet",
            "dealer_id": TABLE,
            "lock": "100000000",
            "client_seed": "c",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let carol = sit(&bare, 2, "carol.testnet").await;
    // The same session twice, a wrong token, another game's session.
    let join = |token: String, session_id: String| {
        let router = router.clone();
        async move {
            call(
                &router,
                "POST",
                &format!("/poker/tables/{TABLE}/join"),
                Some(&token),
                Some(json!({ "session_id": session_id })),
            )
            .await
            .0
        }
    };
    let id = carol.session.session_id.clone();
    assert_eq!(
        join(carol.token().into(), id.clone()).await,
        StatusCode::CONFLICT
    );
    assert_eq!(join("wrong".into(), id).await, StatusCode::UNAUTHORIZED);
    let (status, body) = call(
        &router,
        "POST",
        "/sessions",
        None,
        Some(json!({
            "player": "dave.testnet",
            "dealer_id": "dice-demo",
            "lock": "10000000",
            "client_seed": "d",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let dice: CreateReply = serde_json::from_value(body).unwrap();
    assert_eq!(
        join(dice.token.clone(), dice.session_id.clone()).await,
        StatusCode::CONFLICT
    );
    let (status, _) = call(&router, "GET", "/poker/tables/dice-demo", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Leaving before any hand is dealt: unseated at once, the session closes.
    let (status, body) = call(
        &router,
        "POST",
        &format!("/poker/tables/{TABLE}/leave"),
        Some(carol.token()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // A hand may already be dealt with the NPCs called in; then the leave waits for its end.
    if body["left"] == true {
        let (_, phase) = balance(&router, &carol.session.session_id).await;
        assert_eq!(phase, "closing");
    }
}

/// The demo floor, but no NPC can open a session (as with a missing key or an empty gas
/// allowance), and every chain read is counted.
#[derive(Default)]
struct NpcsCannotSit {
    inner: NoChain,
}

/// Only `NpcsCannotSit` (one test) counts here.
static READS: AtomicUsize = AtomicUsize::new(0);

impl Chain for NpcsCannotSit {
    async fn dealer(&self, dealer_id: &str) -> anyhow::Result<Option<DealerInfo>> {
        READS.fetch_add(1, Ordering::SeqCst);
        self.inner.dealer(dealer_id).await
    }
    async fn floor(&self) -> anyhow::Result<FloorInfo> {
        READS.fetch_add(1, Ordering::SeqCst);
        self.inner.floor().await
    }
    async fn balance(&self, account: &str) -> anyhow::Result<u128> {
        READS.fetch_add(1, Ordering::SeqCst);
        self.inner.balance(account).await
    }
    async fn open_session(
        &self,
        player: &str,
        key: Option<&str>,
        ticket: &SessionTicket,
        sig: &[u8; 64],
    ) -> anyhow::Result<()> {
        anyhow::ensure!(!player.starts_with("g-"), "no access key");
        self.inner.open_session(player, key, ticket, sig).await
    }
    async fn session(&self, id: &str) -> anyhow::Result<Option<ChainSession>> {
        READS.fetch_add(1, Ordering::SeqCst);
        self.inner.session(id).await
    }
    async fn settle(&self, batch: &SettleBatch) -> anyhow::Result<()> {
        self.inner.settle(batch).await
    }
    async fn close(&self, id: &str, seed: &Hash32) -> anyhow::Result<()> {
        self.inner.close(id, seed).await
    }
}

/// Regression: NPCs that failed to sit were called in again at once, in a loop that read the
/// chain thousands of times a second and got the server rate-limited by its RPC (testnet,
/// 2026-11-12). A failed call-in now waits before the next.
#[tokio::test]
async fn failing_npcs_are_not_called_in_a_loop() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let bare = serve_on(dir.path(), NpcsCannotSit::default(), true);
    let alice = sit(&bare, 2, "alice.testnet").await;
    let before = READS.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(3)).await;
    let reads = READS.load(Ordering::SeqCst) - before;
    // One wave of call-ins (3 NPCs: a balance, a dealer, a balance again each), then quiet.
    assert!(reads <= 12, "{reads} chain reads in 3 s");
    let table = state(&alice.router, Some(alice.token())).await;
    assert!(table.seats.iter().flatten().all(|s| !s.npc));
}

/// The demo floor at chain speed for NPCs: a balance read takes `NPC_READ_DELAY`, a session
/// `NPC_OPEN_DELAY` to open (a transaction); every NPC opening is counted.
#[derive(Default)]
struct SlowNpcs {
    inner: NoChain,
}

const NPC_READ_DELAY: Duration = Duration::from_millis(50);
const NPC_OPEN_DELAY: Duration = Duration::from_millis(200);
/// Only `SlowNpcs` (one test) counts here.
static NPC_OPENS: AtomicUsize = AtomicUsize::new(0);

impl Chain for SlowNpcs {
    async fn dealer(&self, dealer_id: &str) -> anyhow::Result<Option<DealerInfo>> {
        self.inner.dealer(dealer_id).await
    }
    async fn floor(&self) -> anyhow::Result<FloorInfo> {
        self.inner.floor().await
    }
    async fn balance(&self, account: &str) -> anyhow::Result<u128> {
        if account.starts_with("g-") {
            tokio::time::sleep(NPC_READ_DELAY).await;
        }
        self.inner.balance(account).await
    }
    async fn open_session(
        &self,
        player: &str,
        key: Option<&str>,
        ticket: &SessionTicket,
        sig: &[u8; 64],
    ) -> anyhow::Result<()> {
        if player.starts_with("g-") {
            NPC_OPENS.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(NPC_OPEN_DELAY).await;
        }
        self.inner.open_session(player, key, ticket, sig).await
    }
    async fn session(&self, id: &str) -> anyhow::Result<Option<ChainSession>> {
        self.inner.session(id).await
    }
    async fn settle(&self, batch: &SettleBatch) -> anyhow::Result<()> {
        self.inner.settle(batch).await
    }
    async fn close(&self, id: &str, seed: &Hash32) -> anyhow::Result<()> {
        self.inner.close(id, seed).await
    }
}

/// Regression (Faye on testnet, 2026-11-13, cli-demo `poker`): a second human sitting while
/// the three NPCs called in for the first were still opening their sessions made each of them
/// count the others as seated and stand up again, so the table called NPCs in wave after wave
/// (a session opened and closed on chain each time) while the gamblers feed showed them
/// "sitting in". Two humans want two NPCs: the first two to arrive sit, only the third leaves.
#[tokio::test]
async fn npcs_called_in_before_a_second_human_still_sit() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let bare = serve_on(dir.path(), SlowNpcs::default(), true);
    let router = with_peer(&bare, 1);
    let _alice = sit(&bare, 2, "alice.testnet").await;
    // Bob sits while the three NPCs called in for Alice alone are opening their sessions.
    tokio::time::sleep(NPC_OPEN_DELAY / 3).await;
    let _bob = sit(&bare, 3, "bob.testnet").await;
    // Long enough for one call-in wave, short of the humans' first timeouts.
    tokio::time::sleep(NPC_OPEN_DELAY * 4).await;
    let table = state(&router, None).await;
    let npcs = table.seats.iter().flatten().filter(|s| s.npc).count();
    assert_eq!(npcs, 2, "{:?}", table.seats);
    assert_eq!(NPC_OPENS.load(Ordering::SeqCst), 3, "one wave of three");
    // The feed shows the seated ones at the table, and only them.
    let (status, floor) = call(&router, "GET", "/gamblers/floor", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let at_poker = floor
        .as_array()
        .unwrap()
        .iter()
        .filter(|g| g["dealer_id"] == TABLE)
        .count();
    assert_eq!(at_poker, 2, "{floor}");
}

/// The demo floor with the poker table's max bet pinned to `max_bet` (repricing lowered it).
struct CappedPoker {
    inner: NoChain,
    max_bet: u128,
}

impl CappedPoker {
    fn new(max_bet: u128) -> Self {
        Self {
            inner: NoChain::default(),
            max_bet,
        }
    }
}

impl Chain for CappedPoker {
    async fn dealer(&self, dealer_id: &str) -> anyhow::Result<Option<DealerInfo>> {
        let dealer = self.inner.dealer(dealer_id).await?;
        Ok(dealer.map(|d| match d.game {
            Game::Poker => DealerInfo {
                max_bet: self.max_bet,
                ..d
            },
            _ => d,
        }))
    }
    async fn floor(&self) -> anyhow::Result<FloorInfo> {
        let mut floor = self.inner.floor().await?;
        for table in floor.tables.iter_mut().filter(|t| t.game == Game::Poker) {
            table.max_bet = self.max_bet;
        }
        Ok(floor)
    }
    async fn balance(&self, account: &str) -> anyhow::Result<u128> {
        self.inner.balance(account).await
    }
    async fn open_session(
        &self,
        player: &str,
        key: Option<&str>,
        ticket: &SessionTicket,
        sig: &[u8; 64],
    ) -> anyhow::Result<()> {
        self.inner.open_session(player, key, ticket, sig).await
    }
    async fn session(&self, id: &str) -> anyhow::Result<Option<ChainSession>> {
        self.inner.session(id).await
    }
    async fn settle(&self, batch: &SettleBatch) -> anyhow::Result<()> {
        self.inner.settle(batch).await
    }
    async fn close(&self, id: &str, seed: &Hash32) -> anyhow::Result<()> {
        self.inner.close(id, seed).await
    }
}

async fn open_poker(router: &Router, player: &str, lock: u128) -> (StatusCode, Value) {
    call(
        router,
        "POST",
        "/sessions",
        None,
        Some(json!({
            "player": player,
            "dealer_id": TABLE,
            "lock": lock.to_string(),
            "client_seed": format!("{player}-seed"),
        })),
    )
    .await
}

/// Regression (Faye on testnet, 2026-11-13): a max bet capping buy-ins at 3.73 showed "buy in
/// between 4.00 and 3.73" and nobody could sit. Under 20 BB the minimum drops to the cap.
#[tokio::test]
async fn a_capped_table_lowers_its_minimum_buy_in() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let router = with_peer(&serve_on(dir.path(), CappedPoker::new(4_662_500), true), 1);
    let (status, tables) = call(&router, "GET", "/poker/tables", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tables[0]["min_buy_in"], "3730000", "{tables}");
    assert_eq!(tables[0]["max_buy_in"], "3730000");
    assert_eq!(tables[0]["open"], true);
    assert_eq!(tables[0]["reason"], Value::Null);
    let (status, body) = call(
        &router,
        "GET",
        &format!("/poker/tables/{TABLE}"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["config"]["min_buy_in"], "3730000", "{body}");
    assert_eq!(body["config"]["open"], true);
    assert_eq!(
        open_poker(&router, "alice.testnet", 3_730_000).await.0,
        StatusCode::OK
    );
    assert_eq!(
        open_poker(&router, "bob.testnet", 3_729_999).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        open_poker(&router, "carol.testnet", 4_000_000).await.0,
        StatusCode::CONFLICT
    );
}

/// Under 10 BB the table says it is closed instead of advertising a range nobody fits.
#[tokio::test]
async fn a_table_capped_under_ten_big_blinds_is_closed() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let router = with_peer(&serve_on(dir.path(), CappedPoker::new(2_000_000), true), 1);
    let (status, tables) = call(&router, "GET", "/poker/tables", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tables[0]["open"], false, "{tables}");
    assert!(tables[0]["reason"]
        .as_str()
        .unwrap()
        .contains("10 big blinds"));
    assert_eq!(tables[0]["min_buy_in"], "0");
    assert_eq!(tables[0]["max_buy_in"], "0");
    let (_, body) = call(
        &router,
        "GET",
        &format!("/poker/tables/{TABLE}"),
        None,
        None,
    )
    .await;
    assert_eq!(body["config"]["open"], false, "{body}");
    let (status, body) = open_poker(&router, "alice.testnet", 1_600_000).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    // No NPC sits at a closed table either.
    tokio::time::sleep(Duration::from_secs(1)).await;
    let (_, body) = call(
        &router,
        "GET",
        &format!("/poker/tables/{TABLE}"),
        None,
        None,
    )
    .await;
    assert!(
        body["seats"].as_array().unwrap().iter().all(Value::is_null),
        "{body}"
    );
}

/// `GAMBLERS=off` (the TILT floor): humans play among themselves, no NPC is ever seated and the
/// gamblers floor stays empty.
#[tokio::test]
async fn without_gamblers_humans_play_alone() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let bare = serve_on(dir.path(), NoChain::default(), false);
    let router = with_peer(&bare, 1);
    let alice = sit(&bare, 2, "alice.testnet").await;
    let bob = sit(&bare, 3, "bob.testnet").await;
    let both = [(&alice, Plan::Passive), (&bob, Plan::Passive)];
    for number in 1..=2 {
        let (record, seen) = play_hand(&router, &both, number).await;
        check_record(&router, &record, &seen).await;
        assert_eq!(record.players.len(), 2, "{:?}", record.players);
        assert!(record.players.iter().all(|p| !p.npc));
    }
    let (status, floor) = call(&router, "GET", "/gamblers/floor", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(floor, json!([]));
}

/// The archive outlives the server: a restarted server still serves every hand, and goes on
/// numbering after the last one, so a (table, hand) in a session round names one hand for good.
#[tokio::test]
async fn hands_are_archived_across_restarts() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let bare = serve(dir.path());
    let alice = sit(&bare, 2, "alice.testnet").await;
    let bob = sit(&bare, 3, "bob.testnet").await;
    let plans = [(&alice, Plan::Passive), (&bob, Plan::Passive)];
    let (first, _) = play_hand(&alice.router, &plans, 1).await;
    drop((alice, bob, bare));

    let bare = serve(dir.path());
    let router = with_peer(&bare, 1);
    let uri = format!("/poker/tables/{TABLE}/hands/1");
    let (status, archived) = call(&router, "GET", &uri, None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(archived, serde_json::to_value(&first).unwrap());
    // (The first server's table may still deal on in the background: compare with the archive.)
    let (_, list) = call(
        &router,
        "GET",
        &format!("/poker/tables/{TABLE}/hands"),
        None,
        None,
    )
    .await;
    let (_, tables) = call(&router, "GET", "/poker/tables", None, None).await;
    assert_eq!(
        tables[0]["hand_number"], list[0]["number"],
        "numbering goes on: {tables} {list}"
    );
}
