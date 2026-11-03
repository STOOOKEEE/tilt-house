//! Read-only views (shapes in docs/contract-api.md).

use core_rules::{base_edge_bp, worst_case_multiple, SHARES_PER_UNIT};
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::serde_json::Value;
use near_sdk::{near, serde_json, AccountId};

use crate::{
    now, Dealer, House, HouseExt, LogEntry, LogKind, Proof, Round, Status, ABANDON_AFTER_SECS,
    HISTORY_PER_DEALER, MIN_BET, REFUND_AFTER_SECS, ROUNDS_PER_PLAYER,
};

/// Share prices in millionths of the launch price, like the simulator: launch = 1_000_000.
const PRICE_SCALE: u128 = 1_000_000;
const MAX_HISTORY_PAGE: u32 = 50;
const USDC: u128 = 1_000_000;

#[near(serializers = [json])]
pub struct DealerView {
    pub id: String,
    pub name: String,
    /// `"dice" | "roulette" | "blackjack"` (core `Game`).
    pub game: Value,
    pub temperament: String,
    /// core `Temperament`: `{greed, caution, promo}`.
    pub traits: Value,
    pub dealer_account: AccountId,
    pub rake_bp: u16,
    pub offer_rake_bp: u16,
    pub base_edge_bp: u16,
    pub total_edge_bp: u16,
    pub min_bet: U128,
    pub max_bet: U128,
    pub worst_case_multiple: U128,
    pub boost_until: u64,
    pub reason: String,
    pub reason_text: String,
    pub repriced_at: u64,
    pub open: bool,
    pub bankroll: U128,
    pub reserved: U128,
    pub open_stakes: U128,
    pub shares: U128,
    pub share_price_buy: U128,
    pub share_price_sell: U128,
    /// core `Stats` (last hour).
    pub stats: Value,
}

#[near(serializers = [json])]
pub struct LpView {
    pub dealer_id: String,
    pub shares: U128,
    pub value: U128,
}

#[near(serializers = [json])]
pub struct PlayerView {
    pub account_id: AccountId,
    pub balance: U128,
    pub lp: Vec<LpView>,
    pub open_round: Option<u64>,
    pub last_round: Option<u64>,
    pub rounds: Vec<u64>,
}

#[near(serializers = [json])]
pub struct RoundView {
    pub id: u64,
    pub player: AccountId,
    pub dealer_id: String,
    pub game: Value,
    /// core `Bet`.
    pub bet: Value,
    pub stake: U128,
    pub wager: U128,
    pub rake_bp: u16,
    pub status: Status,
    pub step: u32,
    pub created_at: u64,
    pub updated_at: u64,
    pub roll: Option<u32>,
    pub pocket: Option<u8>,
    /// core `BjState`.
    pub bj: Option<Value>,
    pub payout: Option<U128>,
    pub proofs: Vec<Proof>,
    pub error: Option<String>,
}

#[near(serializers = [json])]
pub struct HistoryView {
    pub seq: u64,
    pub t: u64,
    pub kind: String,
    pub text: String,
    pub reason: String,
    pub reason_text: String,
    pub rake_bp: u16,
    pub max_bet: U128,
    pub boost_until: u64,
    pub account_id: Option<AccountId>,
    pub amount: Option<U128>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub token: AccountId,
    pub outlayer: AccountId,
    pub vrf_pubkey_hex: String,
    pub vrf_source: Value,
    pub min_bet: U128,
    pub refund_after_secs: u64,
    pub abandon_after_secs: u64,
    pub rounds_per_player: u32,
    pub history_per_dealer: u64,
    pub next_round_id: u64,
    pub dealer_ids: Vec<String>,
}

/// Core types are exposed as JSON values: they carry no schema for the contract ABI.
pub(crate) fn to_json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Price of one launch-size share (1 base unit at launch) for `value` spread over `shares`.
fn share_price(value: u128, shares: u128) -> U128 {
    if shares == 0 {
        return U128(PRICE_SCALE);
    }
    U128(value.saturating_mul(SHARES_PER_UNIT * PRICE_SCALE) / shares)
}

/// Sell value of `shares` now (free bankroll only).
fn share_value(dealer: &Dealer, shares: u128) -> u128 {
    if dealer.pool.shares == 0 {
        return 0;
    }
    shares.saturating_mul(dealer.pool.free()) / dealer.pool.shares
}

/// Base units as USDC with two decimals, rounded up (amounts needed are never understated).
fn usdc(amount: u128) -> String {
    let cents = amount.div_ceil(USDC / 100);
    format!("{}.{:02}", cents / 100, cents % 100)
}

fn dealer_view(dealer: &Dealer, now: u64) -> DealerView {
    let pool = &dealer.pool;
    let rake_bp = dealer.offer.effective_rake_bp(dealer.game, now);
    let base = base_edge_bp(dealer.game);
    DealerView {
        id: dealer.id.clone(),
        name: dealer.name.clone(),
        game: to_json(&dealer.game),
        temperament: dealer.temperament.clone(),
        traits: to_json(&dealer.traits),
        dealer_account: dealer.account.clone(),
        rake_bp,
        offer_rake_bp: dealer.offer.rake_bp,
        base_edge_bp: base,
        total_edge_bp: base + rake_bp,
        min_bet: U128(MIN_BET),
        max_bet: U128(dealer.max_bet()),
        worst_case_multiple: U128(worst_case_multiple(dealer.game)),
        boost_until: dealer.offer.boost_until,
        reason: dealer.offer.reason.code().to_string(),
        reason_text: dealer.offer.reason.explain(),
        repriced_at: dealer.repriced_at,
        open: dealer.is_open(),
        bankroll: U128(pool.bankroll),
        reserved: U128(pool.reserved),
        open_stakes: U128(pool.open_stakes),
        shares: U128(pool.shares),
        share_price_buy: share_price(pool.bankroll.saturating_add(pool.open_stakes), pool.shares),
        share_price_sell: share_price(pool.free(), pool.shares),
        stats: to_json(&dealer.stats(now)),
    }
}

