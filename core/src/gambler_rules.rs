//! # How a gambler behaves (docs/tycoon.md, "Gambler rules")
//!
//! The casino's customers are 24 NPC gamblers, each with its own wallet and a **persona**. This
//! file is everything they decide; the live runner and the simulator both call it, with their
//! own random numbers passed in (`&mut Rng`), so the same draws give the same choices.
//!
//! **Personas.**
//! - *Bargain hunter*: cares about the total edge above everything.
//! - *Regular*: goes back to the tables that treated it well, avoids those that burned it.
//! - *Whale*: rare, bets big; needs a table whose max bet takes its stakes.
//! - *Thrill seeker*: chases boosts and a fat jackpot.
//! - *Tourist*: sits wherever it walks past first: seats by the entrance win.
//!
//! **Arriving.** Every minute, each gambler off the floor may walk in. The chance follows the
//! clock: quiet at 04:00 (UTC), busiest around 21:00 (`DAY_CURVE_BP`), and depends on the persona
//! (whales come rarely). A gambler without the money for a minimum bet stays home.
//!
//! **Picking a table.** On arrival the gambler looks at every seated table that is open and gives
//! each a score. Six things count, each on a 0–100 scale: how low the total edge is, whether the
//! table is boosting, how much of the stake it wants the max bet takes, how busy the seat is
//! (`SEAT_TRAFFIC_BP`), what it remembers about the table (−100 to 100), and the jackpot. The
//! persona's weights (`weights`) mix them, a little noise makes people a bit unpredictable, and
//! the best table wins if it clears the persona's threshold. Otherwise the gambler leaves:
//! "nothing worth it". Every decision comes with a one-line reason, e.g. "Ada's 1.0 % beats
//! Bruno's 2.4 %", naming what made the winner beat the runner-up.
//!
//! **Playing.** At the table the gambler plays one session (docs/sessions.md): a persona-sized
//! stake (never above the table's max bet, never more than a fifth of its balance) for a
//! persona-sized number of rounds, then leaves. It locks at most its balance.
//!
//! **Remembering.** After the session the gambler updates its loyalty to that table: up after
//! a win, down after a loss, more for a bigger result relative to what it locked. Old feelings
//! fade by a quarter each time.
//!
//! **Money.** The house pays every gambler a salary, `GAMBLER_SALARY_PER_HOUR`, until its balance
//! reaches `GAMBLER_MAX_BALANCE`. It is the economy's only money from outside.
//!
//! Amounts are USDC base units (6 decimals); times are seconds.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::dice::{DiceBet, MAX_CHANCE_BP, MIN_CHANCE_BP};
use crate::jackpot::MIN_JACKPOT;
use crate::roulette::RouletteBet;
use crate::seats::SEAT_TRAFFIC_BP;
use crate::session::SESSION_MIN_BET;
use crate::{Bet, Game, Rng, BP};

/// How many NPC gamblers walk the floor.
pub const GAMBLERS: usize = 24;

/// The house pays each gambler 5 USDC an hour...
pub const GAMBLER_SALARY_PER_HOUR: u128 = 5_000_000;
/// ...until its balance reaches 200 USDC.
pub const GAMBLER_MAX_BALANCE: u128 = 200_000_000;

/// Share of the peak arrival rate for each hour of the day (UTC), in bp: quiet before dawn,
/// busy in the evening.
pub const DAY_CURVE_BP: [u16; 24] = [
    7_000, 5_500, 4_000, 2_500, 1_500, 1_500, 2_000, 2_500, 3_000, 3_500, 4_000, 4_500, 5_000,
    5_500, 6_000, 6_500, 7_000, 7_500, 8_500, 9_500, 10_000, 10_000, 9_500, 8_500,
];

/// Random spread added to every table's score, ± this many points.
pub const NOISE_POINTS: u32 = 25;

/// A gambler never stakes more than a fifth of its balance per round.
pub const STAKE_BALANCE_DIVISOR: u128 = 5;

/// Total edges are bounded to 1–5 % (`rake_bounds`); the edge score maps that range to 100–0.
const EDGE_FLOOR_BP: u16 = 100;
const EDGE_CEILING_BP: u16 = 500;

