//! `Chain` over NEAR JSON-RPC: views on the house contract and function-call transactions signed
//! with the server key. `get_session`, `settle_session` and `close_session` are the contract's
//! session methods (docs/sessions.md); until they are deployed these calls fail and the server
//! fails closed (no rounds before a confirmed open, settles retried).

use anyhow::{anyhow, bail, Context};
use core_rules::session::{Hash32, SettleBatch};
use core_rules::Game;
use near_crypto::{InMemorySigner, SecretKey, Signer as NearSigner};
use near_jsonrpc_client::{methods, JsonRpcClient};
use near_jsonrpc_primitives::types::query::QueryResponseKind;
use near_primitives::gas::Gas;
use near_primitives::transaction::{Action, FunctionCallAction, Transaction, TransactionV0};
use near_primitives::types::{AccountId, Balance, BlockReference, Finality, FunctionArgs};
use near_primitives::views::{FinalExecutionStatus, QueryRequest, TxExecutionStatus};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Mutex;

use crate::chain::{Chain, CloseArgs, DealerInfo};

/// Settling 50 rounds hashes and stores them all: give it the per-tx maximum.
const CALL_TGAS: u64 = 300;

pub struct NearChain {
    client: JsonRpcClient,
    house: AccountId,
    signer: NearSigner,
    /// Transactions from one key must use increasing nonces: send them one at a time.
    last_nonce: Mutex<u64>,
}

/// The fields of the contract's `DealerView` (`get_lobby`) the server needs.
#[derive(Deserialize)]
struct LobbyDealer {
    id: String,
    game: Game,
    rake_bp: u16,
    #[serde(with = "core_rules::amount_str")]
    max_bet: u128,
    #[serde(with = "core_rules::amount_str")]
    bankroll: u128,
    #[serde(with = "core_rules::amount_str")]
    reserved: u128,
    open: bool,
}

impl NearChain {
    pub fn new(
        rpc_url: &str,
        house: &str,
        account: &str,
        secret_key: &str,
    ) -> anyhow::Result<Self> {
        let account: AccountId = account.parse().context("SESSION_SERVER_ACCOUNT")?;
        let key: SecretKey = secret_key.parse().context("SESSION_SERVER_PRIVATE_KEY")?;
        Ok(Self {
            client: JsonRpcClient::connect(rpc_url),
            house: house.parse().context("HOUSE_CONTRACT")?,
            signer: InMemorySigner::from_secret_key(account, key),
            last_nonce: Mutex::new(0),
        })
    }

    async fn view<T: DeserializeOwned>(
        &self,
        method: &str,
        args: serde_json::Value,
    ) -> anyhow::Result<T> {
        let response = self
            .client
            .call(methods::query::RpcQueryRequest {
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
            QueryResponseKind::CallResult(result) => {
                serde_json::from_slice(&result.result).with_context(|| format!("decode {method}"))
            }
            _ => bail!("view {method}: unexpected response"),
        }
    }

    async fn call(&self, method: &str, args: Vec<u8>) -> anyhow::Result<()> {
        let mut last_nonce = self.last_nonce.lock().await;
        let access_key = self
            .client
            .call(methods::query::RpcQueryRequest {
                block_reference: BlockReference::Finality(Finality::Final),
                request: QueryRequest::ViewAccessKey {
                    account_id: self.signer.get_account_id(),
                    public_key: self.signer.public_key(),
                },
            })
            .await
            .context("view access key")?;
        let QueryResponseKind::AccessKey(key_view) = access_key.kind else {
            bail!("view access key: unexpected response");
        };
        let nonce = key_view.nonce.max(*last_nonce) + 1;
        let transaction = Transaction::V0(TransactionV0 {
            signer_id: self.signer.get_account_id(),
            public_key: self.signer.public_key(),
            nonce,
            receiver_id: self.house.clone(),
            block_hash: access_key.block_hash,
            actions: vec![Action::FunctionCall(Box::new(FunctionCallAction {
                method_name: method.to_string(),
                args,
                gas: Gas::from_teragas(CALL_TGAS),
                deposit: Balance::ZERO,
            }))],
        });
        *last_nonce = nonce;
        let response = self
            .client
            .call(methods::send_tx::RpcSendTransactionRequest {
                signed_transaction: transaction.sign(&self.signer),
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
}

impl Chain for NearChain {
    async fn dealer(&self, dealer_id: &str) -> anyhow::Result<Option<DealerInfo>> {
        let lobby: Vec<LobbyDealer> = self.view("get_lobby", json!({})).await?;
        Ok(lobby
            .into_iter()
            .find(|dealer| dealer.id == dealer_id)
            .map(|dealer| DealerInfo {
                game: dealer.game,
                rake_bp: dealer.rake_bp,
                max_bet: dealer.max_bet,
                pool_free: dealer.bankroll.saturating_sub(dealer.reserved),
                open: dealer.open,
            }))
    }

    async fn session_opened(&self, session_id: &str) -> anyhow::Result<bool> {
        let session: Option<serde_json::Value> = self
            .view("get_session", json!({ "session_id": session_id }))
            .await?;
        Ok(session.is_some())
    }

    async fn settle(&self, batch: &SettleBatch) -> anyhow::Result<()> {
        let args = json!({ "batch": batch });
        self.call("settle_session", serde_json::to_vec(&args)?)
            .await
    }

    async fn close(&self, session_id: &str, server_seed: &Hash32) -> anyhow::Result<()> {
        let args = CloseArgs {
            session_id,
            server_seed: *server_seed,
        };
        self.call("close_session", serde_json::to_vec(&args)?).await
    }
}
