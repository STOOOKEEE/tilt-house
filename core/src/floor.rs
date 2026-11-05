//! # The floor: seats and rent (docs/floor.md, rules 1–4)
//!
//! The casino floor has `SEATS` seats. Only a seated dealer takes bets. Seats near the entrance
//! see more gamblers and cost more: each seat's minimum rent scales with its traffic
//! (`seats::seat_min_rent`). Every seated dealer pays
//! its own `rent_per_hour` from its pool's free bankroll into the jackpot, accrued per second and
//! settled lazily (`accrue_rent`). A dealer that cannot pay is evicted.
//!
//! A dealer off the floor gets a seat with `bid_for_seat`: a bid takes the busiest empty seat
//! whose minimum rent it covers; on a full floor the bid must beat the lowest rent by 10 %, and the
//! lowest-rent dealer loses its seat. Either way the bidder prepays `PREPAY_HOURS` of rent. An
//! evicted dealer waits `COOLDOWN_SECS` before bidding again.
//!
//! Every function checks everything before it changes anything: an `Err` leaves the floor and
//! the pool untouched.
//!
//! Times are in seconds. Amounts are USDC base units (6 decimals).

use std::fmt;

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::seats::{seat_min_rent, MIN_SEAT_RENT};
use crate::{Pool, BP};

/// Seats on the floor: scarce on purpose, so tables compete for them.
pub const SEATS: usize = 6;

/// Rent of an average-traffic seat at its minimum: 1 USDC an hour. Each seat's own minimum is
/// this scaled by its traffic (`seats::seat_min_rent`: 0.6 to 1.5 USDC).
pub const MIN_RENT_PER_HOUR: u128 = 1_000_000;

/// Hours of rent a bidder pays up front, so a seat is never taken for free.
pub const PREPAY_HOURS: u64 = 2;

/// A bid on a full floor must reach 110 % of the lowest seated rent.
pub const OUTBID_BP: u128 = 11_000;

/// An evicted dealer waits 30 minutes before bidding again (no flip-flop seat wars).
pub const COOLDOWN_SECS: u64 = 30 * 60;

/// Smallest bankroll a player can open a table with: 200 USDC.
pub const MIN_TABLE_SEED: u128 = 200_000_000;

/// Most dealers that can exist, seated or not (bounds the keeper's work and the contract state).
pub const MAX_DEALERS: usize = 16;

/// A table owner can change its temperament at most once an hour.
pub const TEMPERAMENT_COOLDOWN_SECS: u64 = HOUR_SECS;

/// Longest table id and display name, in bytes.
pub const MAX_TABLE_ID_LEN: usize = 32;
pub const MAX_TABLE_NAME_LEN: usize = 32;

pub const HOUR_SECS: u64 = 60 * 60;

const PREPAY_SECS: u64 = PREPAY_HOURS * HOUR_SECS;

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct Seat {
    pub dealer_id: String,
    #[serde(with = "crate::amount_str")]
    pub rent_per_hour: u128,
    pub seated_at: u64,
    /// Rent is paid up to this time. Ahead of `now` while prepaid time remains.
    pub paid_until: u64,
    /// Asking price while the seat is for sale (`list_seat`).
    #[serde(default, with = "opt_amount_str")]
    pub ask: Option<u128>,
}

/// `Option<u128>` as a JSON decimal string or null.
mod opt_amount_str {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &Option<u128>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(amount) => serializer.collect_str(amount),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u128>, D::Error> {
        Option::<String>::deserialize(deserializer)?
            .map(|text| text.parse().map_err(serde::de::Error::custom))
            .transpose()
    }
}

#[derive(
    Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
pub struct Floor {
    pub seats: [Option<Seat>; SEATS],
    /// The global jackpot, fed by rent only.
    #[serde(with = "crate::amount_str")]
    pub jackpot: u128,
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum EvictReason {
    /// The pool's free bankroll could not pay the rent due.
    UnpaidRent,
    /// Another dealer bid at least 110 % of this dealer's rent on a full floor.
    Outbid,
}

impl EvictReason {
    /// Stable identifier for JSON and logs.
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnpaidRent => "unpaid_rent",
            Self::Outbid => "outbid",
        }
    }
}

