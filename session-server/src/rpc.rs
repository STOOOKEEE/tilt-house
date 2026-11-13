//! NEAR JSON-RPC over one or more endpoints (`NEAR_RPC_URLS`, preferred first) that backs off
//! instead of hammering: an endpoint that is rate-limiting (HTTP 429, or a JSON-RPC error body
//! such as FastNear's `{"code":-429,"message":"Rate limits exceeded…"}`), overloaded (5xx),
//! timing out or unreachable cools down (1 s, doubling up to 30 s, reset by a success) and the
//! request moves to the next endpoint, or waits for the first one to cool down.
//!
//! Retrying is safe for every request the server sends: views, and transactions resent signed as
//! they were (same hash, same nonce), which is idempotent: a node that already has the
//! transaction answers with its outcome. Transactions (`send_tx`) still prefer the first
//! endpoint but fail over like reads, and are retried after a timeout. When an attempt may have
//! reached a node (a timeout) and the last one fails, the status is asked by hash on any
//! endpoint, so a transaction that landed is reported as such rather than as an error.

use std::fmt::Debug;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use near_jsonrpc_client::errors::{
    JsonRpcError, JsonRpcServerError, JsonRpcServerResponseStatusError, JsonRpcTransportSendError,
    RpcTransportError,
};
use near_jsonrpc_client::methods::send_tx::{
    RpcSendTransactionRequest, RpcTransactionError, RpcTransactionResponse,
};
use near_jsonrpc_client::methods::tx::{RpcTransactionStatusRequest, TransactionInfo};
use near_jsonrpc_client::methods::RpcMethod;
use near_jsonrpc_client::{JsonRpcClient, MethodCallResult};
use tokio::time::{sleep_until, Instant};

/// Requests tried at most this many times (endpoints included) before the error is returned.
const MAX_ATTEMPTS: u32 = 4;
const FIRST_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// RPC traffic counters, read and reset by the once-a-minute log line.
#[derive(Debug, Default)]
pub struct RpcStats {
    /// HTTP requests sent.
    pub requests: AtomicU64,
    /// Requests refused by a rate limit or 5xx, or timed out.
    pub throttled: AtomicU64,
    /// View reads served from the view cache (`near.rs`), no request sent.
    pub cache_hits: AtomicU64,
}

impl RpcStats {
    /// `(requests, throttled, cache_hits)` since the last call.
    pub fn take(&self) -> (u64, u64, u64) {
        (
            self.requests.swap(0, Ordering::Relaxed),
            self.throttled.swap(0, Ordering::Relaxed),
            self.cache_hits.swap(0, Ordering::Relaxed),
        )
    }
}

/// An endpoint's cool-down after 429/5xx answers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cooling {
    pub until: Option<Instant>,
    /// The next cool-down; zero after a success.
    pub backoff: Duration,
}

impl Cooling {
    /// Cools down for the current backoff, and doubles it for the next failure.
    pub fn failed(&mut self, now: Instant) {
        let backoff = if self.backoff.is_zero() {
            FIRST_BACKOFF
        } else {
            self.backoff
        };
        self.until = Some(now + backoff);
        self.backoff = (backoff * 2).min(MAX_BACKOFF);
    }

    pub fn succeeded(&mut self) {
        *self = Self::default();
    }

    pub fn ready_at(&self) -> Option<Instant> {
        self.until
    }
}

/// Why an endpoint, not the request, failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// Refused (rate limit, overload): try elsewhere.
    Overload,
    /// Timed out or the connection broke: try elsewhere, but the request may have reached a node.
    Timeout,
}

/// FastNear answers a rate limit with a JSON-RPC error `{"code":-429,…}`, sometimes on HTTP 200.
const RATE_LIMIT_CODE: i64 = -429;

/// The endpoint's trouble (`Some`) or the request's own answer (`None`).
pub fn classify<E>(error: &JsonRpcError<E>) -> Option<Failure> {
    use JsonRpcServerResponseStatusError as Status;
    match error {
        JsonRpcError::ServerError(JsonRpcServerError::ResponseStatusError(status)) => {
            match status {
                Status::TooManyRequests | Status::ServiceUnavailable => Some(Failure::Overload),
                Status::TimeoutError => Some(Failure::Timeout),
                Status::Unexpected { status } if status.is_server_error() => {
                    Some(Failure::Overload)
                }
                Status::Unexpected { .. } | Status::Unauthorized | Status::BadRequest => None,
            }
        }
        // HTTP 500 lands here too.
        JsonRpcError::ServerError(JsonRpcServerError::InternalError { .. }) => {
            Some(Failure::Overload)
        }
        // An error body without a NEAR error structure comes from a gateway, not from nearcore:
        // rate limits and plan limits ("Request timeout on the free plan").
        JsonRpcError::ServerError(JsonRpcServerError::NonContextualError(rpc_error)) => {
            let message = rpc_error.message.to_ascii_lowercase();
            if rpc_error.code != RATE_LIMIT_CODE && message.contains("timeout") {
                Some(Failure::Timeout)
            } else {
                Some(Failure::Overload)
            }
        }
        // Sending failed (connection refused, reset, or timed out): it may have been delivered.
        JsonRpcError::TransportError(RpcTransportError::SendError(
            JsonRpcTransportSendError::PayloadSendError(_),
        )) => Some(Failure::Timeout),
        _ => None,
    }
}

