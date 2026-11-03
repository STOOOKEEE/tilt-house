//! # How a dealer prices its table
//!
//! Every dealer runs these rules, nothing else. A dealer looks at its pool and at the last hour
//! of its table, then sets three things:
//!
//! - its **rake**: the cut it takes from winning payouts (on top of the game's own edge);
//! - its **max bet**: the biggest stake it accepts;
//! - an optional **boost**: for up to 15 minutes, the rake drops to the game's minimum.
//!
//! Each rule below handles one situation and says why in one sentence (its `Reason`). `reprice`
//! asks the rules in order of priority and the first one that applies wins. Then, whatever the
//! rule said, the offer is clamped to hard limits: the total edge stays between 1 % and 5 %
//! (`rake_bounds`), and a single bet can never cost the pool more than its free bankroll.
//!
//! Temperament changes how strongly a dealer reacts, each trait from 0 to 100:
//! - `greed`: how high its usual rake sits in the allowed range, and how much it cashes in on
//!   a busy table;
//! - `caution`: how small its bets stay, and how hard it backs off when players beat it;
//! - `promo`: how deep it cuts and how long it boosts to bring players back.
//!
//! Times are in seconds. Amounts are USDC base units (6 decimals).

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::{rake_bounds, worst_case_multiple, Game, Pool, BP};

/// Temperament traits are percentages; anything above counts as 100.
pub const TRAIT_MAX: u8 = 100;

/// No bet for 20 minutes: the table is idle.
pub const IDLE_AFTER_SECS: u64 = 20 * 60;

/// Two bets a minute over the last hour: the table is hot.
pub const HOT_TABLE_BETS_1H: u32 = 120;

/// Players' net result over the hour, as a share of the hour's volume, that counts as a streak
/// (15 %). Above it the dealer is losing; below minus it the dealer is winning.
pub const STREAK_SHARE_BP: u128 = 1_500;

/// Free bankroll under 250 USDC: the dealer plays safe.
pub const LOW_BANKROLL: u128 = 250_000_000;

/// New liquidity over the hour worth 20 % of the bankroll: the dealer has room to be generous.
pub const FRESH_LIQUIDITY_BP: u128 = 2_000;

/// A boost never lasts more than 15 minutes.
pub const MAX_BOOST_SECS: u64 = 15 * 60;

/// Share of the free bankroll a single bet may cost at most, for the boldest dealer (5 %) and
/// for the most cautious one (1 %).
pub const BOLD_RISK_BP: u128 = 500;
pub const CAUTIOUS_RISK_BP: u128 = 100;

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
pub struct Temperament {
    pub greed: u8,
    pub caution: u8,
    pub promo: u8,
}

/// What happened at the table over the last hour.
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    PartialEq,
    Eq,
    BorshSerialize,
    BorshDeserialize,
    Serialize,
    Deserialize,
)]
pub struct Stats {
    pub bets_1h: u32,
    /// Total staked.
    #[serde(with = "crate::amount_str")]
    pub volume_1h: u128,
    /// Players' winnings minus their losses (positive: players are beating the dealer).
    #[serde(with = "crate::amount_str")]
    pub player_net_1h: i128,
    /// Seconds since the last bet.
    pub idle_secs: u64,
    /// Liquidity added minus liquidity withdrawn.
    #[serde(with = "crate::amount_str")]
    pub inflow_1h: i128,
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
pub struct Offer {
    pub rake_bp: u16,
    #[serde(with = "crate::amount_str")]
    pub max_bet: u128,
    /// Until this time the rake is the game's minimum (`effective_rake_bp`). 0: no boost.
    pub boost_until: u64,
    pub reason: Reason,
}

impl Offer {
    /// The rake to apply to a round settled at `now`.
    pub fn effective_rake_bp(&self, game: Game, now: u64) -> u16 {
        let (min, max) = rake_bounds(game);
        if now < self.boost_until {
            min
        } else {
            self.rake_bp.clamp(min, max)
        }
    }
}

/// Why the dealer set its last offer. Reasons are from the dealer's point of view.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Idle,
    HotTable,
    /// Players are beating the dealer.
    LosingStreak,
    /// The dealer is beating the players.
    WinningStreak,
    LowBankroll,
    FreshLiquidity,
    Steady,
}

