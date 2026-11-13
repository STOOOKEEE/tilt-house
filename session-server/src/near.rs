//! `Chain` over NEAR JSON-RPC: views on the house contract and function-call transactions signed
//! with the server key (settle, close) or a gambler's key (open). `get_session`, `open_session`,
//! `settle_session` and `close_session` are the contract's session methods (docs/sessions.md);
//! until they are deployed these calls fail and the server fails closed (no rounds before a
//! confirmed open, settles retried).
//!
//! The floor-wide views (`get_lobby`, `get_floor`) are cached for `VIEW_TTL`, one request in
//! flight per view (the gamblers, the poker tables and every new ticket read them); per-player
//! views (`get_player`, `get_session`) always go to the chain. Requests go through `Rpc`
//! (failover and backoff on rate limits, 5xx and timeouts; transactions resent as signed).

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use core_rules::session::{hex64, Hash32, SessionTicket, SettleBatch};
use core_rules::Game;
use near_crypto::{InMemorySigner, SecretKey, Signer as NearSigner};
use near_jsonrpc_client::methods;
use near_jsonrpc_primitives::types::query::QueryResponseKind;
use near_primitives::gas::Gas;
use near_primitives::transaction::{Action, FunctionCallAction, Transaction, TransactionV0};
use near_primitives::types::{AccountId, Balance, BlockReference, Finality, FunctionArgs};
use near_primitives::views::{FinalExecutionStatus, QueryRequest, TxExecutionStatus};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::chain::{Chain, ChainSession, CloseArgs, DealerInfo, FloorInfo, FloorTable};
use crate::rpc::{Rpc, RpcStats};

/// Settling 50 rounds hashes and stores them all: give it the per-tx maximum. The rest needs far
/// less, and the signer must hold the full prepaid cost (an NPC gambler's wallet is 0.3 NEAR).
const SETTLE_TGAS: u64 = 300;
const CALL_TGAS: u64 = 100;
/// How long a floor-wide view is reused. A ticket priced on a lobby this old is still checked by
/// the contract at `open_session` (and keeps 20% pool headroom), so staleness fails closed.
pub const VIEW_TTL: Duration = Duration::from_secs(5);

/// One cached view: the raw result and when it was read. Its lock is held while it is fetched,
/// so concurrent readers wait for that one request instead of sending their own.
type CachedView = Arc<Mutex<Option<(Instant, Arc<Vec<u8>>)>>>;

pub struct NearChain {
    rpc: Rpc,
    view_ttl: Duration,
    views: std::sync::Mutex<HashMap<&'static str, CachedView>>,
    house: AccountId,
    signer: NearSigner,
    /// Transactions from one key must use increasing nonces: each account sends one at a time.
    last_nonces: std::sync::Mutex<HashMap<AccountId, Arc<Mutex<u64>>>>,
}

/// The fields of the contract's `DealerView` (`get_lobby`) the server needs.
#[derive(Deserialize)]
struct LobbyDealer {
    id: String,
    name: String,
    game: Game,
    rake_bp: u16,
    total_edge_bp: u16,
    boost_until: u64,
    #[serde(with = "core_rules::amount_str")]
    max_bet: u128,
    #[serde(with = "core_rules::amount_str")]
    bankroll: u128,
    #[serde(with = "core_rules::amount_str")]
    reserved: u128,
    open: bool,
    /// 1-based seat number in the contract views.
    seat: Option<usize>,
}

#[derive(Deserialize)]
struct FloorJackpot {
    #[serde(with = "core_rules::amount_str")]
    jackpot: u128,
}

#[derive(Deserialize)]
struct PlayerBalance {
    #[serde(with = "core_rules::amount_str")]
    balance: u128,
}

/// The fields of the contract's `SessionView` (`get_session`) reconciliation needs.
#[derive(Deserialize)]
struct SessionProgress {
    settled_nonce: u64,
    server_seed: Option<String>,
}

#[derive(Serialize)]
struct OpenArgs<'a> {
    ticket: &'a SessionTicket,
    #[serde(with = "hex64")]
    server_sig: [u8; 64],
}