/// A jackpot this big (100 USDC) excites as much as any jackpot can.
const EXCITING_JACKPOT: u128 = 100_000_000;

/// How much one session's result moves loyalty: a base step, plus up to this much for a
/// result as large as the lock.
const LOYALTY_STEP: i32 = 20;
const LOYALTY_SCALE: i32 = 60;
pub const LOYALTY_MAX: i16 = 100;

/// Most tables a gambler remembers (as many as there can be dealers).
pub const MEMORY_TABLES: usize = crate::floor::MAX_DEALERS;

#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    BorshSerialize,
    BorshDeserialize,
    Serialize,
    Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Persona {
    BargainHunter,
    Regular,
    Whale,
    ThrillSeeker,
    Tourist,
}

impl Persona {
    pub const ALL: [Persona; 5] = [
        Self::BargainHunter,
        Self::Regular,
        Self::Whale,
        Self::ThrillSeeker,
        Self::Tourist,
    ];

    /// Stable identifier for JSON and logs.
    pub fn code(&self) -> &'static str {
        match self {
            Self::BargainHunter => "bargain_hunter",
            Self::Regular => "regular",
            Self::Whale => "whale",
            Self::ThrillSeeker => "thrill_seeker",
            Self::Tourist => "tourist",
        }
    }
}

/// The 24 gamblers (account `g-<name>`, lower case), shared by the live runner and the sim.
pub const LINEUP: [(&str, Persona); GAMBLERS] = [
    ("Mia", Persona::BargainHunter),
    ("Noah", Persona::Regular),
    ("Zoe", Persona::Tourist),
    ("Liam", Persona::ThrillSeeker),
    ("Ines", Persona::BargainHunter),
    ("Omar", Persona::Regular),
    ("Kai", Persona::Whale),
    ("Lea", Persona::Tourist),
    ("Hugo", Persona::BargainHunter),
    ("Nina", Persona::Regular),
    ("Theo", Persona::ThrillSeeker),
    ("Ava", Persona::Tourist),
    ("Yuki", Persona::BargainHunter),
    ("Sam", Persona::Regular),
    ("Iris", Persona::ThrillSeeker),
    ("Max", Persona::Tourist),
    ("Rosa", Persona::BargainHunter),
    ("Ezra", Persona::Regular),
    ("Vera", Persona::Whale),
    ("Paul", Persona::Tourist),
    ("June", Persona::BargainHunter),
    ("Ravi", Persona::Regular),
    ("Lola", Persona::ThrillSeeker),
    ("Tom", Persona::BargainHunter),
];

/// How much each score part counts for a persona, in percent, and the score a table needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Weights {
    pub edge: i32,
    pub boost: i32,
    pub fit: i32,
    pub traffic: i32,
    pub loyalty: i32,
    pub jackpot: i32,
    /// The best table must score at least this, or the gambler leaves.
    pub threshold: i32,
}

pub fn weights(persona: Persona) -> Weights {
    let w = |edge, boost, fit, traffic, loyalty, jackpot, threshold| Weights {
        edge,
        boost,
        fit,
        traffic,
        loyalty,
        jackpot,
        threshold,
    };
    match persona {
        // Needs an edge under about 3.5 %.
        Persona::BargainHunter => w(300, 50, 30, 20, 20, 0, 150),
        Persona::Regular => w(80, 20, 40, 30, 150, 10, 90),
        // Needs a max bet that takes nearly all of its stake.
        Persona::Whale => w(80, 20, 250, 10, 30, 10, 220),
        Persona::ThrillSeeker => w(40, 120, 40, 30, 20, 150, 110),
        // Back seats rarely clear its bar.
        Persona::Tourist => w(40, 40, 30, 200, 10, 20, 130),
    }
}

/// Per-minute chance (parts per million) that a gambler off the floor walks in at peak time.
fn peak_arrival_ppm(persona: Persona) -> u32 {
    match persona {
        Persona::BargainHunter => 50_000,
        Persona::Regular => 60_000,
        Persona::Whale => 15_000,
        Persona::ThrillSeeker => 40_000,
        Persona::Tourist => 30_000,
    }
}

