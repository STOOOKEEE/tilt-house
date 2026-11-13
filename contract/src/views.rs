//! Read-only views (shapes in docs/contract-api.md).

use core_rules::seats::{seat_min_rent, SEAT_TRAFFIC_BP};
use core_rules::session::{REVEAL_TIMEOUT_SECS, SESSION_TIMEOUT_SECS};
use core_rules::{
    base_edge_bp, floor::SEATS, worst_case_multiple, JACKPOT_ODDS_UNIT, MIN_JACKPOT,
    SHARES_PER_UNIT,
};
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::serde_json::Value;
use near_sdk::{near, serde_json, AccountId};

use crate::dealers::signed;
use crate::floor::{seat_number, seat_token};
use crate::{
    now, Dealer, House, HouseExt, LogEntry, LogKind, Session, SessionStatus, HISTORY_PER_DEALER,
    MIN_BET, SESSIONS_PER_PLAYER,
};

/// Share prices in millionths of the launch price, like the simulator: launch = 1_000_000.
const PRICE_SCALE: u128 = 1_000_000;
const MAX_HISTORY_PAGE: u32 = 50;
const USDC: u128 = 1_000_000;

#[near(serializers = [json])]
pub struct SeatView {
    pub seat: usize,
    pub token_id: String,
    pub traffic_bp: u16,
    pub min_rent: U128,
    pub dealer_id: Option<String>,
    pub controller: Option<AccountId>,
    pub rent_per_hour: Option<U128>,
    pub seated_at: Option<u64>,
    pub paid_until: Option<u64>,
    pub rent_owed: U128,
    pub ask: Option<U128>,
}

#[near(serializers = [json])]
pub struct FloorView {
    pub seats: Vec<SeatView>,
    pub lowest_rent: Option<U128>,
    pub outbid_min: U128,
    pub jackpot: U128,
    pub jackpot_odds_unit: U128,
    pub min_jackpot: U128,
    /// Tilt Hour runs while `now < tilt_hour_until` (seconds; 0: never started).
    pub tilt_hour_until: u64,
    /// The current UTC day (`block time / 86 400`), as in `get_day` / `close_day`.
    pub day: u64,
}

#[near(serializers = [json])]
pub struct DealerView {
    pub id: String,
    pub name: String,
    /// `"dice" | "roulette" | "blackjack" | "poker"` (core `Game`).
    pub game: Value,
    pub look: Option<String>,
    pub npc: bool,
    pub controller: AccountId,
    pub autopilot: bool,
    pub temperament: String,
    /// core `Temperament`: `{greed, caution, promo}`.
    pub traits: Value,
    pub temperament_changed_at: u64,
    pub last_boost_at: u64,
    /// The rake in force now: the offer's, the game's minimum during a boost or a Tilt Hour.
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
    pub seated: bool,
    pub seat: Option<usize>,
    pub seat_traffic_bp: Option<u16>,
    pub rent_per_hour: Option<U128>,
    pub rent_owed: U128,
    pub paid_until: Option<u64>,
    pub ask: Option<U128>,
    pub cooldown_until: u64,
    pub bankroll: U128,
    pub reserved: U128,
    pub open_stakes: U128,
    pub shares: U128,
    pub share_price_buy: U128,
    pub share_price_sell: U128,
    pub open_sessions: u32,
    /// Signed decimal strings.
    pub earnings_1h: String,
    pub rent_1h: U128,
    pub pnl_1h: String,
    /// core `Stats` (last hour) plus `gamblers_1h`.
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
    pub tables: Vec<String>,
    pub seats: Vec<usize>,
    pub open_session: Option<String>,
    pub sessions: Vec<String>,
}

