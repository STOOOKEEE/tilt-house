//! The floor (docs/floor.md, docs/tycoon.md): seats, rent into the jackpot, evictions, NPC rent
//! bids and the seat market. The rules are `core_rules::Floor`; this module moves the money,
//! keeps the seat lease tokens (`seat-<n>`) with the seated dealers' controllers and logs.

use core_rules::floor::SEATS;
use core_rules::{cooldown_until, RentAction};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, AccountId};

use crate::dealers::{Dealer, LogKind};
use crate::views::to_json;
use crate::{emit, fail, mt, now, House, HouseExt};

/// JSON seat number (1 = by the entrance) of a core seat index.
pub fn seat_number(index: usize) -> usize {
    index + 1
}

pub fn seat_token(index: usize) -> String {
    format!("seat-{}", seat_number(index))
}

/// Core seat index of a `seat-<n>` token id.
pub fn seat_index(token_id: &str) -> Option<usize> {
    let number: usize = token_id.strip_prefix("seat-")?.parse().ok()?;
    (1..=SEATS).contains(&number).then(|| number - 1)
}

#[near]
impl House {
    /// Anyone (the keeper, every minute): settles every seated dealer's rent.
    pub fn collect_rent(&mut self) {
        let total = self.collect_all(now());
        if total > 0 {
            emit("rent_collected", json!({ "total": total.to_string() }));
        }
    }

    /// Owner only, once, on an empty floor: seats the launch dealers in order at their seat's
    /// minimum rent, accruing from now (`core::Floor::launch`, no prepay).
    pub fn launch_floor(&mut self, dealer_ids: Vec<String>) {
        self.assert_owner();
        require!(
            self.floor.seated().next().is_none(),
            "the floor already has seated dealers"
        );
        require!(
            !dealer_ids.is_empty() && dealer_ids.len() <= SEATS,
            "launch 1 to 6 dealers"
        );
        for (i, id) in dealer_ids.iter().enumerate() {
            require!(self.dealer_ids.contains(id), "unknown dealer");
            require!(!dealer_ids[..i].contains(id), "a dealer is listed twice");
        }
        let now = now();
        let ids: Vec<&str> = dealer_ids.iter().map(String::as_str).collect();
        let jackpot = self.floor.jackpot;
        *self.floor = core_rules::Floor::launch(&ids, now);
        self.floor.jackpot = jackpot;
        for id in &dealer_ids {
            let mut dealer = self.dealer(id);
            self.on_seated(&mut dealer, 0);
            self.save_dealer(dealer);
        }
    }

    /// The controller bids for a seat, or changes its seated dealer's rent. Returns the seat
    /// number (1..6).
    pub fn bid_for_seat(&mut self, dealer_id: String, rent_per_hour: U128) -> u8 {
        self.controlled_dealer(&dealer_id);
        self.place_bid(&dealer_id, rent_per_hour.0, now())
    }

    /// The keeper (or the controller) runs an NPC dealer's rent strategy
    /// (`core::rent_bid`). Returns the `RentDecision`.
    pub fn rent_bid(&mut self, dealer_id: String) -> Value {
        let dealer = self.active_dealer(&dealer_id);
        require!(dealer.npc, "only NPC dealers bid by themselves");
        self.assert_keeper_or_controller(&dealer);
        let now = now();
        self.collect_all(now);
        let dealer = self.dealer(&dealer_id);
        let view = self.floor.view(&dealer_id, dealer.cooldown_until);
        let decision = core_rules::rent_bid(
            &dealer.pool,
            &self.full_stats(&dealer, now),
            &dealer.traits,
            &view,
            now,
        );
        match decision.action {
            RentAction::Raise(rent)
            | RentAction::Lower(rent)
            | RentAction::BidEmpty(rent)
            | RentAction::Outbid(rent) => {
                self.place_bid(&dealer_id, rent, now);
            }
            RentAction::Keep | RentAction::Stay => {}
        }
        to_json(&decision)
    }

    /// Lists the seated dealer's seat for sale at `price` (`null` unlists).
    pub fn list_seat(&mut self, dealer_id: String, price: Option<U128>) {
        self.assert_not_npc();
        let mut dealer = self.controlled_dealer(&dealer_id);
        let price = price.map(|p| p.0);
        self.floor
            .list_seat(&dealer_id, price)
            .unwrap_or_else(|e| fail(&e.to_string()));
        let index = self
            .floor
            .seat_of(&dealer_id)
            .unwrap_or_else(|| fail("the dealer is not seated"));
        self.log(
            &mut dealer,
            LogKind::Listed,
            None,
            price.unwrap_or(0),
            seat_token(index),
        );
        emit(
            "seat_listed",
            json!({
                "dealer_id": dealer_id,
                "seat": seat_number(index),
                "price": price.map(|p| p.to_string()),
            }),
        );
        self.save_dealer(dealer);
    }

