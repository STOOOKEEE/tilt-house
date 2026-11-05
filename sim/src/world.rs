//! The simulated casino: five dealers (each a liquidity pool), a virtual clock, and the JSON
//! timeline the fast-forward page plays back. Every money move goes through `core_rules`, the
//! same code the contract runs.

use std::collections::{HashMap, VecDeque};

use core_rules::dealer_rules::{CAUTIOUS, GREEDY, PROMOTER};
use core_rules::{
    reprice, worst_case_multiple, BjStrategy, Game, Offer, Pool, Reason, Rng, Stats,
    Temperament, SHARES_PER_UNIT,
};
use serde::Serialize;

use crate::lps::{self, Lp};
use crate::players::{self, Player};

/// One round per seated player per tick (design: a new round about every 10 s).
pub const TICK_SECS: u64 = 10;
/// Each dealer reprices every minute, like the keeper on testnet.
pub const REPRICE_SECS: u64 = 60;
/// One output frame per 10 simulated minutes.
pub const FRAME_SECS: u64 = 600;
/// Stats buckets, like the contract: 6 × 10 min = the last hour.
pub const BUCKET_SECS: u64 = 600;
pub const BUCKETS: usize = 6;
pub const HOUR: u64 = 3_600;
pub const DAY: u64 = 86_400;

pub const USDC: u128 = 1_000_000;
/// Smallest stake a table takes (0.10 USDC; `rake_bounds` holds from 0.01 USDC up).
pub const MIN_BET: u128 = USDC / 10;
/// What the house seeds each dealer with at launch.
pub const SEED_BANKROLL: u128 = 2_000 * USDC;
/// Share prices are reported in millionths of the launch price: launch = "1000000".
pub const PRICE_SCALE: u128 = 1_000_000;
/// Hourly share-price snapshots kept per dealer: enough for a trailing 24 h return.
const PRICE_HISTORY: usize = 25;

pub struct DealerSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub game: Game,
    pub temperament: &'static str,
    pub traits: Temperament,
}

/// The launch lineup (shared with the contract seed and the web lobby).
pub const LINEUP: [DealerSpec; 5] = [
    DealerSpec {
        id: "ada",
        name: "Ada",
        game: Game::Dice,
        temperament: "greedy",
        traits: GREEDY,
    },
    DealerSpec {
        id: "bruno",
        name: "Bruno",
        game: Game::Dice,
        temperament: "promoter",
        traits: PROMOTER,
    },
    DealerSpec {
        id: "chloe",
        name: "Chloe",
        game: Game::Roulette,
        temperament: "cautious",
        traits: CAUTIOUS,
    },
    DealerSpec {
        id: "dmitri",
        name: "Dmitri",
        game: Game::Roulette,
        temperament: "greedy",
        traits: GREEDY,
    },
    DealerSpec {
        id: "eve",
        name: "Eve",
        game: Game::Blackjack,
        temperament: "promoter",
        traits: PROMOTER,
    },
];

#[derive(Clone, Copy, Default)]
struct Bucket {
    epoch: u64,
    bets: u32,
    volume: u128,
    player_net: i128,
    inflow: i128,
}

pub struct Dealer {
    pub spec: &'static DealerSpec,
    pub pool: Pool,
    pub offer: Offer,
    pub open: bool,
    buckets: [Bucket; BUCKETS],
    last_bet: u64,
    /// Hourly share prices (None while nobody holds shares), oldest first.
    prices: VecDeque<Option<u128>>,
}

impl Dealer {
    fn new(spec: &'static DealerSpec) -> Self {
        let pool = Pool::default();
        let offer = reprice(spec.game, &pool, &Stats::default(), &spec.traits, &[], 0);
        Self {
            spec,
            pool,
            offer,
            open: false,
            buckets: [Bucket::default(); BUCKETS],
            last_bet: 0,
            prices: VecDeque::new(),
        }
    }

    pub fn game(&self) -> Game {
        self.spec.game
    }

    fn bucket(&mut self, now: u64) -> &mut Bucket {
        let epoch = now / BUCKET_SECS;
        let bucket = &mut self.buckets[(epoch % BUCKETS as u64) as usize];
        if bucket.epoch != epoch {
            *bucket = Bucket {
                epoch,
                ..Bucket::default()
            };
        }
        bucket
    }

