//! Simulated players. Their behaviour uses floats (it is only a model of people); every amount
//! they stake or win is an integer and goes through the core rules.
//!
//! - Price hunters sit at the open table of their game with the lowest total edge (boosts count).
//! - Loyal players always play at the same dealer, whatever its price.
//! - Whales show up rarely and bet big, capped by the table's max bet; they hunt prices too.
//! Every blackjack hand is played with the perfect strategy for the rake in force.

use core_rules::{
    apply_rake, bj_deal, bj_double, bj_gross, bj_hit, bj_stand, bj_wager, dice_gross, dice_roll,
    roulette_gross, roulette_spin, worst_case_payout, Bet, BjMove, DiceBet, Game, Rng,
    RouletteBet,
};

use crate::world::{Dealer, Strategies, DAY, HOUR, MIN_BET, USDC};

const HUNTERS: usize = 300;
/// Loyal players per dealer.
const LOYAL_PER_DEALER: usize = 20;
const WHALES: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Hunter,
    Loyal(usize),
    Whale,
}

/// Chance per tick that an offline player of this kind sits down, at the day's peak.
fn peak_arrival(kind: Kind) -> f64 {
    match kind {
        Kind::Hunter => 0.000_6,
        Kind::Loyal(_) => 0.000_5,
        Kind::Whale => 0.000_15,
    }
}

/// Session length range in seconds.
fn session_secs(kind: Kind) -> (u64, u64) {
    match kind {
        Kind::Hunter => (5 * 60, 30 * 60),
        Kind::Loyal(_) => (10 * 60, 60 * 60),
        Kind::Whale => (5 * 60, 20 * 60),
    }
}

pub struct Player {
    pub kind: Kind,
    pub game: Game,
    pub wallet: u128,
    /// Stake the player would like to bet, before the table's max bet.
    stake: u128,
    /// Playing until this time (exclusive); offline when in the past.
    online_until: u64,
}

/// Uniform integer in `lo..=hi`.
pub fn between(rng: &mut Rng, lo: u64, hi: u64) -> u64 {
    lo + u64::from(rng.below((hi - lo + 1) as u32))
}

/// Uniform in [0, 1).
pub fn unit(rng: &mut Rng) -> f64 {
    const RESOLUTION: u32 = 1 << 30;
    f64::from(rng.below(RESOLUTION)) / f64::from(RESOLUTION)
}

fn pick_game(rng: &mut Rng) -> Game {
    match rng.below(100) {
        0..=39 => Game::Dice,
        40..=74 => Game::Roulette,
        _ => Game::Blackjack,
    }
}

/// Amount in hundredths of a USDC, uniform in `lo..=hi` cents.
fn cents(rng: &mut Rng, lo: u64, hi: u64) -> u128 {
    u128::from(between(rng, lo, hi)) * (USDC / 100)
}

fn player(rng: &mut Rng, kind: Kind, game: Game) -> Player {
    let (wallet, stake) = match kind {
        Kind::Hunter => (cents(rng, 2_000, 15_000), cents(rng, 10, 100)),
        Kind::Loyal(_) => (cents(rng, 1_000, 8_000), cents(rng, 10, 50)),
        Kind::Whale => (cents(rng, 300_000, 1_000_000), cents(rng, 5_000, 50_000)),
    };
    Player {
        kind,
        game,
        wallet,
        stake,
        online_until: 0,
    }
}

pub fn population(rng: &mut Rng, dealers: &[Dealer]) -> Vec<Player> {
    let mut players = Vec::new();
    for _ in 0..HUNTERS {
        let game = pick_game(rng);
        players.push(player(rng, Kind::Hunter, game));
    }
    for (index, dealer) in dealers.iter().enumerate() {
        for _ in 0..LOYAL_PER_DEALER {
            players.push(player(rng, Kind::Loyal(index), dealer.game()));
        }
    }
    for _ in 0..WHALES {
        let game = pick_game(rng);
        players.push(player(rng, Kind::Whale, game));
    }
    players
}

/// Share of the peak arrival rate at this time of day: lowest at 04:00, highest at 16:00.
pub fn arrival_curve(now: u64) -> f64 {
    let hour = (now % DAY) as f64 / HOUR as f64;
    let wave = (1.0 - (std::f64::consts::TAU * (hour - 4.0) / 24.0).cos()) / 2.0;
    0.2 + 0.8 * wave
}

impl Player {
    fn online(&self, now: u64) -> bool {
        now < self.online_until
    }

