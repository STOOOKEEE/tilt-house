//! The simulated casino: the floor (seats, rent, jackpot), the dealers (NPC and player-owned,
//! each a liquidity pool), the gamblers, the LPs and a virtual clock, plus the JSON timeline the
//! fast-forward page plays back. Every rule and every money move goes through `core_rules`, the
//! same code the contract and the live runners use.

use std::collections::{HashMap, VecDeque};

use core_rules::dealer_rules::{CAUTIOUS, GREEDY, PROMOTER};
use core_rules::floor::{Floor, HOUR_SECS};
use core_rules::gambler_rules::{self, Persona};
use core_rules::seats::{seat_min_rent, SEAT_TRAFFIC_BP};
use core_rules::session::SESSION_MIN_BET;
use core_rules::{
    base_edge_bp, cooldown_until, rent_bid, reprice, worst_case_multiple, BjStrategy, Game, Offer,
    Pool, Reason, RentAction, RivalOffer, Rng, Stats, Temperament, BP, SHARES_PER_UNIT,
};
use serde::Serialize;

use crate::gamblers::{self, Gambler};
use crate::lps::{self, Lp};
use crate::owners::{self, Owner};

/// One round per seated gambler per tick (sessions make rounds instant; 10 s is a human pace).
pub const TICK_SECS: u64 = 10;
/// Dealers on autopilot reprice every minute, like the keeper on testnet.
pub const REPRICE_SECS: u64 = 60;
/// Rent is collected every minute (the keeper's `collect_rent`).
pub const RENT_SECS: u64 = 60;
/// Seat decisions (rent bids, owners' moves) every 10 minutes.
pub const SEAT_SECS: u64 = 600;
/// One output frame per 10 simulated minutes.
pub const FRAME_SECS: u64 = 600;
/// Stats buckets, like the contract: 6 × 10 min = the last hour.
pub const BUCKET_SECS: u64 = 600;
pub const BUCKETS: usize = 6;
pub const HOUR: u64 = HOUR_SECS;
pub const DAY: u64 = 86_400;
/// An undercut answering one by the same rival within this time is a price war.
pub const PRICE_WAR_WINDOW_SECS: u64 = 2 * HOUR;

pub const USDC: u128 = 1_000_000;
/// Smallest stake a table takes (the session minimum, 0.10 USDC).
pub const MIN_BET: u128 = SESSION_MIN_BET;
/// What the house seeds each NPC dealer with at launch.
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
    pub id: String,
    pub name: String,
    pub game: Game,
    /// Temperament label; "manual" for owners setting their offer by hand.
    pub temperament: &'static str,
    pub traits: Temperament,
    /// Index into `World::owners`; `None` for the house's NPC dealers.
    pub owner: Option<usize>,
    pub pool: Pool,
    pub offer: Offer,
    pub open: bool,
    /// Evicted: may not bid for a seat before this time.
    pub cooldown_until: u64,
    buckets: [Bucket; BUCKETS],
    last_bet: u64,
    /// Hourly share prices (None while nobody holds shares), oldest first.
    prices: VecDeque<Option<u128>>,
}

impl Dealer {
    pub fn new(
        id: String,
        name: String,
        game: Game,
        temperament: &'static str,
        traits: Temperament,
        owner: Option<usize>,
        now: u64,
    ) -> Self {
        let pool = Pool::default();
        let offer = reprice(game, &pool, &Stats::default(), &traits, &[], now);
        Self {
            id,
            name,
            game,
            temperament,
            traits,
            owner,
            pool,
            offer,
            open: false,
            cooldown_until: 0,
            buckets: [Bucket::default(); BUCKETS],
            last_bet: now,
            prices: VecDeque::new(),
        }
    }