impl Reason {
    /// Stable identifier for JSON and logs.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::HotTable => "hot_table",
            Self::LosingStreak => "losing_streak",
            Self::WinningStreak => "winning_streak",
            Self::LowBankroll => "low_bankroll",
            Self::FreshLiquidity => "fresh_liquidity",
            Self::Steady => "steady",
        }
    }

    /// The line players see in the tooltip.
    pub fn explain(&self) -> String {
        match self {
            Self::Idle => format!(
                "cutting my edge: nobody has played for {} min",
                IDLE_AFTER_SECS / 60
            ),
            Self::HotTable => "raising my edge: the table is busy".to_string(),
            Self::LosingStreak => {
                "raising my edge and lowering my max bet: players have been beating me this hour"
                    .to_string()
            }
            Self::WinningStreak => {
                "cutting my edge: I've been winning this hour, sharing some back".to_string()
            }
            Self::LowBankroll => "playing safe: my bankroll is running low".to_string(),
            Self::FreshLiquidity => {
                "raising my max bet and cutting my edge: fresh liquidity came in".to_string()
            }
            Self::Steady => "steady: nothing to react to".to_string(),
        }
    }
}

/// Everything a rule may look at, plus the dealer's usual offer.
struct Table<'a> {
    pool: &'a Pool,
    stats: &'a Stats,
    greed: u128,
    caution: u128,
    promo: u128,
    now: u64,
    min_rake: u16,
    max_rake: u16,
    /// Where the rake sits when nothing happens: higher for greedier dealers.
    usual_rake: u16,
    /// The max bet when nothing happens: smaller for more cautious dealers.
    usual_max_bet: u128,
}

/// Moves the rake from the usual one toward the maximum by `percent` of the way.
fn raise(table: &Table, percent: u128) -> u16 {
    let room = u128::from(table.max_rake - table.usual_rake);
    table.usual_rake + (room * percent.min(100) / 100) as u16
}

/// Moves the rake from the usual one toward the minimum by `percent` of the way.
fn cut(table: &Table, percent: u128) -> u16 {
    let room = u128::from(table.usual_rake - table.min_rake);
    table.usual_rake - (room * percent.min(100) / 100) as u16
}

/// `amount × numerator / denominator`, rounded down, without overflowing for any amount
/// (numerators here are small).
fn scale(amount: u128, numerator: u128, denominator: u128) -> u128 {
    amount / denominator * numerator + amount % denominator * numerator / denominator
}

fn offer(rake_bp: u16, max_bet: u128, reason: Reason) -> Offer {
    Offer {
        rake_bp,
        max_bet,
        boost_until: 0,
        reason,
    }
}

/// Bankroll running low: highest rake, half the usual max bet.
fn low_bankroll(table: &Table) -> Option<Offer> {
    (table.pool.free() < LOW_BANKROLL)
        .then(|| offer(table.max_rake, table.usual_max_bet / 2, Reason::LowBankroll))
}

/// Players are beating the dealer this hour: rake up at least halfway, more for cautious
/// dealers; max bet down by up to half, more for cautious dealers.
fn losing_streak(table: &Table) -> Option<Offer> {
    let net = table.stats.player_net_1h;
    let streak = net > 0
        && net.unsigned_abs().saturating_mul(BP)
            >= table.stats.volume_1h.saturating_mul(STREAK_SHARE_BP);
    let max_bet = scale(table.usual_max_bet, 200 - table.caution, 200);
    streak.then(|| {
        offer(
            raise(table, 50 + table.caution / 2),
            max_bet,
            Reason::LosingStreak,
        )
    })
}

/// Investors just added a fifth of the bankroll or more: twice the usual max bet and a lower
/// rake, deeper for promoters.
fn fresh_liquidity(table: &Table) -> Option<Offer> {
    let inflow = table.stats.inflow_1h;
    let fresh = inflow > 0
        && inflow.unsigned_abs().saturating_mul(BP)
            >= table.pool.bankroll.saturating_mul(FRESH_LIQUIDITY_BP);
    fresh.then(|| {
        offer(
            cut(table, 25 + table.promo / 4),
            table.usual_max_bet.saturating_mul(2),
            Reason::FreshLiquidity,
        )
    })
}

