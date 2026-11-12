//! Scripted table owners: players who open a table (docs/floor.md rule 4) and run it their way.
//!
//! - **Uma, the undercutter**: opens a dice table and always prices 0.1 % under the cheapest
//!   rival dice table. Rivals that lose players undercut her back: a price war.
//! - **Gus, the gambler-owner**: opens a roulette table priced on autopilot (same rules as the
//!   NPCs), outbids his way onto the floor, gambles at the other tables with his own money, and a
//!   day and a half later sells his seat.
//! - **Pia, the premium owner**: opens a blackjack table with the highest edge and a high max bet
//!   for whales, buys a seat on the market rather than fighting for one, boosts every 6 hours.
//!
//! Their offers go through `clamp_owner_offer` and their seats through the floor rules, like any
//! player's on chain.

use core_rules::gambler_rules::Persona;
use core_rules::{
    base_edge_bp, clamp_owner_offer, rake_bounds, validate_new_table, worst_case_multiple, Game,
    Temperament, BP,
};

use crate::gamblers::Gambler;
use crate::world::{usdc, Dealer, World, DAY, HOUR, MIN_BET, USDC};

/// Temperament label of a table whose owner sets the offer by hand.
pub const MANUAL: &str = "manual";

/// Gus's autopilot: middle of the road.
const BALANCED: Temperament = Temperament {
    greed: 50,
    caution: 50,
    promo: 50,
};

/// Uma prices this far under the cheapest rival (0.1 %).
const UNDERCUT_STEP_BP: u16 = 10;
/// Uma's rake with no rival in sight.
const UNDERCUTTER_LONE_RAKE_BP: u16 = 250;
/// Rent Uma raises to once seated, so she is not the first one outbid.
const UNDERCUTTER_RENT: u128 = 1_600_000;
/// Most Uma pays per hour to get back on the floor.
const UNDERCUTTER_MAX_BID: u128 = 3 * USDC;

/// Manual owners risk this share of their free bankroll on one bet at most (3 %).
const OWNER_RISK_BP: u128 = 300;

/// Gus lists his seat this long after opening, at this price.
const SELL_AFTER_SECS: u64 = 36 * HOUR;
const SEAT_PRICE: u128 = 60 * USDC;
/// Most Gus pays per hour for a seat.
const GAMBLER_OWNER_MAX_BID: u128 = 3 * USDC;

/// Pia's max bet ask, the most she pays for a seat, and when she gives up waiting for a listing.
const PREMIUM_MAX_BET: u128 = 50 * USDC;
const PREMIUM_MAX_SEAT_PRICE: u128 = 150 * USDC;
const PREMIUM_PATIENCE_SECS: u64 = 2 * DAY;
const PREMIUM_MAX_BID: u128 = 5 * USDC;
/// Pia boosts for 15 minutes every 6 hours.
const PREMIUM_BOOST_EVERY_SECS: u64 = 6 * HOUR;
const PREMIUM_BOOST_SECS: u64 = 15 * 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Strategy {
    Undercutter,
    Premium,
    GamblerOwner,
}

impl Strategy {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Undercutter => "undercutter",
            Self::Premium => "premium",
            Self::GamblerOwner => "gambler_owner",
        }
    }
}

pub struct Owner {
    pub name: &'static str,
    pub strategy: Strategy,
    /// In-contract balance (the table's seed comes from here, seat sales go to it).
    pub wallet: u128,
    /// The owner's dealer once opened (index into `World::dealers`).
    pub dealer: Option<usize>,
    /// Founding LP shares of the table.
    pub shares: u128,
    table_id: &'static str,
    game: Game,
    opens_at: u64,
    seed: u128,
    /// The gambler entry this owner plays as, if any.
    gambler: Option<usize>,
    last_boost_at: u64,
    listed: bool,
    sold: bool,
}

fn owner(
    name: &'static str,
    strategy: Strategy,
    table_id: &'static str,
    game: Game,
    opens_at: u64,
    seed_usdc: u128,
    wallet_usdc: u128,
) -> Owner {
    Owner {
        name,
        strategy,
        wallet: wallet_usdc * USDC,
        dealer: None,
        shares: 0,
        table_id,
        game,
        opens_at,
        seed: seed_usdc * USDC,
        gambler: None,
        last_boost_at: 0,
        listed: false,
        sold: false,
    }
}

