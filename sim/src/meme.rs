//! `sim meme`: 60 days (or `--days N`) of $TILT supply under a few floor scenarios, on the
//! contract's own rules (`tilt_house_meme::rules`: `day_pool`, `split`, `treasury_burn`,
//! `Streak`, `TiltHourProgress`) with the launch parameters `LAUNCH`.
//!
//! What is modelled (docs/tilt.md, "Simulation"): each day the human players play even-money
//! rounds at a 2 % house edge; their net result and wagers go through `report_day`'s rules; new
//! players claim the welcome mint (daily cap, pool); holders run Tilt Hour rituals (five burners
//! of 100 TILT) when they hold enough TILT. Not modelled: transfers, the TILT floor's own play,
//! and the edge discount during a Tilt Hour.

use core_rules::Rng;
use serde::Serialize;
use std::collections::BTreeMap;
use tilt_house_meme::rules::{
    day_pool, split, treasury_burn, Economics, Streak, TiltHourProgress, BP, LAUNCH, MAX_PLAYERS,
    ONE_TILT,
};

const ONE_TUSDC: u128 = 1_000_000;
/// House edge of the modelled rounds (even money, the player wins with probability (1 - edge)/2).
const EDGE_BP: u32 = 200;
/// A hot run: the dice favour the players by 6 % for the first two weeks of `hot-streak`.
const HOT_EDGE_BP: i32 = -600;
const HOT_DAYS: u32 = 14;
/// A Tilt Hour ritual: this many holders burn this much each.
const RITUAL_BURNERS: u32 = 5;
const RITUAL_BURN: u128 = 100 * ONE_TILT;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scenario {
    Quiet,
    Busy,
    Whales,
    HotStreak,
}

impl Scenario {
    pub const ALL: [Scenario; 4] = [
        Scenario::Quiet,
        Scenario::Busy,
        Scenario::Whales,
        Scenario::HotStreak,
    ];

    pub fn parse(name: &str) -> Option<Scenario> {
        Scenario::ALL.into_iter().find(|s| s.name() == name)
    }

    pub fn name(self) -> &'static str {
        match self {
            Scenario::Quiet => "quiet",
            Scenario::Busy => "busy",
            Scenario::Whales => "whales",
            Scenario::HotStreak => "hot-streak",
        }
    }

    fn profile(self) -> Profile {
        let small = |count, rounds, bet| Group {
            count,
            rounds,
            bet: bet * ONE_TUSDC,
        };
        match self {
            Scenario::Quiet => Profile {
                description: "4 humans, 30 rounds of 1 tUSDC each a day, 2 new players a day, no Tilt Hour (fewer than 5 burners)",
                groups: vec![small(4, 30, 1)],
                welcomes_per_day: 2,
                rituals_per_day: 0,
            },
            Scenario::Busy => Profile {
                description: "30 humans, 50-250 rounds of 2 tUSDC each a day, 15 new players a day, 1 Tilt Hour a day",
                groups: vec![small(30, 150, 2)],
                welcomes_per_day: 15,
                rituals_per_day: 1,
            },
            Scenario::Whales => Profile {
                description: "3 whales (100 rounds of 50 tUSDC) and 10 small players (30 rounds of 1 tUSDC), 3 new players a day, 1 Tilt Hour every other day",
                groups: vec![small(3, 100, 50), small(10, 30, 1)],
                welcomes_per_day: 3,
                rituals_per_day: 1,
            },
            Scenario::HotStreak => Profile {
                description: "busy floor whose dice run 6 % in the players' favour for the first 14 days, then normal; 25 new players a day, 2 Tilt Hours a day",
                groups: vec![small(30, 150, 2)],
                welcomes_per_day: 25,
                rituals_per_day: 2,
            },
        }
    }
}

struct Group {
    count: u32,
    /// Mean rounds a day (each player plays 1/3 to 5/3 of it).
    rounds: u32,
    bet: u128,
}

struct Profile {
    description: &'static str,
    groups: Vec<Group>,
    welcomes_per_day: u32,
    rituals_per_day: u32,
}

#[derive(Serialize)]
pub struct DayPoint {
    pub day: u32,
    pub supply: String,
    pub treasury: String,
    /// Daily mint + welcome claims.
    pub minted: String,
    /// Treasury burn + Tilt Hour burns.
    pub burned: String,
    pub streak: u32,
    pub players_net: String,
    pub tilt_hours: u32,
}

#[derive(Serialize)]
pub struct Summary {
    pub final_supply: String,
    pub final_treasury: String,
    pub player_days: u32,
    pub house_days: u32,
    pub longest_streak: u32,
    pub daily_minted: String,
    pub welcome_minted: String,
    pub treasury_burned: String,
    pub tilt_hour_burned: String,
    pub tilt_hours: u32,
}

