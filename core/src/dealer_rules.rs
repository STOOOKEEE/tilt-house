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
//! ## Rivals
//!
//! Two rules look at the other seated tables of the same game (`RivalOffer`), and only apply
//! when nothing above them did:
//! - **undercut**: a rival shows a lower edge than this dealer's usual one, and this table got
//!   less than its fair share (1 / number of tables) of the game's bets over the hour: the
//!   dealer cuts its rake to just under that rival's;
//! - **match boost**: a rival is boosting: the dealer boosts back, longer for promoters.
//!
//! ## Rent for a seat on the floor (docs/floor.md)
//!
//! Only seated tables take bets, and every seat costs rent. `rent_bid` decides, each time the
//! keeper asks, what the dealer bids:
//! - its **target rent** is a share of what it earned over the last hour (what players lost at
//!   its table): 10 % for the greediest dealer up to 50 % for the biggest promoter, who pays
//!   more to stay visible; never under the floor's minimum rent;
//! - **seated and near the bottom** (its rent within 15 % of the lowest seated rent, on a full
//!   floor, where a newcomer could outbid it): it raises toward its target to defend its seat;
//! - **seated and safe** but paying more than 15 % above its target: it cuts its rent to the
//!   target;
//! - **off the floor**: it bids for an empty seat at its target, or outbids the weakest table,
//!   if its pool can prepay two hours and the rent fits its budget (0.05 % to 0.25 % of its free
//!   bankroll per hour, more for promoters, or its target if higher). Never during its cooldown.
//!
//! Times are in seconds. Amounts are USDC base units (6 decimals).

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::floor::{FloorView, MIN_RENT_PER_HOUR, PREPAY_HOURS};
use crate::seats::MIN_SEAT_RENT;
use crate::{base_edge_bp, rake_bounds, worst_case_multiple, Game, Pool, BP};

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

/// Share of the hour's earnings a dealer pays as rent: the greediest (10 %) to the biggest
/// promoter (50 %).
pub const RENT_SHARE_MIN_BP: u128 = 1_000;
pub const RENT_SHARE_MAX_BP: u128 = 5_000;

/// A seated dealer whose rent is within 15 % of the lowest seated rent defends its seat.
pub const DEFEND_MARGIN_BP: u128 = 1_500;

/// A safe seated dealer cuts its rent only when it pays more than 15 % above its target, so
/// rents do not jitter with every small change in earnings.
pub const CUT_MARGIN_BP: u128 = 1_500;

/// What an off-floor dealer is ready to pay per hour for a seat, as a share of its free
/// bankroll: 0.05 % for the greediest to 0.25 % for the biggest promoter.
pub const RENT_BUDGET_MIN_BP: u128 = 5;
pub const RENT_BUDGET_MAX_BP: u128 = 25;

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
pub struct Temperament {
    pub greed: u8,
    pub caution: u8,
    pub promo: u8,
}

/// Greedy: rake high in its range, cashes in on busy tables, almost never boosts.
pub const GREEDY: Temperament = Temperament {
    greed: 85,
    caution: 30,
    promo: 10,
};
/// Promoter: low usual rake, deep cuts and long boosts to bring players back, bold max bet.
pub const PROMOTER: Temperament = Temperament {
    greed: 25,
    caution: 20,
    promo: 90,
};
/// Cautious: middling rake, small max bet, backs off hard when players beat it.
pub const CAUTIOUS: Temperament = Temperament {
    greed: 50,
    caution: 90,
    promo: 30,
};

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
    /// This table's share of the bets placed at all seated tables of its game, in bp
    /// (10 000: all of them).
    pub game_share_bp: u16,
}

/// Another seated table of the same game, as players see it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RivalOffer {
    /// Total edge players face: the game's own edge plus the rake in force.
    pub edge_bp: u16,
    /// 0: not boosting.
    pub boost_until: u64,
}