/// The three owners. Gus also joins the gamblers (unsalaried, 300 USDC of his own to play).
pub fn population(gamblers: &mut Vec<Gambler>) -> Vec<Owner> {
    let mut gus = owner(
        "Gus",
        Strategy::GamblerOwner,
        "gus-roulette",
        Game::Roulette,
        DAY + 10 * HOUR,
        400,
        500,
    );
    gamblers.push(Gambler::new(
        "Gus",
        Persona::ThrillSeeker,
        300 * USDC,
        false,
    ));
    gus.gambler = Some(gamblers.len() - 1);
    vec![
        owner(
            "Uma",
            Strategy::Undercutter,
            "uma-dice",
            Game::Dice,
            6 * HOUR,
            600,
            800,
        ),
        gus,
        owner(
            "Pia",
            Strategy::Premium,
            "pia-blackjack",
            Game::Blackjack,
            2 * DAY + 12 * HOUR,
            1_500,
            2_000,
        ),
    ]
}

/// Whether this dealer's rent is decided by `rent_bid`: the house's NPCs. Owners bid their way.
pub fn bids_on_autopilot(world: &World, dealer: usize) -> bool {
    world.dealers[dealer].owner.is_none()
}

/// Every seat interval: owners open their tables, manage their seats and set their offers.
pub fn act(world: &mut World) {
    for o in 0..world.owners.len() {
        let Some(dealer) = world.owners[o].dealer else {
            if world.now >= world.owners[o].opens_at {
                open(world, o);
            }
            continue;
        };
        match world.owners[o].strategy {
            Strategy::Undercutter => undercutter(world, dealer),
            Strategy::Premium => premium(world, o, dealer),
            Strategy::GamblerOwner => gambler_owner(world, o, dealer),
        }
    }
}

/// `open_table`: the seed moves from the owner's wallet into a new pool, the owner holds the
/// founding shares; the table starts off the floor.
fn open(world: &mut World, o: usize) {
    let now = world.now;
    let owner = &world.owners[o];
    if validate_new_table(owner.table_id, owner.name, owner.seed, world.dealers.len()).is_err()
        || owner.wallet < owner.seed
    {
        return;
    }
    let temperament = match owner.strategy {
        Strategy::GamblerOwner => "balanced",
        Strategy::Undercutter | Strategy::Premium => MANUAL,
    };
    let mut dealer = Dealer::new(
        owner.table_id.to_string(),
        owner.name.to_string(),
        owner.game,
        temperament,
        BALANCED,
        Some(o),
        now,
    );
    let seed = owner.seed;
    let shares = dealer.pool.buy_shares(seed);
    if shares == 0 {
        return;
    }
    dealer.record_flow(now, seed as i128);
    dealer.open = dealer.pool.is_open(MIN_BET, dealer.game);
    let index = world.dealers.len();
    let text = format!(
        "{} opens a {} table with {} tUSDC ({})",
        owner.name,
        game_name(owner.game),
        usdc(seed),
        owner.strategy.code()
    );
    world.dealers.push(dealer);
    let owner = &mut world.owners[o];
    owner.wallet -= seed;
    owner.shares = shares;
    owner.dealer = Some(index);
    if let Some(g) = owner.gambler {
        world.gamblers[g].own_dealer = Some(index);
    }
    let id = world.dealers[index].id.clone();
    world.push_event(&id, "opened", text);
}

fn game_name(game: Game) -> &'static str {
    match game {
        Game::Dice => "dice",
        Game::Roulette => "roulette",
        Game::Blackjack => "blackjack",
        Game::Poker => "poker",
    }
}

/// Max bet a manual owner asks for: 3 % of the free bankroll at the game's worst case.
fn owner_max_bet(world: &World, dealer: usize) -> u128 {
    let d = &world.dealers[dealer];
    d.pool.free() * OWNER_RISK_BP / BP / worst_case_multiple(d.game)
}