#[derive(Serialize)]
pub struct Run {
    pub description: &'static str,
    pub summary: Summary,
    pub series: Vec<DayPoint>,
}

#[derive(Serialize)]
pub struct Output {
    pub params: Economics,
    pub days: u32,
    pub seed: u64,
    pub edge_bp: u32,
    pub scenarios: BTreeMap<&'static str, Run>,
}

pub fn output(scenarios: &[Scenario], days: u32, seed: u64) -> Output {
    Output {
        params: LAUNCH,
        days,
        seed,
        edge_bp: EDGE_BP,
        scenarios: scenarios
            .iter()
            .map(|s| (s.name(), run(*s, days, seed, &LAUNCH)))
            .collect(),
    }
}

fn rng_from_seed(seed: u64, scenario: Scenario) -> Rng {
    let mut bytes = [0u8; 32];
    bytes[..8].copy_from_slice(&seed.to_le_bytes());
    bytes[8] = scenario as u8;
    Rng::new(bytes)
}

/// One player's day: `rounds` even-money rounds of `bet` with the player winning with
/// probability (1 - edge)/2. Returns (wagered, net).
fn play(rng: &mut Rng, rounds: u32, bet: u128, edge_bp: i32) -> (u128, i128) {
    let win_bp = (BP as i32 - edge_bp) / 2;
    let wins = (0..rounds)
        .filter(|_| (rng.below(BP as u32) as i32) < win_bp)
        .count() as i128;
    let rounds_i = i128::from(rounds);
    (
        bet * u128::from(rounds),
        (2 * wins - rounds_i) * bet as i128,
    )
}

pub fn run(scenario: Scenario, days: u32, seed: u64, economics: &Economics) -> Run {
    let profile = scenario.profile();
    let mut rng = rng_from_seed(seed, scenario);
    let mut streak = Streak::default();
    let mut tilt_hour = TiltHourProgress::default();
    let mut treasury = economics.treasury_initial.0;
    // TILT outside the treasury and the house allocation: what holders can burn.
    let mut holders: u128 = 0;
    let mut welcome_left = economics.welcome_pool.0;
    let mut totals = Summary {
        final_supply: String::new(),
        final_treasury: String::new(),
        player_days: 0,
        house_days: 0,
        longest_streak: 0,
        daily_minted: String::new(),
        welcome_minted: String::new(),
        treasury_burned: String::new(),
        tilt_hour_burned: String::new(),
        tilt_hours: 0,
    };
    let (mut daily_minted, mut welcome_minted, mut treasury_burned, mut ritual_burned) =
        (0u128, 0u128, 0u128, 0u128);
    let mut series = Vec::with_capacity(days as usize);

    for day in 1..=days {
        let edge = if scenario == Scenario::HotStreak && day <= HOT_DAYS {
            HOT_EDGE_BP
        } else {
            EDGE_BP as i32
        };
        // Humans play.
        let mut wagers = Vec::new();
        let mut net: i128 = 0;
        for group in &profile.groups {
            for _ in 0..group.count {
                let rounds = group.rounds / 3 + rng.below(group.rounds * 4 / 3 + 1);
                let (wagered, result) = play(&mut rng, rounds, group.bet, edge);
                if wagered > 0 {
                    wagers.push(wagered);
                }
                net += result;
            }
        }
        // The floor reports the 50 largest wagerers.
        wagers.sort_unstable_by(|a, b| b.cmp(a));
        wagers.truncate(MAX_PLAYERS);

        // report_day.
        let players_won = net > 0;
        streak.record(day, players_won);
        let (mut minted, mut burned) = (0u128, 0u128);
        if players_won {
            totals.player_days += 1;
            let pool = day_pool(net, streak.current, economics);
            let shares = split(pool, &wagers, economics.player_day_cap.0);
            minted = shares.iter().sum();
            daily_minted += minted;
            holders += minted;
        } else {
            totals.house_days += 1;
            burned = treasury_burn(treasury, economics.burn_bp);
            treasury -= burned;
            treasury_burned += burned;
        }

        // Welcome claims.
        let claims = profile.welcomes_per_day.min(economics.welcome_daily_claims);
        for _ in 0..claims {
            let amount = economics.welcome_amount.0.min(welcome_left);
            welcome_left -= amount;
            holders += amount;
            minted += amount;
            welcome_minted += amount;
        }

        // Tilt Hour rituals, through the contract's window rules (one burn a second).
        let mut hours = 0;
        let rituals = if scenario == Scenario::Whales {
            profile.rituals_per_day * (day % 2)
        } else {
            profile.rituals_per_day
        };
        for ritual in 0..rituals {
            if holders < RITUAL_BURN * u128::from(RITUAL_BURNERS) {
                break;
            }
            let start_ns = (u64::from(day) * 86_400 + u64::from(ritual) * 7_200) * 1_000_000_000;
            for burner in 0..RITUAL_BURNERS {
                tilt_hour.roll(
                    start_ns + u64::from(burner) * 1_000_000_000,
                    economics.tilt_hour_window_secs,
                );
                holders -= RITUAL_BURN;
                burned += RITUAL_BURN;
                ritual_burned += RITUAL_BURN;
                if tilt_hour.add(RITUAL_BURN, true, economics).is_some() {
                    hours += 1;
                }
            }
        }
        totals.tilt_hours += hours;

        let supply = treasury + economics.house_allocation.0 + holders;
        series.push(DayPoint {
            day,
            supply: supply.to_string(),
            treasury: treasury.to_string(),
            minted: minted.to_string(),
            burned: burned.to_string(),
            streak: streak.current,
            players_net: net.to_string(),
            tilt_hours: hours,
        });
    }

    totals.final_supply = series.last().map(|p| p.supply.clone()).unwrap_or_default();
    totals.final_treasury = treasury.to_string();
    totals.longest_streak = streak.longest;
    totals.daily_minted = daily_minted.to_string();
    totals.welcome_minted = welcome_minted.to_string();
    totals.treasury_burned = treasury_burned.to_string();
    totals.tilt_hour_burned = ritual_burned.to_string();
    Run {
        description: profile.description,
        summary: totals,
        series,
    }
}

