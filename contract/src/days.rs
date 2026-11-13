//! v4: the floor's day books and Tilt Hour, the two hooks of the $TILT memecoin (docs/tilt.md).
//!
//! Day books: per UTC day (`block time / 86 400`), what human players won or lost against the
//! house (`players_net = Σ payout − Σ stake` of their settled rounds, every game, poker included;
//! NPC gamblers excluded) and how much each one wagered. Fed by `settle_session`. Storage is
//! bounded: only the `DAYS_KEPT` latest books are kept, and a book tracks at most
//! `MAX_DAY_PLAYERS` players (the top wagerers: a newcomer replaces the smallest wagerer only if
//! it wagered more; the evicted player's rounds stay in the day's totals). Once a day is over,
//! anyone calls `close_day`, once, and the floor reports it to the meme contract
//! (`report_day`, the `MAX_REPORTED_PLAYERS` largest wagerers).
//!
//! Tilt Hour: the meme contract (only it) calls `start_tilt_hour`; for `TILT_HOUR_SECS` every
//! table's rake in force is its game's minimum (`rake_bounds`).

use core_rules::{rake_bounds, Game};
use near_sdk::json_types::{I128, U128};
use near_sdk::serde_json::json;
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, PromiseError};

use crate::dealers::signed;
use crate::{emit, fail, now, Dealer, House, HouseExt};

pub const SECS_PER_DAY: u64 = 86_400;
/// Books kept: the current day and the previous one.
pub const DAYS_KEPT: usize = 2;
/// Players tracked per day (the top wagerers).
pub const MAX_DAY_PLAYERS: usize = 200;
/// Players sent to `report_day`, largest wagerers first.
pub const MAX_REPORTED_PLAYERS: usize = 50;
pub const TILT_HOUR_SECS: u64 = 3_600;

const REPORT_DAY_GAS: Gas = Gas::from_tgas(150);
const ON_DAY_REPORTED_GAS: Gas = Gas::from_tgas(10);
/// `close_day` refuses less, so a report never fails for lack of gas.
const CLOSE_DAY_MIN_GAS: Gas = Gas::from_tgas(200);

#[allow(dead_code)] // only used through the generated `ext_meme`
#[ext_contract(ext_meme)]
trait Meme {
    fn report_day(&mut self, day: u64, players_net: I128, wagers: Vec<(AccountId, U128)>);
}