impl RivalOffer {
    /// A rival's offer as it stands at `now`.
    pub fn new(game: Game, offer: &Offer, now: u64) -> Self {
        Self {
            edge_bp: base_edge_bp(game).saturating_add(offer.effective_rake_bp(game, now)),
            boost_until: offer.boost_until,
        }
    }
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
    // New variants go last: the contract stores offers with borsh, which encodes the index.
    /// A rival is cheaper and took this table's players.
    Undercut,
    /// A rival is boosting.
    MatchBoost,
    /// A table owner set this offer by hand (`clamp_owner_offer`).
    Owner,
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
            Self::Undercut => "undercut",
            Self::MatchBoost => "match_boost",
            Self::Owner => "owner",
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
            Self::Undercut => {
                "cutting my edge under a rival's: players went to the cheaper table".to_string()
            }
            Self::MatchBoost => "boosting: a rival is boosting, I'm matching it".to_string(),
            Self::Owner => "my owner set this offer".to_string(),
        }
    }
}

/// Everything a rule may look at, plus the dealer's usual offer.
struct Table<'a> {
    pool: &'a Pool,
    stats: &'a Stats,
    rivals: &'a [RivalOffer],
    base_edge: u16,
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

/// A rival shows a lower edge than our usual one and we got less than our fair share of the
/// game's bets: rake just under that rival's (the clamp keeps it within bounds).
fn undercut(table: &Table) -> Option<Offer> {
    let cheapest = table.rivals.iter().map(|rival| rival.edge_bp).min()?;
    let tables = table.rivals.len() as u128 + 1;
    let usual_edge = table.base_edge.saturating_add(table.usual_rake);
    let lost_players = u128::from(table.stats.game_share_bp) * tables < BP;
    (cheapest < usual_edge && lost_players).then(|| {
        let rake = cheapest.saturating_sub(table.base_edge).saturating_sub(1);
        offer(rake, table.usual_max_bet, Reason::Undercut)
    })
}

/// A rival is boosting: boost back for up to 15 minutes, longer for bigger promoters (none
/// without promo).
fn match_boost(table: &Table) -> Option<Offer> {
    let rival_boosting = table
        .rivals
        .iter()
        .any(|rival| rival.boost_until > table.now);
    let boost_secs = MAX_BOOST_SECS * table.promo as u64 / 100;
    if !rival_boosting || boost_secs == 0 {
        return None;
    }
    let mut boost = offer(table.usual_rake, table.usual_max_bet, Reason::MatchBoost);
    boost.boost_until = table.now.saturating_add(boost_secs);
    Some(boost)
}

/// Nothing special: the usual offer.
fn steady(table: &Table) -> Offer {
    offer(table.usual_rake, table.usual_max_bet, Reason::Steady)
}

/// The rules in order of priority: safety first, then reacting to players, then to the room.
const RULES: [fn(&Table) -> Option<Offer>; 8] = [
    low_bankroll,
    losing_streak,
    fresh_liquidity,
    idle,
    hot_table,
    winning_streak,
    undercut,
    match_boost,
];