#[near(serializers = [json])]
pub struct SessionView {
    pub id: String,
    pub player: AccountId,
    pub dealer_id: String,
    pub game: Value,
    pub status: SessionStatus,
    pub lock: U128,
    pub rake_bp: u16,
    pub max_bet: U128,
    pub max_win: U128,
    pub server_seed_hash: String,
    pub client_seed: String,
    pub server_seed: Option<String>,
    pub opened_at: u64,
    pub last_settle_at: u64,
    pub closed_at: u64,
    pub settled_nonce: u64,
    pub balance: U128,
    pub reserve: U128,
    pub chain: String,
    pub wagered: U128,
    pub paid: U128,
    pub jackpot_won: U128,
    pub paid_out: U128,
    pub force_close_after: u64,
    pub claim_after: u64,
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
    pub amount: U128,
    pub detail: String,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub token: AccountId,
    pub keeper: AccountId,
    pub server_pubkey_hex: String,
    pub min_bet: U128,
    pub history_per_dealer: u64,
    pub sessions_per_player: u32,
    pub session_timeout_secs: u64,
    pub reveal_timeout_secs: u64,
    pub dealer_ids: Vec<String>,
    /// The $TILT contract (`set_meme`), null until set.
    pub meme: Option<AccountId>,
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

fn log_text(entry: &LogEntry) -> String {
    let amount = usdc(entry.amount);
    let detail = &entry.detail;
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
        LogKind::Opened => format!("table opened with {amount} USDC"),
        LogKind::Seated => format!("took {detail} · prepaid {amount} USDC of rent"),
        LogKind::Evicted => format!("lost my seat: {}", detail.replace('_', " ")),
        LogKind::Rent => format!("rent of {detail} set to {amount} USDC/h"),
        LogKind::Listed if entry.amount == 0 => format!("{detail} no longer for sale"),
        LogKind::Listed => format!("{detail} for sale at {amount} USDC"),
        LogKind::Sold => format!("sold {detail} for {amount} USDC"),
        LogKind::Bought => format!("bought {detail} for {amount} USDC"),
        LogKind::Jackpot => format!("jackpot! {amount} USDC won at my table"),
        LogKind::Offer => format!(
            "owner set the rake to {} bp, max bet {} USDC",
            entry.rake_bp,
            usdc(entry.max_bet)
        ),
        LogKind::Autopilot if detail == "manual" => "owner took the controls".to_string(),
        LogKind::Autopilot => format!("autopilot on ({detail})"),
        LogKind::Temperament => format!("temperament now {detail}"),
        LogKind::Renamed => format!("renamed to {detail}"),
        LogKind::Retired => format!("table retired · {amount} USDC paid out to the owner"),
    }
}

fn history_view(entry: &LogEntry) -> HistoryView {
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
        amount: U128(entry.amount),
        detail: entry.detail.clone(),
    }
}

fn session_view(session: &Session) -> SessionView {
    SessionView {
        id: session.id.clone(),
        player: session.player.clone(),
        dealer_id: session.dealer_id.clone(),
        game: to_json(&session.game),
        status: session.status,
        lock: U128(session.lock),
        rake_bp: session.rake_bp,
        max_bet: U128(session.max_bet),
        max_win: U128(session.max_win),
        server_seed_hash: hex::encode(session.server_seed_hash),
        client_seed: session.client_seed.clone(),
        server_seed: session.server_seed.map(hex::encode),
        opened_at: session.opened_at,
        last_settle_at: session.last_settle_at,
        closed_at: session.closed_at,
        settled_nonce: session.settled_nonce,
        balance: U128(session.escrow),
        reserve: U128(session.reserve),
        chain: hex::encode(session.chain),
        wagered: U128(session.wagered),
        paid: U128(session.paid),
        jackpot_won: U128(session.jackpot_won),
        paid_out: U128(session.paid_out),
        force_close_after: session.force_close_after(),
        claim_after: session.claim_after(),
    }
}

impl House {
    fn dealer_view(&self, dealer: &Dealer, now: u64) -> DealerView {
        let pool = &dealer.pool;
        let rake_bp = self.effective_rake_bp(dealer, now);
        let base = base_edge_bp(dealer.game);
        let stats = self.full_stats(dealer, now);
        let extra = dealer.hour_extra(now);
        let earnings = -stats.player_net_1h;
        let mut stats_json = to_json(&stats);
        stats_json["gamblers_1h"] = Value::from(extra.gamblers);
        let index = self.floor.seat_of(&dealer.id);
        let seat = self.floor.seat(&dealer.id);
        DealerView {
            id: dealer.id.clone(),
            name: dealer.name.clone(),
            game: to_json(&dealer.game),
            look: dealer.look.clone(),
            npc: dealer.npc,
            controller: dealer.controller.clone(),
            autopilot: dealer.autopilot,
            temperament: dealer.temperament.clone(),
            traits: to_json(&dealer.traits),
            temperament_changed_at: dealer.temperament_changed_at,
            last_boost_at: dealer.last_boost_at,
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
            seated: index.is_some(),
            seat: index.map(seat_number),
            seat_traffic_bp: index.map(|i| SEAT_TRAFFIC_BP[i]),
            rent_per_hour: seat.map(|s| U128(s.rent_per_hour)),
            rent_owed: U128(self.floor.rent_owed(&dealer.id, now)),
            paid_until: seat.map(|s| s.paid_until),
            ask: seat.and_then(|s| s.ask).map(U128),
            cooldown_until: dealer.cooldown_until,
            bankroll: U128(pool.bankroll),
            reserved: U128(pool.reserved),
            open_stakes: U128(pool.open_stakes),
            shares: U128(pool.shares),
            share_price_buy: share_price(
                pool.bankroll.saturating_add(pool.open_stakes),
                pool.shares,
            ),
            share_price_sell: share_price(pool.free(), pool.shares),
            open_sessions: dealer.open_sessions,
            earnings_1h: earnings.to_string(),
            rent_1h: U128(extra.rent),
            pnl_1h: earnings.saturating_sub(signed(extra.rent)).to_string(),
            stats: stats_json,
        }
    }