/// What settling a dealer's rent did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RentOutcome {
    /// Moved from the pool to the jackpot.
    pub paid: u128,
    /// Set when the dealer lost its seat; the caller starts its cooldown (`cooldown_until`).
    pub evicted: Option<EvictReason>,
}

/// What a successful bid did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BidOutcome {
    /// Index of the bidder's seat.
    pub seat: usize,
    /// The dealer that lost its seat to this bid (reason `Outbid`); the caller starts its cooldown.
    pub evicted: Option<String>,
    /// Moved from the bidder's pool to the jackpot (the prepay; 0 for a seated dealer's rent change).
    pub paid: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FloorError {
    RentTooLow,
    /// Too large to compute with (only absurd amounts).
    RentTooHigh,
    /// The pool's free bankroll cannot prepay `need`.
    CannotPrepay {
        need: u128,
    },
    /// The floor is full and the bid is under `min`.
    BidTooLow {
        min: u128,
    },
    /// The dealer was evicted and may bid again from `until`.
    Cooldown {
        until: u64,
    },
    /// This dealer's rent must be settled (`accrue_rent`) before the bid.
    RentDue {
        dealer_id: String,
    },
    SeedTooLow,
    TooManyDealers,
    BadTableId,
    BadTableName,
    /// The dealer has no seat (to list).
    NotSeated,
    /// The buyer's dealer already has a seat (its own included).
    AlreadySeated,
    /// The seat is empty or not for sale.
    NotListed,
    /// The seat's asking price is above the buyer's `max_price`.
    PriceAbove {
        ask: u128,
    },
    /// A listing price must be positive.
    BadPrice,
}

impl fmt::Display for FloorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RentTooLow => f.write_str("rent below the seat's minimum"),
            Self::RentTooHigh => f.write_str("rent too high"),
            Self::CannotPrepay { need } => {
                write!(f, "the pool's free bankroll cannot prepay {need}")
            }
            Self::BidTooLow { min } => write!(f, "the floor is full: bid at least {min}"),
            Self::Cooldown { until } => write!(f, "evicted: cannot bid again before {until}"),
            Self::RentDue { dealer_id } => write!(f, "rent of {dealer_id} must be settled first"),
            Self::SeedTooLow => write!(f, "a table needs a seed of at least {MIN_TABLE_SEED}"),
            Self::TooManyDealers => write!(f, "the house already has {MAX_DEALERS} dealers"),
            Self::BadTableId => write!(
                f,
                "table id: 1 to {MAX_TABLE_ID_LEN} characters among a-z, 0-9 and -"
            ),
            Self::BadTableName => write!(
                f,
                "table name: 1 to {MAX_TABLE_NAME_LEN} bytes, no control characters"
            ),
            Self::NotSeated => f.write_str("this dealer has no seat"),
            Self::AlreadySeated => f.write_str("this dealer already has a seat"),
            Self::NotListed => f.write_str("this seat is not for sale"),
            Self::PriceAbove { ask } => write!(f, "the seat costs {ask}, above your maximum"),
            Self::BadPrice => f.write_str("a seat's price must be positive"),
        }
    }
}

impl std::error::Error for FloorError {}

/// When an evicted dealer may bid again.
pub fn cooldown_until(evicted_at: u64) -> u64 {
    evicted_at.saturating_add(COOLDOWN_SECS)
}

/// Whether a table owner may change its temperament (`last_change` 0: never changed).
pub fn can_set_temperament(last_change: u64, now: u64) -> bool {
    last_change == 0 || now >= last_change.saturating_add(TEMPERAMENT_COOLDOWN_SECS)
}

/// Checks a player's `open_table` request (rule 4). The contract still checks the id is unused
/// and the player's balance covers the seed.
pub fn validate_new_table(
    id: &str,
    name: &str,
    seed_amount: u128,
    dealers: usize,
) -> Result<(), FloorError> {
    let id_ok = (1..=MAX_TABLE_ID_LEN).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !id_ok {
        return Err(FloorError::BadTableId);
    }
    let name_ok = (1..=MAX_TABLE_NAME_LEN).contains(&name.len())
        && !name.chars().any(char::is_control)
        && name.trim() == name;
    if !name_ok {
        return Err(FloorError::BadTableName);
    }
    if seed_amount < MIN_TABLE_SEED {
        return Err(FloorError::SeedTooLow);
    }
    if dealers >= MAX_DEALERS {
        return Err(FloorError::TooManyDealers);
    }
    Ok(())
}