/// Stake range per round, in base units.
fn stake_range(persona: Persona) -> (u128, u128) {
    match persona {
        Persona::BargainHunter => (500_000, 2_000_000),
        Persona::Regular => (500_000, 3_000_000),
        Persona::Whale => (10_000_000, 30_000_000),
        Persona::ThrillSeeker => (1_000_000, 5_000_000),
        Persona::Tourist => (200_000, 1_000_000),
    }
}

/// Rounds per session.
fn rounds_range(persona: Persona) -> (u32, u32) {
    match persona {
        Persona::BargainHunter => (20, 60),
        Persona::Regular => (30, 90),
        Persona::Whale => (10, 40),
        Persona::ThrillSeeker => (10, 30),
        Persona::Tourist => (5, 20),
    }
}

/// Uniform in `lo..=hi` (`hi < lo` gives `lo`).
fn between(rng: &mut Rng, lo: u128, hi: u128) -> u128 {
    let span = u32::try_from(hi.saturating_sub(lo)).unwrap_or(u32::MAX - 1);
    lo + u128::from(rng.below(span + 1))
}

/// Share of the peak arrival rate at `now`, in bp.
pub fn day_curve_bp(now: u64) -> u16 {
    DAY_CURVE_BP[((now % 86_400) / 3_600) as usize]
}

/// Whether a gambler off the floor walks in during the minute starting at `now`. Drawn once a
/// minute per gambler: the discrete form of a Poisson arrival process.
pub fn arrives(persona: Persona, balance: u128, now: u64, rng: &mut Rng) -> bool {
    if balance < SESSION_MIN_BET {
        return false;
    }
    let chance = u64::from(peak_arrival_ppm(persona)) * u64::from(day_curve_bp(now)) / BP as u64;
    u64::from(rng.below(1_000_000)) < chance
}

/// What the gambler would like to stake per round today: within its persona's range, at most a
/// fifth of its balance.
pub fn desired_stake(persona: Persona, balance: u128, rng: &mut Rng) -> u128 {
    let (lo, hi) = stake_range(persona);
    between(rng, lo, hi).min(balance / STAKE_BALANCE_DIVISOR)
}

/// A seated, open table as a gambler sees it from the aisle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TableView<'a> {
    pub dealer_id: &'a str,
    pub name: &'a str,
    pub game: Game,
    /// Seat index, 0 = by the entrance.
    pub seat: usize,
    /// Total edge in force (game edge + rake, boost included).
    pub edge_bp: u16,
    pub boosting: bool,
    pub max_bet: u128,
}

/// What a gambler remembers about tables: loyalty from −100 (burned) to 100 (loves it).
#[derive(
    Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
pub struct Memory {
    tables: Vec<(String, i16)>,
}

impl Memory {
    pub fn loyalty(&self, dealer_id: &str) -> i16 {
        self.tables
            .iter()
            .find(|(id, _)| id == dealer_id)
            .map_or(0, |(_, loyalty)| *loyalty)
    }

    /// After a session that locked `lock` and ended `net` (positive: the gambler won): old
    /// feelings fade by a quarter, then a win adds and a loss subtracts 20 points plus up to 60
    /// more for a result as large as the lock. A full memory forgets the mildest table.
    pub fn remember(&mut self, dealer_id: &str, net: i128, lock: u128) {
        let old = i32::from(self.loyalty(dealer_id));
        let size = (net.unsigned_abs().min(lock) * LOYALTY_SCALE as u128)
            .checked_div(lock)
            .map_or(0, |size| size as i32);
        let delta = match net.signum() {
            1 => LOYALTY_STEP + size,
            -1 => -(LOYALTY_STEP + size),
            _ => 0,
        };
        let max = i32::from(LOYALTY_MAX);
        let new = (old * 3 / 4 + delta).clamp(-max, max) as i16;
        self.tables.retain(|(id, _)| id != dealer_id);
        if self.tables.len() >= MEMORY_TABLES {
            if let Some(mildest) = (0..self.tables.len()).min_by_key(|&i| self.tables[i].1.abs()) {
                self.tables.remove(mildest);
            }
        }
        self.tables.push((dealer_id.to_string(), new));
    }
}