/// Nobody played for 20 minutes: rake down at least halfway, and promoters add a boost (rake
/// at the minimum) lasting up to 15 minutes, longer for bigger promoters.
fn idle(table: &Table) -> Option<Offer> {
    if table.stats.idle_secs < IDLE_AFTER_SECS {
        return None;
    }
    let mut idle = offer(
        cut(table, 50 + table.promo / 2),
        table.usual_max_bet,
        Reason::Idle,
    );
    let boost_secs = MAX_BOOST_SECS * table.promo as u64 / 100;
    if boost_secs > 0 {
        idle.boost_until = table.now.saturating_add(boost_secs);
    }
    Some(idle)
}

/// The table is busy: rake up, a quarter of the way for the least greedy, all the way for the
/// greediest.
fn hot_table(table: &Table) -> Option<Offer> {
    (table.stats.bets_1h >= HOT_TABLE_BETS_1H).then(|| {
        offer(
            raise(table, 25 + table.greed * 3 / 4),
            table.usual_max_bet,
            Reason::HotTable,
        )
    })
}

/// The dealer is beating the players this hour: it shares some back with a lower rake, more
/// for promoters.
fn winning_streak(table: &Table) -> Option<Offer> {
    let net = table.stats.player_net_1h;
    let streak = net < 0
        && net.unsigned_abs().saturating_mul(BP)
            >= table.stats.volume_1h.saturating_mul(STREAK_SHARE_BP);
    streak.then(|| {
        offer(
            cut(table, 25 + table.promo * 3 / 4),
            table.usual_max_bet,
            Reason::WinningStreak,
        )
    })
}

/// Nothing special: the usual offer.
fn steady(table: &Table) -> Offer {
    offer(table.usual_rake, table.usual_max_bet, Reason::Steady)
}

/// The rules in order of priority: safety first, then reacting to players, then to the room.
const RULES: [fn(&Table) -> Option<Offer>; 6] = [
    low_bankroll,
    losing_streak,
    fresh_liquidity,
    idle,
    hot_table,
    winning_streak,
];

/// The dealer's new offer. Always within `rake_bounds(game)`, with a max bet the free bankroll
/// covers at the game's worst case, and a boost ending at most 15 minutes from `now`.
pub fn reprice(
    game: Game,
    pool: &Pool,
    stats: &Stats,
    temperament: &Temperament,
    now: u64,
) -> Offer {
    let (min_rake, max_rake) = rake_bounds(game);
    let [greed, caution, promo] = [temperament.greed, temperament.caution, temperament.promo]
        .map(|t| u128::from(t.min(TRAIT_MAX)));
    let span = u128::from(max_rake - min_rake);
    let risk_bp = BOLD_RISK_BP - (BOLD_RISK_BP - CAUTIOUS_RISK_BP) * caution / 100;
    let table = Table {
        pool,
        stats,
        greed,
        caution,
        promo,
        now,
        min_rake,
        max_rake,
        usual_rake: min_rake + (span * greed / 100) as u16,
        usual_max_bet: scale(pool.free(), risk_bp, BP) / worst_case_multiple(game),
    };
    let chosen = RULES
        .iter()
        .find_map(|rule| rule(&table))
        .unwrap_or_else(|| steady(&table));
    clamp(game, pool, chosen, now)
}