/// The UTC day of the current block.
pub(crate) fn today() -> u64 {
    now() / SECS_PER_DAY
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum DayReport {
    Pending,
    Reported,
    Failed,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct DayPlayer {
    pub account_id: AccountId,
    pub wagered: u128,
    pub net: i128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct DayBook {
    /// Human players against the house: > 0 when they won.
    pub players_net: i128,
    pub wagered: u128,
    /// At most `MAX_DAY_PLAYERS`, unordered.
    pub players: Vec<DayPlayer>,
    pub closed: bool,
    /// `None`: not closed, or closed without a meme contract.
    pub report: Option<DayReport>,
}

impl DayBook {
    fn record(&mut self, account: &AccountId, wagered: u128, net: i128) {
        self.players_net = self.players_net.saturating_add(net);
        self.wagered = self.wagered.saturating_add(wagered);
        if let Some(player) = self.players.iter_mut().find(|p| p.account_id == *account) {
            player.wagered = player.wagered.saturating_add(wagered);
            player.net = player.net.saturating_add(net);
            return;
        }
        let entry = DayPlayer {
            account_id: account.clone(),
            wagered,
            net,
        };
        if self.players.len() < MAX_DAY_PLAYERS {
            self.players.push(entry);
            return;
        }
        let smallest = self
            .players
            .iter()
            .enumerate()
            .min_by_key(|(_, p)| p.wagered)
            .map(|(i, p)| (i, p.wagered));
        if let Some((index, least)) = smallest {
            if wagered > least {
                self.players[index] = entry;
            }
        }
    }

    /// Largest wagerers first (ties by account id), never zero wagers.
    fn ranked(&self) -> Vec<DayPlayer> {
        let mut players: Vec<DayPlayer> = self
            .players
            .iter()
            .filter(|p| p.wagered > 0)
            .cloned()
            .collect();
        players.sort_by(|a, b| {
            b.wagered
                .cmp(&a.wagered)
                .then_with(|| a.account_id.cmp(&b.account_id))
        });
        players
    }
}

#[near(serializers = [json])]
pub struct DayPlayerView {
    pub account_id: AccountId,
    pub wagered: U128,
    pub net: I128,
}

#[near(serializers = [json])]
pub struct DayView {
    pub day: u64,
    pub closed: bool,
    pub report: Option<DayReport>,
    pub players_net: I128,
    pub wagered: U128,
    /// Tracked players, largest wagerers first.
    pub players: Vec<DayPlayerView>,
}

#[near]
impl House {
    /// Owner, once: the meme contract that receives `report_day` and may `start_tilt_hour`.
    pub fn set_meme(&mut self, account_id: AccountId) {
        self.assert_owner();
        require!(self.meme.is_none(), "the meme contract is already set");
        emit("meme_set", json!({ "account_id": account_id }));
        self.meme = Some(account_id);
    }

    /// The meme contract only: every table plays at its game's minimum rake for an hour (an
    /// active Tilt Hour is extended, never shortened).
    pub fn start_tilt_hour(&mut self) {
        require!(
            self.meme.as_ref() == Some(&env::predecessor_account_id()),
            "only the meme contract can start a tilt hour"
        );
        self.tilt_hour_until = self
            .tilt_hour_until
            .max(now().saturating_add(TILT_HOUR_SECS));
        emit("tilt_hour", json!({ "until": self.tilt_hour_until }));
    }

    /// Anyone, once per finished day: closes its book and, with a meme contract, reports it
    /// (`report_day`; the result lands in `on_day_reported`). A day with no human play closes
    /// empty, unless it is older than what the floor still knows (`days_known_from`).
    pub fn close_day(&mut self, day: u64) {
        require!(day < today(), "the day is not over yet");
        let mut book = match self.days.get(&day) {
            Some(book) => book.clone(),
            None if day >= self.days_known_from => DayBook::default(),
            None => fail("no record for that day"),
        };
        require!(!book.closed, "the day is already closed");
        book.closed = true;
        let ranked = book.ranked();
        let players_net = book.players_net;
        let meme = self.meme.clone();
        if meme.is_some() {
            require!(
                env::prepaid_gas() >= CLOSE_DAY_MIN_GAS,
                "close_day needs at least 200 Tgas"
            );
            book.report = Some(DayReport::Pending);
        }
        emit(
            "day_closed",
            json!({
                "day": day,
                "players_net": players_net.to_string(),
                "wagered": book.wagered.to_string(),
                "players": ranked.len(),
                "meme": meme,
            }),
        );
        self.save_day(day, book);
        let Some(meme) = meme else { return };
        let wagers = ranked
            .into_iter()
            .take(MAX_REPORTED_PLAYERS)
            .map(|p| (p.account_id, U128(p.wagered)))
            .collect();
        ext_meme::ext(meme)
            .with_static_gas(REPORT_DAY_GAS)
            .report_day(day, I128(players_net), wagers)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_DAY_REPORTED_GAS)
                    .on_day_reported(day),
            )
            .detach();
    }

    /// The meme contract's answer to `report_day`. No retry: the day stays closed.
    #[private]
    pub fn on_day_reported(&mut self, day: u64) {
        let ok = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        if let Some(book) = self.days.get_mut(&day) {
            book.report = Some(if ok {
                DayReport::Reported
            } else {
                DayReport::Failed
            });
        }
        emit("day_reported", json!({ "day": day, "ok": ok }));
    }

    /// A day's book (`day`: null = today). An unrecorded day the floor knows had no human play
    /// shows empty; a day the floor no longer knows (or a future one) is `null`.
    pub fn get_day(&self, day: Option<u64>) -> Option<DayView> {
        let today = today();
        let day = day.unwrap_or(today);
        let book = match self.days.get(&day) {
            Some(book) => book.clone(),
            None if (self.days_known_from..=today).contains(&day) => DayBook::default(),
            None => return None,
        };
        Some(DayView {
            day,
            closed: book.closed,
            report: book.report,
            players_net: I128(book.players_net),
            wagered: U128(book.wagered),
            players: book
                .ranked()
                .into_iter()
                .map(|p| DayPlayerView {
                    account_id: p.account_id,
                    wagered: U128(p.wagered),
                    net: I128(p.net),
                })
                .collect(),
        })
    }
}

impl House {
    /// The rake in force at `dealer`'s table: its game's minimum during Tilt Hour, else its
    /// offer's (`Offer::effective_rake_bp`, boosts included).
    pub(crate) fn effective_rake_bp(&self, dealer: &Dealer, now: u64) -> u16 {
        tilt_rake(
            dealer.game,
            dealer.offer.effective_rake_bp(dealer.game, now),
            self.tilt_hour_until,
            now,
        )
    }

    /// A settled batch of a human player's rounds counts in today's book.
    pub(crate) fn record_day_play(&mut self, account: &AccountId, wagered: u128, paid: u128) {
        if self.is_npc(account) || (wagered == 0 && paid == 0) {
            return;
        }
        let day = today();
        let mut book = self.days.get(&day).cloned().unwrap_or_default();
        book.record(
            account,
            wagered,
            signed(paid).saturating_sub(signed(wagered)),
        );
        self.save_day(day, book);
    }

    /// Stores a book; past `DAYS_KEPT` books the oldest leaves storage, and days up to it are
    /// no longer known.
    fn save_day(&mut self, day: u64, book: DayBook) {
        self.days.insert(day, book);
        if let Err(at) = self.day_keys.binary_search(&day) {
            self.day_keys.insert(at, day);
        }
        while self.day_keys.len() > DAYS_KEPT {
            let dropped = self.day_keys.remove(0);
            self.days.remove(&dropped);
            self.days_known_from = self.days_known_from.max(dropped + 1);
        }
    }
}

/// `offer_rake` outside Tilt Hour, the game's minimum during it.
fn tilt_rake(game: Game, offer_rake: u16, tilt_hour_until: u64, now: u64) -> u16 {
    if now < tilt_hour_until {
        rake_bounds(game).0
    } else {
        offer_rake
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn account(i: usize) -> AccountId {
        format!("p{i}.testnet").parse().unwrap()
    }

    fn at_day(day: u64) {
        let secs = day * SECS_PER_DAY + 1;
        testing_env!(VMContextBuilder::new()
            .block_timestamp(secs * 1_000_000_000)
            .build());
    }

    fn house() -> House {
        House::new(account(0), account(1), account(0), "00".repeat(32))
    }

    #[test]
    fn only_the_two_latest_books_stay_and_dropped_days_are_unknown() {
        at_day(10);
        let mut house = house();
        house.record_day_play(&account(5), 5, 0);
        at_day(11);
        house.record_day_play(&account(5), 5, 10);
        at_day(12);
        house.record_day_play(&account(5), 5, 0);
        assert_eq!(house.day_keys, vec![11, 12]);
        assert_eq!(house.days_known_from, 11);
        assert!(house.get_day(Some(10)).is_none());
        assert_eq!(house.get_day(Some(11)).unwrap().players_net.0, 5);
        assert!(house.get_day(Some(13)).is_none());
        // Day 11 closes (no meme: nothing reported), once.
        house.close_day(11);
        let book = house.get_day(Some(11)).unwrap();
        assert!(book.closed && book.report.is_none());
    }

    #[test]
    #[should_panic(expected = "no record for that day")]
    fn a_dropped_day_is_never_closed_empty() {
        at_day(10);
        let mut house = house();
        house.record_day_play(&account(5), 5, 0);
        at_day(11);
        house.record_day_play(&account(5), 5, 0);
        at_day(12);
        house.record_day_play(&account(5), 5, 0);
        house.close_day(10);
    }

    #[test]
    fn npc_gamblers_are_not_counted() {
        at_day(10);
        let mut house = house();
        house.npcs.push(account(7));
        house.record_day_play(&account(7), 5, 0);
        assert!(house.day_keys.is_empty());
        assert_eq!(house.get_day(None).unwrap().players.len(), 0);
    }

    #[test]
    fn a_book_sums_every_round_and_keeps_the_top_wagerers() {
        let mut book = DayBook::default();
        for i in 0..MAX_DAY_PLAYERS {
            book.record(&account(i), 10 + i as u128, -1);
        }
        book.record(&account(0), 5, 3);
        assert_eq!(book.players.len(), MAX_DAY_PLAYERS);
        assert_eq!(book.players[0].wagered, 15);
        assert_eq!(book.players[0].net, 2);
        // A newcomer under the smallest wagerer (p1, 11) is counted but not tracked.
        book.record(&account(999), 11, -11);
        assert!(book.players.iter().all(|p| p.account_id != account(999)));
        // One above it replaces the smallest.
        book.record(&account(1000), 12, 4);
        assert!(book.players.iter().any(|p| p.account_id == account(1000)));
        assert!(book.players.iter().all(|p| p.account_id != account(1)));
        assert_eq!(book.players.len(), MAX_DAY_PLAYERS);
        let wagered: u128 =
            (0..MAX_DAY_PLAYERS as u128).map(|i| 10 + i).sum::<u128>() + 5 + 11 + 12;
        assert_eq!(book.wagered, wagered);
        assert_eq!(book.players_net, -(MAX_DAY_PLAYERS as i128) + 3 - 11 + 4);
    }

    #[test]
    fn ranking_is_by_wager_then_account_and_skips_zero_wagers() {
        let mut book = DayBook::default();
        book.record(&account(2), 7, 0);
        book.record(&account(1), 7, 0);
        book.record(&account(3), 9, 0);
        book.record(&account(4), 0, 5);
        let ranked: Vec<AccountId> = book.ranked().into_iter().map(|p| p.account_id).collect();
        assert_eq!(ranked, vec![account(3), account(1), account(2)]);
    }

    #[test]
    fn tilt_hour_takes_the_game_minimum() {
        assert_eq!(
            tilt_rake(Game::Dice, 300, 100, 99),
            rake_bounds(Game::Dice).0
        );
        assert_eq!(tilt_rake(Game::Dice, 300, 100, 100), 300);
        assert_eq!(tilt_rake(Game::Roulette, 200, 0, 5), 200);
    }
}