/// One table's score parts, each 0–100 (loyalty −100–100), before weights.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Parts {
    pub edge: i32,
    pub boost: i32,
    pub fit: i32,
    pub traffic: i32,
    pub loyalty: i32,
    pub jackpot: i32,
}

impl Parts {
    /// `(part, weighted points)` in reason order.
    fn weighted(&self, w: &Weights) -> [(Part, i32); 6] {
        [
            (Part::Edge, self.edge * w.edge / 100),
            (Part::Boost, self.boost * w.boost / 100),
            (Part::Fit, self.fit * w.fit / 100),
            (Part::Traffic, self.traffic * w.traffic / 100),
            (Part::Loyalty, self.loyalty * w.loyalty / 100),
            (Part::Jackpot, self.jackpot * w.jackpot / 100),
        ]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Part {
    Edge,
    Boost,
    Fit,
    Traffic,
    Loyalty,
    Jackpot,
}

/// The score parts of one table for a gambler wanting to stake `stake`.
pub fn parts(table: &TableView, stake: u128, loyalty: i16, jackpot: u128) -> Parts {
    let edge = table.edge_bp.clamp(EDGE_FLOOR_BP, EDGE_CEILING_BP);
    let fit = (table.max_bet.min(stake) * 100)
        .checked_div(stake)
        .map_or(100, |fit| fit as i32);
    let traffic = SEAT_TRAFFIC_BP
        .get(table.seat)
        .map_or(0, |bp| i32::from(*bp) * 100 / i32::from(SEAT_TRAFFIC_BP[0]));
    Parts {
        edge: i32::from(EDGE_CEILING_BP - edge) * 100 / i32::from(EDGE_CEILING_BP - EDGE_FLOOR_BP),
        boost: if table.boosting { 100 } else { 0 },
        fit,
        traffic,
        loyalty: i32::from(loyalty.clamp(-LOYALTY_MAX, LOYALTY_MAX)),
        jackpot: (jackpot.min(EXCITING_JACKPOT) * 100 / EXCITING_JACKPOT) as i32,
    }
}

/// A table's score: the persona-weighted parts plus `noise`.
pub fn score(persona: Persona, parts: &Parts, noise: i32) -> i32 {
    let w = weights(persona);
    parts
        .weighted(&w)
        .iter()
        .map(|(_, points)| points)
        .sum::<i32>()
        + noise
}

/// Why a gambler did what it did.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GamblerReason {
    Cheapest,
    Loyal,
    FitsMyBets,
    Boosting,
    Jackpot,
    NearEntrance,
    BestOverall,
    NothingWorthIt,
    Broke,
}

impl GamblerReason {
    /// Stable identifier for JSON and logs.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Cheapest => "cheapest",
            Self::Loyal => "loyal",
            Self::FitsMyBets => "fits_my_bets",
            Self::Boosting => "boosting",
            Self::Jackpot => "jackpot",
            Self::NearEntrance => "near_entrance",
            Self::BestOverall => "best_overall",
            Self::NothingWorthIt => "nothing_worth_it",
            Self::Broke => "broke",
        }
    }
}

/// A gambler's choice: a table (index into the `tables` given) or none, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub table: Option<usize>,
    pub reason: GamblerReason,
    /// The line shown above the gambler.
    pub text: String,
}

/// "2.4 %" from 240 bp.
fn percent(bp: u16) -> String {
    format!("{}.{} %", bp / 100, bp % 100 / 10)
}

/// "12.5" from 12_500_000 base units.
fn usdc(amount: u128) -> String {
    format!("{}.{}", amount / 1_000_000, amount % 1_000_000 / 100_000)
}

