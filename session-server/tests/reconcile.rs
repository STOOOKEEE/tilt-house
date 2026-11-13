//! Settles and closes that time out here but execute on chain (testnet, 2026-11-13: a
//! `settle_session` sent through a slow RPC executed, the server resent the same batch forever and
//! the contract refused it each time with `round nonces must follow the last settle`).

use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Request, StatusCode};
use axum::Router;
use core_rules::session::{Hash32, SessionTicket, SettleBatch};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tilt_house_session_server::app::{App, CreateReply};
use tilt_house_session_server::chain::{Chain, ChainSession, DealerInfo, FloorInfo, NoChain};
use tilt_house_session_server::gamblers::{Clock, Gamblers};
use tilt_house_session_server::http::router;
use tilt_house_session_server::keys::Signer;
use tilt_house_session_server::poker::{Poker, PokerConfig};
use tilt_house_session_server::poker_hands::HandLog;
use tilt_house_session_server::store::Store;
use tower::ServiceExt;

const USDC: u128 = 1_000_000;
const ROUNDS: u64 = 3;

/// The contract's view of the sessions (`NoChain`) and what was sent to it.
#[derive(Default)]
struct Ledger {
    chain: NoChain,
    settles: AtomicUsize,
    closes: AtomicUsize,
}

/// Every settle and close executes, then the RPC answers with a timeout. `down_after_send`: from
/// then on reading `get_session` fails too (the RPC went down for everything).
struct TimesOutAfterExecuting {
    ledger: Arc<Ledger>,
    down_after_send: bool,
    views_down: AtomicBool,
}

impl TimesOutAfterExecuting {
    fn new(ledger: &Arc<Ledger>, down_after_send: bool) -> Self {
        Self {
            ledger: Arc::clone(ledger),
            down_after_send,
            views_down: AtomicBool::new(false),
        }
    }

    fn sent(&self) {
        if self.down_after_send {
            self.views_down.store(true, Ordering::SeqCst);
        }
    }
}

impl Chain for TimesOutAfterExecuting {
    async fn dealer(&self, dealer_id: &str) -> anyhow::Result<Option<DealerInfo>> {
        self.ledger.chain.dealer(dealer_id).await
    }
    async fn floor(&self) -> anyhow::Result<FloorInfo> {
        self.ledger.chain.floor().await
    }
    async fn balance(&self, account: &str) -> anyhow::Result<u128> {
        self.ledger.chain.balance(account).await
    }
    async fn open_session(
        &self,
        player: &str,
        key: Option<&str>,
        ticket: &SessionTicket,
        sig: &[u8; 64],
    ) -> anyhow::Result<()> {
        self.ledger
            .chain
            .open_session(player, key, ticket, sig)
            .await
    }
    async fn session(&self, id: &str) -> anyhow::Result<Option<ChainSession>> {
        anyhow::ensure!(!self.views_down.load(Ordering::SeqCst), "rpc down");
        self.ledger.chain.session(id).await
    }
    /// Like the contract: a batch must start right after the last settled nonce.
    async fn settle(&self, batch: &SettleBatch) -> anyhow::Result<()> {
        let on_chain = self.ledger.chain.session(&batch.session_id).await?;
        let settled = on_chain.map_or(0, |s| s.settled_nonce);
        anyhow::ensure!(
            batch.upto_nonce - batch.rounds.len() as u64 == settled,
            "round nonces must follow the last settle"
        );
        self.ledger.settles.fetch_add(1, Ordering::SeqCst);
        self.ledger.chain.settle(batch).await?;
        self.sent();
        anyhow::bail!("send settle_session: timeout")
    }
    async fn close(&self, id: &str, seed: &Hash32) -> anyhow::Result<()> {
        let on_chain = self.ledger.chain.session(id).await?;
        anyhow::ensure!(
            !on_chain.is_some_and(|s| s.revealed),
            "the session is already closed"
        );
        self.ledger.closes.fetch_add(1, Ordering::SeqCst);
        self.ledger.chain.close(id, seed).await?;
        self.sent();
        anyhow::bail!("send close_session: timeout")
    }
}

fn key_text() -> String {
    let seed: [u8; 32] = tilt_house_session_server::keys::random_bytes().unwrap();
    format!("ed25519:{}", bs58::encode(seed).into_string())
}