/// The dealer's new offer. Always within `rake_bounds(game)`, with a max bet the free bankroll
/// covers at the game's worst case, and a boost ending at most 15 minutes from `now`.
/// `rivals`: the other seated tables of the same game.
pub fn reprice(
    game: Game,
    pool: &Pool,
    stats: &Stats,
    temperament: &Temperament,
    rivals: &[RivalOffer],
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
        rivals,
        base_edge: base_edge_bp(game),
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

/// An owner may start a boost at most once an hour (docs/tycoon.md, "Owner controls").
pub const BOOST_COOLDOWN_SECS: u64 = 60 * 60;

/// A table owner's hand-set offer (`set_offer`), clamped to the same hard limits as the NPC
/// dealers' (`rake_bounds`, max bet the free bankroll covers, boost ≤ 15 min), plus one boost
/// per hour: a boost asked within `BOOST_COOLDOWN_SECS` of the last one (`last_boost_at`, 0 =
/// never) is dropped. The caller stores `last_boost_at = now` when the result boosts.
pub fn clamp_owner_offer(
    game: Game,
    pool: &Pool,
    rake_bp: u16,
    max_bet: u128,
    boost_secs: u64,
    last_boost_at: u64,
    now: u64,
) -> Offer {
    let boost_allowed =
        last_boost_at == 0 || now >= last_boost_at.saturating_add(BOOST_COOLDOWN_SECS);
    let boost_until = if boost_secs > 0 && boost_allowed {
        now.saturating_add(boost_secs)
    } else {
        0
    };
    let asked = Offer {
        rake_bp,
        max_bet,
        boost_until,
        reason: Reason::Owner,
    };
    clamp(game, pool, asked, now)
}

/// What the dealer does about its seat.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RentAction {
    /// Seated: keep the current rent.
    Keep,
    /// Seated: new, higher rent.
    Raise(#[serde(with = "crate::amount_str")] u128),
    /// Seated: new, lower rent.
    Lower(#[serde(with = "crate::amount_str")] u128),
    /// Off the floor: bid this rent for an empty seat.
    BidEmpty(#[serde(with = "crate::amount_str")] u128),
    /// Off the floor: bid this rent to take the weakest seat of a full floor.
    Outbid(#[serde(with = "crate::amount_str")] u128),
    /// Off the floor: do not bid.
    Stay,
}

/// Why the dealer changed its rent. Reasons are from the dealer's point of view.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RentReason {
    DefendingSeat,
    BiddingForSeat,
    CuttingRent,
}

impl RentReason {
    /// Stable identifier for JSON and logs.
    pub fn code(&self) -> &'static str {
        match self {
            Self::DefendingSeat => "defending_seat",
            Self::BiddingForSeat => "bidding_for_seat",
            Self::CuttingRent => "cutting_rent",
        }
    }

    /// The line players see in the tooltip.
    pub fn explain(&self) -> &'static str {
        match self {
            Self::DefendingSeat => "raising my rent: a newcomer could take my seat",
            Self::BiddingForSeat => "bidding for a seat: I want back on the floor",
            Self::CuttingRent => "cutting my rent: my seat is safe and costs more than I earn",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct RentDecision {
    pub action: RentAction,
    /// `None` for `Keep` and `Stay`.
    pub reason: Option<RentReason>,
}

fn decide(action: RentAction, reason: RentReason) -> RentDecision {
    RentDecision {
        action,
        reason: Some(reason),
    }
}

const KEEP: RentDecision = RentDecision {
    action: RentAction::Keep,
    reason: None,
};
const STAY: RentDecision = RentDecision {
    action: RentAction::Stay,
    reason: None,
};

/// How much a dealer is willing to pay for visibility, 0 to 100: promoters more, greedy less.
fn rent_appetite(temperament: &Temperament) -> u128 {
    let [greed, promo] =
        [temperament.greed, temperament.promo].map(|t| u128::from(t.min(TRAIT_MAX)));
    (promo + 100 - greed) / 2
}

/// Between `min` and `max` by `appetite` percent of the way.
fn by_appetite(min: u128, max: u128, appetite: u128) -> u128 {
    min + (max - min) * appetite / 100
}

/// The dealer's rent decision. Every rent it bids is at least `MIN_RENT_PER_HOUR`, and an
/// off-floor bid always leaves the pool able to prepay it.
pub fn rent_bid(
    pool: &Pool,
    stats: &Stats,
    temperament: &Temperament,
    floor: &FloorView,
    now: u64,
) -> RentDecision {
    let appetite = rent_appetite(temperament);
    // What players lost at the table: the dealer's earnings before rent.
    let net = stats.player_net_1h;
    let earnings = if net < 0 { net.unsigned_abs() } else { 0 };
    let share_bp = by_appetite(RENT_SHARE_MIN_BP, RENT_SHARE_MAX_BP, appetite);
    let target = scale(earnings, share_bp, BP).max(MIN_RENT_PER_HOUR);
    // The highest rent the pool can prepay.
    let affordable = pool.free() / u128::from(PREPAY_HOURS);
    match floor.my_rent {
        Some(rent) => seated_rent(rent, target.max(floor.my_min_rent), affordable, floor),
        None => {
            let budget = scale(
                pool.free(),
                by_appetite(RENT_BUDGET_MIN_BP, RENT_BUDGET_MAX_BP, appetite),
                BP,
            );
            off_floor_bid(target, target.max(budget).min(affordable), floor, now)
        }
    }
}

/// Seated: defend when near the bottom of a full floor, cut when safe and overpaying.
fn seated_rent(rent: u128, target: u128, affordable: u128, floor: &FloorView) -> RentDecision {
    let at_risk = floor.empty_seats == 0
        && floor.lowest_rent.is_some_and(|lowest| {
            rent.saturating_mul(BP) <= lowest.saturating_mul(BP + DEFEND_MARGIN_BP)
        });
    if at_risk {
        let raise_to = target.min(affordable);
        return if raise_to > rent {
            decide(RentAction::Raise(raise_to), RentReason::DefendingSeat)
        } else {
            KEEP
        };
    }
    if rent.saturating_mul(BP) > target.saturating_mul(BP + CUT_MARGIN_BP) {
        return decide(RentAction::Lower(target), RentReason::CuttingRent);
    }
    KEEP
}

/// Off the floor: an empty seat at the target, else the weakest seat if `ceiling` reaches it.
fn off_floor_bid(target: u128, ceiling: u128, floor: &FloorView, now: u64) -> RentDecision {
    if now < floor.cooldown_until || ceiling < MIN_SEAT_RENT {
        return STAY;
    }
    if floor.empty_seats > 0 {
        // `outbid_min` is the cheapest empty seat's minimum rent: never bid under it.
        let bid = target.min(ceiling).max(floor.outbid_min);
        return if bid <= ceiling {
            decide(RentAction::BidEmpty(bid), RentReason::BiddingForSeat)
        } else {
            STAY
        };
    }
    if floor.outbid_min <= ceiling {
        return decide(
            RentAction::Outbid(floor.outbid_min),
            RentReason::BiddingForSeat,
        );
    }
    STAY
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
            // Alone at its game unless a test adds rivals.
            game_share_bp: BP as u16,
        }
    }

    fn usual(game: Game) -> Offer {
        reprice(game, &pool(10_000), &calm(), &BALANCED, &[], NOW)
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
        let offer = reprice(Game::Dice, &pool(10_000), &stats, &BALANCED, &[], NOW);
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
            reprice(Game::Dice, &pool(10_000), &stats, &shy, &[], NOW).boost_until,
            0
        );
    }

    #[test]
    fn hot_table() {
        let stats = Stats {
            bets_1h: HOT_TABLE_BETS_1H,
            ..calm()
        };
        let offer = reprice(Game::Roulette, &pool(10_000), &stats, &BALANCED, &[], NOW);
        assert_eq!(offer.reason, Reason::HotTable);
        assert!(offer.rake_bp > usual(Game::Roulette).rake_bp);
    }

    #[test]
    fn losing_streak() {
        let stats = Stats {
            player_net_1h: 45 * USDC as i128,
            ..calm()
        }; // 15 % of 300
        let offer = reprice(Game::Dice, &pool(10_000), &stats, &BALANCED, &[], NOW);
        assert_eq!(offer.reason, Reason::LosingStreak);
        assert!(offer.rake_bp > usual(Game::Dice).rake_bp);
        assert!(offer.max_bet < usual(Game::Dice).max_bet);
        let small = Stats {
            player_net_1h: 44 * USDC as i128,
            ..calm()
        };
        assert_eq!(
            reprice(Game::Dice, &pool(10_000), &small, &BALANCED, &[], NOW).reason,
            Reason::Steady
        );
    }

    #[test]
    fn winning_streak() {
        let stats = Stats {
            player_net_1h: -45 * USDC as i128,
            ..calm()
        };
        let offer = reprice(Game::Dice, &pool(10_000), &stats, &BALANCED, &[], NOW);
        assert_eq!(offer.reason, Reason::WinningStreak);
        assert!(offer.rake_bp < usual(Game::Dice).rake_bp);
    }

    #[test]
    fn low_bankroll() {
        let offer = reprice(Game::Dice, &pool(200), &calm(), &BALANCED, &[], NOW);
        assert_eq!(offer.reason, Reason::LowBankroll);
        assert_eq!(offer.rake_bp, rake_bounds(Game::Dice).1);
        // Reserved money does not count.
        let mut busy = pool(1_000);
        busy.reserved = 800 * USDC;
        assert_eq!(
            reprice(Game::Dice, &busy, &calm(), &BALANCED, &[], NOW).reason,
            Reason::LowBankroll
        );
    }

    #[test]
    fn fresh_liquidity() {
        let stats = Stats {
            inflow_1h: 2_000 * USDC as i128,
            ..calm()
        };
        let offer = reprice(Game::Blackjack, &pool(10_000), &stats, &BALANCED, &[], NOW);
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
            game_share_bp: 0,
        };
        assert_eq!(
            reprice(Game::Dice, &pool(100), &everything, &BALANCED, &[], NOW).reason,
            Reason::LowBankroll
        );
        assert_eq!(
            reprice(Game::Dice, &pool(10_000), &everything, &BALANCED, &[], NOW).reason,
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
            reprice(Game::Dice, &pool(10_000), &calm(), &wild, &[], NOW),
            reprice(Game::Dice, &pool(10_000), &calm(), &max, &[], NOW)
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
            Reason::Undercut,
            Reason::MatchBoost,
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
    fn undercut() {
        let usual = usual(Game::Roulette);
        let rival = RivalOffer {
            edge_bp: base_edge_bp(Game::Roulette) + 100,
            boost_until: 0,
        };
        // Two tables, we took 40 % of the bets: under our fair half.
        let stats = Stats {
            game_share_bp: 4_000,
            ..calm()
        };
        let offer = reprice(
            Game::Roulette,
            &pool(10_000),
            &stats,
            &BALANCED,
            &[rival],
            NOW,
        );
        assert_eq!(offer.reason, Reason::Undercut);
        assert_eq!(offer.rake_bp, 99);
        assert!(offer.rake_bp < usual.rake_bp);
        // Fair share kept: no reaction.
        let fair = Stats {
            game_share_bp: 5_000,
            ..calm()
        };
        assert_eq!(
            reprice(
                Game::Roulette,
                &pool(10_000),
                &fair,
                &BALANCED,
                &[rival],
                NOW
            )
            .reason,
            Reason::Steady
        );
        // A rival already at the minimum: we can only match the minimum.
        let floor_rival = RivalOffer {
            edge_bp: 0,
            boost_until: 0,
        };
        let offer = reprice(
            Game::Dice,
            &pool(10_000),
            &stats,
            &BALANCED,
            &[floor_rival],
            NOW,
        );
        assert_eq!((offer.reason, offer.rake_bp), (Reason::Undercut, 100));
    }

    #[test]
    fn match_boost() {
        let rival = RivalOffer {
            edge_bp: 495,
            boost_until: NOW + 60,
        };
        let offer = reprice(Game::Dice, &pool(10_000), &calm(), &BALANCED, &[rival], NOW);
        assert_eq!(offer.reason, Reason::MatchBoost);
        assert_eq!(offer.boost_until, NOW + MAX_BOOST_SECS / 2);
        let shy = Temperament {
            promo: 0,
            ..BALANCED
        };
        assert_eq!(
            reprice(Game::Dice, &pool(10_000), &calm(), &shy, &[rival], NOW).reason,
            Reason::Steady
        );
        let ended = RivalOffer {
            boost_until: NOW,
            ..rival
        };
        assert_eq!(
            reprice(Game::Dice, &pool(10_000), &calm(), &BALANCED, &[ended], NOW).reason,
            Reason::Steady
        );
    }

    #[test]
    fn rival_offer_from_an_offer() {
        let mut offer = usual(Game::Roulette);
        let rival = RivalOffer::new(Game::Roulette, &offer, NOW);
        assert_eq!(rival.edge_bp, 270 + offer.rake_bp);
        offer.boost_until = NOW + 1;
        assert_eq!(RivalOffer::new(Game::Roulette, &offer, NOW).edge_bp, 270);
    }

    fn floor(my_rent: Option<u128>, lowest: u128, empty_seats: usize) -> FloorView {
        FloorView {
            my_rent,
            lowest_rent: Some(lowest),
            empty_seats,
            outbid_min: if empty_seats > 0 {
                MIN_RENT_PER_HOUR
            } else {
                (lowest * 11_000).div_ceil(BP)
            },
            cooldown_until: 0,
            my_min_rent: if my_rent.is_some() { MIN_RENT_PER_HOUR } else { 0 },
        }
    }

    /// The dealer earned 100 USDC this hour.
    fn earning() -> Stats {
        Stats {
            player_net_1h: -100 * USDC as i128,
            ..calm()
        }
    }

    #[test]
    fn rent_target_follows_earnings_and_temperament() {
        // Share of 100 USDC: balanced (appetite 50) 30 %, greedy (appetite 12) 14.8 %,
        // promoter (appetite 82) 42.8 %.
        let at_risk = floor(Some(2 * USDC), 2 * USDC, 0);
        for (temperament, target) in [
            (BALANCED, 30_000_000),
            (GREEDY, 14_800_000),
            (PROMOTER, 42_800_000),
        ] {
            assert_eq!(
                rent_bid(&pool(10_000), &earning(), &temperament, &at_risk, NOW),
                decide(RentAction::Raise(target), RentReason::DefendingSeat)
            );
        }
    }

    #[test]
    fn seated_dealer_defends_cuts_or_keeps() {
        let p = pool(10_000);
        // Within 15 % of the lowest on a full floor, earnings allow: raise.
        let near = floor(Some(11 * USDC), 10 * USDC, 0);
        assert_eq!(
            rent_bid(&p, &earning(), &BALANCED, &near, NOW).action,
            RentAction::Raise(30 * USDC)
        );
        // At risk but earnings do not allow more: keep (never cut under threat).
        assert_eq!(rent_bid(&p, &calm(), &BALANCED, &near, NOW), KEEP);
        // Safe and overpaying: cut to the target (the minimum without earnings).
        let safe = floor(Some(20 * USDC), 10 * USDC, 0);
        assert_eq!(
            rent_bid(&p, &calm(), &BALANCED, &safe, NOW),
            decide(
                RentAction::Lower(MIN_RENT_PER_HOUR),
                RentReason::CuttingRent
            )
        );
        // Safe, near the target: keep.
        let fine = floor(Some(34 * USDC), 10 * USDC, 1);
        assert_eq!(rent_bid(&p, &earning(), &BALANCED, &fine, NOW), KEEP);
        // A raise never goes beyond what the pool can prepay.
        assert_eq!(rent_bid(&pool(20), &earning(), &BALANCED, &near, NOW), KEEP);
    }

    #[test]
    fn off_floor_dealer_bids() {
        // Empty seat: bid the target.
        assert_eq!(
            rent_bid(
                &pool(10_000),
                &calm(),
                &BALANCED,
                &floor(None, 5 * USDC, 1),
                NOW
            ),
            decide(
                RentAction::BidEmpty(MIN_RENT_PER_HOUR),
                RentReason::BiddingForSeat
            )
        );
        // Full floor: budget is 0.15 % of 10 000 = 15 USDC/h, enough to outbid 10 × 110 %.
        assert_eq!(
            rent_bid(
                &pool(10_000),
                &calm(),
                &BALANCED,
                &floor(None, 10 * USDC, 0),
                NOW
            ),
            decide(RentAction::Outbid(11 * USDC), RentReason::BiddingForSeat)
        );
        // Not enough budget.
        assert_eq!(
            rent_bid(
                &pool(10_000),
                &calm(),
                &BALANCED,
                &floor(None, 14 * USDC, 0),
                NOW
            ),
            STAY
        );
        // Cannot prepay even the minimum.
        assert_eq!(
            rent_bid(&pool(1), &calm(), &BALANCED, &floor(None, 5 * USDC, 1), NOW),
            STAY
        );
        // Cooldown.
        let cooling = FloorView {
            cooldown_until: NOW + 1,
            ..floor(None, 5 * USDC, 1)
        };
        assert_eq!(
            rent_bid(&pool(10_000), &calm(), &BALANCED, &cooling, NOW),
            STAY
        );
    }

    #[test]
    fn rent_bids_respect_seat_minimums() {
        // Seated at the entrance (min 1.5 USDC): a cut stops at the seat's minimum.
        let entrance = FloorView {
            my_min_rent: 1_500_000,
            ..floor(Some(20 * USDC), 10 * USDC, 0)
        };
        assert_eq!(
            rent_bid(&pool(10_000), &calm(), &BALANCED, &entrance, NOW).action,
            RentAction::Lower(1_500_000)
        );
        // Off the floor, only the entrance seat is free: bid its minimum, not the bare target.
        let only_entrance = FloorView {
            outbid_min: 1_500_000,
            ..floor(None, 5 * USDC, 1)
        };
        assert_eq!(
            rent_bid(&pool(10_000), &calm(), &BALANCED, &only_entrance, NOW).action,
            RentAction::BidEmpty(1_500_000)
        );
        // ...unless the pool cannot prepay it.
        assert_eq!(
            rent_bid(&pool(2), &calm(), &BALANCED, &only_entrance, NOW),
            STAY
        );
    }

    #[test]
    fn owner_offer_is_clamped_like_an_npc_offer() {
        let p = pool(1_000);
        let wild = clamp_owner_offer(Game::Dice, &p, 9_000, u128::MAX, 3 * 3_600, 0, NOW);
        assert_eq!(wild.rake_bp, rake_bounds(Game::Dice).1);
        assert_eq!(wild.max_bet, p.free() / worst_case_multiple(Game::Dice));
        assert_eq!(wild.boost_until, NOW + MAX_BOOST_SECS);
        assert_eq!(wild.reason, Reason::Owner);
        let cheap = clamp_owner_offer(Game::Dice, &p, 0, USDC, 0, 0, NOW);
        assert_eq!((cheap.rake_bp, cheap.max_bet, cheap.boost_until), (100, USDC, 0));
        // One boost per hour.
        let again = clamp_owner_offer(Game::Dice, &p, 200, USDC, 600, NOW - 3_599, NOW);
        assert_eq!(again.boost_until, 0);
        let later = clamp_owner_offer(Game::Dice, &p, 200, USDC, 600, NOW - 3_600, NOW);
        assert_eq!(later.boost_until, NOW + 600);
        assert_eq!(Reason::Owner.code(), "owner");
    }

    #[test]
    fn rent_reason_codes() {
        for reason in [
            RentReason::DefendingSeat,
            RentReason::BiddingForSeat,
            RentReason::CuttingRent,
        ] {
            assert_eq!(
                serde_json::to_string(&reason).unwrap(),
                format!("\"{}\"", reason.code())
            );
            assert!(!reason.explain().is_empty());
        }
        let json =
            serde_json::to_value(decide(RentAction::Outbid(USDC), RentReason::BiddingForSeat))
                .unwrap();
        assert_eq!(json["action"]["outbid"], "1000000");
        assert_eq!(json["reason"], "bidding_for_seat");
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
                game_share_bp: rng.below(u32::from(u16::MAX) + 1) as u16,
            };
            let temperament = Temperament {
                greed: rng.below(256) as u8,
                caution: rng.below(256) as u8,
                promo: rng.below(256) as u8,
            };
            let now = [0, NOW, u64::MAX - u64::from(rng.below(1_000))][rng.below(3) as usize];
            let rivals: Vec<RivalOffer> = (0..rng.below(6))
                .map(|_| RivalOffer {
                    edge_bp: rng.below(u32::from(u16::MAX) + 1) as u16,
                    boost_until: [0, now.saturating_add(u64::from(rng.below(100_000)))]
                        [rng.below(2) as usize],
                })
                .collect();

            let offer = reprice(game, &pool, &stats, &temperament, &rivals, now);

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