    /// The last hour, from the buckets still inside it.
    pub fn stats(&self, now: u64) -> Stats {
        let epoch = now / BUCKET_SECS;
        let mut stats = Stats {
            idle_secs: now - self.last_bet,
            ..Stats::default()
        };
        for bucket in self.buckets.iter().filter(|b| b.epoch + BUCKETS as u64 > epoch) {
            stats.bets_1h += bucket.bets;
            stats.volume_1h += bucket.volume;
            stats.player_net_1h += bucket.player_net;
            stats.inflow_1h += bucket.inflow;
        }
        stats
    }

    pub fn record_bet(&mut self, now: u64, wager: u128, payout: u128) {
        let bucket = self.bucket(now);
        bucket.bets += 1;
        bucket.volume += wager;
        bucket.player_net += payout as i128 - wager as i128;
        self.last_bet = now;
    }

    pub fn record_flow(&mut self, now: u64, amount: i128) {
        self.bucket(now).inflow += amount;
    }

    /// What one launch-size share (1 base unit at launch) sells for, in `PRICE_SCALE` units.
    pub fn share_price(&self) -> Option<u128> {
        (self.pool.shares > 0)
            .then(|| self.pool.free() * SHARES_PER_UNIT * PRICE_SCALE / self.pool.shares)
    }

    /// What a launch-size share costs to buy, in `PRICE_SCALE` units (an empty pool sells at launch).
    pub fn buy_price(&self) -> u128 {
        if self.pool.shares == 0 {
            return PRICE_SCALE;
        }
        let value = self.pool.bankroll + self.pool.open_stakes;
        value * SHARES_PER_UNIT * PRICE_SCALE / self.pool.shares
    }

    /// Sell value of `shares` right now.
    pub fn value_of(&self, shares: u128) -> u128 {
        if self.pool.shares == 0 {
            return 0;
        }
        shares * self.pool.free() / self.pool.shares
    }

    /// Share-price change over the last 24 h (or since launch), e.g. 0.02 for +2 %.
    pub fn return_24h(&self) -> Option<f64> {
        let then = (*self.prices.front()?)?;
        let now = self.share_price()?;
        Some(now as f64 / then.max(1) as f64 - 1.0)
    }

    /// Rake in force at `now` (boost included). Tables of one game share the base edge, so
    /// this ranks them by total edge.
    pub fn rake_bp(&self, now: u64) -> u16 {
        self.offer.effective_rake_bp(self.game(), now)
    }

    /// Bankroll needed to cover a minimum bet at the game's worst case.
    fn reopen_threshold(&self) -> u128 {
        MIN_BET * worst_case_multiple(self.game())
    }

