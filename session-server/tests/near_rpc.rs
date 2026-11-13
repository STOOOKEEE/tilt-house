//! `NearChain` against a local mock JSON-RPC server: the floor-wide view cache (one request in
//! flight, reused for its TTL) and the backoff / failover on 429.

use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};
use tilt_house_session_server::chain::Chain;
use tilt_house_session_server::near::{NearChain, VIEW_TTL};

const VIEWS: [&str; 3] = ["get_lobby", "get_floor", "get_player"];

#[derive(Default)]
struct Mock {
    /// Requests per view method, in `VIEWS` order.
    views: [AtomicUsize; 3],
    /// The next this many requests answer 429 (`u32::MAX`: always).
    throttle: AtomicU32,
    throttled: AtomicUsize,
}

impl Mock {
    fn throttling(throttle: u32) -> Arc<Self> {
        let mock = Self::default();
        mock.throttle.store(throttle, Ordering::SeqCst);
        Arc::new(mock)
    }

    fn count(&self, method: &str) -> usize {
        let index = VIEWS.iter().position(|v| *v == method).unwrap();
        self.views[index].load(Ordering::SeqCst)
    }

    fn throttled(&self) -> usize {
        self.throttled.load(Ordering::SeqCst)
    }

    /// Spends one 429 if any is left.
    fn take_throttle(&self) -> bool {
        self.throttle
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |left| match left {
                0 => None,
                u32::MAX => Some(u32::MAX),
                n => Some(n - 1),
            })
            .is_ok()
    }
}

fn view_result(method: &str) -> Value {
    match method {
        "get_lobby" => json!([{
            "id": "dice-1", "name": "Ada", "game": "dice", "rake_bp": 100, "total_edge_bp": 200,
            "boost_until": 0, "max_bet": "5000000", "bankroll": "100000000", "reserved": "0",
            "open": true, "seat": 1
        }]),
        "get_floor" => json!({ "jackpot": "42" }),
        _ => json!({ "balance": "7" }),
    }
}

async fn rpc(State(mock): State<Arc<Mock>>, Json(body): Json<Value>) -> Response {
    if mock.take_throttle() {
        mock.throttled.fetch_add(1, Ordering::SeqCst);
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let method = body["params"]["method_name"]
        .as_str()
        .unwrap_or("?")
        .to_string();
    if let Some(index) = VIEWS.iter().position(|v| *v == method) {
        mock.views[index].fetch_add(1, Ordering::SeqCst);
    }
    // Slow enough for concurrent readers to overlap.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let bytes = serde_json::to_vec(&view_result(&method)).unwrap();
    Json(json!({
        "jsonrpc": "2.0",
        "id": body["id"],
        "result": {
            "result": bytes,
            "logs": [],
            "block_height": 1,
            "block_hash": "11111111111111111111111111111111"
        }
    }))
    .into_response()
}

async fn serve(mock: Arc<Mock>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().route("/", post(rpc)).with_state(mock);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

/// A throwaway server key: these tests only read.
fn key_text() -> String {
    let seed: [u8; 32] = tilt_house_session_server::keys::random_bytes().unwrap();
    let public = ed25519_dalek::SigningKey::from_bytes(&seed).verifying_key();
    let keypair = [seed, public.to_bytes()].concat();
    format!("ed25519:{}", bs58::encode(keypair).into_string())
}

fn chain(urls: &[String], ttl: Duration) -> NearChain {
    let key = key_text();
    NearChain::new(
        urls,
        ttl,
        "floor.tilthouse.testnet",
        "sessions.tilthouse.testnet",
        &key,
    )
    .unwrap()
}

#[tokio::test]
async fn floor_views_are_read_once_per_ttl_by_concurrent_readers() {
    let mock = Arc::new(Mock::default());
    let url = serve(Arc::clone(&mock)).await;
    let chain = Arc::new(chain(&[url], VIEW_TTL));
    let readers: Vec<_> = (0..20)
        .map(|i| {
            let chain = Arc::clone(&chain);
            tokio::spawn(async move {
                if i % 2 == 0 {
                    chain.floor().await.unwrap().jackpot
                } else {
                    chain.dealer("dice-1").await.unwrap().unwrap().max_bet
                }
            })
        })
        .collect();
    for reader in readers {
        reader.await.unwrap();
    }
    assert_eq!(mock.count("get_lobby"), 1);
    assert_eq!(mock.count("get_floor"), 1);
    assert_eq!(chain.floor().await.unwrap().jackpot, 42);
    // Per-player views are never cached.
    chain.balance("a.testnet").await.unwrap();
    chain.balance("a.testnet").await.unwrap();
    assert_eq!(mock.count("get_player"), 2);
    let (requests, throttled, hits) = chain.rpc_stats().take();
    assert_eq!((requests, throttled), (4, 0));
    assert!(hits >= 19, "{hits}");
}

#[tokio::test]
async fn a_zero_ttl_reads_through() {
    let mock = Arc::new(Mock::default());
    let url = serve(Arc::clone(&mock)).await;
    let chain = chain(&[url], Duration::ZERO);
    for _ in 0..3 {
        chain.dealer("dice-1").await.unwrap();
    }
    assert_eq!(mock.count("get_lobby"), 3);
}

#[tokio::test]
async fn a_throttled_endpoint_is_retried_after_backing_off() {
    let mock = Mock::throttling(1);
    let url = serve(Arc::clone(&mock)).await;
    let chain = chain(&[url], VIEW_TTL);
    let started = std::time::Instant::now();
    assert_eq!(chain.balance("a.testnet").await.unwrap(), 7);
    assert!(
        started.elapsed() >= Duration::from_millis(900),
        "no backoff"
    );
    assert_eq!(mock.throttled(), 1);
    assert_eq!(chain.rpc_stats().take().1, 1);
}

#[tokio::test]
async fn a_throttled_endpoint_fails_over_to_the_next_at_once() {
    let first = Mock::throttling(u32::MAX);
    let second = Arc::new(Mock::default());
    let urls = [
        serve(Arc::clone(&first)).await,
        serve(Arc::clone(&second)).await,
    ];
    let chain = chain(&urls, Duration::ZERO);
    let started = std::time::Instant::now();
    for _ in 0..3 {
        chain.balance("a.testnet").await.unwrap();
    }
    assert!(
        started.elapsed() < Duration::from_millis(900),
        "waited instead of failing over"
    );
    // The first endpoint cools down after its 429: later requests skip it.
    assert_eq!(first.throttled(), 1);
    assert_eq!(second.count("get_player"), 3);
}