fn log_text(entry: &LogEntry) -> String {
    let amount = usdc(entry.amount);
    match entry.kind {
        LogKind::Reprice => entry.reason.explain(),
        LogKind::Boost => format!("{} · boost on", entry.reason.explain()),
        LogKind::Bust => format!(
            "closed: my pool can no longer cover a {} USDC bet · needs {amount} USDC to reopen",
            usdc(MIN_BET)
        ),
        LogKind::Reopen => "reopened: new liquidity covers the minimum bet again".to_string(),
        LogKind::Invest => format!("{amount} USDC of new liquidity came in"),
        LogKind::Divest => format!("{amount} USDC of liquidity left"),
    }
}

fn history_view(entry: &LogEntry) -> HistoryView {
    let has_amount = matches!(
        entry.kind,
        LogKind::Bust | LogKind::Invest | LogKind::Divest
    );
    HistoryView {
        seq: entry.seq,
        t: entry.t,
        kind: entry.kind.code().to_string(),
        text: log_text(entry),
        reason: entry.reason.code().to_string(),
        reason_text: entry.reason.explain(),
        rake_bp: entry.rake_bp,
        max_bet: U128(entry.max_bet),
        boost_until: entry.boost_until,
        account_id: entry.account_id.clone(),
        amount: has_amount.then_some(U128(entry.amount)),
    }
}

fn round_view(round: &Round) -> RoundView {
    RoundView {
        id: round.id,
        player: round.player.clone(),
        dealer_id: round.dealer_id.clone(),
        game: to_json(&round.bet.game()),
        bet: to_json(&round.bet),
        stake: U128(round.stake),
        wager: U128(round.wager),
        rake_bp: round.rake_bp,
        status: round.status,
        step: round.step,
        created_at: round.created_at,
        updated_at: round.updated_at,
        roll: round.roll,
        pocket: round.pocket,
        bj: round.bj.as_ref().map(to_json),
        payout: round.payout.map(U128),
        proofs: round.proofs.clone(),
        error: round.error.clone(),
    }
}

#[near]
impl House {
    pub fn get_lobby(&self) -> Vec<DealerView> {
        let now = now();
        let mut ids = self.dealer_ids.clone();
        ids.sort();
        ids.iter()
            .filter_map(|id| self.dealers.get(id))
            .map(|dealer| dealer_view(dealer, now))
            .collect()
    }

    pub fn get_player(&self, account_id: AccountId) -> PlayerView {
        let player = self.player(&account_id);
        let lp = self
            .dealer_ids
            .iter()
            .filter_map(|id| {
                let shares = self.shares_of(id, &account_id);
                let dealer = self.dealers.get(id)?;
                (shares > 0).then(|| LpView {
                    dealer_id: id.clone(),
                    shares: U128(shares),
                    value: U128(share_value(dealer, shares)),
                })
            })
            .collect();
        PlayerView {
            account_id,
            balance: U128(player.balance),
            lp,
            open_round: player.open_round,
            last_round: player.rounds.last().copied(),
            rounds: player.rounds,
        }
    }

    pub fn get_round(&self, round_id: u64) -> Option<RoundView> {
        self.rounds.get(&round_id).map(round_view)
    }

    /// The dealer's log, oldest first. `from`: first seq wanted (None: the latest `limit`).
    pub fn get_history(
        &self,
        dealer_id: String,
        from: Option<u64>,
        limit: u32,
    ) -> Vec<HistoryView> {
        let Some(dealer) = self.dealers.get(&dealer_id) else {
            return Vec::new();
        };
        let limit = u64::from(limit.min(MAX_HISTORY_PAGE));
        let len = dealer.log_len;
        let oldest = len.saturating_sub(HISTORY_PER_DEALER);
        let start = from.unwrap_or(len.saturating_sub(limit)).max(oldest);
        let end = start.saturating_add(limit).min(len);
        (start..end)
            .filter_map(|seq| {
                self.history
                    .get(&(dealer_id.clone(), seq % HISTORY_PER_DEALER))
            })
            .map(history_view)
            .collect()
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            token: self.token.clone(),
            outlayer: self.outlayer.clone(),
            vrf_pubkey_hex: hex::encode(self.vrf_pubkey),
            vrf_source: serde_json::from_str(&self.vrf_source).unwrap_or(Value::Null),
            min_bet: U128(MIN_BET),
            refund_after_secs: REFUND_AFTER_SECS,
            abandon_after_secs: ABANDON_AFTER_SECS,
            rounds_per_player: ROUNDS_PER_PLAYER as u32,
            history_per_dealer: HISTORY_PER_DEALER,
            next_round_id: self.next_round_id,
            dealer_ids: self.dealer_ids.clone(),
        }
    }
}
