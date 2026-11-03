//! A dealer's liquidity pool. LPs own `shares`; the pool backs every bet at its table.
//!
//! - `bankroll`: settled money of the pool.
//! - `open_stakes`: stakes of rounds still open, held apart until the round settles.
//! - `reserved`: worst-case payouts of open rounds; that part of the bankroll cannot leave.
//!
//! Buying is priced as if every open bet lost for the players (bankroll + open stakes), selling
//! as if every open bet won at its worst case (bankroll − reserved). The spread removes the
//! "sell just before a known loss" trade. Buys never go below 1 base unit per share, so a
//! busted pool can be rescued without minting absurd share counts; sells always pay the true
//! value, so that floor can never pay out money the pool does not have.
//!
//! Invariant kept by every method: `reserved ≤ bankroll`.

use std::fmt;

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::{worst_case_multiple, Game};

#[derive(
    Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
pub struct Pool {
    #[serde(with = "crate::amount_str")]
    pub bankroll: u128,
    #[serde(with = "crate::amount_str")]
    pub shares: u128,
    #[serde(with = "crate::amount_str")]
    pub reserved: u128,
    #[serde(with = "crate::amount_str")]
    pub open_stakes: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoolError {
    ZeroShares,
    /// More shares than exist.
    NotEnoughShares,
    /// The free bankroll cannot cover the payout or the bet's worst case.
    NotEnoughFree,
    /// The shares are worth nothing right now.
    ZeroPayout,
    /// Settling or refunding more than is open.
    NotOpen,
    /// The payout exceeds what was reserved for the round.
    PayoutAboveReserve,
}

impl fmt::Display for PoolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::ZeroShares => "zero shares",
            Self::NotEnoughShares => "not enough shares",
            Self::NotEnoughFree => "the pool's free bankroll cannot cover this",
            Self::ZeroPayout => "these shares are worth nothing right now",
            Self::NotOpen => "no such open stake or reserve",
            Self::PayoutAboveReserve => "payout above the round's reserve",
        })
    }
}

impl std::error::Error for PoolError {}

/// `a × b / c` rounded down, `None` on overflow or division by zero.
fn mul_div(a: u128, b: u128, c: u128) -> Option<u128> {
    a.checked_mul(b)?.checked_div(c)
}

impl Pool {
    /// Bankroll not backing any open bet.
    pub fn free(&self) -> u128 {
        self.bankroll.saturating_sub(self.reserved)
    }

    /// Adds `amount` to the bankroll and returns the shares minted for it (rounded down, in the
    /// existing holders' favour). The first deposit mints 1 share per base unit. Returns 0 and
    /// changes nothing when the amount is too small to buy one share (or on overflow): the caller
    /// must refuse the deposit.
    pub fn buy_shares(&mut self, amount: u128) -> u128 {
        let minted = if self.shares == 0 {
            amount
        } else {
            let value = self
                .bankroll
                .saturating_add(self.open_stakes)
                .max(self.shares);
            mul_div(amount, self.shares, value).unwrap_or(0)
        };
        let (Some(bankroll), Some(shares)) = (
            self.bankroll.checked_add(amount),
            self.shares.checked_add(minted),
        ) else {
            return 0;
        };
        if minted == 0 {
            return 0;
        }
        self.bankroll = bankroll;
        self.shares = shares;
        minted
    }

    /// Burns `shares` and returns what they are worth at the sell price, taken from the free
    /// bankroll. Rounded down.
    pub fn sell_shares(&mut self, shares: u128) -> Result<u128, PoolError> {
        if shares == 0 {
            return Err(PoolError::ZeroShares);
        }
        if shares > self.shares {
            return Err(PoolError::NotEnoughShares);
        }
        let free = self.free();
        let payout = mul_div(shares, free, self.shares).ok_or(PoolError::NotEnoughFree)?;
        if payout > free {
            return Err(PoolError::NotEnoughFree);
        }
        if payout == 0 {
            return Err(PoolError::ZeroPayout);
        }
        self.shares -= shares;
        self.bankroll -= payout;
        Ok(payout)
    }

    pub fn can_cover(&self, worst: u128) -> bool {
        self.free() >= worst
    }

