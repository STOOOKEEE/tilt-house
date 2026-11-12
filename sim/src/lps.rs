//! Simulated liquidity providers. Each checks the pools now and then and moves money with
//! `Pool::buy_shares` / `Pool::sell_shares`, so they pay the same prices as on chain.
//!
//! - The house seeds every dealer at launch, then sells like anyone else: it cuts a dealer whose
//!   share price fell too far over 24 h.
//! - Movers chase the best trailing-24 h share-price return and leave laggards.
//! - Profit takers sit in a pool and sell half once it is up enough.
//! - Rescuers only buy into closed tables, at the low price a bust leaves, and cash out later.
//!
//! Movers and profit takers also cut a pool that falls past their stop-loss.

use core_rules::Rng;

use crate::world::{Dealer, HOUR, PRICE_SCALE, USDC};

const MOVERS: usize = 14;
const PROFIT_TAKERS: usize = 6;
const RESCUERS: usize = 4;

/// Below this much cash, an LP does not bother buying.
const MIN_INVEST: u128 = 10 * USDC;
/// A mover leaves a pool trailing the best one by this much over 24 h.
const MOVE_GAP: f64 = 0.01;
/// The house cuts a dealer down this much over 24 h.
const HOUSE_STOP_LOSS: f64 = 0.03;
/// A profit taker sells half its position once it is up this much.
const TAKE_PROFIT: f64 = 0.04;
/// A rescuer cashes out once its rescue is up this much.
const RESCUE_PROFIT: f64 = 0.15;
/// Rescuers only buy a closed table at or under the launch price.
const RESCUE_MAX_PRICE: u128 = PRICE_SCALE;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    House,
    Mover,
    ProfitTaker,
    Rescuer,
}

pub struct Lp {
    pub kind: Kind,
    pub wallet: u128,
    pub shares: Vec<u128>,
    /// What the LP paid for its current shares, per dealer (reduced pro rata on sells).
    cost: Vec<u128>,
    /// 24 h loss at which this LP sells a pool.
    stop_loss: f64,
    /// Seconds between two looks at the pools.
    period: u64,
    next_check: u64,
}

/// Uniform integer in `lo..=hi`.
fn between(rng: &mut Rng, lo: u64, hi: u64) -> u64 {
    lo + u64::from(rng.below((hi - lo + 1) as u32))
}

/// Uniform in [0, 1).
fn unit(rng: &mut Rng) -> f64 {
    const RESOLUTION: u32 = 1 << 30;
    f64::from(rng.below(RESOLUTION)) / f64::from(RESOLUTION)
}

fn lp(rng: &mut Rng, kind: Kind) -> Lp {
    let (wallet_usdc, period, stop_loss) = match kind {
        Kind::House => (0, 2 * HOUR, HOUSE_STOP_LOSS),
        Kind::Mover => (
            between(rng, 300, 2_000),
            between(rng, 1, 6) * HOUR,
            0.02 + 0.03 * unit(rng),
        ),
        Kind::ProfitTaker => (
            between(rng, 300, 1_500),
            between(rng, 2, 8) * HOUR,
            0.03 + 0.04 * unit(rng),
        ),
        Kind::Rescuer => (between(rng, 500, 3_000), 30 * 60, f64::INFINITY),
    };
    Lp {
        kind,
        wallet: u128::from(wallet_usdc) * USDC,
        shares: Vec::new(),
        cost: Vec::new(),
        stop_loss,
        period,
        next_check: between(rng, 1, period),
    }
}

/// The house first, then the other LPs.
pub fn population(rng: &mut Rng) -> Vec<Lp> {
    let mut lps = vec![lp(rng, Kind::House)];
    for (kind, count) in [
        (Kind::Mover, MOVERS),
        (Kind::ProfitTaker, PROFIT_TAKERS),
        (Kind::Rescuer, RESCUERS),
    ] {
        lps.extend((0..count).map(|_| lp(rng, kind)));
    }
    lps
}

/// Launch: the house funds every dealer with `amount` and holds the founding shares.
pub fn seed_house(house: &mut Lp, dealers: &mut [Dealer], amount: u128, now: u64) {
    house.wallet += amount * dealers.len() as u128;
    house.track(dealers.len());
    for index in 0..dealers.len() {
        house.buy(dealers, index, amount, now);
    }
}

impl Lp {
    /// Positions for every dealer (owners open new ones over time).
    fn track(&mut self, dealers: usize) {
        self.shares.resize(dealers, 0);
        self.cost.resize(dealers, 0);
    }