/// Rent for `secs` seconds at `rent_per_hour`, rounded up so settling often can never shave
/// rent off (at most one base unit per settlement). Saturates: an absurd debt is simply unpaid.
fn rent_for(rent_per_hour: u128, secs: u64) -> u128 {
    rent_per_hour
        .saturating_mul(u128::from(secs))
        .div_ceil(u128::from(HOUR_SECS))
}

/// Moves `amount` from the pool's free bankroll to the jackpot. The caller checked
/// `amount ≤ pool.free()`, so the reserve stays covered.
fn pay_jackpot(jackpot: &mut u128, pool: &mut Pool, amount: u128) {
    debug_assert!(amount <= pool.free());
    pool.bankroll -= amount;
    // Overflow would need more money than exists; panicking (fail closed) beats losing it.
    *jackpot = jackpot.checked_add(amount).expect("jackpot overflow");
}

impl Floor {
    /// The launch floor: these dealers seated in order at their seat's minimum rent, rent
    /// accruing from `now` (no prepay: their pools may still be empty). Extra dealers beyond
    /// `SEATS` are ignored.
    pub fn launch(dealer_ids: &[&str], now: u64) -> Self {
        let mut floor = Self::default();
        for (index, (seat, id)) in floor.seats.iter_mut().zip(dealer_ids).enumerate() {
            *seat = Some(Seat {
                dealer_id: (*id).to_string(),
                rent_per_hour: seat_min_rent(index),
                seated_at: now,
                paid_until: now,
                ask: None,
            });
        }
        floor
    }

    pub fn seat_of(&self, dealer_id: &str) -> Option<usize> {
        self.seats
            .iter()
            .position(|seat| seat.as_ref().is_some_and(|s| s.dealer_id == dealer_id))
    }

    pub fn seat(&self, dealer_id: &str) -> Option<&Seat> {
        self.seat_of(dealer_id).and_then(|i| self.seats[i].as_ref())
    }

    pub fn seated(&self) -> impl Iterator<Item = &Seat> {
        self.seats.iter().flatten()
    }

    pub fn empty_seats(&self) -> usize {
        self.seats.iter().filter(|seat| seat.is_none()).count()
    }

    /// Rent accrued and not yet paid by this dealer at `now` (0 if not seated or prepaid).
    pub fn rent_owed(&self, dealer_id: &str, now: u64) -> u128 {
        self.seat(dealer_id).map_or(0, |seat| {
            rent_for(seat.rent_per_hour, now.saturating_sub(seat.paid_until))
        })
    }

    /// Lowest rent among seated dealers; `None` when nobody is seated.
    pub fn lowest_rent(&self) -> Option<u128> {
        self.seated().map(|seat| seat.rent_per_hour).min()
    }

    /// Smallest rent that gets a seat right now: the cheapest empty seat's minimum while a seat
    /// is empty, otherwise 110 % of the lowest seated rent, rounded up.
    pub fn outbid_min(&self) -> u128 {
        if let Some(cheapest) = self.empty_seat_indexes().map(seat_min_rent).min() {
            return cheapest;
        }
        self.lowest_rent().map_or(MIN_SEAT_RENT, |lowest| {
            lowest
                .saturating_mul(OUTBID_BP)
                .div_ceil(BP)
                .max(MIN_SEAT_RENT)
        })
    }

