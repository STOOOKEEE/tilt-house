//! The $TILT rules as plain functions over integers: the launch economics, the daily mint and
//! burn, the streak and the Tilt Hour window. The contract (`lib.rs`) and the 60-day simulator
//! (`sim meme`) both call these, so the simulation runs the deployed rules.
//!
//! Amounts are TILT base units (6 decimals) or tUSDC base units (6 decimals), never floats.

#[cfg(feature = "contract")]
pub use near_sdk::json_types::{U128, U64};
#[cfg(not(feature = "contract"))]
pub use plain::{U128, U64};

/// The amount wrappers without near-sdk (simulator build): same field, same JSON (decimal
/// strings).
#[cfg(not(feature = "contract"))]
mod plain {
    use serde::{Serialize, Serializer};

    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct U128(pub u128);

    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct U64(pub u64);

    impl Serialize for U128 {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.collect_str(&self.0)
        }
    }

    impl Serialize for U64 {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.collect_str(&self.0)
        }
    }
}

/// Basis points: 10,000 = 100 %.
pub const BP: u128 = 10_000;
/// 1 TILT in base units (6 decimals, like tUSDC: one chip of USD floor net maps to TILT 1:1 at 10,000 bp).
pub const ONE_TILT: u128 = 1_000_000;
/// Most players a day report may list (the floor sends the largest wagerers first).
pub const MAX_PLAYERS: usize = 50;
/// Largest amount accepted from the floor for one player's wager, or a cap: keeps every product
/// below u128 (`pool × wager` with 50 wagers each < 2^64).
pub const MAX_AMOUNT: u128 = u64::MAX as u128;
/// One UTC day in nanoseconds.
pub const DAY_NS: u64 = 86_400 * 1_000_000_000;
const SECOND_NS: u64 = 1_000_000_000;

/// UTC day number (days since 1970-01-01) of a block timestamp, the same day index as the floor.
pub fn utc_day(timestamp_ns: u64) -> u32 {
    // u32 days cover 11 million years.
    (timestamp_ns / DAY_NS) as u32
}

/// Launch economics: set once by `new`, readable through `get_params`, never changed (the
/// contract has no owner and no setter).
#[cfg_attr(feature = "contract", near_sdk::near(serializers = [borsh, json]))]
#[cfg_attr(not(feature = "contract"), derive(serde::Serialize))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Economics {
    /// Minted to the contract at launch: the treasury, the only balance the daily rule burns.
    pub treasury_initial: U128,
    /// Minted to the house receiver at launch: the bankroll of the TILT floor's dealers.
    pub house_allocation: U128,
    /// Reserve of welcome mints (not minted at launch: each claim mints).
    pub welcome_pool: U128,
    /// Minted once per account by `claim_welcome_for`.
    pub welcome_amount: U128,
    /// Most welcome claims per UTC day.
    pub welcome_daily_claims: u32,
    /// TILT base units minted per tUSDC base unit the humans won from the house, in bp.
    pub mint_rate_bp: u32,
    /// Extra mint per consecutive winning day after the first, in bp of the base mint.
    pub streak_bonus_bp: u32,
    /// The streak bonus stops growing after this many extra days.
    pub streak_bonus_max_days: u32,
    /// Most TILT one player can receive from one day.
    pub player_day_cap: U128,
    /// Most TILT one day can mint in total.
    pub day_cap: U128,
    /// Share of the treasury burned on a house day, in bp.
    pub burn_bp: u32,
    /// TILT to burn within one window to start a Tilt Hour.
    pub tilt_hour_amount: U128,
    /// Distinct accounts that must burn within the window.
    pub tilt_hour_min_burners: u32,
    /// Smallest burn accepted (a dust burn does not make a burner).
    pub tilt_hour_min_burn: U128,
    /// Window length, from the first burn of a round.
    pub tilt_hour_window_secs: u32,
}

/// The launch economics of `tilt.tilthouse.testnet`, chosen with the 60-day simulation
/// (docs/tilt.md, "Launch parameters").
pub const LAUNCH: Economics = Economics {
    treasury_initial: U128(1_000_000 * ONE_TILT),
    house_allocation: U128(300_000 * ONE_TILT),
    welcome_pool: U128(500_000 * ONE_TILT),
    welcome_amount: U128(100 * ONE_TILT),
    welcome_daily_claims: 200,
    mint_rate_bp: 100_000,
    streak_bonus_bp: 1_000,
    streak_bonus_max_days: 7,
    player_day_cap: U128(500 * ONE_TILT),
    day_cap: U128(5_000 * ONE_TILT),
    burn_bp: 100,
    tilt_hour_amount: U128(500 * ONE_TILT),
    tilt_hour_min_burners: 5,
    tilt_hour_min_burn: U128(20 * ONE_TILT),
    tilt_hour_window_secs: 3_600,
};