/// Scores every table and picks one (see the module doc). `tables` are the seated, open tables;
/// noise is drawn once per table, in order.
pub fn choose_table(
    persona: Persona,
    balance: u128,
    stake: u128,
    tables: &[TableView],
    memory: &Memory,
    jackpot: u128,
    rng: &mut Rng,
) -> Decision {
    if balance < SESSION_MIN_BET || stake < SESSION_MIN_BET {
        return Decision {
            table: None,
            reason: GamblerReason::Broke,
            text: "broke until payday".to_string(),
        };
    }
    let w = weights(persona);
    let mut scored: Vec<(usize, i32, Parts)> = tables
        .iter()
        .enumerate()
        .map(|(i, table)| {
            let noise = rng.below(2 * NOISE_POINTS + 1) as i32 - NOISE_POINTS as i32;
            let p = parts(table, stake, memory.loyalty(table.dealer_id), jackpot);
            (i, score(persona, &p, noise), p)
        })
        .collect();
    // Best first; ties go to the seat nearest the entrance, then the first listed.
    scored.sort_by_key(|(i, s, _)| (-s, tables[*i].seat, *i));
    let Some(&(best, best_score, best_parts)) = scored.first() else {
        return Decision {
            table: None,
            reason: GamblerReason::NothingWorthIt,
            text: "nothing worth it: no table is open".to_string(),
        };
    };
    if best_score < w.threshold {
        return Decision {
            table: None,
            reason: GamblerReason::NothingWorthIt,
            text: format!(
                "nothing worth it: {}'s {} at best",
                tables[best].name,
                percent(tables[best].edge_bp)
            ),
        };
    }
    let runner_up = scored.get(1).map(|&(i, _, p)| (&tables[i], p));
    let (reason, text) = explain(
        persona,
        stake,
        jackpot,
        &tables[best],
        &best_parts,
        runner_up,
    );
    Decision {
        table: Some(best),
        reason,
        text,
    }
}

/// The part that made the winner beat the runner-up the most (or, alone, that scored most).
fn explain(
    persona: Persona,
    stake: u128,
    jackpot: u128,
    best: &TableView,
    best_parts: &Parts,
    runner_up: Option<(&TableView, Parts)>,
) -> (GamblerReason, String) {
    let w = weights(persona);
    let mine = best_parts.weighted(&w);
    let theirs = runner_up.map_or([0; 6], |(_, p)| p.weighted(&w).map(|(_, points)| points));
    let lead = mine
        .iter()
        .zip(theirs)
        .map(|(&(part, points), other)| (part, points - other))
        .filter(|&(_, gap)| gap > 0)
        .max_by_key(|&(_, gap)| gap)
        .map(|(part, _)| part);
    let name = best.name;
    match lead {
        Some(Part::Edge) => {
            let text = match runner_up {
                Some((other, _)) => format!(
                    "{name}'s {} beats {}'s {}",
                    percent(best.edge_bp),
                    other.name,
                    percent(other.edge_bp)
                ),
                None => format!("{name}'s {} is fair", percent(best.edge_bp)),
            };
            (GamblerReason::Cheapest, text)
        }
        Some(Part::Boost) => (GamblerReason::Boosting, format!("{name} is boosting")),
        Some(Part::Fit) => (
            GamblerReason::FitsMyBets,
            format!("{name} takes my {} bets", usdc(stake)),
        ),
        Some(Part::Traffic) => (
            GamblerReason::NearEntrance,
            format!("{name} is right by the entrance"),
        ),
        Some(Part::Loyalty) => (
            GamblerReason::Loyal,
            format!("{name} treated me well last time"),
        ),
        Some(Part::Jackpot) | None
            if persona == Persona::ThrillSeeker && jackpot >= MIN_JACKPOT =>
        {
            (
                GamblerReason::Jackpot,
                format!("jackpot at {} tUSDC, {name} it is", usdc(jackpot)),
            )
        }
        Some(Part::Jackpot) | None => (GamblerReason::BestOverall, format!("{name} feels right")),
    }
}

/// One session's plan: the stake per round, how many rounds, and what to lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionPlan {
    pub stake: u128,
    pub rounds: u32,
    /// Moved into the session escrow: enough for every round, at most the balance.
    pub lock: u128,
}