/// `classify`, plus nearcore's own `send_tx` timeout (the transaction is in flight).
pub fn classify_tx(error: &JsonRpcError<RpcTransactionError>) -> Option<Failure> {
    match error.handler_error() {
        Some(RpcTransactionError::TimeoutError(_)) => Some(Failure::Timeout),
        _ => classify(error),
    }
}

struct Endpoint {
    url: String,
    client: JsonRpcClient,
    cooling: Mutex<Cooling>,
}

pub struct Rpc {
    endpoints: Vec<Endpoint>,
    stats: Arc<RpcStats>,
}

impl Rpc {
    pub fn new(urls: &[String]) -> anyhow::Result<Self> {
        anyhow::ensure!(!urls.is_empty(), "no NEAR RPC URL");
        Ok(Self {
            endpoints: urls
                .iter()
                .map(|url| Endpoint {
                    url: url.clone(),
                    client: JsonRpcClient::connect(url),
                    cooling: Mutex::new(Cooling::default()),
                })
                .collect(),
            stats: Arc::new(RpcStats::default()),
        })
    }

    pub fn stats(&self) -> Arc<RpcStats> {
        Arc::clone(&self.stats)
    }

    fn cooling(&self, index: usize) -> Cooling {
        self.endpoints[index]
            .cooling
            .lock()
            .map(|c| *c)
            .unwrap_or_default()
    }

    fn update(&self, index: usize, change: impl FnOnce(&mut Cooling)) {
        if let Ok(mut cooling) = self.endpoints[index].cooling.lock() {
            change(&mut cooling);
        }
    }

    /// The preferred endpoint that is not cooling down, else the one that cools down first.
    fn pick(&self, now: Instant) -> (usize, Option<Instant>) {
        let mut earliest: Option<(usize, Instant)> = None;
        for index in 0..self.endpoints.len() {
            match self.cooling(index).ready_at() {
                Some(until) if until > now => {
                    if earliest.is_none_or(|(_, at)| until < at) {
                        earliest = Some((index, until));
                    }
                }
                _ => return (index, None),
            }
        }
        earliest.map_or((0, None), |(index, at)| (index, Some(at)))
    }

    /// A read: any endpoint.
    pub async fn call<M>(&self, method: &M) -> MethodCallResult<M::Response, M::Error>
    where
        M: RpcMethod,
        M::Error: Debug,
    {
        self.request(method, classify).await.0
    }

    /// A transaction, resent as signed (same bytes) after a refusal or a timeout. If an attempt
    /// may have reached a node and the last one fails, its status decides: landed is success.
    pub async fn send_tx(
        &self,
        request: &RpcSendTransactionRequest,
    ) -> MethodCallResult<RpcTransactionResponse, RpcTransactionError> {
        let (result, maybe_delivered) = self.request(request, classify_tx).await;
        let Err(error) = result else {
            return result;
        };
        if !maybe_delivered {
            return Err(error);
        }
        let transaction = &request.signed_transaction;
        let status = RpcTransactionStatusRequest {
            transaction_info: TransactionInfo::TransactionId {
                tx_hash: transaction.get_hash(),
                sender_account_id: transaction.transaction.signer_id().clone(),
            },
            wait_until: request.wait_until.clone(),
        };
        match self.call(&status).await {
            Ok(landed) => {
                eprintln!(
                    "rpc: transaction {} landed despite {error:?}",
                    transaction.get_hash()
                );
                Ok(landed)
            }
            Err(_) => Err(error),
        }
    }