fn serve<C: Chain>(dir: &Path, key: &str, chain: C) -> (Arc<App<C>>, Router) {
    let (store, events) = Store::open(dir).unwrap();
    let signer = Signer::from_near_secret(key).unwrap();
    let app = Arc::new(App::load(signer, chain, store, events).unwrap());
    let gamblers = Arc::new(Gamblers::off(Arc::clone(&app), Clock::system(), dir).unwrap());
    let poker = Arc::new(Poker::new(
        Arc::clone(&app),
        Arc::clone(&gamblers),
        HandLog::open(dir).unwrap(),
        PokerConfig::default(),
    ));
    let router = router(Arc::clone(&app), gamblers, poker)
        .layer(MockConnectInfo(SocketAddr::from(([10, 0, 0, 1], 9))));
    (app, router)
}

async fn call(
    router: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let body = body.map_or_else(Body::empty, |b| Body::from(b.to_string()));
    let response = router
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// A dice session with `ROUNDS` rounds played, then closed by the player (the chain part runs in
/// the tick).
async fn play_and_close(router: &Router) -> String {
    let (status, body) = call(
        router,
        "POST",
        "/sessions",
        None,
        Some(json!({
            "player": "alice.testnet",
            "dealer_id": "dice-demo",
            "lock": (10 * USDC).to_string(),
            "client_seed": "seed",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let s: CreateReply = serde_json::from_value(body).unwrap();
    for nonce in 1..=ROUNDS {
        let bet = json!({
            "nonce": nonce,
            "bet": { "dice": { "chance_bp": 5000, "over": true } },
            "stake": USDC.to_string(),
        });
        let uri = format!("/sessions/{}/rounds", s.session_id);
        let (status, body) = call(router, "POST", &uri, Some(&s.token), Some(bet)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let uri = format!("/sessions/{}/close", s.session_id);
    assert_eq!(
        call(router, "POST", &uri, Some(&s.token), None).await.0,
        StatusCode::OK
    );
    s.session_id
}

async fn phase(router: &Router, id: &str) -> String {
    let (_, view) = call(router, "GET", &format!("/sessions/{id}"), None, None).await;
    view["phase"].as_str().unwrap().to_string()
}

/// Ticks until the session is closed (spawned chain work included), or gives up.
async fn tick_until_closed<C: Chain>(app: &Arc<App<C>>, router: &Router, id: &str) -> bool {
    for _ in 0..40 {
        app.tick().await;
        tokio::time::sleep(Duration::from_millis(25)).await;
        if phase(router, id).await == "closed" {
            return true;
        }
    }
    false
}

#[tokio::test]
async fn a_settle_and_a_close_that_executed_are_not_sent_again() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let ledger = Arc::new(Ledger::default());
    let (app, router) = serve(
        dir.path(),
        &key_text(),
        TimesOutAfterExecuting::new(&ledger, false),
    );
    let id = play_and_close(&router).await;
    assert!(
        tick_until_closed(&app, &router, &id).await,
        "stuck in {}",
        phase(&router, &id).await
    );
    assert_eq!(ledger.settles.load(Ordering::SeqCst), 1);
    assert_eq!(ledger.closes.load(Ordering::SeqCst), 1);
    let log = std::fs::read_to_string(dir.path().join("sessions.jsonl")).unwrap();
    assert!(
        log.contains(&format!(
            r#""kind":"settled","session_id":"{id}","upto_nonce":{ROUNDS}"#
        )),
        "{log}"
    );
}

/// The server restarts with a closing session whose settle and close executed while it could not
/// tell (RPC down): it reads the chain first and sends nothing again.
#[tokio::test]
async fn a_restarted_server_starts_from_what_the_chain_has() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let key = key_text();
    let ledger = Arc::new(Ledger::default());
    let id = {
        let chain = TimesOutAfterExecuting::new(&ledger, true);
        let (app, router) = serve(dir.path(), &key, chain);
        let id = play_and_close(&router).await;
        // The settle executes, then times out; reading the chain back fails too.
        for _ in 0..3 {
            app.tick().await;
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(phase(&router, &id).await, "closing");
        id
    };
    let sent = (
        ledger.settles.load(Ordering::SeqCst),
        ledger.closes.load(Ordering::SeqCst),
    );
    assert_eq!(sent.0, 1);
    let (app, router) = serve(
        dir.path(),
        &key,
        TimesOutAfterExecuting::new(&ledger, false),
    );
    assert!(
        tick_until_closed(&app, &router, &id).await,
        "stuck in {}",
        phase(&router, &id).await
    );
    assert_eq!(
        ledger.settles.load(Ordering::SeqCst),
        sent.0,
        "settle sent again"
    );
    assert_eq!(ledger.closes.load(Ordering::SeqCst), 1);
}
