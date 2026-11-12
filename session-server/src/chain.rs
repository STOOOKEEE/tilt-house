//! What the server needs from the contract. `NearChain` (near.rs) calls the house contract;
//! `NoChain` runs without it (`--no-chain`): a fixed demo floor, every session counts as opened,
//! gamblers' balances and escrows kept in memory, and settle/close payloads only printed.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;

use anyhow::{anyhow, ensure};
use core_rules::session::{hex32, Hash32, SessionTicket, SettleBatch};
use core_rules::{base_edge_bp, Game};
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

/// A dealer as the gamblers see the floor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FloorTable {
    pub dealer_id: String,
    pub name: String,
    pub game: Game,
    /// 0-based seat, `None` off the floor.
    pub seat: Option<usize>,
    /// Total edge in force (game edge + rake, boost included).
    pub edge_bp: u16,
    /// Unix seconds; boosting while in the future.
    pub boost_until: u64,
    pub max_bet: u128,
    pub open: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FloorInfo {
    /// Every dealer, seated or not.
    pub tables: Vec<FloorTable>,
    pub jackpot: u128,
}

pub trait Chain: Send + Sync + 'static {
    /// `None` when no such dealer exists.
    fn dealer(
        &self,
        dealer_id: &str,
    ) -> impl Future<Output = anyhow::Result<Option<DealerInfo>>> + Send;

    fn floor(&self) -> impl Future<Output = anyhow::Result<FloorInfo>> + Send;

    /// A player's in-contract balance.
    fn balance(&self, account: &str) -> impl Future<Output = anyhow::Result<u128>> + Send;

    /// `open_session({ticket, server_sig})` signed by the player (`secret_key`: its NEAR key).
    fn open_session(
        &self,
        player: &str,
        secret_key: Option<&str>,
        ticket: &SessionTicket,
        server_sig: &[u8; 64],
    ) -> impl Future<Output = anyhow::Result<()>> + Send;

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
/// What every gambler holds at start in `--no-chain` mode (no salary there: that is the keeper's).
pub const DEMO_GAMBLER_BALANCE: u128 = 100_000_000;

/// The demo floor: id, name, game, seat, rake, boosting. Rakes within `rake_bounds`.
const DEMO_TABLES: [(&str, &str, Game, usize, u16, bool); 6] = [
    ("dice-demo", "Ada", Game::Dice, 0, 100, false),
    ("roulette-demo", "Bruno", Game::Roulette, 1, 120, false),
    ("blackjack-demo", "Cleo", Game::Blackjack, 2, 150, false),
    ("dice-pricey", "Dario", Game::Dice, 3, 300, false),
    ("roulette-boost", "Elsa", Game::Roulette, 4, 0, true),
    ("poker-demo", "Faye", Game::Poker, 5, 250, false),
];

#[derive(Default)]
pub struct NoChain {
    ledger: Mutex<Ledger>,
}

#[derive(Default)]
struct Ledger {
    balances: HashMap<String, u128>,
    /// Session id → (player, session balance at the last settle).
    escrows: HashMap<String, (String, u128)>,
}

impl Ledger {
    fn balance(&self, account: &str) -> u128 {
        self.balances
            .get(account)
            .copied()
            .unwrap_or(DEMO_GAMBLER_BALANCE)
    }
}

impl NoChain {
    fn ledger(&self) -> anyhow::Result<std::sync::MutexGuard<'_, Ledger>> {
        self.ledger
            .lock()
            .map_err(|_| anyhow!("no-chain ledger lock poisoned"))
    }
}

impl Chain for NoChain {
    async fn dealer(&self, dealer_id: &str) -> anyhow::Result<Option<DealerInfo>> {
        Ok(DEMO_TABLES.iter().find(|table| table.0 == dealer_id).map(
            |&(_, _, game, _, rake_bp, _)| DealerInfo {
                game,
                rake_bp,
                max_bet: DEMO_MAX_BET,
                pool_free: DEMO_POOL_FREE,
                open: true,
            },
        ))
    }

    async fn floor(&self) -> anyhow::Result<FloorInfo> {
        let tables = DEMO_TABLES
            .iter()
            .map(|&(id, name, game, seat, rake_bp, boosting)| FloorTable {
                dealer_id: id.to_string(),
                name: name.to_string(),
                game,
                seat: Some(seat),
                edge_bp: base_edge_bp(game) + rake_bp,
                boost_until: if boosting { u64::MAX } else { 0 },
                max_bet: DEMO_MAX_BET,
                open: true,
            })
            .collect();
        Ok(FloorInfo { tables, jackpot: 0 })
    }

    async fn balance(&self, account: &str) -> anyhow::Result<u128> {
        Ok(self.ledger()?.balance(account))
    }

    async fn open_session(
        &self,
        player: &str,
        _secret_key: Option<&str>,
        ticket: &SessionTicket,
        _server_sig: &[u8; 64],
    ) -> anyhow::Result<()> {
        let mut ledger = self.ledger()?;
        let balance = ledger.balance(player);
        ensure!(balance >= ticket.lock, "not enough balance for the lock");
        ledger
            .balances
            .insert(player.to_string(), balance - ticket.lock);
        ledger
            .escrows
            .insert(ticket.session_id.clone(), (player.to_string(), ticket.lock));
        Ok(())
    }

    async fn session_opened(&self, _session_id: &str) -> anyhow::Result<bool> {
        Ok(true)
    }

    async fn settle(&self, batch: &SettleBatch) -> anyhow::Result<()> {
        if let Some(escrow) = self.ledger()?.escrows.get_mut(&batch.session_id) {
            escrow.1 = batch.balance;
        }
        let args = serde_json::json!({ "batch": batch });
        println!("no-chain settle_session {args}");
        Ok(())
    }

    async fn close(&self, session_id: &str, server_seed: &Hash32) -> anyhow::Result<()> {
        {
            let mut ledger = self.ledger()?;
            if let Some((player, balance)) = ledger.escrows.remove(session_id) {
                let paid = ledger.balance(&player).saturating_add(balance);
                ledger.balances.insert(player, paid);
            }
        }
        let args = CloseArgs {
            session_id,
            server_seed: *server_seed,
        };
        println!("no-chain close_session {}", serde_json::to_string(&args)?);
        Ok(())
    }
}