    pub fn tick(
        &mut self,
        dealers: &mut [Dealer],
        strategies: &mut Strategies,
        rng: &mut Rng,
        now: u64,
        rate: f64,
    ) {
        if !self.online(now) {
            if self.wallet >= MIN_BET && unit(rng) < peak_arrival(self.kind) * rate {
                let (lo, hi) = session_secs(self.kind);
                self.online_until = now + between(rng, lo, hi);
            }
            return;
        }
        if let Some(index) = self.choose_table(dealers, now) {
            self.play_round(&mut dealers[index], strategies, rng, now);
        }
        if self.wallet < MIN_BET {
            self.online_until = 0;
        }
    }

    fn choose_table(&self, dealers: &[Dealer], now: u64) -> Option<usize> {
        let playable = |d: &Dealer| d.open && d.offer.max_bet >= MIN_BET;
        match self.kind {
            Kind::Loyal(index) => playable(&dealers[index]).then_some(index),
            Kind::Hunter | Kind::Whale => dealers
                .iter()
                .enumerate()
                .filter(|(_, d)| d.game() == self.game && playable(d))
                .min_by_key(|(index, d)| (d.rake_bp(now), *index))
                .map(|(index, _)| index),
        }
    }

    fn dice_bet(&self, rng: &mut Rng) -> DiceBet {
        let chance_bp = if self.kind == Kind::Whale {
            // Whales chase long shots.
            [100, 200, 500, 1_000][rng.below(4) as usize]
        } else {
            [500, 1_000, 2_500, 4_950, 5_000, 5_000, 7_500, 9_000][rng.below(8) as usize]
        };
        DiceBet {
            chance_bp,
            over: rng.below(2) == 1,
        }
    }

    fn roulette_bet(&self, rng: &mut Rng) -> RouletteBet {
        let long_shot = self.kind == Kind::Whale || rng.below(10) == 0;
        if long_shot {
            return RouletteBet::Straight(rng.below(37) as u8);
        }
        match rng.below(7) {
            0 => RouletteBet::Red,
            1 => RouletteBet::Black,
            2 => RouletteBet::Odd,
            3 => RouletteBet::Even,
            4 => RouletteBet::High,
            5 => RouletteBet::Dozen(rng.below(3) as u8 + 1),
            _ => RouletteBet::Column(rng.below(3) as u8 + 1),
        }
    }

    /// One round, settled at once: stake out of the wallet into the pool, payout back.
    fn play_round(
        &mut self,
        dealer: &mut Dealer,
        strategies: &mut Strategies,
        rng: &mut Rng,
        now: u64,
    ) {
        let game = dealer.game();
        let stake = self.stake.min(dealer.offer.max_bet).min(self.wallet);
        if stake < MIN_BET {
            return;
        }
        let bet = match game {
            Game::Dice => Bet::Dice(self.dice_bet(rng)),
            Game::Roulette => Bet::Roulette(self.roulette_bet(rng)),
            Game::Blackjack => Bet::Blackjack,
        };
        let worst = worst_case_payout(game, stake, &bet);
        if dealer.pool.open_bet(stake, worst).is_err() {
            return;
        }
        self.wallet -= stake;
        let rake = dealer.offer.effective_rake_bp(game, now);
        let (wager, gross) = match bet {
            Bet::Dice(dice) => (stake, dice_gross(stake, &dice, dice_roll(rng))),
            Bet::Roulette(roulette) => (stake, roulette_gross(stake, &roulette, roulette_spin(rng))),
            Bet::Blackjack => self.play_hand(dealer, strategies, rng, stake, rake),
        };
        let payout = apply_rake(gross, wager, rake);
        dealer
            .pool
            .settle(wager, worst, payout)
            .expect("payout within the round's reserve");
        self.wallet += payout;
        dealer.record_bet(now, wager, payout);
    }

    /// Plays a blackjack hand perfectly; returns (total wagered, gross payout).
    fn play_hand(
        &mut self,
        dealer: &mut Dealer,
        strategies: &mut Strategies,
        rng: &mut Rng,
        stake: u128,
        rake: u16,
    ) -> (u128, u128) {
        let strategy = strategies.get(rake);
        let mut hand = bj_deal(rng);
        while !hand.done {
            let step = match strategy.decide(&hand) {
                BjMove::Double if self.wallet >= stake => {
                    dealer.pool.add_stake(stake).expect("double stake");
                    self.wallet -= stake;
                    bj_double(&mut hand, rng)
                }
                BjMove::Double | BjMove::Hit => bj_hit(&mut hand, rng),
                BjMove::Stand => bj_stand(&mut hand, rng),
            };
            step.expect("strategy only picks legal moves");
        }
        (bj_wager(&hand, stake), bj_gross(&hand, stake))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrivals_peak_in_the_afternoon() {
        assert!((arrival_curve(4 * HOUR) - 0.2).abs() < 1e-9);
        assert!((arrival_curve(16 * HOUR) - 1.0).abs() < 1e-9);
        assert!(arrival_curve(DAY + 16 * HOUR) > arrival_curve(DAY + 23 * HOUR));
    }
}