    pub fn maybe_act(&mut self, dealers: &mut [Dealer], now: u64, rng: &mut Rng) {
        if now < self.next_check {
            return;
        }
        self.track(dealers.len());
        // A little jitter so LPs drift apart instead of all acting on the same tick.
        self.next_check = now + self.period + between(rng, 0, 600);
        let returns: Vec<Option<f64>> = dealers.iter().map(Dealer::return_24h).collect();
        if self.kind != Kind::Rescuer {
            self.stop_losses(dealers, &returns, now);
        }
        match self.kind {
            Kind::House => {}
            Kind::Mover => self.chase_returns(dealers, &returns, now),
            Kind::ProfitTaker => self.take_profit(dealers, &returns, now),
            Kind::Rescuer => self.rescue(dealers, now),
        }
    }

    fn stop_losses(&mut self, dealers: &mut [Dealer], returns: &[Option<f64>], now: u64) {
        for (index, ret) in returns.iter().enumerate() {
            if ret.is_some_and(|r| r < -self.stop_loss) {
                self.sell(dealers, index, self.shares[index], now);
            }
        }
    }

    fn chase_returns(&mut self, dealers: &mut [Dealer], returns: &[Option<f64>], now: u64) {
        let Some((best, best_return)) = best_open(dealers, returns) else {
            return;
        };
        for (index, ret) in returns.iter().enumerate() {
            let lagging = best_return - ret.unwrap_or(0.0) > MOVE_GAP;
            if index != best && lagging {
                self.sell(dealers, index, self.shares[index], now);
            }
        }
        if self.wallet >= MIN_INVEST {
            self.buy(dealers, best, self.wallet, now);
        }
    }

    fn take_profit(&mut self, dealers: &mut [Dealer], returns: &[Option<f64>], now: u64) {
        for index in 0..dealers.len() {
            if self.gain(&dealers[index], index) >= TAKE_PROFIT {
                self.sell(dealers, index, self.shares[index] / 2, now);
            }
        }
        let invested = self.shares.iter().any(|&s| s > 0);
        if !invested && self.wallet >= MIN_INVEST {
            if let Some((best, _)) = best_open(dealers, returns) {
                self.buy(dealers, best, self.wallet / 2, now);
            }
        }
    }

    fn rescue(&mut self, dealers: &mut [Dealer], now: u64) {
        for index in 0..dealers.len() {
            if self.gain(&dealers[index], index) >= RESCUE_PROFIT {
                self.sell(dealers, index, self.shares[index], now);
            }
        }
        for index in 0..dealers.len() {
            let dealer = &dealers[index];
            if !dealer.open && dealer.buy_price() <= RESCUE_MAX_PRICE && self.wallet >= MIN_INVEST {
                self.buy(dealers, index, self.wallet / 2, now);
            }
        }
    }

    /// Paper gain of the position in one pool, e.g. 0.05 for +5 %. 0 without a position.
    fn gain(&self, dealer: &Dealer, index: usize) -> f64 {
        if self.cost[index] == 0 {
            return 0.0;
        }
        dealer.value_of(self.shares[index]) as f64 / self.cost[index] as f64 - 1.0
    }

    fn buy(&mut self, dealers: &mut [Dealer], index: usize, amount: u128, now: u64) {
        let amount = amount.min(self.wallet);
        let dealer = &mut dealers[index];
        let minted = dealer.pool.buy_shares(amount);
        if minted == 0 {
            return;
        }
        self.wallet -= amount;
        self.shares[index] += minted;
        self.cost[index] += amount;
        dealer.record_flow(now, amount as i128);
    }

    fn sell(&mut self, dealers: &mut [Dealer], index: usize, shares: u128, now: u64) {
        let held = self.shares[index];
        if shares == 0 || held == 0 {
            return;
        }
        let dealer = &mut dealers[index];
        // A pool with nothing free to pay right now is simply kept for later.
        let Ok(payout) = dealer.pool.sell_shares(shares) else {
            return;
        };
        self.wallet += payout;
        self.cost[index] = self.cost[index] * (held - shares) / held;
        self.shares[index] = held - shares;
        dealer.record_flow(now, -(payout as i128));
    }
}

/// The open dealer with the best 24 h return (unknown counts as 0), lowest index on ties.
fn best_open(dealers: &[Dealer], returns: &[Option<f64>]) -> Option<(usize, f64)> {
    dealers
        .iter()
        .enumerate()
        .filter(|(_, d)| d.open)
        .map(|(index, _)| (index, returns[index].unwrap_or(0.0)))
        .fold(None, |best, (index, r)| match best {
            Some((_, best_r)) if best_r >= r => best,
            _ => Some((index, r)),
        })
}
