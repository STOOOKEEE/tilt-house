//! Tilt House v4: the casino floor (docs/floor.md, docs/sessions.md, docs/tycoon.md).
//!
//! Players keep a tUSDC balance in the contract. Each dealer is a table (one game) backed by an
//! LP pool (NEP-245 shares, token id = dealer id), run by an NPC or by the player who opened it.
//! Dealers rent one of the floor's seats (lease token `seat-<n>`); rent fills the jackpot. Play
//! happens in provably fair sessions: the session server plays the rounds off chain and settles
//! them here in signed batches. Every rule comes from `core_rules`; this crate holds the money,
//! checks the signatures and keeps the books. API: `docs/contract-api.md`.
//!
//! Times are seconds (block time). Amounts are token base units (`u128`, decimal strings in JSON).

mod days;
mod dealers;
mod floor;
mod ft;
mod mt;
mod npcs;
mod sessions;
mod views;

use near_sdk::borsh::BorshDeserialize;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{Lazy, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

pub use dealers::{Dealer, LogEntry, LogKind};
pub use sessions::{Session, SessionStatus};

/// Smallest stake a table takes: 0.10 tUSDC (core's `SESSION_MIN_BET`).
pub const MIN_BET: u128 = core_rules::session::SESSION_MIN_BET;
/// Log entries kept per dealer (a ring).
pub const HISTORY_PER_DEALER: u64 = 100;
/// Session ids kept per player; older finished sessions are deleted (the contract pays storage).
pub const SESSIONS_PER_PLAYER: usize = 20;
/// Retired tables kept (`retire_table`); bounds the storage a cycle of open/retire can take.
pub const MAX_RETIRED_TABLES: usize = 64;

const EVENT_STANDARD: &str = "tilthouse";
const EVENT_VERSION: &str = "2.0.0";

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Players,
    Dealers,
    Shares,
    History,
    Sessions,
    Floor,
    /// v4. Day books (`days.rs`), keyed by UTC day.
    Days,
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Player {
    pub balance: u128,
    /// The session still in status `open` (one at a time).
    pub open_session: Option<String>,
    /// Last `SESSIONS_PER_PLAYER` session ids, oldest first.
    pub sessions: Vec<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct House {
    owner: AccountId,
    token: AccountId,
    /// Runs `reprice` / `rent_bid` for dealers whose controller is not online (autopilot).
    keeper: AccountId,
    /// The session server's ed25519 public key: signs tickets and session states.
    server_pubkey: [u8; 32],
    players: LookupMap<AccountId, Player>,
    dealer_ids: Vec<String>,
    dealers: LookupMap<String, Dealer>,
    shares: LookupMap<(String, AccountId), u128>,
    /// Key: (dealer id, seq % HISTORY_PER_DEALER).
    history: LookupMap<(String, u64), LogEntry>,
    floor: Lazy<core_rules::Floor>,
    sessions: LookupMap<String, Session>,
    /// v3. Registered NPC gamblers (`npcs.rs`): they may only play sessions.
    npcs: Vec<AccountId>,
    /// v3. Retired tables, oldest first: out of the lobby and of the `MAX_DEALERS` count.
    retired_ids: Vec<String>,
    /// v4. The $TILT contract (`set_meme`, once): receives `report_day`, may `start_tilt_hour`.
    meme: Option<AccountId>,
    /// v4. Until this time (seconds) every table plays at its game's minimum rake.
    tilt_hour_until: u64,
    /// v4. Day books (`days.rs`): at most `DAYS_KEPT`, their days in `day_keys` (ascending).
    days: LookupMap<u64, days::DayBook>,
    day_keys: Vec<u64>,
    /// v4. A day from here on with no book had no human play: it may close empty. Earlier days
    /// without a book are unknown (before the upgrade, or dropped) and refused.
    days_known_from: u64,
}

/// The v3 root state (deployed on testnet before v4), read once by `migrate`.
#[derive(BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
struct HouseV3 {
    owner: AccountId,
    token: AccountId,
    keeper: AccountId,
    server_pubkey: [u8; 32],
    players: LookupMap<AccountId, Player>,
    dealer_ids: Vec<String>,
    dealers: LookupMap<String, Dealer>,
    shares: LookupMap<(String, AccountId), u128>,
    history: LookupMap<(String, u64), LogEntry>,
    floor: Lazy<core_rules::Floor>,
    sessions: LookupMap<String, Session>,
    npcs: Vec<AccountId>,
    retired_ids: Vec<String>,
}

/// Block time in seconds.
pub(crate) fn now() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

pub(crate) fn fail(message: &str) -> ! {
    env::panic_str(message)
}

/// NEP-297 event of this contract.
pub(crate) fn emit(event: &str, data: Value) {
    let log = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": data,
    });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

pub(crate) fn parse_hex<const N: usize>(text: &str, what: &str) -> [u8; N] {
    let mut out = [0u8; N];
    hex::decode_to_slice(text, &mut out)
        .unwrap_or_else(|_| fail(&format!("{what}: expected {} hex characters", N * 2)));
    out
}

#[near]
impl House {
    #[init]
    pub fn new(
        owner: AccountId,
        token: AccountId,
        keeper: AccountId,
        server_pubkey_hex: String,
    ) -> Self {
        Self {
            owner,
            token,
            keeper,
            server_pubkey: parse_hex(&server_pubkey_hex, "server_pubkey_hex"),
            players: LookupMap::new(StorageKey::Players),
            dealer_ids: Vec::new(),
            dealers: LookupMap::new(StorageKey::Dealers),
            shares: LookupMap::new(StorageKey::Shares),
            history: LookupMap::new(StorageKey::History),
            floor: Lazy::new(StorageKey::Floor, core_rules::Floor::default()),
            sessions: LookupMap::new(StorageKey::Sessions),
            npcs: Vec::new(),
            retired_ids: Vec::new(),
            meme: None,
            tilt_hour_until: 0,
            days: LookupMap::new(StorageKey::Days),
            day_keys: Vec::new(),
            days_known_from: days::today(),
        }
    }

    /// Upgrade from v3: deploy the v4 code with this as the init call (signed by the contract
    /// account). Only the root state changes; every collection keeps its storage prefix. Day
    /// accounting starts with the upgrade day (counted from the upgrade on). A v4 state does
    /// not read as v3, so a second call fails.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: HouseV3 = env::state_read().unwrap_or_else(|| fail("no state to migrate"));
        Self {
            owner: old.owner,
            token: old.token,
            keeper: old.keeper,
            server_pubkey: old.server_pubkey,
            players: old.players,
            dealer_ids: old.dealer_ids,
            dealers: old.dealers,
            shares: old.shares,
            history: old.history,
            floor: old.floor,
            sessions: old.sessions,
            npcs: old.npcs,
            retired_ids: old.retired_ids,
            meme: None,
            tilt_hour_until: 0,
            days: LookupMap::new(StorageKey::Days),
            day_keys: Vec::new(),
            days_known_from: days::today(),
        }
    }

    /// The session server rotated its key.
    pub fn set_server_pubkey(&mut self, server_pubkey_hex: String) {
        self.assert_owner();
        self.server_pubkey = parse_hex(&server_pubkey_hex, "server_pubkey_hex");
    }

    pub fn set_keeper(&mut self, keeper: AccountId) {
        self.assert_owner();
        self.keeper = keeper;
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
        if amount == 0 {
            return;
        }
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