    fn seat_view(&self, index: usize, now: u64) -> SeatView {
        let seat = self.floor.seats[index].as_ref();
        SeatView {
            seat: seat_number(index),
            token_id: seat_token(index),
            traffic_bp: SEAT_TRAFFIC_BP[index],
            min_rent: U128(seat_min_rent(index)),
            dealer_id: seat.map(|s| s.dealer_id.clone()),
            controller: self.seat_holder(index),
            rent_per_hour: seat.map(|s| U128(s.rent_per_hour)),
            seated_at: seat.map(|s| s.seated_at),
            paid_until: seat.map(|s| s.paid_until),
            rent_owed: U128(seat.map_or(0, |s| self.floor.rent_owed(&s.dealer_id, now))),
            ask: seat.and_then(|s| s.ask).map(U128),
        }
    }
}

#[near]
impl House {
    pub fn get_floor(&self) -> FloorView {
        let now = now();
        FloorView {
            seats: (0..SEATS).map(|i| self.seat_view(i, now)).collect(),
            lowest_rent: self.floor.lowest_rent().map(U128),
            outbid_min: U128(self.floor.outbid_min()),
            jackpot: U128(self.floor.jackpot),
            jackpot_odds_unit: U128(JACKPOT_ODDS_UNIT),
            min_jackpot: U128(MIN_JACKPOT),
            tilt_hour_until: self.tilt_hour_until,
            day: crate::days::today(),
        }
    }

    pub fn get_lobby(&self) -> Vec<DealerView> {
        let now = now();
        let mut ids = self.dealer_ids.clone();
        ids.sort();
        ids.iter()
            .filter_map(|id| self.dealers.get(id))
            .map(|dealer| self.dealer_view(dealer, now))
            .collect()
    }

    /// Retired tables (`retire_table`), oldest retirement first.
    pub fn get_retired(&self) -> Vec<DealerView> {
        let now = now();
        self.retired_ids
            .iter()
            .filter_map(|id| self.dealers.get(id))
            .map(|dealer| self.dealer_view(dealer, now))
            .collect()
    }

    pub fn get_player(&self, account_id: AccountId) -> PlayerView {
        let player = self.player(&account_id);
        let mut lp = Vec::new();
        let mut tables = Vec::new();
        for id in &self.dealer_ids {
            let Some(dealer) = self.dealers.get(id) else {
                continue;
            };
            let shares = self.shares_of(id, &account_id);
            if shares > 0 {
                lp.push(LpView {
                    dealer_id: id.clone(),
                    shares: U128(shares),
                    value: U128(share_value(dealer, shares)),
                });
            }
            if dealer.controller == account_id {
                tables.push(id.clone());
            }
        }
        let seats = (0..SEATS)
            .filter(|i| self.seat_holder(*i).as_ref() == Some(&account_id))
            .map(seat_number)
            .collect();
        PlayerView {
            account_id,
            balance: U128(player.balance),
            lp,
            tables,
            seats,
            open_session: player.open_session,
            sessions: player.sessions,
        }
    }

    pub fn get_session(&self, session_id: String) -> Option<SessionView> {
        self.sessions.get(&session_id).map(session_view)
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
            keeper: self.keeper.clone(),
            server_pubkey_hex: hex::encode(self.server_pubkey),
            min_bet: U128(MIN_BET),
            history_per_dealer: HISTORY_PER_DEALER,
            sessions_per_player: SESSIONS_PER_PLAYER as u32,
            session_timeout_secs: SESSION_TIMEOUT_SECS,
            reveal_timeout_secs: REVEAL_TIMEOUT_SECS,
            dealer_ids: self.dealer_ids.clone(),
            meme: self.meme.clone(),
        }
    }
}