impl Economics {
    /// Refuses parameters the rules cannot honour (fail closed at launch rather than later).
    pub fn validate(&self) -> Result<(), &'static str> {
        let amounts = [
            self.treasury_initial.0,
            self.house_allocation.0,
            self.welcome_pool.0,
            self.player_day_cap.0,
            self.day_cap.0,
            self.tilt_hour_amount.0,
        ];
        if amounts.iter().any(|a| *a > MAX_AMOUNT) {
            return Err("amounts must be below 2^64");
        }
        if self.treasury_initial.0 == 0 {
            return Err("treasury_initial must be positive");
        }
        if self.welcome_amount.0 == 0 || self.welcome_amount.0 > self.welcome_pool.0 {
            return Err("welcome_amount must be positive and at most welcome_pool");
        }
        if self.welcome_daily_claims == 0 {
            return Err("welcome_daily_claims must be positive");
        }
        if self.mint_rate_bp == 0 {
            return Err("mint_rate_bp must be positive");
        }
        if self.player_day_cap.0 == 0 || self.player_day_cap.0 > self.day_cap.0 {
            return Err("player_day_cap must be positive and at most day_cap");
        }
        if self.burn_bp == 0 || u128::from(self.burn_bp) > BP {
            return Err("burn_bp must be in 1..=10000");
        }
        if self.tilt_hour_min_burners == 0 {
            return Err("tilt_hour_min_burners must be positive");
        }
        if self.tilt_hour_min_burn.0 == 0 || self.tilt_hour_min_burn.0 > self.tilt_hour_amount.0 {
            return Err("tilt_hour_min_burn must be positive and at most tilt_hour_amount");
        }
        if self.tilt_hour_window_secs == 0 {
            return Err("tilt_hour_window_secs must be positive");
        }
        Ok(())
    }
}

/// TILT minted on a day the humans beat the house by `players_net` (> 0), with `streak` the
/// streak including that day: `net × rate`, plus the streak bonus, capped by `day_cap`.
/// Zero when the house won or broke even.
pub fn day_pool(players_net: i128, streak: u32, economics: &Economics) -> u128 {
    if players_net <= 0 {
        return 0;
    }
    // Saturating is exact here: anything that large is cut to `day_cap` below.
    let base = (players_net as u128).saturating_mul(u128::from(economics.mint_rate_bp)) / BP;
    let bonus_days = streak
        .saturating_sub(1)
        .min(economics.streak_bonus_max_days);
    let multiplier =
        BP.saturating_add(u128::from(bonus_days) * u128::from(economics.streak_bonus_bp));
    (base.saturating_mul(multiplier) / BP).min(economics.day_cap.0)
}

/// Splits `pool` pro rata to the wagers, each share rounded down and capped at `player_cap`.
/// What rounding and the cap leave over is not minted. Needs `pool` and every wager ≤
/// [`MAX_AMOUNT`] and at most [`MAX_PLAYERS`] wagers (the contract checks both).
pub fn split(pool: u128, wagers: &[u128], player_cap: u128) -> Vec<u128> {
    let total: u128 = wagers.iter().sum();
    wagers
        .iter()
        .map(|wager| {
            (pool * wager)
                .checked_div(total)
                .unwrap_or(0)
                .min(player_cap)
        })
        .collect()
}

/// TILT burned from a treasury of `treasury` on a house day.
pub fn treasury_burn(treasury: u128, burn_bp: u32) -> u128 {
    treasury * u128::from(burn_bp) / BP
}

/// The daily streak of days the humans beat the house, and its record.
#[cfg_attr(feature = "contract", near_sdk::near(serializers = [borsh, json]))]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Streak {
    pub current: u32,
    pub longest: u32,
    /// Last day of the record streak.
    pub longest_day: Option<u32>,
    /// Last reported day.
    pub last_day: Option<u32>,
}

impl Streak {
    /// Applies a reported day (the caller ensures `day` is after `last_day`). A win extends the
    /// streak only if the previous reported day is the day before: an unreported day breaks it.
    pub fn record(&mut self, day: u32, players_won: bool) {
        let follows = self.last_day.and_then(|d| d.checked_add(1)) == Some(day);
        self.current = match (players_won, follows) {
            (false, _) => 0,
            (true, true) => self.current + 1,
            (true, false) => 1,
        };
        if self.current > self.longest {
            self.longest = self.current;
            self.longest_day = Some(day);
        }
        self.last_day = Some(day);
    }
}