const USAGE: &str =
    "usage: sim meme [--days N] [--seed S] [--scenario quiet|busy|whales|hot-streak|all] [--out PATH]";

/// `sim meme …`: prints (or writes) the JSON of the chosen scenarios (default: all).
pub fn main(mut args: impl Iterator<Item = String>) -> Result<String, String> {
    let (mut days, mut seed, mut scenarios, mut out) = (60u32, 42u64, Scenario::ALL.to_vec(), None);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}\n{USAGE}"))?;
        match flag.as_str() {
            "--days" => {
                days = value
                    .parse()
                    .ok()
                    .filter(|d| *d > 0)
                    .ok_or_else(|| format!("--days needs a positive integer, got {value:?}"))?
            }
            "--seed" => {
                seed = value
                    .parse()
                    .map_err(|_| format!("--seed needs a non-negative integer, got {value:?}"))?
            }
            "--scenario" if value == "all" => scenarios = Scenario::ALL.to_vec(),
            "--scenario" => {
                scenarios = vec![Scenario::parse(&value)
                    .ok_or_else(|| format!("unknown scenario {value:?}\n{USAGE}"))?]
            }
            "--out" => out = Some(value),
            _ => return Err(format!("unknown argument {flag}\n{USAGE}")),
        }
    }
    let json = serde_json::to_string(&output(&scenarios, days, seed)).expect("output serializes");
    match out {
        Some(path) => {
            std::fs::write(&path, json + "\n").map_err(|e| format!("cannot write {path}: {e}"))?;
            Ok(String::new())
        }
        None => Ok(json),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn amount(s: &str) -> u128 {
        s.parse().unwrap()
    }

    #[test]
    fn supply_identity_holds_every_day() {
        for scenario in Scenario::ALL {
            let run = run(scenario, 60, 42, &LAUNCH);
            let mut supply = LAUNCH.treasury_initial.0 + LAUNCH.house_allocation.0;
            for point in &run.series {
                supply = supply + amount(&point.minted) - amount(&point.burned);
                assert_eq!(
                    supply,
                    amount(&point.supply),
                    "{scenario:?} day {}",
                    point.day
                );
                assert!(amount(&point.minted) <= LAUNCH.day_cap.0 + 25 * LAUNCH.welcome_amount.0);
            }
        }
    }

    #[test]
    fn scenarios_tell_different_stories() {
        let quiet = run(Scenario::Quiet, 60, 42, &LAUNCH).summary;
        let busy = run(Scenario::Busy, 60, 42, &LAUNCH).summary;
        let hot = run(Scenario::HotStreak, 60, 42, &LAUNCH).summary;
        // A busy floor is almost always a house day; a quiet one often is not.
        assert!(quiet.player_days > busy.player_days);
        assert!(hot.longest_streak >= 10);
        assert_eq!(quiet.tilt_hours, 0);
        assert!(busy.tilt_hours > 0);
    }

    #[test]
    fn deterministic_for_a_seed() {
        let a = serde_json::to_string(&output(&Scenario::ALL, 10, 7)).unwrap();
        let b = serde_json::to_string(&output(&Scenario::ALL, 10, 7)).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn arguments() {
        let parse = |args: &[&str]| main(args.iter().map(|a| a.to_string()));
        assert!(parse(&["--scenario", "busy", "--days", "3"])
            .unwrap()
            .contains("\"busy\""));
        assert!(parse(&["--scenario", "moon"]).is_err());
        assert!(parse(&["--days", "0"]).is_err());
        assert!(parse(&["--days"]).is_err());
        assert!(parse(&["--speed", "2"]).is_err());
    }
}
