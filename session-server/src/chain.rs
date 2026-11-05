//! What the server needs from the contract. `NearChain` (near.rs) calls the house contract;
//! `NoChain` runs without it (`--no-chain`): demo dealers, every session counts as opened, and
//! settle/close payloads are only printed.

use std::future::Future;

use core_rules::session::{hex32, Hash32, SettleBatch};
use core_rules::Game;
use serde::Serialize;

/// A dealer's live offer, read when a session starts and frozen into its ticket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DealerInfo {
    pub game: Game,
    /// Effective rake now (boost included).
    pub rake_bp: u16,
    /// Biggest stake the table takes now.
    pub max_bet: u128,
    pub pool_free: u128,
    pub open: bool,
}

pub trait Chain: Send + Sync + 'static {
    /// `None` when no such dealer exists.
    fn dealer(
        &self,
        dealer_id: &str,
    ) -> impl Future<Output = anyhow::Result<Option<DealerInfo>>> + Send;

    /// Whether `open_session` for this id has executed (lock escrowed, max win reserved).
    fn session_opened(&self, session_id: &str)
        -> impl Future<Output = anyhow::Result<bool>> + Send;

    /// `settle_session({"batch": ...})`.
    fn settle(&self, batch: &SettleBatch) -> impl Future<Output = anyhow::Result<()>> + Send;

    /// `close_session(session_id, server_seed)`: reveals the seed.
    fn close(
        &self,
        session_id: &str,
        server_seed: &Hash32,
    ) -> impl Future<Output = anyhow::Result<()>> + Send;
}

/// Args of `close_session`.
#[derive(Serialize)]
pub struct CloseArgs<'a> {
    pub session_id: &'a str,
    #[serde(with = "hex32")]
    pub server_seed: Hash32,
}

const DEMO_MAX_BET: u128 = 100_000_000;
const DEMO_POOL_FREE: u128 = 100_000_000_000;
const DEMO_RAKE_BP: u16 = 100;

pub struct NoChain;

impl NoChain {
    fn demo_game(dealer_id: &str) -> Option<Game> {
        match dealer_id {
            "dice-demo" => Some(Game::Dice),
            "roulette-demo" => Some(Game::Roulette),
            "blackjack-demo" => Some(Game::Blackjack),
            _ => None,
        }
    }
}

impl Chain for NoChain {
    async fn dealer(&self, dealer_id: &str) -> anyhow::Result<Option<DealerInfo>> {
        Ok(Self::demo_game(dealer_id).map(|game| DealerInfo {
            game,
            rake_bp: DEMO_RAKE_BP,
            max_bet: DEMO_MAX_BET,
            pool_free: DEMO_POOL_FREE,
            open: true,
        }))
    }

    async fn session_opened(&self, _session_id: &str) -> anyhow::Result<bool> {
        Ok(true)
    }

    async fn settle(&self, batch: &SettleBatch) -> anyhow::Result<()> {
        let args = serde_json::json!({ "batch": batch });
        println!("no-chain settle_session {args}");
        Ok(())
    }

    async fn close(&self, session_id: &str, server_seed: &Hash32) -> anyhow::Result<()> {
        let args = CloseArgs {
            session_id,
            server_seed: *server_seed,
        };
        println!("no-chain close_session {}", serde_json::to_string(&args)?);
        Ok(())
    }
}