    /// A table is open while its pool can cover the worst case of a minimum bet.
    pub fn is_open(&self, min_bet: u128, game: Game) -> bool {
        self.can_cover(min_bet.saturating_mul(worst_case_multiple(game)))
    }

    /// Takes a bet: holds the stake apart and reserves its worst case. Refused if the free
    /// bankroll cannot cover it.
    pub fn open_bet(&mut self, stake: u128, worst: u128) -> Result<(), PoolError> {
        if !self.can_cover(worst) {
            return Err(PoolError::NotEnoughFree);
        }
        let open_stakes = self
            .open_stakes
            .checked_add(stake)
            .ok_or(PoolError::NotEnoughFree)?;
        self.reserved += worst; // cannot overflow: worst ≤ bankroll − reserved
        self.open_stakes = open_stakes;
        Ok(())
    }

    /// Extra stake on an open round (a blackjack double). Its worst case was reserved at the deal.
    pub fn add_stake(&mut self, extra: u128) -> Result<(), PoolError> {
        self.open_stakes = self
            .open_stakes
            .checked_add(extra)
            .ok_or(PoolError::NotEnoughFree)?;
        Ok(())
    }

    /// Settles a round: the stake joins the bankroll, the payout leaves it, the reserve is freed.
    /// `payout ≤ worst` keeps the bankroll above the remaining reserve.
    pub fn settle(&mut self, stake: u128, worst: u128, payout: u128) -> Result<(), PoolError> {
        self.release(stake, worst)?;
        if payout > worst {
            return Err(PoolError::PayoutAboveReserve);
        }
        self.reserved -= worst;
        self.open_stakes -= stake;
        self.bankroll = self.bankroll + stake - payout;
        Ok(())
    }

    /// Cancels a round (VRF never answered): the stake goes back to the player, the reserve is
    /// freed, the bankroll does not move.
    pub fn refund(&mut self, stake: u128, worst: u128) -> Result<(), PoolError> {
        self.release(stake, worst)?;
        self.reserved -= worst;
        self.open_stakes -= stake;
        Ok(())
    }