/// The session a gambler plays at a table with this max bet, or `None` if it cannot even
/// stake the minimum.
pub fn plan_session(
    persona: Persona,
    stake: u128,
    max_bet: u128,
    balance: u128,
    rng: &mut Rng,
) -> Option<SessionPlan> {
    let stake = stake
        .min(max_bet)
        .min(balance / STAKE_BALANCE_DIVISOR)
        .max(SESSION_MIN_BET);
    if stake > max_bet || stake > balance {
        return None;
    }
    let (lo, hi) = rounds_range(persona);
    let rounds = between(rng, u128::from(lo), u128::from(hi)) as u32;
    Some(SessionPlan {
        stake,
        rounds,
        lock: stake.saturating_mul(u128::from(rounds)).min(balance),
    })
}

/// The bet of one round. Whales and thrill seekers chase long shots.
pub fn pick_bet(persona: Persona, game: Game, rng: &mut Rng) -> Bet {
    let long_shots = matches!(persona, Persona::Whale | Persona::ThrillSeeker);
    match game {
        Game::Dice => {
            let chance_bp = if long_shots {
                [100, 200, 500, 1_000][rng.below(4) as usize]
            } else {
                [500, 1_000, 2_500, 4_950, 5_000, 5_000, 7_500, 9_000][rng.below(8) as usize]
            };
            debug_assert!((MIN_CHANCE_BP..=MAX_CHANCE_BP).contains(&chance_bp));
            Bet::Dice(DiceBet {
                chance_bp,
                over: rng.below(2) == 1,
            })
        }
        Game::Roulette => {
            if long_shots || rng.below(10) == 0 {
                return Bet::Roulette(RouletteBet::Straight(rng.below(37) as u8));
            }
            Bet::Roulette(match rng.below(7) {
                0 => RouletteBet::Red,
                1 => RouletteBet::Black,
                2 => RouletteBet::Odd,
                3 => RouletteBet::Even,
                4 => RouletteBet::High,
                5 => RouletteBet::Dozen(rng.below(3) as u8 + 1),
                _ => RouletteBet::Column(rng.below(3) as u8 + 1),
            })
        }
        Game::Blackjack => Bet::Blackjack,
    }
}