    fn empty_seat_indexes(&self) -> impl Iterator<Item = usize> + '_ {
        self.seats
            .iter()
            .enumerate()
            .filter(|(_, seat)| seat.is_none())
            .map(|(i, _)| i)
    }

    /// The seat a winning outbid takes: the lowest rent, ties going to the most recently
    /// seated (then the highest seat index, so the choice is always deterministic).
    pub fn weakest_seat(&self) -> Option<usize> {
        self.seats
            .iter()
            .enumerate()
            .filter_map(|(i, seat)| seat.as_ref().map(|s| (i, s)))
            .min_by_key(|(i, s)| (s.rent_per_hour, u64::MAX - s.seated_at, usize::MAX - i))
            .map(|(i, _)| i)
    }

    /// Settles a seated dealer's rent up to `now`: pays it from the pool's free bankroll into
    /// the jackpot. If the free bankroll falls short, pays all of it and evicts the dealer.
    /// A dealer that is not seated pays nothing.
    pub fn accrue_rent(&mut self, dealer_id: &str, pool: &mut Pool, now: u64) -> RentOutcome {
        let Some(index) = self.seat_of(dealer_id) else {
            return RentOutcome::default();
        };
        let owed = self.rent_owed(dealer_id, now);
        if owed == 0 {
            return RentOutcome::default();
        }
        let free = pool.free();
        if owed > free {
            pay_jackpot(&mut self.jackpot, pool, free);
            self.seats[index] = None;
            return RentOutcome {
                paid: free,
                evicted: Some(EvictReason::UnpaidRent),
            };
        }
        pay_jackpot(&mut self.jackpot, pool, owed);
        if let Some(seat) = self.seats[index].as_mut() {
            seat.paid_until = now;
        }
        RentOutcome {
            paid: owed,
            evicted: None,
        }
    }

    /// A dealer's controller sets its rent. Off the floor: takes the busiest empty seat whose
    /// minimum rent the bid covers, or the weakest seat on a full floor, and prepays
    /// `PREPAY_HOURS`. Seated: changes its own rent (any raise, any cut down to its seat's
    /// minimum); see `change_rent`.
    ///
    /// `cooldown_until` is the bidder's (0 if never evicted). Rent due by the bidder or by the
    /// seat it would take must be settled first (`RentDue`), so the evicted dealer's pool,
    /// which this function does not see, is never owed anything.
    pub fn bid_for_seat(
        &mut self,
        dealer_id: &str,
        rent_per_hour: u128,
        pool: &mut Pool,
        now: u64,
        cooldown_until: u64,
    ) -> Result<BidOutcome, FloorError> {
        if rent_per_hour < MIN_SEAT_RENT {
            return Err(FloorError::RentTooLow);
        }
        if let Some(seat) = self.seat_of(dealer_id) {
            self.change_rent(seat, rent_per_hour, now)?;
            return Ok(BidOutcome {
                seat,
                evicted: None,
                paid: 0,
            });
        }
        if now < cooldown_until {
            return Err(FloorError::Cooldown {
                until: cooldown_until,
            });
        }
        let need = rent_per_hour
            .checked_mul(u128::from(PREPAY_HOURS))
            .ok_or(FloorError::RentTooHigh)?;
        let (seat, evicted) = self.seat_for_bid(rent_per_hour, now)?;
        if pool.free() < need {
            return Err(FloorError::CannotPrepay { need });
        }
        pay_jackpot(&mut self.jackpot, pool, need);
        self.seats[seat] = Some(Seat {
            dealer_id: dealer_id.to_string(),
            rent_per_hour,
            seated_at: now,
            paid_until: now.saturating_add(PREPAY_SECS),
            ask: None,
        });
        Ok(BidOutcome {
            seat,
            evicted,
            paid: need,
        })
    }

    /// Where a winning bid sits, and who it evicts. Changes nothing.
    fn seat_for_bid(&self, rent: u128, now: u64) -> Result<(usize, Option<String>), FloorError> {
        if self.empty_seats() > 0 {
            // Seats are in traffic order: the first empty one the bid covers is the busiest.
            return self
                .empty_seat_indexes()
                .find(|&i| rent >= seat_min_rent(i))
                .map(|i| (i, None))
                .ok_or(FloorError::RentTooLow);
        }
        let min = self.outbid_min();
        if rent < min {
            return Err(FloorError::BidTooLow { min });
        }
        let weakest = self
            .weakest_seat()
            .expect("a full floor has a weakest seat");
        let victim = self.seats[weakest].as_ref().expect("weakest seat is taken");
        if victim.paid_until < now {
            return Err(FloorError::RentDue {
                dealer_id: victim.dealer_id.clone(),
            });
        }
        Ok((weakest, Some(victim.dealer_id.clone())))
    }

    /// A seated dealer's new rent. The prepaid time left keeps its value: it is converted at the
    /// new rate (a raise shortens it, a cut stretches it). So a dealer cannot prepay cheap, raise
    /// to an unbeatable rent for protection and lower it again before paying anything: a raise
    /// starts costing at once.
    fn change_rent(&mut self, index: usize, rent: u128, now: u64) -> Result<(), FloorError> {
        if rent < seat_min_rent(index) {
            return Err(FloorError::RentTooLow);
        }
        let seat = self.seats[index].as_mut().expect("seat_of found it");
        if seat.paid_until < now {
            return Err(FloorError::RentDue {
                dealer_id: seat.dealer_id.clone(),
            });
        }
        let credit = seat
            .rent_per_hour
            .checked_mul(u128::from(seat.paid_until - now))
            .ok_or(FloorError::RentTooHigh)?;
        // Rounded down: leftover fractions of a second stay with the jackpot.
        let secs = u64::try_from(credit / rent).unwrap_or(u64::MAX);
        seat.rent_per_hour = rent;
        seat.paid_until = now.saturating_add(secs);
        Ok(())
    }

    /// What one dealer's rent strategy needs to know about the floor (`dealer_rules::rent_bid`).
    pub fn view(&self, dealer_id: &str, cooldown_until: u64) -> FloorView {
        FloorView {
            my_rent: self.seat(dealer_id).map(|seat| seat.rent_per_hour),
            lowest_rent: self.lowest_rent(),
            empty_seats: self.empty_seats(),
            outbid_min: self.outbid_min(),
            cooldown_until,
            my_min_rent: self.seat_of(dealer_id).map_or(0, seat_min_rent),
        }
    }
}