/// Burns collected toward the next Tilt Hour. A round's window opens at its first burn; when it
/// ends before the goal, the next burn opens a new round from zero.
#[cfg_attr(feature = "contract", near_sdk::near(serializers = [borsh, json]))]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TiltHourProgress {
    /// Round number: burners are counted once per round.
    pub round: u64,
    pub burned: U128,
    pub burners: u32,
    /// End of the open window, 0 when no window is open.
    pub window_end_ns: U64,
}

impl TiltHourProgress {
    /// Call before a burn: opens a window if none is open, or starts a new round if the open
    /// window has ended.
    pub fn roll(&mut self, now_ns: u64, window_secs: u32) {
        let open = self.burned.0 > 0 && now_ns < self.window_end_ns.0;
        if open {
            return;
        }
        if self.burned.0 > 0 {
            // Expired without a Tilt Hour: its burners must be able to count again.
            self.round += 1;
        }
        self.burned = U128(0);
        self.burners = 0;
        self.window_end_ns = U64(now_ns.saturating_add(u64::from(window_secs) * SECOND_NS));
    }

    /// Adds a burn after [`roll`](Self::roll); `new_burner` is whether the account has not
    /// burned yet this round. Returns `Some((burned, burners))` of the round when it reaches the
    /// goal: a Tilt Hour starts and the progress resets to the next round.
    pub fn add(
        &mut self,
        amount: u128,
        new_burner: bool,
        economics: &Economics,
    ) -> Option<(u128, u32)> {
        self.burned = U128(self.burned.0 + amount);
        if new_burner {
            self.burners += 1;
        }
        let reached = self.burned.0 >= economics.tilt_hour_amount.0
            && self.burners >= economics.tilt_hour_min_burners;
        if !reached {
            return None;
        }
        let done = (self.burned.0, self.burners);
        *self = TiltHourProgress {
            round: self.round + 1,
            ..TiltHourProgress::default()
        };
        Some(done)
    }