impl NearChain {
    /// `rpc_urls`: preferred first. `view_ttl`: `VIEW_TTL`, or zero to read through.
    pub fn new(
        rpc_urls: &[String],
        view_ttl: Duration,
        house: &str,
        account: &str,
        secret_key: &str,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            rpc: Rpc::new(rpc_urls)?,
            view_ttl,
            views: std::sync::Mutex::new(HashMap::new()),
            house: house.parse().context("HOUSE_CONTRACT")?,
            signer: signer(account, secret_key).context("session server key")?,
            last_nonces: std::sync::Mutex::new(HashMap::new()),
        })
    }

    pub fn rpc_stats(&self) -> Arc<RpcStats> {
        self.rpc.stats()
    }

    async fn view_bytes(&self, method: &str, args: serde_json::Value) -> anyhow::Result<Vec<u8>> {
        let response = self
            .rpc
            .call(&methods::query::RpcQueryRequest {
                block_reference: BlockReference::Finality(Finality::Final),
                request: QueryRequest::CallFunction {
                    account_id: self.house.clone(),
                    method_name: method.to_string(),
                    args: FunctionArgs::from(args.to_string().into_bytes()),
                },
            })
            .await
            .with_context(|| format!("view {method}"))?;
        match response.kind {
            QueryResponseKind::CallResult(result) => Ok(result.result),
            _ => bail!("view {method}: unexpected response"),
        }
    }

    async fn view<T: DeserializeOwned>(
        &self,
        method: &str,
        args: serde_json::Value,
    ) -> anyhow::Result<T> {
        let bytes = self.view_bytes(method, args).await?;
        serde_json::from_slice(&bytes).with_context(|| format!("decode {method}"))
    }

    /// A floor-wide view without arguments, reused for `view_ttl` (errors are not cached).
    async fn cached_view<T: DeserializeOwned>(&self, method: &'static str) -> anyhow::Result<T> {
        let entry = {
            let mut views = self
                .views
                .lock()
                .map_err(|_| anyhow!("view cache lock poisoned"))?;
            Arc::clone(views.entry(method).or_default())
        };
        let mut cached = entry.lock().await;
        let bytes = match cached.as_ref() {
            Some((read_at, bytes)) if read_at.elapsed() < self.view_ttl => {
                self.rpc.stats().cache_hits.fetch_add(1, Ordering::Relaxed);
                Arc::clone(bytes)
            }
            _ => {
                let bytes = Arc::new(self.view_bytes(method, json!({})).await?);
                *cached = Some((Instant::now(), Arc::clone(&bytes)));
                bytes
            }
        };
        drop(cached);
        serde_json::from_slice(&bytes).with_context(|| format!("decode {method}"))
    }

    fn nonce_lock(&self, account: &AccountId) -> anyhow::Result<Arc<Mutex<u64>>> {
        let mut locks = self
            .last_nonces
            .lock()
            .map_err(|_| anyhow!("nonce map lock poisoned"))?;
        Ok(Arc::clone(locks.entry(account.clone()).or_default()))
    }

    async fn call(&self, signer: &NearSigner, method: &str, args: Vec<u8>) -> anyhow::Result<()> {
        let lock = self.nonce_lock(&signer.get_account_id())?;
        let mut last_nonce = lock.lock().await;
        let access_key = self
            .rpc
            .call(&methods::query::RpcQueryRequest {
                block_reference: BlockReference::Finality(Finality::Final),
                request: QueryRequest::ViewAccessKey {
                    account_id: signer.get_account_id(),
                    public_key: signer.public_key(),
                },
            })
            .await
            .context("view access key")?;
        let QueryResponseKind::AccessKey(key_view) = access_key.kind else {
            bail!("view access key: unexpected response");
        };
        let nonce = key_view.nonce.max(*last_nonce) + 1;
        let transaction = Transaction::V0(TransactionV0 {
            signer_id: signer.get_account_id(),
            public_key: signer.public_key(),
            nonce,
            receiver_id: self.house.clone(),
            block_hash: access_key.block_hash,
            actions: vec![Action::FunctionCall(Box::new(FunctionCallAction {
                method_name: method.to_string(),
                args,
                gas: Gas::from_teragas(if method == "settle_session" {
                    SETTLE_TGAS
                } else {
                    CALL_TGAS
                }),
                deposit: Balance::ZERO,
            }))],
        });
        *last_nonce = nonce;
        let response = self
            .rpc
            .send_tx(&methods::send_tx::RpcSendTransactionRequest {
                signed_transaction: transaction.sign(signer),
                wait_until: TxExecutionStatus::Final,
            })
            .await
            .with_context(|| format!("send {method}"))?;
        let outcome = response
            .final_execution_outcome
            .ok_or_else(|| anyhow!("{method}: no execution outcome"))?
            .into_outcome();
        match outcome.status {
            FinalExecutionStatus::SuccessValue(_) => Ok(()),
            FinalExecutionStatus::Failure(err) => bail!("{method} failed: {err}"),
            other => bail!("{method} not finished: {other:?}"),
        }
    }

    async fn lobby(&self) -> anyhow::Result<Vec<LobbyDealer>> {
        self.cached_view("get_lobby").await
    }
}

