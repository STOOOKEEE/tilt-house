//! `Rpc::send_tx` against scripted JSON-RPC endpoints: rate-limit answers fail over with the same
//! signed bytes, timeouts are retried, and a transaction that timed out everywhere is looked up by
//! hash before giving up.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use near_crypto::{InMemorySigner, KeyType, SecretKey};
use near_jsonrpc_client::methods::send_tx::RpcSendTransactionRequest;
use near_primitives::hash::CryptoHash;
use near_primitives::transaction::{Action, Transaction, TransactionV0, TransferAction};
use near_primitives::types::Balance;
use near_primitives::views::TxExecutionStatus;
use serde_json::{json, Value};
use tilt_house_session_server::rpc::Rpc;

/// What an endpoint answers: an HTTP status and a JSON-RPC body (its `id` filled in).
type Reply = (StatusCode, Value);

struct Mock {
    replies: Mutex<VecDeque<Reply>>,
    /// Answer once `replies` is empty, per method.
    rest: fn(&str) -> Reply,
    /// `(method, params)` of every request.
    seen: Mutex<Vec<(String, Value)>>,
}

impl Mock {
    fn new(replies: Vec<Reply>, rest: fn(&str) -> Reply) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into()),
            rest,
            seen: Mutex::new(Vec::new()),
        })
    }

    fn seen(&self) -> Vec<(String, Value)> {
        self.seen.lock().unwrap().clone()
    }

    fn methods(&self) -> Vec<String> {
        self.seen().into_iter().map(|(method, _)| method).collect()
    }
}

fn ok() -> Reply {
    (
        StatusCode::OK,
        json!({ "result": { "final_execution_status": "INCLUDED" } }),
    )
}

fn rate_limited() -> Reply {
    (
        StatusCode::OK,
        json!({ "error": { "code": -429, "message": "Rate limits exceeded. For higher rate limits get a subscription at https://fastnear.com" } }),
    )
}

fn http_timeout() -> Reply {
    (
        StatusCode::REQUEST_TIMEOUT,
        json!({ "error": { "code": 30, "message": "Request timeout on the free plan, please upgrade to paid plan" } }),
    )
}

fn near_timeout() -> Reply {
    (
        StatusCode::OK,
        // nearcore 2.14: still pending when `wait_until` ran out.
        json!({ "error": { "name": "HANDLER_ERROR", "cause": { "name": "TIMEOUT_ERROR", "info": { "cause": "PENDING", "status": { "final_execution_status": "INCLUDED" } } }, "code": -32000, "message": "Server error", "data": "Timeout" } }),
    )
}

fn unknown_tx() -> Reply {
    (
        StatusCode::OK,
        json!({ "error": { "name": "HANDLER_ERROR", "cause": { "name": "UNKNOWN_TRANSACTION", "info": { "requested_transaction_hash": "11111111111111111111111111111111" } }, "code": -32000, "message": "Server error" } }),
    )
}

async fn rpc(State(mock): State<Arc<Mock>>, Json(body): Json<Value>) -> Response {
    let method = body["method"].as_str().unwrap_or("?").to_string();
    mock.seen
        .lock()
        .unwrap()
        .push((method.clone(), body["params"].clone()));
    let next = mock.replies.lock().unwrap().pop_front();
    let (status, mut reply) = next.unwrap_or_else(|| (mock.rest)(&method));
    reply["jsonrpc"] = json!("2.0");
    reply["id"] = body["id"].clone();
    (status, Json(reply)).into_response()
}

