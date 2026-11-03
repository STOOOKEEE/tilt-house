//! Tilt House: a casino where each NPC dealer is a liquidity pool.
//!
//! Players keep a tUSDC balance in the contract and play dice, roulette and blackjack against a
//! dealer's pool; LPs own the pools through NEP-245 shares (token id = dealer id). Every rule
//! (payouts, rake, pool prices, dealer pricing) comes from `core_rules`; this crate only holds the
//! money, the rounds and the randomness (OutLayer VRF). API: `docs/contract-api.md`.
//!
//! Times are seconds (block time). Amounts are token base units (`u128`, decimal strings in JSON).

mod dealers;
mod ft;
mod mt;
mod rounds;
mod views;
mod vrf;

#[cfg(test)]
mod tests;

use near_sdk::serde_json::{self, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

pub use dealers::{Dealer, LogEntry, LogKind};
pub use rounds::{Proof, Round, Status};

/// Smallest stake a table takes: 0.10 tUSDC.
pub const MIN_BET: u128 = 100_000;
/// `core_rules::rake_bounds` keeps every bet's edge under 5 % only from 0.01 USDC up (integer
/// rounding); the table minimum must never go below it.
const CORE_MIN_STAKE: u128 = 10_000;
const _: () = assert!(MIN_BET >= CORE_MIN_STAKE);

/// A round still waiting for its VRF answer after this long can be refunded.
pub const REFUND_AFTER_SECS: u64 = 120;
/// A blackjack hand left in the player's turn this long can be stood by anyone, so an abandoned
/// hand cannot lock the pool's reserve forever.
pub const ABANDON_AFTER_SECS: u64 = 600;
/// Rounds kept per player; older ones are deleted (the contract pays storage).
pub const ROUNDS_PER_PLAYER: usize = 50;
/// Log entries kept per dealer (a ring).
pub const HISTORY_PER_DEALER: u64 = 100;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Players,
    Dealers,
    Shares,
    Rounds,
    History,
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Player {
    pub balance: u128,
    /// The round not yet settled or refunded (one at a time).
    pub open_round: Option<u64>,
    /// Last `ROUNDS_PER_PLAYER` round ids, oldest first.
    pub rounds: Vec<u64>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct House {
    owner: AccountId,
    token: AccountId,
    outlayer: AccountId,
    vrf_pubkey: [u8; 32],
    /// OutLayer `source` JSON (pinned project version).
    vrf_source: String,
    players: LookupMap<AccountId, Player>,
    dealer_ids: Vec<String>,
    dealers: LookupMap<String, Dealer>,
    shares: LookupMap<(String, AccountId), u128>,
    rounds: LookupMap<u64, Round>,
    /// Key: (dealer id, seq % HISTORY_PER_DEALER).
    history: LookupMap<(String, u64), LogEntry>,
    next_round_id: u64,
}

/// Block time in seconds.
pub(crate) fn now() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

pub(crate) fn fail(message: &str) -> ! {
    env::panic_str(message)
}

#[near]
impl House {
    #[init]
    pub fn new(
        owner: AccountId,
        token: AccountId,
        outlayer: AccountId,
        vrf_pubkey_hex: String,
        vrf_source: Value,
    ) -> Self {
        Self {
            owner,
            token,
            outlayer,
            vrf_pubkey: parse_pubkey(&vrf_pubkey_hex),
            vrf_source: checked_source(&vrf_source),
            players: LookupMap::new(StorageKey::Players),
            dealer_ids: Vec::new(),
            dealers: LookupMap::new(StorageKey::Dealers),
            shares: LookupMap::new(StorageKey::Shares),
            rounds: LookupMap::new(StorageKey::Rounds),
            history: LookupMap::new(StorageKey::History),
            next_round_id: 1,
        }
    }

    /// OutLayer may rotate its VRF key (rare).
    pub fn set_vrf_pubkey(&mut self, vrf_pubkey_hex: String) {
        self.assert_owner();
        self.vrf_pubkey = parse_pubkey(&vrf_pubkey_hex);
    }

    /// Points rounds at another pinned VRF version.
    pub fn set_vrf_source(&mut self, vrf_source: Value) {
        self.assert_owner();
        self.vrf_source = checked_source(&vrf_source);
    }
}

impl House {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner can do this"
        );
    }

    pub(crate) fn player(&self, account: &AccountId) -> Player {
        self.players.get(account).cloned().unwrap_or_default()
    }

    pub(crate) fn save_player(&mut self, account: &AccountId, player: Player) {
        self.players.insert(account.clone(), player);
    }

    pub(crate) fn credit(&mut self, account: &AccountId, amount: u128) {
        let mut player = self.player(account);
        player.balance = player
            .balance
            .checked_add(amount)
            .unwrap_or_else(|| fail("balance overflow"));
        self.save_player(account, player);
    }

    pub(crate) fn debit(&mut self, account: &AccountId, amount: u128) {
        let mut player = self.player(account);
        require!(player.balance >= amount, "not enough balance");
        player.balance -= amount;
        self.save_player(account, player);
    }

    pub(crate) fn shares_of(&self, dealer_id: &str, account: &AccountId) -> u128 {
        self.shares
            .get(&(dealer_id.to_string(), account.clone()))
            .copied()
            .unwrap_or(0)
    }

    /// Zero balances are removed so storage only holds real positions.
    pub(crate) fn set_shares(&mut self, dealer_id: &str, account: &AccountId, shares: u128) {
        let key = (dealer_id.to_string(), account.clone());
        if shares == 0 {
            self.shares.remove(&key);
        } else {
            self.shares.insert(key, shares);
        }
    }
}

fn parse_pubkey(hex_key: &str) -> [u8; 32] {
    vrf::decode_hex::<32>(hex_key).unwrap_or_else(|e| fail(&format!("vrf_pubkey_hex: {e}")))
}

fn checked_source(source: &Value) -> String {
    require!(
        source.is_object(),
        "vrf_source must be an OutLayer source object"
    );
    serde_json::to_string(source).unwrap_or_else(|_| fail("vrf_source"))
}