/// The floor as one dealer sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FloorView {
    /// This dealer's rent if it is seated.
    pub my_rent: Option<u128>,
    /// Lowest seated rent, this dealer's included.
    pub lowest_rent: Option<u128>,
    pub empty_seats: usize,
    pub outbid_min: u128,
    /// This dealer cannot bid before this time.
    pub cooldown_until: u64,
    /// The minimum rent of this dealer's seat (0 when off the floor): it cannot cut below it.
    pub my_min_rent: u128,
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: u128 = 1_000_000;
    const NOW: u64 = 1_800_000_000;

    fn pool(free_usdc: u128) -> Pool {
        Pool {
            bankroll: free_usdc * USDC,
            shares: free_usdc * USDC,
            reserved: 0,
            open_stakes: 0,
        }
    }

    fn full_floor() -> Floor {
        let mut floor = Floor::default();
        for (i, id) in ["a", "b", "c", "d", "e", "f"].iter().enumerate() {
            floor
                .bid_for_seat(id, (2 + i as u128) * USDC, &mut pool(100), NOW, 0)
                .unwrap();
        }
        floor
    }

    #[test]
    fn launch_seats_dealers_at_min_rent() {
        let floor = Floor::launch(&["ada", "bo"], NOW);
        assert_eq!(floor.seat_of("bo"), Some(1));
        assert_eq!(floor.empty_seats(), SEATS - 2);
        // Each at its seat's minimum: 1.5 and 1.3 USDC.
        assert_eq!(floor.lowest_rent(), Some(1_300_000));
        // The back seat is the cheapest empty one.
        assert_eq!(floor.outbid_min(), MIN_SEAT_RENT);
        assert_eq!(Floor::default().lowest_rent(), None);
    }

    #[test]
    fn a_bid_takes_the_busiest_empty_seat_it_covers() {
        let mut floor = Floor::default();
        let outcome = floor
            .bid_for_seat("ada", 1_200_000, &mut pool(100), NOW, 0)
            .unwrap();
        assert_eq!(outcome.seat, 2);
        let outcome = floor
            .bid_for_seat("bo", 1_500_000, &mut pool(100), NOW, 0)
            .unwrap();
        assert_eq!(outcome.seat, 0);
        assert_eq!(
            floor.bid_for_seat("cy", MIN_SEAT_RENT - 1, &mut pool(100), NOW, 0),
            Err(FloorError::RentTooLow)
        );
        // Seated at 1.1 USDC minimum: cannot cut under it.
        assert_eq!(
            floor.bid_for_seat("ada", 1_099_999, &mut pool(100), NOW, 0),
            Err(FloorError::RentTooLow)
        );
        // Only seats 1 and 2 (1.3, 1.1 USDC) and the back ones left: 1.0 USDC gets seat 3.
        let outcome = floor
            .bid_for_seat("cy", MIN_RENT_PER_HOUR, &mut pool(100), NOW, 0)
            .unwrap();
        assert_eq!(outcome.seat, 3);
        assert_eq!(floor.view("ada", 0).my_min_rent, 1_100_000);
        assert_eq!(floor.view("zed", 0).my_min_rent, 0);
    }

    #[test]
    fn empty_seat_bid_prepays_two_hours() {
        let mut floor = Floor::default();
        let mut p = pool(10);
        let outcome = floor.bid_for_seat("ada", 3 * USDC, &mut p, NOW, 0).unwrap();
        assert_eq!(outcome.seat, 0);
        assert_eq!(outcome.paid, 6 * USDC);
        assert_eq!(p.bankroll, 4 * USDC);
        assert_eq!(floor.jackpot, 6 * USDC);
        assert_eq!(floor.seat("ada").unwrap().paid_until, NOW + 2 * HOUR_SECS);
        // Prepaid: nothing due during the two hours.
        assert_eq!(
            floor.accrue_rent("ada", &mut p, NOW + 2 * HOUR_SECS).paid,
            0
        );
    }

    #[test]
    fn bid_refusals_change_nothing() {
        let mut floor = full_floor();
        let before = floor.clone();
        let mut p = pool(5);
        assert_eq!(
            floor.bid_for_seat("z", USDC / 2, &mut p, NOW, 0),
            Err(FloorError::RentTooLow)
        );
        assert_eq!(
            floor.bid_for_seat("z", 2 * USDC, &mut p, NOW, 0),
            Err(FloorError::BidTooLow { min: 2_200_000 })
        );
        assert_eq!(
            floor.bid_for_seat("z", 3 * USDC, &mut p, NOW, 0),
            Err(FloorError::CannotPrepay { need: 6 * USDC })
        );
        assert_eq!(
            floor.bid_for_seat("z", 3 * USDC, &mut pool(100), NOW, NOW + 1),
            Err(FloorError::Cooldown { until: NOW + 1 })
        );
        assert_eq!(
            floor.bid_for_seat("z", 3 * USDC, &mut pool(100), NOW + 3 * HOUR_SECS, 0),
            Err(FloorError::RentDue {
                dealer_id: "a".to_string()
            })
        );
        assert_eq!(floor, before);
        assert_eq!(p, pool(5));
    }

    #[test]
    fn outbid_evicts_the_lowest_rent() {
        let mut floor = full_floor();
        assert_eq!(floor.outbid_min(), 2_200_000);
        let outcome = floor
            .bid_for_seat("z", 2_200_000, &mut pool(100), NOW, 0)
            .unwrap();
        assert_eq!(outcome.evicted.as_deref(), Some("a"));
        assert_eq!(floor.seat_of("z"), Some(0));
        assert_eq!(floor.seat_of("a"), None);
    }

    #[test]
    fn outbid_tie_evicts_the_most_recently_seated() {
        let mut floor = Floor::default();
        for (i, id) in ["a", "b", "c", "d", "e", "f"].iter().enumerate() {
            floor
                .bid_for_seat(id, 5 * USDC, &mut pool(100), NOW + i as u64, 0)
                .unwrap();
        }
        let outcome = floor
            .bid_for_seat("z", 6 * USDC, &mut pool(100), NOW + 10, 0)
            .unwrap();
        assert_eq!(outcome.evicted.as_deref(), Some("f"));
        assert_eq!(outcome.seat, 5);
    }

    #[test]
    fn rent_accrues_per_second_rounded_up() {
        // Seat 4 (index 3) has the average traffic: 1 USDC/h.
        let mut floor = Floor::launch(&["a", "b", "c", "ada"], NOW);
        let mut p = pool(10);
        // 1 USDC/h for 1 s: 277.7… units, rounded up.
        assert_eq!(floor.rent_owed("ada", NOW + 1), 278);
        let outcome = floor.accrue_rent("ada", &mut p, NOW + HOUR_SECS);
        assert_eq!(
            outcome,
            RentOutcome {
                paid: USDC,
                evicted: None
            }
        );
        assert_eq!(floor.jackpot, USDC);
        assert_eq!(p.bankroll, 9 * USDC);
        assert_eq!(floor.rent_owed("ada", NOW + HOUR_SECS), 0);
    }

    #[test]
    fn unpaid_rent_evicts_and_takes_what_is_free() {
        let mut floor = Floor::launch(&["ada"], NOW);
        let mut p = pool(10);
        p.reserved = 9 * USDC + USDC / 2;
        let outcome = floor.accrue_rent("ada", &mut p, NOW + HOUR_SECS);
        assert_eq!(
            outcome,
            RentOutcome {
                paid: USDC / 2,
                evicted: Some(EvictReason::UnpaidRent)
            }
        );
        assert_eq!(p.free(), 0);
        assert_eq!(p.reserved, p.bankroll);
        assert_eq!(floor.seat_of("ada"), None);
        assert_eq!(EvictReason::UnpaidRent.code(), "unpaid_rent");
    }

    #[test]
    fn raising_rent_spends_the_prepaid_time_faster() {
        let mut floor = Floor::default();
        floor
            .bid_for_seat("ada", 2 * USDC, &mut pool(100), NOW, 0)
            .unwrap();
        let mut p = pool(100);
        let outcome = floor.bid_for_seat("ada", 8 * USDC, &mut p, NOW, 0).unwrap();
        assert_eq!(outcome.paid, 0);
        // 2 h at 2 USDC = 30 min at 8 USDC.
        assert_eq!(floor.seat("ada").unwrap().paid_until, NOW + HOUR_SECS / 2);
        // A cut back stretches it again, it never refunds.
        floor.bid_for_seat("ada", 2 * USDC, &mut p, NOW, 0).unwrap();
        assert_eq!(floor.seat("ada").unwrap().paid_until, NOW + 2 * HOUR_SECS);
        assert_eq!(p, pool(100));
        assert_eq!(
            floor.bid_for_seat("ada", USDC - 1, &mut p, NOW, 0),
            Err(FloorError::RentTooLow)
        );
    }

    #[test]
    fn table_validation() {
        assert_eq!(
            validate_new_table("my-table", "My Table", MIN_TABLE_SEED, 5),
            Ok(())
        );
        assert_eq!(
            validate_new_table("my-table", "My Table", MIN_TABLE_SEED - 1, 5),
            Err(FloorError::SeedTooLow)
        );
        assert_eq!(
            validate_new_table("my-table", "My Table", MIN_TABLE_SEED, MAX_DEALERS),
            Err(FloorError::TooManyDealers)
        );
        for bad in ["", "My", "a.b", &"a".repeat(33)] {
            assert_eq!(
                validate_new_table(bad, "x", MIN_TABLE_SEED, 0),
                Err(FloorError::BadTableId)
            );
        }
        for bad in ["", " x", "a\nb", &"a".repeat(33)] {
            assert_eq!(
                validate_new_table("x", bad, MIN_TABLE_SEED, 0),
                Err(FloorError::BadTableName)
            );
        }
        assert!(can_set_temperament(0, NOW));
        assert!(!can_set_temperament(NOW, NOW + HOUR_SECS - 1));
        assert!(can_set_temperament(NOW, NOW + HOUR_SECS));
    }

    #[test]
    fn floor_json() {
        let floor = Floor::launch(&["ada"], NOW);
        let json = serde_json::to_value(&floor).unwrap();
        assert_eq!(json["jackpot"], "0");
        assert_eq!(json["seats"][0]["rent_per_hour"], "1500000");
        assert!(json["seats"][0]["ask"].is_null());
        assert!(json["seats"][1].is_null());
        let mut listed = floor.clone();
        listed.list_seat("ada", Some(7)).unwrap();
        let json = serde_json::to_string(&listed).unwrap();
        assert!(json.contains(r#""ask":"7""#));
        assert_eq!(serde_json::from_str::<Floor>(&json).unwrap(), listed);
    }
}