    fn npc(spec: &DealerSpec) -> Self {
        Self::new(
            spec.id.to_string(),
            spec.name.to_string(),
            spec.game,
            spec.temperament,
            spec.traits,
            None,
            0,
        )
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

    /// The last hour, from the buckets still inside it (`game_share_bp` is set by the world).
    pub fn stats(&self, now: u64) -> Stats {
        let epoch = now / BUCKET_SECS;
        let mut stats = Stats {
            idle_secs: now.saturating_sub(self.last_bet),
            game_share_bp: BP as u16,
            ..Stats::default()
        };
        for bucket in self
            .buckets
            .iter()
            .filter(|b| b.epoch + BUCKETS as u64 > epoch)
        {
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

    /// Rake in force at `now` (boost included).
    pub fn rake_bp(&self, now: u64) -> u16 {
        self.offer.effective_rake_bp(self.game, now)
    }

    /// Total edge players face at `now` (boost included).
    pub fn edge_bp(&self, now: u64) -> u16 {
        base_edge_bp(self.game) + self.rake_bp(now)
    }

    /// Total edge of the offer outside boosts: what price wars are fought over.
    pub fn list_edge_bp(&self) -> u16 {
        base_edge_bp(self.game) + self.offer.effective_rake_bp(self.game, 0)
    }

    /// Bankroll needed to cover a minimum bet at the game's worst case.
    fn reopen_threshold(&self) -> u128 {
        MIN_BET * worst_case_multiple(self.game)
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
    pub dealer: String,
    pub kind: &'static str,
    pub text: String,
}

#[derive(Serialize)]
pub struct DealerFrame {
    pub id: String,
    pub bankroll: String,
    pub share_price: String,
    pub rake_bp: u16,
    pub edge_bp: u16,
    pub max_bet: String,
    pub boost: bool,
    pub open: bool,
    pub reason: &'static str,
    pub seat: Option<usize>,
    /// "0" when off the floor.
    pub rent_per_hour: String,
}

#[derive(Serialize)]
pub struct SeatFrame {
    pub seat: usize,
    pub dealer_id: Option<String>,
    /// "0" when empty.
    pub rent_per_hour: String,
    pub min_rent: String,
    pub traffic_bp: u16,
    pub ask: Option<String>,
}

#[derive(Serialize)]
pub struct Frame {
    pub t: u64,
    pub jackpot: String,
    pub dealers: Vec<DealerFrame>,
    pub seats: Vec<SeatFrame>,
    pub gamblers: Vec<gamblers::GamblerFrame>,
    pub events: Vec<Event>,
}

#[derive(Serialize)]
pub struct DealerInfo {
    pub id: String,
    pub name: String,
    pub game: Game,
    pub temperament: &'static str,
    pub traits: Temperament,
    /// The owner's name; `None` for the house's NPC dealers.
    pub owner: Option<String>,
    pub strategy: Option<&'static str>,
}

#[derive(Serialize)]
pub struct GamblerInfo {
    pub id: String,
    pub name: String,
    pub persona: Persona,
}

#[derive(Serialize)]
pub struct Output {
    pub seed: u64,
    pub days: u64,
    pub frame_secs: u64,
    pub min_bet: String,
    pub seat_traffic_bp: [u16; SEAT_TRAFFIC_BP.len()],
    pub dealers: Vec<DealerInfo>,
    pub gamblers: Vec<GamblerInfo>,
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

/// Who undercut whom, and when (for price-war detection).
struct Undercut {
    t: u64,
    from: usize,
    to: usize,
}

pub struct World {
    pub now: u64,
    pub rng: Rng,
    pub floor: Floor,
    pub dealers: Vec<Dealer>,
    pub gamblers: Vec<Gambler>,
    pub owners: Vec<Owner>,
    pub lps: Vec<Lp>,
    /// Salary paid to gamblers so far: the only money that enters from outside.
    pub salary_paid: u128,
    pub strategies: Strategies,
    pub events: Vec<Event>,
    undercuts: Vec<Undercut>,
    /// Every price-war undercut so far, `(undercutter, rival)`.
    pub price_wars: Vec<(usize, usize)>,
}

fn rng_from_seed(seed: u64) -> Rng {
    let mut bytes = [0u8; 32];
    bytes[..8].copy_from_slice(&seed.to_le_bytes());
    Rng::new(bytes)
}

impl World {
    pub fn new(seed: u64) -> Self {
        let mut rng = rng_from_seed(seed);
        let mut dealers: Vec<Dealer> = LINEUP.iter().map(Dealer::npc).collect();
        let mut lps = lps::population(&mut rng);
        lps::seed_house(&mut lps[0], &mut dealers, SEED_BANKROLL, 0);
        for dealer in &mut dealers {
            dealer.open = dealer.pool.is_open(MIN_BET, dealer.game);
        }
        let ids: Vec<&str> = LINEUP.iter().map(|spec| spec.id).collect();
        let mut gamblers = gamblers::population(&mut rng);
        let owners = owners::population(&mut gamblers);
        Self {
            now: 0,
            floor: Floor::launch(&ids, 0),
            gamblers,
            owners,
            rng,
            dealers,
            lps,
            salary_paid: 0,
            strategies: Strategies::default(),
            events: Vec::new(),
            undercuts: Vec::new(),
            price_wars: Vec::new(),
        }
    }

    /// Every base unit in the world: wallets, pools and the jackpot. Equals the money at launch
    /// plus `salary_paid`.
    #[cfg(test)]
    pub fn total_money(&self) -> u128 {
        let wallets: u128 = self.gamblers.iter().map(|g| g.balance).sum::<u128>()
            + self.owners.iter().map(|o| o.wallet).sum::<u128>()
            + self.lps.iter().map(|lp| lp.wallet).sum::<u128>();
        let pools: u128 = self
            .dealers
            .iter()
            .map(|d| d.pool.bankroll + d.pool.open_stakes)
            .sum();
        wallets + pools + self.floor.jackpot
    }

    pub fn dealer_index(&self, id: &str) -> Option<usize> {
        self.dealers.iter().position(|d| d.id == id)
    }

    /// Runs 10 simulated minutes and returns the frame at their end.
    pub fn advance_frame(&mut self) -> Frame {
        for _ in 0..FRAME_SECS / TICK_SECS {
            self.tick();
            self.now += TICK_SECS;
        }
        if self.now.is_multiple_of(HOUR) {
            self.dealers.iter_mut().for_each(Dealer::snapshot_price);
        }
        self.frame()
    }

    fn tick(&mut self) {
        let now = self.now;
        if now == 0 {
            self.dealers.iter_mut().for_each(Dealer::snapshot_price);
        }
        if now.is_multiple_of(RENT_SECS) {
            self.collect_rent();
        }
        if now.is_multiple_of(HOUR) && now > 0 {
            self.pay_salaries();
        }
        if now.is_multiple_of(SEAT_SECS) {
            owners::act(self);
            self.npc_rent_bids();
        }
        if now.is_multiple_of(REPRICE_SECS) {
            for index in 0..self.dealers.len() {
                if self.dealers[index].temperament != owners::MANUAL {
                    self.reprice(index);
                }
            }
        }
        for lp in &mut self.lps {
            lp.maybe_act(&mut self.dealers, now, &mut self.rng);
        }
        self.update_open();
        gamblers::tick_all(self);
        self.update_open();
    }

    /// The keeper's `collect_rent`: settles every seated dealer's rent into the jackpot.
    fn collect_rent(&mut self) {
        let now = self.now;
        for index in 0..self.dealers.len() {
            let dealer = &mut self.dealers[index];
            let outcome = self.floor.accrue_rent(&dealer.id, &mut dealer.pool, now);
            if let Some(reason) = outcome.evicted {
                dealer.cooldown_until = cooldown_until(now);
                let id = dealer.id.clone();
                self.push_event(&id, "evicted", format!("evicted: {}", reason.code()));
            }
        }
    }

    fn pay_salaries(&mut self) {
        for gambler in self.gamblers.iter_mut().filter(|g| g.salaried) {
            let salary = gambler_rules::salary_for(gambler.balance, HOUR);
            gambler.balance += salary;
            self.salary_paid += salary;
        }
    }

    /// NPC dealers (and owners on autopilot) decide their rent with `rent_bid`.
    fn npc_rent_bids(&mut self) {
        let now = self.now;
        for index in 0..self.dealers.len() {
            let dealer = &self.dealers[index];
            if !owners::bids_on_autopilot(self, index) {
                continue;
            }
            let view = self.floor.view(&dealer.id, dealer.cooldown_until);
            let decision = rent_bid(&dealer.pool, &dealer.stats(now), &dealer.traits, &view, now);
            let rent = match decision.action {
                RentAction::Raise(rent)
                | RentAction::Lower(rent)
                | RentAction::BidEmpty(rent)
                | RentAction::Outbid(rent) => rent,
                RentAction::Keep | RentAction::Stay => continue,
            };
            let text = decision.reason.map_or("", |r| r.explain()).to_string();
            self.bid(index, rent, &text);
        }
    }

    /// Bids `rent` for dealer `index` (or changes its rent if seated). Emits `seated`,
    /// `evicted` and `rent` events. Returns whether the bid went through.
    pub fn bid(&mut self, index: usize, rent: u128, why: &str) -> bool {
        let now = self.now;
        let dealer = &mut self.dealers[index];
        let was_seated = self.floor.seat_of(&dealer.id).is_some();
        let cooldown = dealer.cooldown_until;
        let Ok(outcome) =
            self.floor
                .bid_for_seat(&dealer.id, rent, &mut dealer.pool, now, cooldown)
        else {
            return false;
        };
        let id = dealer.id.clone();
        let rent_text = usdc(rent);
        if was_seated {
            self.push_event(&id, "rent", format!("rent now {rent_text}/h: {why}"));
            return true;
        }
        self.push_event(
            &id,
            "seated",
            format!("took seat {} at {rent_text}/h: {why}", outcome.seat + 1),
        );
        if let Some(victim) = outcome.evicted {
            if let Some(v) = self.dealer_index(&victim) {
                self.dealers[v].cooldown_until = cooldown_until(now);
            }
            self.push_event(&victim, "evicted", format!("evicted: outbid by {id}"));
        }
        true
    }

    /// The other seated dealers of the same game, as `reprice` sees them.
    fn rivals(&self, index: usize) -> Vec<RivalOffer> {
        let me = &self.dealers[index];
        self.seated_same_game(index)
            .map(|d| RivalOffer::new(me.game, &self.dealers[d].offer, self.now))
            .collect()
    }

    pub fn seated_same_game(&self, index: usize) -> impl Iterator<Item = usize> + '_ {
        let game = self.dealers[index].game;
        (0..self.dealers.len()).filter(move |&d| {
            d != index
                && self.dealers[d].game == game
                && self.floor.seat_of(&self.dealers[d].id).is_some()
        })
    }

    /// This dealer's share of the bets at all seated tables of its game over the hour.
    fn game_share_bp(&self, index: usize) -> u16 {
        let now = self.now;
        let mine = u128::from(self.dealers[index].stats(now).bets_1h);
        let total = mine
            + self
                .seated_same_game(index)
                .map(|d| u128::from(self.dealers[d].stats(now).bets_1h))
                .sum::<u128>();
        if total == 0 {
            return BP as u16;
        }
        (mine * BP / total) as u16
    }

    fn reprice(&mut self, index: usize) {
        let now = self.now;
        let rivals = self.rivals(index);
        let stats = Stats {
            game_share_bp: self.game_share_bp(index),
            ..self.dealers[index].stats(now)
        };
        let dealer = &self.dealers[index];
        let offer = reprice(
            dealer.game,
            &dealer.pool,
            &stats,
            &dealer.traits,
            &rivals,
            now,
        );
        self.set_offer(index, offer);
    }

    /// Installs a new offer and emits `reprice`, `boost` and `price_war` events.
    pub fn set_offer(&mut self, index: usize, offer: Offer) {
        let now = self.now;
        let dealer = &mut self.dealers[index];
        let old_edge = dealer.list_edge_bp();
        let boost_starts = offer.boost_until > now && dealer.offer.boost_until <= now;
        let kind = if boost_starts {
            Some("boost")
        } else if offer.reason != dealer.offer.reason {
            Some("reprice")
        } else {
            None
        };
        let id = dealer.id.clone();
        dealer.offer = offer;
        if let Some(kind) = kind {
            self.push_event(&id, kind, reason_text(offer.reason, boost_starts));
        }
        self.check_price_war(index, old_edge);
    }

    /// An undercut is a deliberate cut (an NPC's `undercut` rule or an owner's hand-set price)
    /// that takes this dealer from at-or-above a seated rival's edge to under it. Answering the
    /// same rival's undercut within `PRICE_WAR_WINDOW_SECS` is a price war.
    fn check_price_war(&mut self, index: usize, old_edge: u16) {
        let now = self.now;
        let dealer = &self.dealers[index];
        let new_edge = dealer.list_edge_bp();
        let deliberate = matches!(dealer.offer.reason, Reason::Undercut | Reason::Owner);
        if !deliberate || new_edge >= old_edge || self.floor.seat_of(&dealer.id).is_none() {
            return;
        }
        let crossed: Vec<usize> = self
            .seated_same_game(index)
            .filter(|&r| {
                let edge = self.dealers[r].list_edge_bp();
                new_edge < edge && edge <= old_edge
            })
            .collect();
        for rival in crossed {
            // A war needs alternation: the pair's last undercut was the rival's, not ours.
            let answered = self
                .undercuts
                .iter()
                .rev()
                .find(|u| (u.from, u.to) == (rival, index) || (u.from, u.to) == (index, rival))
                .is_some_and(|u| u.from == rival && u.t + PRICE_WAR_WINDOW_SECS >= now);
            self.undercuts.push(Undercut {
                t: now,
                from: index,
                to: rival,
            });
            if answered {
                self.price_wars.push((index, rival));
                let (me, them) = (&self.dealers[index], &self.dealers[rival]);
                let text = format!(
                    "price war: {} undercuts {} back, {} vs {}",
                    me.name,
                    them.name,
                    percent_2(new_edge),
                    percent_2(them.list_edge_bp())
                );
                let id = me.id.clone();
                self.push_event(&id, "price_war", text);
            }
        }
        self.undercuts
            .retain(|u| u.t + PRICE_WAR_WINDOW_SECS >= now);
    }

    /// Bust when a pool can no longer cover a minimum bet, reopen when liquidity brings it back.
    fn update_open(&mut self) {
        for index in 0..self.dealers.len() {
            let dealer = &mut self.dealers[index];
            let open = dealer.pool.is_open(MIN_BET, dealer.game);
            if open == dealer.open {
                continue;
            }
            dealer.open = open;
            let id = dealer.id.clone();
            let (kind, text) = if open {
                (
                    "reopen",
                    "reopened: new liquidity covers the minimum bet again".to_string(),
                )
            } else {
                let needed = dealer.reopen_threshold().saturating_sub(dealer.pool.free());
                (
                    "bust",
                    format!(
                        "closed: my pool can no longer cover a {} USDC bet · needs {} USDC to reopen",
                        usdc(MIN_BET),
                        usdc(needed)
                    ),
                )
            };
            self.push_event(&id, kind, text);
        }
    }

    pub fn push_event(&mut self, dealer: &str, kind: &'static str, text: String) {
        self.events.push(Event {
            t: self.now,
            dealer: dealer.to_string(),
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
                id: d.id.clone(),
                bankroll: d.pool.bankroll.to_string(),
                share_price: d.share_price().unwrap_or(PRICE_SCALE).to_string(),
                rake_bp: d.rake_bp(now),
                edge_bp: d.edge_bp(now),
                max_bet: d.offer.max_bet.to_string(),
                boost: d.offer.boost_until > now,
                open: d.open,
                reason: d.offer.reason.code(),
                seat: self.floor.seat_of(&d.id),
                rent_per_hour: self
                    .floor
                    .seat(&d.id)
                    .map_or(0, |s| s.rent_per_hour)
                    .to_string(),
            })
            .collect();
        let seats = self
            .floor
            .seats
            .iter()
            .enumerate()
            .map(|(i, seat)| SeatFrame {
                seat: i,
                dealer_id: seat.as_ref().map(|s| s.dealer_id.clone()),
                rent_per_hour: seat.as_ref().map_or(0, |s| s.rent_per_hour).to_string(),
                min_rent: seat_min_rent(i).to_string(),
                traffic_bp: SEAT_TRAFFIC_BP[i],
                ask: seat.as_ref().and_then(|s| s.ask).map(|a| a.to_string()),
            })
            .collect();
        Frame {
            t: now,
            jackpot: self.floor.jackpot.to_string(),
            dealers,
            seats,
            gamblers: gamblers::frames(self),
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

/// "2.39 %" from 239 bp: price wars move by a basis point.
fn percent_2(bp: u16) -> String {
    format!("{}.{:02} %", bp / 100, bp % 100)
}

/// Base units as USDC with two decimals, rounded up (amounts needed are never understated).
pub fn usdc(amount: u128) -> String {
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
        frame_secs: FRAME_SECS,
        min_bet: MIN_BET.to_string(),
        seat_traffic_bp: SEAT_TRAFFIC_BP,
        dealers: world
            .dealers
            .iter()
            .map(|d| DealerInfo {
                id: d.id.clone(),
                name: d.name.clone(),
                game: d.game,
                temperament: d.temperament,
                traits: d.traits,
                owner: d.owner.map(|o| world.owners[o].name.to_string()),
                strategy: d.owner.map(|o| world.owners[o].strategy.code()),
            })
            .collect(),
        gamblers: world
            .gamblers
            .iter()
            .map(|g| GamblerInfo {
                id: g.id.clone(),
                name: g.name.clone(),
                persona: g.persona,
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

    /// Seed 42 over a week: the tycoon story happens, money is conserved (the salary is the
    /// only inflow), pools stay sound.
    #[test]
    fn week_42() {
        let mut world = World::new(42);
        let start = world.total_money();
        let mut events = Vec::new();
        for _ in 0..7 * DAY / FRAME_SECS {
            let frame = world.advance_frame();
            assert_eq!(
                world.total_money(),
                start + world.salary_paid,
                "money conserved at t={}",
                frame.t
            );
            for dealer in &world.dealers {
                assert!(dealer.pool.reserved <= dealer.pool.bankroll);
                assert_eq!(dealer.pool.open_stakes, 0, "rounds settle instantly");
            }
            assert!(frame.seats.iter().filter(|s| s.dealer_id.is_some()).count() <= 6);
            events.extend(frame.events);
        }
        assert!(world.salary_paid > 0, "salary flows in");
        let count = |kind: &str| events.iter().filter(|e| e.kind == kind).count();
        let owned = |id: &str| {
            world
                .dealer_index(id)
                .is_some_and(|i| world.dealers[i].owner.is_some())
        };
        assert!(
            events
                .iter()
                .any(|e| e.kind == "seated" && owned(&e.dealer)),
            "no owner-opened table took a seat"
        );
        assert!(count("opened") >= 1, "no table opened");
        assert!(count("seat_sold") >= 1, "no seat sale");
        assert!(count("evicted") >= 1, "no eviction");
        assert!(count("jackpot") >= 3, "only {} jackpots", count("jackpot"));
        // Two tables undercutting each other several times.
        let mut wars: HashMap<(usize, usize), usize> = HashMap::new();
        for &(a, b) in &world.price_wars {
            *wars.entry((a.min(b), a.max(b))).or_default() += 1;
        }
        assert!(wars.values().any(|&n| n >= 3), "no price war: {wars:?}");
    }

    #[test]
    fn stats_cover_the_last_hour_only() {
        let mut dealer = Dealer::npc(&LINEUP[0]);
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
    fn formatting() {
        assert_eq!(usdc(MIN_BET), "0.10");
        assert_eq!(usdc(36 * MIN_BET - 1), "3.60");
        assert_eq!(usdc(2_000 * USDC + 1), "2000.01");
        assert_eq!(percent_2(305), "3.05 %");
    }
}