async fn serve(mock: &Arc<Mock>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/", post(rpc))
        .with_state(Arc::clone(mock));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

const SENDER: &str = "sessions.tilthouse.testnet";

fn request() -> RpcSendTransactionRequest {
    let signer = InMemorySigner::from_secret_key(
        SENDER.parse().unwrap(),
        SecretKey::from_random(KeyType::ED25519),
    );
    let transaction = Transaction::V0(TransactionV0 {
        signer_id: SENDER.parse().unwrap(),
        public_key: signer.public_key(),
        nonce: 5,
        receiver_id: "floor.tilthouse.testnet".parse().unwrap(),
        block_hash: CryptoHash::default(),
        actions: vec![Action::Transfer(TransferAction {
            deposit: Balance::from_yoctonear(1),
        })],
    });
    RpcSendTransactionRequest {
        signed_transaction: transaction.sign(&signer),
        wait_until: TxExecutionStatus::Final,
    }
}

fn rpc_over(urls: &[String]) -> Rpc {
    Rpc::new(urls).unwrap()
}

#[tokio::test]
async fn a_rate_limit_body_sends_the_same_signed_bytes_to_the_next_endpoint() {
    let first = Mock::new(vec![rate_limited()], |_| ok());
    let second = Mock::new(vec![], |_| ok());
    let rpc = rpc_over(&[serve(&first).await, serve(&second).await]);
    rpc.send_tx(&request()).await.unwrap();
    let (sent_first, sent_second) = (first.seen(), second.seen());
    assert_eq!(first.methods(), ["send_tx"]);
    assert_eq!(second.methods(), ["send_tx"]);
    assert_eq!(
        sent_first[0].1["signed_tx_base64"],
        sent_second[0].1["signed_tx_base64"]
    );
}

#[tokio::test]
async fn transactions_still_prefer_the_first_endpoint() {
    let first = Mock::new(vec![], |_| ok());
    let second = Mock::new(vec![], |_| ok());
    let rpc = rpc_over(&[serve(&first).await, serve(&second).await]);
    rpc.send_tx(&request()).await.unwrap();
    assert_eq!(first.methods(), ["send_tx"]);
    assert!(second.methods().is_empty());
}

#[tokio::test]
async fn a_timeout_is_retried_with_the_same_signed_bytes() {
    for timeout in [http_timeout(), near_timeout()] {
        let one = Mock::new(vec![timeout], |_| ok());
        let rpc = rpc_over(&[serve(&one).await]);
        rpc.send_tx(&request()).await.unwrap();
        let seen = one.seen();
        assert_eq!(one.methods(), ["send_tx", "send_tx"]);
        assert_eq!(seen[0].1, seen[1].1);
    }
}

#[tokio::test]
async fn a_transaction_that_timed_out_everywhere_but_landed_is_a_success() {
    let first = Mock::new(vec![], |method| match method {
        "tx" => ok(),
        _ => http_timeout(),
    });
    let second = Mock::new(vec![], |_| http_timeout());
    let rpc = rpc_over(&[serve(&first).await, serve(&second).await]);
    let request = request();
    rpc.send_tx(&request).await.unwrap();
    let lookups: Vec<Value> = [first.seen(), second.seen()]
        .concat()
        .into_iter()
        .filter(|(method, _)| method == "tx")
        .map(|(_, params)| params)
        .collect();
    assert_eq!(lookups.len(), 1);
    assert_eq!(
        lookups[0]["tx_hash"],
        json!(request.signed_transaction.get_hash().to_string())
    );
    assert_eq!(lookups[0]["sender_account_id"], json!(SENDER));
}

#[tokio::test]
async fn a_transaction_the_chain_does_not_know_fails_with_the_timeout() {
    let first = Mock::new(vec![], |method| match method {
        "tx" => unknown_tx(),
        _ => http_timeout(),
    });
    let second = Mock::new(vec![], |method| match method {
        "tx" => unknown_tx(),
        _ => http_timeout(),
    });
    let rpc = rpc_over(&[serve(&first).await, serve(&second).await]);
    let error = rpc.send_tx(&request()).await.unwrap_err();
    assert!(format!("{error:?}").contains("TimeoutError"), "{error:?}");
}

#[tokio::test]
async fn rate_limits_everywhere_give_up_without_a_lookup() {
    let first = Mock::new(vec![], |_| rate_limited());
    let second = Mock::new(vec![], |_| rate_limited());
    let rpc = rpc_over(&[serve(&first).await, serve(&second).await]);
    assert!(rpc.send_tx(&request()).await.is_err());
    let methods = [first.methods(), second.methods()].concat();
    assert_eq!(methods.len(), 4);
    assert!(methods.iter().all(|m| m == "send_tx"));
}