fn undercutter(world: &mut World, dealer: usize) {
    let now = world.now;
    let d = &world.dealers[dealer];
    match world.floor.seat(&d.id).map(|s| s.rent_per_hour) {
        None if now >= d.cooldown_until => {
            let bid = world.floor.outbid_min();
            if bid <= UNDERCUTTER_MAX_BID {
                world.bid(dealer, bid, "the undercutter wants a seat");
            }
        }
        Some(rent) if rent < UNDERCUTTER_RENT => {
            world.bid(
                dealer,
                UNDERCUTTER_RENT,
                "staying off the bottom of the floor",
            );
        }
        _ => {}
    }
    let d = &world.dealers[dealer];
    let base = base_edge_bp(d.game);
    let cheapest = world
        .seated_same_game(dealer)
        .map(|r| world.dealers[r].list_edge_bp())
        .min();
    let rake = cheapest.map_or(UNDERCUTTER_LONE_RAKE_BP, |edge| {
        edge.saturating_sub(base).saturating_sub(UNDERCUT_STEP_BP)
    });
    let offer = clamp_owner_offer(
        d.game,
        &d.pool,
        rake,
        owner_max_bet(world, dealer),
        0,
        0,
        now,
    );
    world.set_offer(dealer, offer);
}

fn premium(world: &mut World, o: usize, dealer: usize) {
    let now = world.now;
    if world.floor.seat_of(&world.dealers[dealer].id).is_none() {
        premium_find_seat(world, o, dealer);
    }
    let d = &world.dealers[dealer];
    let boost_secs = if now.is_multiple_of(PREMIUM_BOOST_EVERY_SECS) {
        PREMIUM_BOOST_SECS
    } else {
        0
    };
    let offer = clamp_owner_offer(
        d.game,
        &d.pool,
        rake_bounds(d.game).1,
        PREMIUM_MAX_BET.min(owner_max_bet(world, dealer)),
        boost_secs,
        world.owners[o].last_boost_at,
        now,
    );
    if offer.boost_until > now && d.offer.boost_until <= now {
        world.owners[o].last_boost_at = now;
    }
    world.set_offer(dealer, offer);
}

/// Pia buys the cheapest listed seat she can afford; after two days of waiting she bids.
fn premium_find_seat(world: &mut World, o: usize, dealer: usize) {
    let now = world.now;
    let listing = world
        .floor
        .seats
        .iter()
        .enumerate()
        .filter_map(|(i, s)| Some((i, s.as_ref()?.ask?)))
        .filter(|&(_, ask)| ask <= PREMIUM_MAX_SEAT_PRICE && ask <= world.owners[o].wallet)
        .min_by_key(|&(_, ask)| ask);
    if let Some((seat, ask)) = listing {
        let buyer_id = world.dealers[dealer].id.clone();
        let Ok(sale) = world.floor.buy_seat(seat, &buyer_id, ask, now) else {
            return;
        };
        world.owners[o].wallet -= sale.price;
        let seller = world.dealer_index(&sale.seller);
        if let Some(so) = seller.and_then(|s| world.dealers[s].owner) {
            world.owners[so].wallet += sale.price;
            world.owners[so].sold = true;
        }
        let text = format!(
            "{} buys seat {} from {} for {} tUSDC",
            world.owners[o].name,
            seat + 1,
            sale.seller,
            usdc(sale.price)
        );
        world.push_event(&buyer_id, "seat_sold", text);
        return;
    }
    let opened = world.owners[o].opens_at;
    if now >= opened + PREMIUM_PATIENCE_SECS && now >= world.dealers[dealer].cooldown_until {
        let bid = world.floor.outbid_min();
        if bid <= PREMIUM_MAX_BID {
            world.bid(dealer, bid, "no seat for sale, outbidding");
        }
    }
}

/// Gus's offer runs on autopilot (like an NPC's); he outbids his way onto the floor, then lists
/// his seat a day and a half after opening. Once sold he stays off the floor.
fn gambler_owner(world: &mut World, o: usize, dealer: usize) {
    let owner = &world.owners[o];
    let d = &world.dealers[dealer];
    let seated = world.floor.seat_of(&d.id).is_some();
    if !seated && !owner.sold && world.now >= d.cooldown_until {
        let bid = world.floor.outbid_min();
        if bid <= GAMBLER_OWNER_MAX_BID {
            world.bid(dealer, bid, "Gus wants his table on the floor");
        }
        return;
    }
    if !seated || owner.listed || world.now < owner.opens_at + SELL_AFTER_SECS {
        return;
    }
    let id = world.dealers[dealer].id.clone();
    if world.floor.list_seat(&id, Some(SEAT_PRICE)).is_err() {
        return;
    }
    world.owners[o].listed = true;
    let seat = world.floor.seat_of(&id).map_or(0, |s| s + 1);
    let text = format!(
        "{} puts seat {} up for sale at {} tUSDC",
        world.owners[o].name,
        seat,
        usdc(SEAT_PRICE)
    );
    world.push_event(&id, "seat_listed", text);
}