/// Salary owed for `secs` of time to a gambler holding `balance`: 5 USDC an hour (rounded down),
/// never lifting the balance above `GAMBLER_MAX_BALANCE`. Pay it hourly to lose nothing to
/// rounding.
pub fn salary_for(balance: u128, secs: u64) -> u128 {
    let earned = GAMBLER_SALARY_PER_HOUR * u128::from(secs) / 3_600;
    earned.min(GAMBLER_MAX_BALANCE.saturating_sub(balance))
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: u128 = 1_000_000;

    fn table<'a>(name: &'a str, seat: usize, edge_bp: u16) -> TableView<'a> {
        TableView {
            dealer_id: name,
            name,
            game: Game::Dice,
            seat,
            edge_bp,
            boosting: false,
            max_bet: 100 * USDC,
        }
    }

    fn rng(seed: u8) -> Rng {
        Rng::new([seed; 32])
    }

    /// Property: for every persona, any other inputs and any noise, raising a table's edge
    /// never raises its score (so a bargain hunter never prefers a dearer twin).
    #[test]
    fn higher_edge_never_scores_higher() {
        let mut r = rng(1);
        for _ in 0..20_000 {
            let persona = Persona::ALL[r.below(5) as usize];
            let mut t = table("a", r.below(6) as usize, 50 + r.below(600) as u16);
            t.boosting = r.below(2) == 1;
            t.max_bet = u128::from(r.below(50_000_000));
            let stake = u128::from(r.below(30_000_000));
            let loyalty = r.below(201) as i16 - 100;
            let jackpot = u128::from(r.below(200_000_000));
            let noise = r.below(51) as i32 - 25;
            let dearer = TableView {
                edge_bp: t.edge_bp + 1 + r.below(300) as u16,
                ..t
            };
            let cheap = score(persona, &parts(&t, stake, loyalty, jackpot), noise);
            let dear = score(persona, &parts(&dearer, stake, loyalty, jackpot), noise);
            assert!(dear <= cheap, "{persona:?} {t:?} → {dearer:?}");
        }
    }

    /// Property: two tables identical but for the edge: a bargain hunter, with the same draws,
    /// never picks the dearer one.
    #[test]
    fn bargain_hunter_never_picks_the_dearer_twin() {
        let mut r = rng(2);
        for seed in 0..2_000u32 {
            let cheap = 100 + r.below(300) as u16;
            // 70 bp is 52 weighted points for a bargain hunter: more than any noise gap (50).
            let dear = cheap + 70 + r.below(100) as u16;
            // Same seat for both: only the edge differs. Order alternates.
            let (a, b) = (table("Cheap", 2, cheap), table("Dear", 2, dear));
            let tables = if seed % 2 == 0 { [a, b] } else { [b, a] };
            let mut draws = Rng::new([(seed % 251) as u8; 32]);
            let decision = choose_table(
                Persona::BargainHunter,
                100 * USDC,
                USDC,
                &tables,
                &Memory::default(),
                0,
                &mut draws,
            );
            if let Some(i) = decision.table {
                assert_eq!(tables[i].name, "Cheap", "{decision:?}");
            }
        }
    }

    #[test]
    fn reasons_name_what_won() {
        let tables = [table("Ada", 3, 100), table("Bruno", 3, 240)];
        let d = choose_table(
            Persona::BargainHunter,
            100 * USDC,
            USDC,
            &tables,
            &Memory::default(),
            0,
            &mut rng(3),
        );
        assert_eq!(d.table, Some(0));
        assert_eq!(d.reason, GamblerReason::Cheapest);
        assert_eq!(d.text, "Ada's 1.0 % beats Bruno's 2.4 %");

        // Tourists go by the door.
        let tables = [table("Back", 5, 250), table("Door", 0, 250)];
        let d = choose_table(
            Persona::Tourist,
            100 * USDC,
            USDC / 2,
            &tables,
            &Memory::default(),
            0,
            &mut rng(4),
        );
        assert_eq!((d.table, d.reason), (Some(1), GamblerReason::NearEntrance));

        // Whales need the max bet.
        let mut small = table("Small", 0, 150);
        small.max_bet = USDC;
        let tables = [small, table("Big", 4, 300)];
        let d = choose_table(
            Persona::Whale,
            200 * USDC,
            20 * USDC,
            &tables,
            &Memory::default(),
            0,
            &mut rng(5),
        );
        assert_eq!((d.table, d.reason), (Some(1), GamblerReason::FitsMyBets));
        assert_eq!(d.text, "Big takes my 20.0 bets");
    }

    #[test]
    fn leaves_when_nothing_is_worth_it_or_broke() {
        let tables = [table("Ada", 5, 495)];
        let d = choose_table(
            Persona::BargainHunter,
            100 * USDC,
            USDC,
            &tables,
            &Memory::default(),
            0,
            &mut rng(6),
        );
        assert_eq!((d.table, d.reason), (None, GamblerReason::NothingWorthIt));
        assert_eq!(d.text, "nothing worth it: Ada's 4.9 % at best");
        let d = choose_table(
            Persona::Regular,
            0,
            0,
            &tables,
            &Memory::default(),
            0,
            &mut rng(6),
        );
        assert_eq!(d.reason, GamblerReason::Broke);
        let d = choose_table(
            Persona::Regular,
            100 * USDC,
            USDC,
            &[],
            &Memory::default(),
            0,
            &mut rng(6),
        );
        assert_eq!(d.table, None);
    }

    #[test]
    fn regulars_follow_their_memory() {
        let mut memory = Memory::default();
        memory.remember("Bruno", 20 * USDC as i128, 20 * USDC);
        memory.remember("Ada", -20 * USDC as i128, 20 * USDC);
        assert_eq!(memory.loyalty("Bruno"), 80);
        assert_eq!(memory.loyalty("Ada"), -80);
        let tables = [table("Ada", 3, 200), table("Bruno", 3, 250)];
        let d = choose_table(
            Persona::Regular,
            100 * USDC,
            USDC,
            &tables,
            &memory,
            0,
            &mut rng(7),
        );
        assert_eq!((d.table, d.reason), (Some(1), GamblerReason::Loyal));
        // Feelings fade, then flip.
        memory.remember("Bruno", -(USDC as i128), 20 * USDC);
        assert_eq!(memory.loyalty("Bruno"), 80 * 3 / 4 - 23);
    }

    #[test]
    fn memory_is_bounded() {
        let mut memory = Memory::default();
        for i in 0..MEMORY_TABLES + 5 {
            memory.remember(&format!("t{i}"), (i as i128 + 1) * USDC as i128, 100 * USDC);
        }
        assert_eq!(memory.tables.len(), MEMORY_TABLES);
        // The mildest feelings were forgotten first.
        assert_eq!(memory.loyalty("t0"), 0);
        assert!(memory.loyalty(&format!("t{}", MEMORY_TABLES + 4)) > 0);
        let mut m = Memory::default();
        m.remember("x", 1_000 * USDC as i128, USDC);
        assert_eq!(m.loyalty("x"), 80);
        for _ in 0..10 {
            m.remember("x", 1_000 * USDC as i128, USDC);
        }
        assert_eq!(m.loyalty("x"), LOYALTY_MAX);
    }

    #[test]
    fn sessions_respect_max_bet_and_balance() {
        let mut r = rng(8);
        for _ in 0..5_000 {
            let persona = Persona::ALL[r.below(5) as usize];
            let balance = u128::from(r.below(300_000_000));
            let max_bet = u128::from(r.below(40_000_000));
            let stake = desired_stake(persona, balance, &mut r);
            assert!(stake <= balance / STAKE_BALANCE_DIVISOR);
            if let Some(plan) = plan_session(persona, stake, max_bet, balance, &mut r) {
                assert!(plan.stake >= SESSION_MIN_BET && plan.stake <= max_bet);
                assert!(plan.stake <= balance && plan.lock <= balance);
                assert!(plan.lock >= plan.stake);
                let (lo, hi) = rounds_range(persona);
                assert!((lo..=hi).contains(&plan.rounds));
            } else {
                assert!(max_bet < SESSION_MIN_BET || balance < SESSION_MIN_BET);
            }
        }
    }

    #[test]
    fn arrivals_follow_the_clock() {
        let count = |hour: u64| {
            let mut r = rng(9);
            (0..20_000)
                .filter(|_| arrives(Persona::Regular, 100 * USDC, hour * 3_600, &mut r))
                .count()
        };
        let (night, evening) = (count(4), count(21));
        assert!(night * 4 < evening, "{night} vs {evening}");
        assert!(!arrives(
            Persona::Regular,
            SESSION_MIN_BET - 1,
            21 * 3_600,
            &mut rng(9)
        ));
    }

    #[test]
    fn salary_stops_at_the_cap() {
        assert_eq!(salary_for(0, 3_600), GAMBLER_SALARY_PER_HOUR);
        assert_eq!(salary_for(GAMBLER_MAX_BALANCE - USDC, 3_600), USDC);
        assert_eq!(salary_for(GAMBLER_MAX_BALANCE + 1, 3_600), 0);
        assert_eq!(salary_for(0, 0), 0);
    }

    #[test]
    fn bets_are_valid() {
        let mut r = rng(10);
        for _ in 0..2_000 {
            let persona = Persona::ALL[r.below(5) as usize];
            for game in [Game::Dice, Game::Roulette, Game::Blackjack] {
                let bet = pick_bet(persona, game, &mut r);
                assert!(bet.is_valid() && bet.game() == game);
            }
        }
    }

    #[test]
    fn lineup_and_codes() {
        assert_eq!(LINEUP.len(), GAMBLERS);
        for persona in Persona::ALL {
            assert!(LINEUP.iter().any(|(_, p)| *p == persona));
            assert_eq!(
                serde_json::to_string(&persona).unwrap(),
                format!("\"{}\"", persona.code())
            );
        }
    }
}
