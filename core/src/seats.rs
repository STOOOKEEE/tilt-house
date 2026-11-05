//! # Seats: traffic and the seat market (docs/tycoon.md, "Seats")
//!
//! Seats are not equal. Seat 1 is by the entrance and sees 1.5× the passers-by; the last seat,
//! at the back, sees 0.6×. Gamblers weigh that traffic (`gambler_rules`), and the minimum rent of
//! a seat scales with it: `seat_min_rent(seat) = MIN_RENT_PER_HOUR × traffic`.
//!
//! A seated dealer's controller may put its seat up for sale (`list_seat`). Another controller
//! buys it (`buy_seat`): its dealer takes the seat at once, with the seat's rent and whatever
//! prepaid time is left, and the seller's dealer goes off the floor (no cooldown: it sold, it was
//! not evicted). The price moves between the controllers' balances, which the caller holds.
//!
//! Every function checks everything before it changes anything: an `Err` leaves the floor
//! untouched. Amounts are USDC base units (6 decimals).

use crate::floor::{Floor, FloorError, Seat, MIN_RENT_PER_HOUR, SEATS};
use crate::BP;

/// Passers-by at each seat relative to an average seat, in bp (seat 1 = index 0, by the entrance).
pub const SEAT_TRAFFIC_BP: [u16; SEATS] = [15_000, 13_000, 11_000, 10_000, 8_000, 6_000];

/// Cheapest rent any seat can be held for: the back seat's minimum (0.6 USDC an hour).
pub const MIN_SEAT_RENT: u128 = MIN_RENT_PER_HOUR * SEAT_TRAFFIC_BP[SEATS - 1] as u128 / BP;

/// Cheapest rent this seat can be held for. Out-of-range seats count as the back seat.
pub fn seat_min_rent(seat: usize) -> u128 {
    let traffic = SEAT_TRAFFIC_BP
        .get(seat)
        .copied()
        .unwrap_or(SEAT_TRAFFIC_BP[SEATS - 1]);
    MIN_RENT_PER_HOUR * u128::from(traffic) / BP
}

/// What a seat sale did. The caller moves `price` from the buyer's controller to `seller`'s.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeatSale {
    /// The dealer that left the floor.
    pub seller: String,
    pub price: u128,
}

impl Floor {
    /// A seated dealer's controller puts its seat up for `price`, or takes it off sale (`None`).
    pub fn list_seat(&mut self, dealer_id: &str, price: Option<u128>) -> Result<(), FloorError> {
        if price == Some(0) {
            return Err(FloorError::BadPrice);
        }
        let index = self.seat_of(dealer_id).ok_or(FloorError::NotSeated)?;
        if let Some(seat) = self.seats[index].as_mut() {
            seat.ask = price;
        }
        Ok(())
    }

    /// `buyer_id`'s dealer buys seat `seat` at its asking price, if that is at most `max_price`
    /// (protects the buyer from a price raised under it). The seat keeps its rent and prepaid
    /// time; rent due on it must be settled first (`RentDue`), so the seller's pool owes nothing.
    pub fn buy_seat(
        &mut self,
        seat: usize,
        buyer_id: &str,
        max_price: u128,
        now: u64,
    ) -> Result<SeatSale, FloorError> {
        if self.seat_of(buyer_id).is_some() {
            return Err(FloorError::AlreadySeated);
        }
        let current = self
            .seats
            .get(seat)
            .and_then(Option::as_ref)
            .ok_or(FloorError::NotListed)?;
        let price = current.ask.ok_or(FloorError::NotListed)?;
        if price > max_price {
            return Err(FloorError::PriceAbove { ask: price });
        }
        if current.paid_until < now {
            return Err(FloorError::RentDue {
                dealer_id: current.dealer_id.clone(),
            });
        }
        let seller = current.dealer_id.clone();
        let sold = Seat {
            dealer_id: buyer_id.to_string(),
            seated_at: now,
            ask: None,
            ..current.clone()
        };
        self.seats[seat] = Some(sold);
        Ok(SeatSale { seller, price })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::floor::HOUR_SECS;
    use crate::Pool;

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

    #[test]
    fn traffic_scales_min_rent() {
        assert_eq!(seat_min_rent(0), 1_500_000);
        assert_eq!(seat_min_rent(3), MIN_RENT_PER_HOUR);
        assert_eq!(seat_min_rent(5), MIN_SEAT_RENT);
        assert_eq!(MIN_SEAT_RENT, 600_000);
        assert_eq!(seat_min_rent(99), MIN_SEAT_RENT);
    }

    #[test]
    fn listing_needs_a_seat_and_a_price() {
        let mut floor = Floor::launch(&["ada"], NOW);
        assert_eq!(
            floor.list_seat("bo", Some(USDC)),
            Err(FloorError::NotSeated)
        );
        assert_eq!(floor.list_seat("ada", Some(0)), Err(FloorError::BadPrice));
        floor.list_seat("ada", Some(5 * USDC)).unwrap();
        assert_eq!(floor.seat("ada").unwrap().ask, Some(5 * USDC));
        floor.list_seat("ada", None).unwrap();
        assert_eq!(floor.seat("ada").unwrap().ask, None);
    }

    #[test]
    fn buying_moves_the_seat_with_its_prepaid_time() {
        let mut floor = Floor::default();
        floor
            .bid_for_seat("ada", 2 * USDC, &mut pool(100), NOW, 0)
            .unwrap();
        floor.list_seat("ada", Some(30 * USDC)).unwrap();
        let sale = floor.buy_seat(0, "bo", 30 * USDC, NOW + 60).unwrap();
        assert_eq!(
            sale,
            SeatSale {
                seller: "ada".to_string(),
                price: 30 * USDC
            }
        );
        let seat = floor.seat("bo").unwrap();
        assert_eq!(seat.rent_per_hour, 2 * USDC);
        assert_eq!(seat.paid_until, NOW + 2 * HOUR_SECS);
        assert_eq!(seat.ask, None);
        assert_eq!(floor.seat_of("ada"), None);
    }

    #[test]
    fn buy_refusals_change_nothing() {
        let mut floor = Floor::default();
        floor
            .bid_for_seat("ada", 2 * USDC, &mut pool(100), NOW, 0)
            .unwrap();
        floor
            .bid_for_seat("bo", 2 * USDC, &mut pool(100), NOW, 0)
            .unwrap();
        let before = floor.clone();
        assert_eq!(
            floor.buy_seat(0, "zed", USDC, NOW),
            Err(FloorError::NotListed)
        );
        assert_eq!(
            floor.buy_seat(5, "zed", USDC, NOW),
            Err(FloorError::NotListed)
        );
        floor.list_seat("ada", Some(10 * USDC)).unwrap();
        let listed = floor.clone();
        assert_eq!(
            floor.buy_seat(0, "zed", 9 * USDC, NOW),
            Err(FloorError::PriceAbove { ask: 10 * USDC })
        );
        assert_eq!(
            floor.buy_seat(0, "bo", 10 * USDC, NOW),
            Err(FloorError::AlreadySeated)
        );
        assert_eq!(
            floor.buy_seat(0, "ada", 10 * USDC, NOW),
            Err(FloorError::AlreadySeated)
        );
        assert_eq!(
            floor.buy_seat(0, "zed", 10 * USDC, NOW + 3 * HOUR_SECS),
            Err(FloorError::RentDue {
                dealer_id: "ada".to_string()
            })
        );
        assert_eq!(floor, listed);
        assert_ne!(floor, before);
    }
}