    /// Tries up to `MAX_ATTEMPTS` times while `failure` blames the endpoint. Also says whether an
    /// attempt timed out (the request may have reached a node).
    async fn request<M>(
        &self,
        method: &M,
        failure: impl Fn(&JsonRpcError<M::Error>) -> Option<Failure>,
    ) -> (MethodCallResult<M::Response, M::Error>, bool)
    where
        M: RpcMethod,
        M::Error: Debug,
    {
        let mut timed_out = false;
        let mut attempt = 1;
        loop {
            let (index, wait) = self.pick(Instant::now());
            if let Some(at) = wait {
                sleep_until(at).await;
            }
            self.stats.requests.fetch_add(1, Ordering::Relaxed);
            let endpoint = &self.endpoints[index];
            let result = endpoint.client.call(method).await;
            let blamed = match &result {
                Ok(_) => {
                    self.update(index, Cooling::succeeded);
                    None
                }
                Err(error) => failure(error),
            };
            let Some(blamed) = blamed else {
                return (result, timed_out);
            };
            timed_out |= blamed == Failure::Timeout;
            self.stats.throttled.fetch_add(1, Ordering::Relaxed);
            self.update(index, |c| c.failed(Instant::now()));
            if attempt >= MAX_ATTEMPTS {
                return (result, timed_out);
            }
            if let Err(error) = &result {
                eprintln!(
                    "rpc {}: {blamed:?}: {error:?}, retrying (attempt {attempt})",
                    endpoint.url
                );
            }
            attempt += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_up_to_the_cap_and_resets_on_success() {
        let now = Instant::now();
        let mut cooling = Cooling::default();
        let mut waits = Vec::new();
        for _ in 0..8 {
            cooling.failed(now);
            waits.push(cooling.until.unwrap() - now);
        }
        let secs: Vec<u64> = waits.iter().map(Duration::as_secs).collect();
        assert_eq!(secs, [1, 2, 4, 8, 16, 30, 30, 30]);
        cooling.succeeded();
        assert_eq!(cooling, Cooling::default());
        cooling.failed(now);
        assert_eq!(cooling.until, Some(now + FIRST_BACKOFF));
    }

    #[test]
    fn only_the_endpoints_trouble_is_retried() {
        use JsonRpcServerResponseStatusError as Status;
        let status =
            |s| JsonRpcError::<()>::ServerError(JsonRpcServerError::ResponseStatusError(s));
        let overload = Some(Failure::Overload);
        assert_eq!(classify(&status(Status::TooManyRequests)), overload);
        assert_eq!(classify(&status(Status::ServiceUnavailable)), overload);
        assert_eq!(
            classify(&status(Status::Unexpected {
                status: reqwest_status(502)
            })),
            overload
        );
        assert_eq!(
            classify(&status(Status::TimeoutError)),
            Some(Failure::Timeout)
        );
        assert_eq!(
            classify(&status(Status::Unexpected {
                status: reqwest_status(404)
            })),
            None
        );
        assert_eq!(classify(&status(Status::BadRequest)), None);
        assert_eq!(
            classify(&JsonRpcError::<()>::ServerError(
                JsonRpcServerError::InternalError { info: None }
            )),
            overload
        );
        assert_eq!(
            classify(&JsonRpcError::<()>::ServerError(
                JsonRpcServerError::HandlerError(())
            )),
            None
        );
    }

    fn gateway_error(body: serde_json::Value) -> JsonRpcError<RpcTransactionError> {
        let error: near_jsonrpc_primitives::errors::RpcError =
            serde_json::from_value(body).unwrap();
        JsonRpcError::from(error)
    }

    #[test]
    fn a_rate_limit_body_is_an_overload_and_a_gateway_timeout_a_timeout() {
        let rate_limited = gateway_error(serde_json::json!({
            "code": -429,
            "message": "Rate limits exceeded. For higher rate limits get a subscription at https://fastnear.com"
        }));
        assert_eq!(classify_tx(&rate_limited), Some(Failure::Overload));
        let plan_timeout = gateway_error(serde_json::json!({
            "code": 30,
            "message": "Request timeout on the free plan, please upgrade to paid plan"
        }));
        assert_eq!(classify_tx(&plan_timeout), Some(Failure::Timeout));
    }

    #[test]
    fn nearcores_send_tx_timeout_is_a_timeout_and_its_refusals_are_answers() {
        let timeout = JsonRpcError::ServerError(JsonRpcServerError::HandlerError(
            RpcTransactionError::TimeoutError(None),
        ));
        assert_eq!(classify_tx(&timeout), Some(Failure::Timeout));
        let unknown = JsonRpcError::ServerError(JsonRpcServerError::HandlerError(
            RpcTransactionError::DoesNotTrackShard,
        ));
        assert_eq!(classify_tx(&unknown), None);
    }

    fn reqwest_status(code: u16) -> axum::http::StatusCode {
        axum::http::StatusCode::from_u16(code).unwrap()
    }
}