    /// The progress as of `now_ns`: an ended window counts as empty.
    pub fn at(&self, now_ns: u64) -> TiltHourProgress {
        if now_ns < self.window_end_ns.0 {
            return self.clone();
        }
        TiltHourProgress {
            round: self.round,
            ..TiltHourProgress::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tilt(n: u128) -> u128 {
        n * ONE_TILT
    }

    #[test]
    fn launch_parameters_are_valid() {
        assert_eq!(LAUNCH.validate(), Ok(()));
    }

    #[test]
    fn validation_refuses_broken_parameters() {
        let broken = [
            Economics {
                burn_bp: 0,
                ..LAUNCH
            },
            Economics {
                burn_bp: 10_001,
                ..LAUNCH
            },
            Economics {
                player_day_cap: U128(LAUNCH.day_cap.0 + 1),
                ..LAUNCH
            },
            Economics {
                welcome_amount: U128(LAUNCH.welcome_pool.0 + 1),
                ..LAUNCH
            },
            Economics {
                tilt_hour_min_burners: 0,
                ..LAUNCH
            },
            Economics {
                tilt_hour_min_burn: U128(0),
                ..LAUNCH
            },
            Economics {
                day_cap: U128(MAX_AMOUNT + 1),
                ..LAUNCH
            },
            Economics {
                treasury_initial: U128(0),
                ..LAUNCH
            },
        ];
        for economics in broken {
            assert!(economics.validate().is_err(), "{economics:?}");
        }
    }

    #[test]
    fn day_pool_follows_net_rate_bonus_and_cap() {
        // 10 TILT per tUSDC won: +3 tUSDC → 30 TILT on the first day.
        assert_eq!(day_pool(3_000_000, 1, &LAUNCH), tilt(30));
        // Third day of a streak: +2 × 10 %.
        assert_eq!(day_pool(3_000_000, 3, &LAUNCH), tilt(36));
        // The bonus stops at 7 extra days.
        assert_eq!(day_pool(3_000_000, 30, &LAUNCH), tilt(51));
        // The house won or broke even: nothing.
        assert_eq!(day_pool(0, 1, &LAUNCH), 0);
        assert_eq!(day_pool(-5_000_000, 1, &LAUNCH), 0);
        // Capped per day, even for absurd nets.
        assert_eq!(day_pool(i128::MAX, 8, &LAUNCH), LAUNCH.day_cap.0);
    }

    #[test]
    fn split_is_pro_rata_capped_and_never_exceeds_the_pool() {
        assert_eq!(
            split(tilt(100), &[3, 1], tilt(1_000)),
            vec![tilt(75), tilt(25)]
        );
        // Whale capped; the rest is not redistributed.
        assert_eq!(
            split(tilt(5_000), &[98, 1, 1], LAUNCH.player_day_cap.0),
            vec![tilt(500), tilt(50), tilt(50)]
        );
        assert_eq!(split(7, &[1, 1, 1], 100), vec![2, 2, 2]);
        assert!(split(tilt(10), &[], tilt(1)).is_empty());
        // Worst case inputs fit u128.
        let shares = split(MAX_AMOUNT, &[MAX_AMOUNT; MAX_PLAYERS], MAX_AMOUNT);
        assert_eq!(shares.iter().sum::<u128>(), MAX_AMOUNT / 50 * 50);
    }

    #[test]
    fn split_property_sum_bounded_and_monotonic() {
        // Deterministic sweep instead of a property-test dependency.
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..2_000 {
            let n = (next() % 50 + 1) as usize;
            let wagers: Vec<u128> = (0..n).map(|_| u128::from(next() % 1_000_000_000)).collect();
            let pool = u128::from(next() % 10_000_000_000);
            let cap = u128::from(next() % 1_000_000_000 + 1);
            let shares = split(pool, &wagers, cap);
            assert!(shares.iter().sum::<u128>() <= pool);
            for (i, a) in wagers.iter().enumerate() {
                assert!(shares[i] <= cap);
                for (j, b) in wagers.iter().enumerate() {
                    if a >= b {
                        assert!(shares[i] >= shares[j]);
                    }
                }
            }
        }
    }

    #[test]
    fn treasury_burn_is_the_share() {
        assert_eq!(treasury_burn(tilt(1_000_000), 100), tilt(10_000));
        assert_eq!(treasury_burn(99, 100), 0);
    }

    #[test]
    fn streak_grows_resets_breaks_on_gaps_and_keeps_the_record() {
        let mut s = Streak::default();
        s.record(10, true);
        s.record(11, true);
        s.record(12, true);
        assert_eq!((s.current, s.longest, s.longest_day), (3, 3, Some(12)));
        s.record(13, false);
        assert_eq!((s.current, s.longest, s.longest_day), (0, 3, Some(12)));
        s.record(14, true);
        // Day 15 not reported: day 16 starts over.
        s.record(16, true);
        assert_eq!((s.current, s.longest), (1, 3));
        s.record(17, true);
        s.record(18, true);
        s.record(19, true);
        assert_eq!((s.current, s.longest, s.longest_day), (4, 4, Some(19)));
        assert_eq!(s.last_day, Some(19));
    }

    #[test]
    fn tilt_hour_needs_amount_and_distinct_burners_within_the_window() {
        let e = Economics {
            tilt_hour_amount: U128(100),
            tilt_hour_min_burners: 2,
            tilt_hour_min_burn: U128(1),
            tilt_hour_window_secs: 10,
            ..LAUNCH
        };
        let mut p = TiltHourProgress::default();
        p.roll(0, 10);
        assert_eq!(p.window_end_ns, U64(10 * SECOND_NS));
        // One account alone never triggers, whatever it burns.
        assert_eq!(p.add(150, true, &e), None);
        p.roll(SECOND_NS, 10);
        assert_eq!(p.add(150, false, &e), None);
        // A second burner within the window triggers and resets to the next round.
        p.roll(2 * SECOND_NS, 10);
        assert_eq!(p.add(1, true, &e), Some((301, 2)));
        assert_eq!(p.round, 1);
        assert_eq!((p.burned, p.burners, p.window_end_ns), (U128(0), 0, U64(0)));
    }

    #[test]
    fn an_ended_window_starts_a_new_round_from_zero() {
        let e = Economics {
            tilt_hour_amount: U128(100),
            tilt_hour_min_burners: 2,
            tilt_hour_min_burn: U128(1),
            tilt_hour_window_secs: 10,
            ..LAUNCH
        };
        let mut p = TiltHourProgress::default();
        p.roll(0, 10);
        assert_eq!(p.add(90, true, &e), None);
        assert_eq!(p.at(9 * SECOND_NS).burned, U128(90));
        assert_eq!(p.at(10 * SECOND_NS).burned, U128(0));
        p.roll(10 * SECOND_NS, 10);
        assert_eq!(p.round, 1);
        assert_eq!(p.add(20, true, &e), None);
        assert_eq!((p.burned, p.burners), (U128(20), 1));
        assert_eq!(p.window_end_ns, U64(20 * SECOND_NS));
    }
}