    /// The controller of the off-floor `dealer_id` buys a listed seat: the ask (≤ `max_price`)
    /// moves from the caller's balance to the seller's controller, the seat (rent, prepaid time)
    /// to `dealer_id`; the seller's dealer goes off the floor without cooldown.
    pub fn buy_seat(&mut self, seat: u8, dealer_id: String, max_price: U128) {
        self.assert_not_npc();
        let mut buyer = self.controlled_dealer(&dealer_id);
        let index = usize::from(seat)
            .checked_sub(1)
            .filter(|i| *i < SEATS)
            .unwrap_or_else(|| fail("seat must be 1 to 6"));
        let now = now();
        self.collect_all(now);
        let sale = self
            .floor
            .buy_seat(index, &dealer_id, max_price.0, now)
            .unwrap_or_else(|e| fail(&e.to_string()));
        let mut seller = self.dealer(&sale.seller);
        let buyer_account = env::predecessor_account_id();
        self.debit(&buyer_account, sale.price);
        self.credit(&seller.controller, sale.price);
        let token = seat_token(index);
        self.log(
            &mut seller,
            LogKind::Sold,
            Some(buyer_account.clone()),
            sale.price,
            token.clone(),
        );
        self.log(
            &mut buyer,
            LogKind::Bought,
            Some(seller.controller.clone()),
            sale.price,
            token.clone(),
        );
        mt::emit_transfer(&seller.controller, &buyer_account, &token, 1, None);
        emit(
            "seat_sold",
            json!({
                "seat": seat_number(index),
                "seller": seller.controller,
                "buyer": buyer_account,
                "from_dealer": seller.id,
                "to_dealer": buyer.id,
                "price": sale.price.to_string(),
            }),
        );
        self.save_dealer(seller);
        self.save_dealer(buyer);
    }
}

impl House {
    /// Settles every seated dealer's rent; returns the total paid.
    pub(crate) fn collect_all(&mut self, now: u64) -> u128 {
        let seated: Vec<String> = self
            .floor
            .seated()
            .map(|seat| seat.dealer_id.clone())
            .collect();
        let mut total: u128 = 0;
        for id in seated {
            let mut dealer = self.dealer(&id);
            total = total.saturating_add(self.settle_rent(&mut dealer, now));
            self.save_dealer(dealer);
        }
        total
    }

    /// Settles this dealer's rent (lazily, on every interaction); evicts it if its pool can't
    /// pay. Returns the rent paid. The caller saves the dealer.
    pub(crate) fn settle_rent(&mut self, dealer: &mut Dealer, now: u64) -> u128 {
        let Some(index) = self.floor.seat_of(&dealer.id) else {
            return 0;
        };
        let outcome = self.floor.accrue_rent(&dealer.id, &mut dealer.pool, now);
        dealer.record_rent(now, outcome.paid);
        if let Some(reason) = outcome.evicted {
            self.on_evicted(dealer, index, reason.code(), outcome.paid, now);
        }
        outcome.paid
    }

    /// Takes a bid after settling all rent (core refuses bids while rent is due). Returns the
    /// seat number.
    pub(crate) fn place_bid(&mut self, dealer_id: &str, rent: u128, now: u64) -> u8 {
        self.collect_all(now);
        let mut dealer = self.dealer(dealer_id);
        let was_seated = self.floor.seat_of(dealer_id).is_some();
        let outcome = self
            .floor
            .bid_for_seat(
                dealer_id,
                rent,
                &mut dealer.pool,
                now,
                dealer.cooldown_until,
            )
            .unwrap_or_else(|e| fail(&e.to_string()));
        if let Some(victim_id) = &outcome.evicted {
            let mut victim = self.dealer(victim_id);
            self.on_evicted(&mut victim, outcome.seat, "outbid", 0, now);
            self.save_dealer(victim);
        }
        dealer.record_rent(now, outcome.paid);
        if was_seated {
            self.log(
                &mut dealer,
                LogKind::Rent,
                None,
                rent,
                seat_token(outcome.seat),
            );
            emit(
                "rent_changed",
                json!({
                    "dealer_id": dealer_id,
                    "seat": seat_number(outcome.seat),
                    "rent_per_hour": rent.to_string(),
                }),
            );
        } else {
            // A seat is the floor's scarcest thing: a table whose pool can no longer take a
            // minimum bet once the rent is prepaid would hold it (and may have evicted an open
            // table for it) without taking a single bet. Panicking reverts the whole bid.
            require!(
                dealer.is_open(),
                "after prepaying the rent the pool could not cover a minimum bet: add liquidity first"
            );
            self.on_seated(&mut dealer, outcome.paid);
        }
        self.save_dealer(dealer);
        // SEATS ≤ 255: the seat number always fits.
        u8::try_from(seat_number(outcome.seat)).unwrap_or(u8::MAX)
    }

    /// Log, event and lease token of a dealer that just took a seat.
    fn on_seated(&mut self, dealer: &mut Dealer, prepaid: u128) {
        let Some(seat) = self.floor.seat(&dealer.id).cloned() else {
            return;
        };
        let index = self.floor.seat_of(&dealer.id).unwrap_or_default();
        let token = seat_token(index);
        self.log(dealer, LogKind::Seated, None, prepaid, token.clone());
        emit(
            "seated",
            json!({
                "dealer_id": dealer.id,
                "seat": seat_number(index),
                "rent_per_hour": seat.rent_per_hour.to_string(),
                "prepaid": prepaid.to_string(),
            }),
        );
        mt::emit_mint(&dealer.controller, &token, 1);
    }

    /// An eviction: cooldown (`core::cooldown_until`), log, event, lease token burnt.
    fn on_evicted(
        &mut self,
        dealer: &mut Dealer,
        index: usize,
        reason: &str,
        paid: u128,
        now: u64,
    ) {
        dealer.cooldown_until = cooldown_until(now);
        let token = seat_token(index);
        self.log(dealer, LogKind::Evicted, None, paid, reason.to_string());
        emit(
            "evicted",
            json!({
                "dealer_id": dealer.id,
                "seat": seat_number(index),
                "reason": reason,
                "paid": paid.to_string(),
            }),
        );
        mt::emit_burn(&dealer.controller, &token, 1);
    }

    /// Controller of the dealer seated at `index`: the holder of `seat-<index+1>`.
    pub(crate) fn seat_holder(&self, index: usize) -> Option<AccountId> {
        let seat = self.floor.seats.get(index)?.as_ref()?;
        self.dealers
            .get(&seat.dealer_id)
            .map(|d| d.controller.clone())
    }
}