    fn snapshot_price(&mut self) {
        self.prices.push_back(self.share_price());
        if self.prices.len() > PRICE_HISTORY {
            self.prices.pop_front();
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Event {
    pub t: u64,
    pub dealer: &'static str,
    pub kind: &'static str,
    pub text: String,
}

#[derive(Serialize)]
pub struct DealerFrame {
    pub id: &'static str,
    pub bankroll: String,
    pub share_price: String,
    pub rake_bp: u16,
    pub max_bet: String,
    pub boost: bool,
    pub open: bool,
    pub reason: &'static str,
}

#[derive(Serialize)]
pub struct Frame {
    pub t: u64,
    pub dealers: Vec<DealerFrame>,
    pub events: Vec<Event>,
}

#[derive(Serialize)]
pub struct DealerInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub game: Game,
    pub temperament: &'static str,
    pub traits: Temperament,
}

#[derive(Serialize)]
pub struct Output {
    pub seed: u64,
    pub days: u64,
    pub min_bet: String,
    pub dealers: Vec<DealerInfo>,
    pub frames: Vec<Frame>,
}

/// Perfect blackjack play for each rake seen, computed once.
#[derive(Default)]
pub struct Strategies(HashMap<u16, BjStrategy>);

impl Strategies {
    pub fn get(&mut self, rake_bp: u16) -> &BjStrategy {
        self.0
            .entry(rake_bp)
            .or_insert_with(|| BjStrategy::optimal(rake_bp))
    }
}

pub struct World {
    pub now: u64,
    pub rng: Rng,
    pub dealers: Vec<Dealer>,
    pub players: Vec<Player>,
    pub lps: Vec<Lp>,
    strategies: Strategies,
    events: Vec<Event>,
}

fn rng_from_seed(seed: u64) -> Rng {
    let mut bytes = [0u8; 32];
    bytes[..8].copy_from_slice(&seed.to_le_bytes());
    Rng::new(bytes)
}

impl World {
    pub fn new(seed: u64) -> Self {
        let mut rng = rng_from_seed(seed);
        let mut dealers: Vec<Dealer> = LINEUP.iter().map(Dealer::new).collect();
        let mut lps = lps::population(&mut rng, dealers.len());
        lps::seed_house(&mut lps[0], &mut dealers, SEED_BANKROLL, 0);
        for dealer in &mut dealers {
            dealer.open = dealer.pool.is_open(MIN_BET, dealer.game());
        }
        Self {
            now: 0,
            players: players::population(&mut rng, &dealers),
            rng,
            dealers,
            lps,
            strategies: Strategies::default(),
            events: Vec::new(),
        }
    }

    /// Every base unit in the world: players' and LPs' wallets plus the pools.
    #[cfg(test)]
    pub fn total_money(&self) -> u128 {
        let wallets: u128 = self.players.iter().map(|p| p.wallet).sum::<u128>()
            + self.lps.iter().map(|lp| lp.wallet).sum::<u128>();
        let pools: u128 = self
            .dealers
            .iter()
            .map(|d| d.pool.bankroll + d.pool.open_stakes)
            .sum();
        wallets + pools
    }

    /// Runs 10 simulated minutes and returns the frame at their end.
    pub fn advance_frame(&mut self) -> Frame {
        for _ in 0..FRAME_SECS / TICK_SECS {
            self.tick();
            self.now += TICK_SECS;
        }
        if self.now % HOUR == 0 {
            self.dealers.iter_mut().for_each(Dealer::snapshot_price);
        }
        self.frame()
    }

    fn tick(&mut self) {
        let now = self.now;
        if now == 0 {
            self.dealers.iter_mut().for_each(Dealer::snapshot_price);
        }
        if now % REPRICE_SECS == 0 {
            for index in 0..self.dealers.len() {
                self.reprice(index);
            }
        }
        for lp in &mut self.lps {
            lp.maybe_act(&mut self.dealers, now, &mut self.rng);
        }
        self.update_open();
        let rate = players::arrival_curve(now);
        for player in &mut self.players {
            player.tick(
                &mut self.dealers,
                &mut self.strategies,
                &mut self.rng,
                now,
                rate,
            );
        }
        self.update_open();
    }

    fn reprice(&mut self, index: usize) {
        let now = self.now;
        let dealer = &mut self.dealers[index];
        let stats = dealer.stats(now);
        let offer = reprice(dealer.game(), &dealer.pool, &stats, &dealer.spec.traits, &[], now);
        let boost_starts = offer.boost_until > now && dealer.offer.boost_until <= now;
        let kind = if boost_starts {
            Some("boost")
        } else if offer.reason != dealer.offer.reason {
            Some("reprice")
        } else {
            None
        };
        let id = dealer.spec.id;
        dealer.offer = offer;
        if let Some(kind) = kind {
            self.push_event(id, kind, reason_text(offer.reason, boost_starts));
        }
    }

    /// Bust when a pool can no longer cover a minimum bet, reopen when liquidity brings it back.
    fn update_open(&mut self) {
        for index in 0..self.dealers.len() {
            let dealer = &mut self.dealers[index];
            let open = dealer.pool.is_open(MIN_BET, dealer.game());
            if open == dealer.open {
                continue;
            }
            dealer.open = open;
            let id = dealer.spec.id;
            let (kind, text) = if open {
                (
                    "reopen",
                    "reopened: new liquidity covers the minimum bet again".to_string(),
                )
            } else {
                let needed = dealer.reopen_threshold() - dealer.pool.free();
                (
                    "bust",
                    format!(
                        "closed: my pool can no longer cover a {} USDC bet · needs {} USDC to reopen",
                        usdc(MIN_BET),
                        usdc(needed)
                    ),
                )
            };
            self.push_event(id, kind, text);
        }
    }

    fn push_event(&mut self, dealer: &'static str, kind: &'static str, text: String) {
        self.events.push(Event {
            t: self.now,
            dealer,
            kind,
            text,
        });
    }

    fn frame(&mut self) -> Frame {
        let now = self.now;
        let dealers = self
            .dealers
            .iter()
            .map(|d| DealerFrame {
                id: d.spec.id,
                bankroll: d.pool.bankroll.to_string(),
                share_price: d.share_price().unwrap_or(PRICE_SCALE).to_string(),
                rake_bp: d.rake_bp(now),
                max_bet: d.offer.max_bet.to_string(),
                boost: d.offer.boost_until > now,
                open: d.open,
                reason: d.offer.reason.code(),
            })
            .collect();
        Frame {
            t: now,
            dealers,
            events: std::mem::take(&mut self.events),
        }
    }
}

fn reason_text(reason: Reason, boost: bool) -> String {
    let text = reason.explain();
    if boost {
        format!("{text} · boost on")
    } else {
        text
    }
}

/// Base units as USDC with two decimals, rounded up (amounts needed are never understated).
fn usdc(amount: u128) -> String {
    let cents = amount.div_ceil(USDC / 100);
    format!("{}.{:02}", cents / 100, cents % 100)
}

pub fn run(days: u64, seed: u64) -> Output {
    let mut world = World::new(seed);
    let frames = (0..days * DAY / FRAME_SECS)
        .map(|_| world.advance_frame())
        .collect();
    Output {
        seed,
        days,
        min_bet: MIN_BET.to_string(),
        dealers: LINEUP
            .iter()
            .map(|spec| DealerInfo {
                id: spec.id,
                name: spec.name,
                game: spec.game,
                temperament: spec.temperament,
                traits: spec.traits,
            })
            .collect(),
        frames,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_json() {
        let a = serde_json::to_string(&run(1, 7)).unwrap();
        let b = serde_json::to_string(&run(1, 7)).unwrap();
        assert_eq!(a, b);
        let c = serde_json::to_string(&run(1, 8)).unwrap();
        assert_ne!(a, c);
    }

    /// Seed 42 over a week: busts and reopenings happen, money is conserved, prices stay sane.
    #[test]
    fn week_42() {
        let mut world = World::new(42);
        let total = world.total_money();
        let mut kinds = Vec::new();
        for _ in 0..7 * DAY / FRAME_SECS {
            let frame = world.advance_frame();
            assert_eq!(world.total_money(), total, "money conserved at t={}", frame.t);
            for dealer in &frame.dealers {
                // Non-negative integers by construction; this checks they parse as such.
                dealer.share_price.parse::<u128>().unwrap();
                dealer.bankroll.parse::<u128>().unwrap();
            }
            for dealer in &world.dealers {
                assert!(dealer.pool.reserved <= dealer.pool.bankroll);
                assert_eq!(dealer.pool.open_stakes, 0, "rounds settle instantly");
            }
            kinds.extend(frame.events.iter().map(|e| e.kind));
        }
        let count = |kind| kinds.iter().filter(|&&k| k == kind).count();
        assert!(count("bust") >= 1, "no bust");
        assert!(count("reopen") >= 1, "no reopen");
    }

    #[test]
    fn stats_cover_the_last_hour_only() {
        let mut dealer = Dealer::new(&LINEUP[0]);
        dealer.record_bet(0, 100, 0);
        dealer.record_bet(3_000, 50, 150);
        dealer.record_flow(3_000, 10);
        let stats = dealer.stats(3_599);
        assert_eq!(stats.bets_1h, 2);
        assert_eq!(stats.volume_1h, 150);
        assert_eq!(stats.player_net_1h, 0);
        assert_eq!(stats.inflow_1h, 10);
        assert_eq!(stats.idle_secs, 599);
        let later = dealer.stats(3_600);
        assert_eq!(later.bets_1h, 1);
        assert_eq!(later.player_net_1h, 100);
    }

    #[test]
    fn usdc_formatting_rounds_up() {
        assert_eq!(usdc(MIN_BET), "0.10");
        assert_eq!(usdc(36 * MIN_BET - 1), "3.60");
        assert_eq!(usdc(2_000 * USDC + 1), "2000.01");
    }
}
