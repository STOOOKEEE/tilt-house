//! NEAR JSON-RPC over one or more endpoints (`NEAR_RPC_URLS`, preferred first) that backs off
//! instead of hammering: an endpoint answering 429 or 5xx cools down (1 s, doubling up to 30 s,
//! reset by a success) and the request moves to the next endpoint, or waits for the first one to
//! cool down. Retrying is safe for every request the server sends: views, and transactions that
//! are resent signed as they were (same hash, same nonce). Transactions go to the first endpoint
//! only (`send`): a failover endpoint may serve reads well and time out on `send_tx`.

use std::fmt::Debug;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use near_jsonrpc_client::errors::{
    JsonRpcError, JsonRpcServerError, JsonRpcServerResponseStatusError,
};
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
    /// Requests answered 429 or 5xx.
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

/// 429, 5xx and internal errors: the endpoint is overloaded or down; anything else is the
/// request's own answer.
pub fn is_overload<E>(error: &JsonRpcError<E>) -> bool {
    use JsonRpcServerResponseStatusError as Status;
    match error {
        JsonRpcError::ServerError(JsonRpcServerError::ResponseStatusError(status)) => {
            match status {
                Status::TooManyRequests | Status::ServiceUnavailable => true,
                Status::Unexpected { status } => status.is_server_error(),
                Status::Unauthorized | Status::BadRequest | Status::TimeoutError => false,
            }
        }
        // HTTP 500 lands here too.
        JsonRpcError::ServerError(JsonRpcServerError::InternalError { .. }) => true,
        _ => false,
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

    /// Among the first `usable` endpoints: the preferred one that is not cooling down, else the
    /// one that cools down first.
    fn pick(&self, usable: usize, now: Instant) -> (usize, Option<Instant>) {
        let mut earliest: Option<(usize, Instant)> = None;
        for index in 0..usable.min(self.endpoints.len()) {
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
        self.request(method, self.endpoints.len()).await
    }

    /// A transaction: the first endpoint only.
    pub async fn send<M>(&self, method: &M) -> MethodCallResult<M::Response, M::Error>
    where
        M: RpcMethod,
        M::Error: Debug,
    {
        self.request(method, 1).await
    }

    async fn request<M>(&self, method: &M, usable: usize) -> MethodCallResult<M::Response, M::Error>
    where
        M: RpcMethod,
        M::Error: Debug,
    {
        let mut attempt = 1;
        loop {
            let (index, wait) = self.pick(usable, Instant::now());
            if let Some(at) = wait {
                sleep_until(at).await;
            }
            self.stats.requests.fetch_add(1, Ordering::Relaxed);
            let endpoint = &self.endpoints[index];
            match endpoint.client.call(method).await {
                Err(error) if is_overload(&error) => {
                    self.stats.throttled.fetch_add(1, Ordering::Relaxed);
                    self.update(index, |c| c.failed(Instant::now()));
                    if attempt >= MAX_ATTEMPTS {
                        return Err(error);
                    }
                    eprintln!(
                        "rpc {}: {error:?}, backing off (attempt {attempt})",
                        endpoint.url
                    );
                    attempt += 1;
                }
                result => {
                    if result.is_ok() {
                        self.update(index, Cooling::succeeded);
                    }
                    return result;
                }
            }
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
    fn only_overload_answers_are_retried() {
        use JsonRpcServerResponseStatusError as Status;
        let status =
            |s| JsonRpcError::<()>::ServerError(JsonRpcServerError::ResponseStatusError(s));
        assert!(is_overload(&status(Status::TooManyRequests)));
        assert!(is_overload(&status(Status::ServiceUnavailable)));
        assert!(is_overload(&status(Status::Unexpected {
            status: reqwest_status(502)
        })));
        assert!(!is_overload(&status(Status::Unexpected {
            status: reqwest_status(404)
        })));
        assert!(!is_overload(&status(Status::BadRequest)));
        assert!(is_overload(&JsonRpcError::<()>::ServerError(
            JsonRpcServerError::InternalError { info: None }
        )));
        assert!(!is_overload(&JsonRpcError::<()>::ServerError(
            JsonRpcServerError::HandlerError(())
        )));
    }

    fn reqwest_status(code: u16) -> axum::http::StatusCode {
        axum::http::StatusCode::from_u16(code).unwrap()
    }
}