    fn release(&self, stake: u128, worst: u128) -> Result<(), PoolError> {
        if stake > self.open_stakes || worst > self.reserved {
            return Err(PoolError::NotOpen);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn funded(amount: u128) -> Pool {
        let mut pool = Pool::default();
        assert_eq!(pool.buy_shares(amount), amount);
        pool
    }

    #[test]
    fn first_buy_is_one_to_one_then_priced_at_value() {
        let mut pool = funded(1_000);
        pool.bankroll = 2_000; // the pool doubled
        assert_eq!(pool.buy_shares(500), 250);
        assert_eq!(pool.shares, 1_250);
        assert_eq!(pool.bankroll, 2_500);
    }

    #[test]
    fn buy_counts_open_stakes() {
        let mut pool = funded(1_000);
        pool.open_bet(1_000, 2_000).unwrap_err(); // cannot cover
        pool.open_bet(500, 1_000).unwrap();
        // Bought as if the open bet lost for the player: value 1_500 for 1_000 shares.
        assert_eq!(pool.buy_shares(1_500), 1_000);
    }

    #[test]
    fn buy_price_floor_is_one_unit_per_share() {
        let mut pool = funded(1_000);
        pool.bankroll = 10; // busted
        assert_eq!(pool.buy_shares(100), 100);
        assert_eq!(pool.shares, 1_100);
    }

    #[test]
    fn buy_too_small_changes_nothing() {
        let mut pool = funded(10);
        pool.bankroll = 1_000;
        let before = pool.clone();
        assert_eq!(pool.buy_shares(50), 0);
        assert_eq!(pool, before);
    }

    #[test]
    fn sell_pays_value_and_burns() {
        let mut pool = funded(1_000);
        pool.bankroll = 1_500;
        assert_eq!(pool.sell_shares(400), Ok(600));
        assert_eq!(pool.shares, 600);
        assert_eq!(pool.bankroll, 900);
    }

    #[test]
    fn sell_cannot_take_reserved_money() {
        let mut pool = funded(1_000);
        pool.open_bet(100, 900).unwrap();
        // Priced as if the open bet won at its worst case: free 100 for 1_000 shares.
        assert_eq!(pool.sell_shares(1_000), Ok(100));
        assert_eq!(pool.bankroll, 900);
        assert_eq!(pool.reserved, 900);
        assert_eq!(pool.sell_shares(1), Err(PoolError::NotEnoughShares));
        // The round can still pay its worst case.
        pool.settle(100, 900, 900).unwrap();
        assert_eq!(pool.bankroll, 100);
        assert_eq!(pool.reserved, 0);
    }

    #[test]
    fn sell_errors() {
        let mut pool = funded(1_000);
        assert_eq!(pool.sell_shares(0), Err(PoolError::ZeroShares));
        assert_eq!(pool.sell_shares(1_001), Err(PoolError::NotEnoughShares));
        pool.open_bet(10, 1_000).unwrap();
        assert_eq!(pool.sell_shares(500), Err(PoolError::ZeroPayout));
    }

    #[test]
    fn settle_and_refund() {
        let mut pool = funded(1_000);
        pool.open_bet(10, 40).unwrap();
        pool.add_stake(10).unwrap();
        assert_eq!(pool.settle(20, 40, 41), Err(PoolError::PayoutAboveReserve));
        pool.settle(20, 40, 40).unwrap();
        assert_eq!(
            (pool.bankroll, pool.reserved, pool.open_stakes),
            (980, 0, 0)
        );

        pool.open_bet(10, 20).unwrap();
        pool.settle(10, 20, 0).unwrap();
        assert_eq!(pool.bankroll, 990);

        pool.open_bet(10, 20).unwrap();
        pool.refund(10, 20).unwrap();
        assert_eq!(
            (pool.bankroll, pool.reserved, pool.open_stakes),
            (990, 0, 0)
        );
        assert_eq!(pool.refund(10, 20), Err(PoolError::NotOpen));
        assert_eq!(pool.settle(0, 1, 0), Err(PoolError::NotOpen));
    }

    #[test]
    fn open_and_close_by_min_bet() {
        let pool = funded(3_599);
        assert!(!pool.is_open(100, Game::Roulette));
        assert!(pool.is_open(99, Game::Roulette));
        assert!(pool.is_open(100, Game::Blackjack));
        assert!(!Pool::default().is_open(1, Game::Dice));
    }

    #[test]
    fn json_amounts_are_strings() {
        let json = serde_json::to_string(&funded(5)).unwrap();
        assert_eq!(
            json,
            r#"{"bankroll":"5","shares":"5","reserved":"0","open_stakes":"0"}"#
        );
    }

    /// Random sequences of every operation never break `reserved ≤ bankroll` nor let money appear.
    #[test]
    fn invariants_hold_under_random_operations() {
        let mut rng = crate::Rng::new([42; 32]);
        for _ in 0..200 {
            let mut pool = funded(u128::from(rng.below(1_000_000)) + 1);
            let mut open: Vec<(u128, u128)> = Vec::new();
            for _ in 0..200 {
                let before = pool.clone();
                match rng.below(4) {
                    0 => {
                        pool.buy_shares(u128::from(rng.below(100_000)));
                    }
                    1 => {
                        let _ = pool.sell_shares(u128::from(rng.below(200_000)));
                    }
                    2 => {
                        let stake = u128::from(rng.below(10_000)) + 1;
                        let worst = stake * u128::from(rng.below(36) + 1);
                        if pool.open_bet(stake, worst).is_ok() {
                            open.push((stake, worst));
                        }
                    }
                    _ => {
                        if let Some((stake, worst)) = open.pop() {
                            let payout = u128::from(rng.below(u32::try_from(worst).unwrap() + 1));
                            pool.settle(stake, worst, payout).unwrap();
                            assert_eq!(pool.bankroll + payout, before.bankroll + stake);
                        }
                    }
                }
                assert!(pool.reserved <= pool.bankroll);
                assert_eq!(pool.reserved, open.iter().map(|o| o.1).sum::<u128>());
                assert_eq!(pool.open_stakes, open.iter().map(|o| o.0).sum::<u128>());
            }
        }
    }
}
