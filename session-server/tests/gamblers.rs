//! The NPC gambler runner in `--no-chain` mode over a simulated hour (tokio paused time).

use std::fs;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::Value;
use tilt_house_session_server::app::App;
use tilt_house_session_server::chain::NoChain;
use tilt_house_session_server::gamblers::{Clock, Gamblers};
use tilt_house_session_server::http::router;
use tilt_house_session_server::keys::Signer;
use tilt_house_session_server::store::Store;
use tower::ServiceExt;

/// 2026-11-05 20:00 UTC: the evening rush of the day curve.
const EVENING: u64 = 1_793_908_800;
const PERSONAS: [&str; 5] = [
    "bargain_hunter",
    "regular",
    "whale",
    "thrill_seeker",
    "tourist",
];
const STATES: [&str; 4] = ["walking", "deciding", "seated", "leaving"];

async fn get(router: &Router, uri: &str) -> (StatusCode, Value) {
    let request = Request::builder().uri(uri).body(Body::empty()).unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn keys(value: &Value) -> Vec<&str> {
    let mut keys: Vec<&str> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort();
    keys
}

fn is_amount(value: &Value, signed: bool) -> bool {
    let text = value.as_str().unwrap_or("x");
    let digits = if signed {
        text.strip_prefix('-').unwrap_or(text)
    } else {
        text
    };
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

fn check_snapshot(g: &Value) {
    assert_eq!(
        keys(g),
        [
            "balance",
            "dealer_id",
            "id",
            "name",
            "persona",
            "reason",
            "reason_code",
            "seat",
            "session_net",
            "state"
        ]
    );
    assert!(g["id"].as_str().unwrap().starts_with("g-"));
    assert!(PERSONAS.contains(&g["persona"].as_str().unwrap()));
    assert!(STATES.contains(&g["state"].as_str().unwrap()));
    assert!(is_amount(&g["balance"], false));
    assert!(is_amount(&g["session_net"], true));
    if g["state"] == "seated" {
        assert!(g["dealer_id"].is_string());
        assert!(g["seat"].as_u64().unwrap() < 6);
    }
    if g["state"] == "walking" {
        assert!(g["dealer_id"].is_null());
    }
}

#[tokio::test(start_paused = true)]
async fn an_evening_hour_of_gamblers() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let (store, events) = Store::open(dir.path()).unwrap();
    let app =
        Arc::new(App::load(Signer::random().unwrap(), NoChain::default(), store, events).unwrap());
    let clock = Clock::starting_at(EVENING);
    let gamblers =
        Arc::new(Gamblers::new(Arc::clone(&app), clock, dir.path(), None, [42; 32]).unwrap());
    gamblers.start();
    let router =
        router(app, gamblers).layer(MockConnectInfo(SocketAddr::from(([127, 0, 0, 1], 9))));

    let mut seen_seated = false;
    let mut seen = 0;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let (status, floor) = get(&router, "/gamblers/floor").await;
        assert_eq!(status, StatusCode::OK);
        for g in floor.as_array().unwrap() {
            check_snapshot(g);
            seen += 1;
            seen_seated |= g["state"] == "seated";
        }
    }
    assert!(seen > 0, "nobody walked in all evening");
    assert!(seen_seated, "nobody sat down");

    // Sessions were played and closed through the app.
    let log = fs::read_to_string(dir.path().join("sessions.jsonl")).unwrap();
    let count = |kind: &str| log.matches(&format!(r#""kind":"{kind}""#)).count();
    assert!(count("created") > 0);
    assert!(count("round") > count("created"));
    // Every session plays: a gambler never opens one its first bet cannot fit (an empty
    // session still costs an open and a close on chain).
    let events: Vec<Value> = log
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    for created in events.iter().filter(|e| e["kind"] == "created") {
        let id = &created["ticket"]["session_id"];
        assert!(
            events
                .iter()
                .any(|e| (e["kind"] == "round" || e["kind"] == "hand") && &e["session_id"] == id),
            "session {id} closed without a round: {created}"
        );
    }
    // Closed on the player's side; the chain reveal runs in the background tick, not run here.
    assert!(count("closing") > 0);
    // Loyalty is remembered on disk.
    let memories: Value =
        serde_json::from_str(&fs::read_to_string(dir.path().join("gamblers.json")).unwrap())
            .unwrap();
    assert!(!memories.as_object().unwrap().is_empty());

    // Footfall: every arrival of the hour, scored for this table.
    let mut sat = 0;
    for dealer in [
        "dice-demo",
        "roulette-demo",
        "blackjack-demo",
        "dice-pricey",
        "roulette-boost",
    ] {
        let (status, reply) = get(&router, &format!("/gamblers/footfall?dealer_id={dealer}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            keys(&reply),
            ["arrivals_1h", "dealer_id", "passed_1h", "sat_1h"]
        );
        assert_eq!(reply["dealer_id"], dealer);
        let arrivals = reply["arrivals_1h"].as_array().unwrap();
        assert!(!arrivals.is_empty());
        for a in arrivals {
            assert_eq!(keys(a), ["chose", "persona", "reason", "score"]);
            assert!(PERSONAS.contains(&a["persona"].as_str().unwrap()));
            assert!(a["score"].is_i64());
            assert!(a["chose"].is_boolean());
            assert!(a["reason"].is_string());
        }
        let chosen = arrivals.iter().filter(|a| a["chose"] == true).count();
        let sat_here = reply["sat_1h"].as_u64().unwrap() as usize;
        assert!(sat_here <= chosen);
        assert_eq!(sat_here == 0, chosen == 0);
        sat += sat_here;
    }
    assert!(sat > 0);

    let (status, reply) = get(&router, "/gamblers/footfall?dealer_id=nobody").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(reply, serde_json::json!({ "error": "unknown dealer" }));
}