fn signer(account: &str, secret_key: &str) -> anyhow::Result<NearSigner> {
    let account: AccountId = account.parse().context("account id")?;
    let key: SecretKey = secret_key.parse().context("secret key")?;
    Ok(InMemorySigner::from_secret_key(account, key))
}

impl Chain for NearChain {
    async fn dealer(&self, dealer_id: &str) -> anyhow::Result<Option<DealerInfo>> {
        Ok(self
            .lobby()
            .await?
            .into_iter()
            .find(|dealer| dealer.id == dealer_id)
            .map(|dealer| DealerInfo {
                game: dealer.game,
                rake_bp: dealer.rake_bp,
                max_bet: dealer.max_bet,
                pool_free: dealer.bankroll.saturating_sub(dealer.reserved),
                // open_session refuses a dealer off the floor: no ticket for it either.
                open: dealer.open && dealer.seat.is_some(),
            }))
    }

    async fn floor(&self) -> anyhow::Result<FloorInfo> {
        let lobby = self.lobby().await?;
        let floor: FloorJackpot = self.cached_view("get_floor").await?;
        let tables = lobby
            .into_iter()
            .map(|dealer| FloorTable {
                seat: dealer.seat.and_then(|n| n.checked_sub(1)),
                dealer_id: dealer.id,
                name: dealer.name,
                game: dealer.game,
                edge_bp: dealer.total_edge_bp,
                boost_until: dealer.boost_until,
                max_bet: dealer.max_bet,
                open: dealer.open,
            })
            .collect();
        Ok(FloorInfo {
            tables,
            jackpot: floor.jackpot,
        })
    }

    async fn balance(&self, account: &str) -> anyhow::Result<u128> {
        let player: PlayerBalance = self
            .view("get_player", json!({ "account_id": account }))
            .await?;
        Ok(player.balance)
    }

    async fn open_session(
        &self,
        player: &str,
        secret_key: Option<&str>,
        ticket: &SessionTicket,
        server_sig: &[u8; 64],
    ) -> anyhow::Result<()> {
        let key = secret_key.ok_or_else(|| anyhow!("no key for {player}"))?;
        let signer = signer(player, key).with_context(|| format!("key of {player}"))?;
        let args = OpenArgs {
            ticket,
            server_sig: *server_sig,
        };
        self.call(&signer, "open_session", serde_json::to_vec(&args)?)
            .await
    }

    async fn session(&self, session_id: &str) -> anyhow::Result<Option<ChainSession>> {
        let session: Option<SessionProgress> = self
            .view("get_session", json!({ "session_id": session_id }))
            .await?;
        Ok(session.map(|s| ChainSession {
            settled_nonce: s.settled_nonce,
            revealed: s.server_seed.is_some(),
        }))
    }

    async fn settle(&self, batch: &SettleBatch) -> anyhow::Result<()> {
        let args = json!({ "batch": batch });
        self.call(&self.signer, "settle_session", serde_json::to_vec(&args)?)
            .await
    }

    async fn close(&self, session_id: &str, server_seed: &Hash32) -> anyhow::Result<()> {
        let args = CloseArgs {
            session_id,
            server_seed: *server_seed,
        };
        self.call(&self.signer, "close_session", serde_json::to_vec(&args)?)
            .await
    }
}