/// Hard limits no rule can get around.
fn clamp(game: Game, pool: &Pool, offer: Offer, now: u64) -> Offer {
    let (min_rake, max_rake) = rake_bounds(game);
    let boost_until = if offer.boost_until > now {
        offer.boost_until.min(now.saturating_add(MAX_BOOST_SECS))
    } else {
        0
    };
    Offer {
        rake_bp: offer.rake_bp.clamp(min_rake, max_rake),
        max_bet: offer.max_bet.min(pool.free() / worst_case_multiple(game)),
        boost_until,
        reason: offer.reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Rng;

    const USDC: u128 = 1_000_000;
    const NOW: u64 = 1_800_000_000;
    const BALANCED: Temperament = Temperament {
        greed: 50,
        caution: 50,
        promo: 50,
    };

    fn pool(free_usdc: u128) -> Pool {
        Pool {
            bankroll: free_usdc * USDC,
            shares: free_usdc * USDC,
            reserved: 0,
            open_stakes: 0,
        }
    }

    /// A quiet but not idle hour.
    fn calm() -> Stats {
        Stats {
            bets_1h: 30,
            volume_1h: 300 * USDC,
            player_net_1h: 0,
            idle_secs: 60,
            inflow_1h: 0,
        }
    }

    fn usual(game: Game) -> Offer {
        reprice(game, &pool(10_000), &calm(), &BALANCED, NOW)
    }

    #[test]
    fn steady() {
        let offer = usual(Game::Dice);
        assert_eq!(offer.reason, Reason::Steady);
        // Halfway between 100 and 495.
        assert_eq!(offer.rake_bp, 297);
        // 3 % of 10 000 USDC at a 100× worst case.
        assert_eq!(offer.max_bet, 3 * USDC);
        assert_eq!(offer.boost_until, 0);
    }

    #[test]
    fn idle() {
        let stats = Stats {
            idle_secs: IDLE_AFTER_SECS,
            ..calm()
        };
        let offer = reprice(Game::Dice, &pool(10_000), &stats, &BALANCED, NOW);
        assert_eq!(offer.reason, Reason::Idle);
        assert!(offer.rake_bp < usual(Game::Dice).rake_bp);
        assert_eq!(offer.boost_until, NOW + MAX_BOOST_SECS / 2);
        assert_eq!(offer.effective_rake_bp(Game::Dice, NOW), 100);
        assert_eq!(
            offer.effective_rake_bp(Game::Dice, offer.boost_until),
            offer.rake_bp
        );
        // No promo, no boost.
        let shy = Temperament {
            promo: 0,
            ..BALANCED
        };
        assert_eq!(
            reprice(Game::Dice, &pool(10_000), &stats, &shy, NOW).boost_until,
            0
        );
    }

    #[test]
    fn hot_table() {
        let stats = Stats {
            bets_1h: HOT_TABLE_BETS_1H,
            ..calm()
        };
        let offer = reprice(Game::Roulette, &pool(10_000), &stats, &BALANCED, NOW);
        assert_eq!(offer.reason, Reason::HotTable);
        assert!(offer.rake_bp > usual(Game::Roulette).rake_bp);
    }

    #[test]
    fn losing_streak() {
        let stats = Stats {
            player_net_1h: 45 * USDC as i128,
            ..calm()
        }; // 15 % of 300
        let offer = reprice(Game::Dice, &pool(10_000), &stats, &BALANCED, NOW);
        assert_eq!(offer.reason, Reason::LosingStreak);
        assert!(offer.rake_bp > usual(Game::Dice).rake_bp);
        assert!(offer.max_bet < usual(Game::Dice).max_bet);
        let small = Stats {
            player_net_1h: 44 * USDC as i128,
            ..calm()
        };
        assert_eq!(
            reprice(Game::Dice, &pool(10_000), &small, &BALANCED, NOW).reason,
            Reason::Steady
        );
    }

    #[test]
    fn winning_streak() {
        let stats = Stats {
            player_net_1h: -45 * USDC as i128,
            ..calm()
        };
        let offer = reprice(Game::Dice, &pool(10_000), &stats, &BALANCED, NOW);
        assert_eq!(offer.reason, Reason::WinningStreak);
        assert!(offer.rake_bp < usual(Game::Dice).rake_bp);
    }

    #[test]
    fn low_bankroll() {
        let offer = reprice(Game::Dice, &pool(200), &calm(), &BALANCED, NOW);
        assert_eq!(offer.reason, Reason::LowBankroll);
        assert_eq!(offer.rake_bp, rake_bounds(Game::Dice).1);
        // Reserved money does not count.
        let mut busy = pool(1_000);
        busy.reserved = 800 * USDC;
        assert_eq!(
            reprice(Game::Dice, &busy, &calm(), &BALANCED, NOW).reason,
            Reason::LowBankroll
        );
    }

    #[test]
    fn fresh_liquidity() {
        let stats = Stats {
            inflow_1h: 2_000 * USDC as i128,
            ..calm()
        };
        let offer = reprice(Game::Blackjack, &pool(10_000), &stats, &BALANCED, NOW);
        assert_eq!(offer.reason, Reason::FreshLiquidity);
        assert_eq!(offer.max_bet, 2 * usual(Game::Blackjack).max_bet);
        assert!(offer.rake_bp <= usual(Game::Blackjack).rake_bp);
    }

    #[test]
    fn safety_comes_first() {
        let everything = Stats {
            bets_1h: 500,
            volume_1h: 100 * USDC,
            player_net_1h: 50 * USDC as i128,
            idle_secs: 0,
            inflow_1h: 100 * USDC as i128,
        };
        assert_eq!(
            reprice(Game::Dice, &pool(100), &everything, &BALANCED, NOW).reason,
            Reason::LowBankroll
        );
        assert_eq!(
            reprice(Game::Dice, &pool(10_000), &everything, &BALANCED, NOW).reason,
            Reason::LosingStreak
        );
    }

    #[test]
    fn traits_above_100_count_as_100() {
        let wild = Temperament {
            greed: 255,
            caution: 255,
            promo: 255,
        };
        let max = Temperament {
            greed: 100,
            caution: 100,
            promo: 100,
        };
        assert_eq!(
            reprice(Game::Dice, &pool(10_000), &calm(), &wild, NOW),
            reprice(Game::Dice, &pool(10_000), &calm(), &max, NOW)
        );
    }

    #[test]
    fn reason_codes_and_lines() {
        let all = [
            Reason::Idle,
            Reason::HotTable,
            Reason::LosingStreak,
            Reason::WinningStreak,
            Reason::LowBankroll,
            Reason::FreshLiquidity,
            Reason::Steady,
        ];
        for reason in all {
            assert_eq!(
                serde_json::to_string(&reason).unwrap(),
                format!("\"{}\"", reason.code())
            );
            assert!(!reason.explain().is_empty());
        }
        assert_eq!(
            Reason::Idle.explain(),
            "cutting my edge: nobody has played for 20 min"
        );
    }

    #[test]
    fn offer_json() {
        let json = serde_json::to_value(usual(Game::Dice)).unwrap();
        assert_eq!(json["max_bet"], "3000000");
        assert_eq!(json["reason"], "steady");
    }

    fn random_u128(rng: &mut Rng) -> u128 {
        // Spread over many magnitudes, including 0 and amounts near u128::MAX.
        match rng.below(4) {
            0 => 0,
            1 => u128::from(rng.below(u32::MAX)),
            2 => u128::from(rng.below(u32::MAX)) * 1_000_000_000,
            _ => u128::MAX - u128::from(rng.below(1_000)),
        }
    }

    fn random_i128(rng: &mut Rng) -> i128 {
        let magnitude = (random_u128(rng) >> 1) as i128;
        if rng.below(2) == 0 {
            magnitude
        } else {
            -magnitude
        }
    }

    /// Property: whatever the inputs, the offer stays within the hard limits.
    #[test]
    fn reprice_always_within_bounds() {
        let mut rng = Rng::new(*b"reprice property test seed 00001");
        for _ in 0..200_000 {
            let game = [Game::Dice, Game::Roulette, Game::Blackjack][rng.below(3) as usize];
            let bankroll = random_u128(&mut rng);
            let reserved = random_u128(&mut rng).min(bankroll);
            let pool = Pool {
                bankroll,
                shares: random_u128(&mut rng),
                reserved,
                open_stakes: random_u128(&mut rng),
            };
            let stats = Stats {
                bets_1h: rng.below(u32::MAX),
                volume_1h: random_u128(&mut rng),
                player_net_1h: random_i128(&mut rng),
                idle_secs: u64::from(rng.below(u32::MAX)) * u64::from(rng.below(3)),
                inflow_1h: random_i128(&mut rng),
            };
            let temperament = Temperament {
                greed: rng.below(256) as u8,
                caution: rng.below(256) as u8,
                promo: rng.below(256) as u8,
            };
            let now = [0, NOW, u64::MAX - u64::from(rng.below(1_000))][rng.below(3) as usize];

            let offer = reprice(game, &pool, &stats, &temperament, now);

            let (min, max) = rake_bounds(game);
            assert!((min..=max).contains(&offer.rake_bp), "{offer:?}");
            assert!(
                offer.max_bet.saturating_mul(worst_case_multiple(game)) <= pool.free(),
                "{offer:?} {pool:?}"
            );
            assert!(
                offer.boost_until == 0
                    || (offer.boost_until > now && offer.boost_until - now <= MAX_BOOST_SECS),
                "{offer:?}"
            );
            assert!((min..=max).contains(&offer.effective_rake_bp(game, now)));
        }
    }
}
