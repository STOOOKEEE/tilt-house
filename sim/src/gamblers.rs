//! The gamblers on the floor. Every choice comes from `core_rules::gambler_rules`; this file only
//! walks them through their states and plays their sessions with the session rules
//! (`core_rules::session`): seeds per round, the session's max win, rounds settled at once.
//!
//! States: away → walking in (1 min) → deciding in front of a table (30 s) → seated, one round
//! per tick → leaving (1 min) → away.

use core_rules::gambler_rules::{
    self, arrives, choose_table, desired_stake, pick_bet, plan_session, GamblerReason, Memory,
    Persona, TableView,
};
use core_rules::session::{resolve_round, round_seed, session_max_win, BjAction, BjSession};
use core_rules::{draw_jackpot, worst_case_payout, Bet, BjMove, DiceBet, Game, Rng, RouletteBet};
use serde::Serialize;

use crate::world::{usdc, World, MIN_BET, USDC};

const WALK_SECS: u64 = 60;
const DECIDE_SECS: u64 = 30;
const LEAVE_SECS: u64 = 60;
/// Arrivals are drawn once a minute.
const ARRIVAL_SECS: u64 = 60;

pub struct Session {
    pub dealer: usize,
    /// Offer frozen at open (docs/sessions.md).
    rake_bp: u16,
    stake: u128,
    rounds_left: u32,
    lock: u128,
    max_win: u128,
    net: i128,
    server_seed: [u8; 32],
    client_seed: String,
    nonce: u64,
}

pub enum State {
    Away,
    Walking { until: u64 },
    Deciding { until: u64, choice: Option<usize> },
    Seated(Session),
    Leaving { until: u64, dealer: Option<usize> },
}

pub struct Gambler {
    pub id: String,
    pub name: String,
    pub persona: Persona,
    pub balance: u128,
    /// Paid by the house; owners who gamble are not.
    pub salaried: bool,
    /// An owner who gambles never plays at its own table.
    pub own_dealer: Option<usize>,
    memory: Memory,
    pub state: State,
    stake: u128,
    reason: Option<(&'static str, String)>,
    sessions: u64,
}

impl Gambler {
    pub fn new(name: &str, persona: Persona, balance: u128, salaried: bool) -> Self {
        Self {
            id: format!("g-{}", name.to_lowercase()),
            name: name.to_string(),
            persona,
            balance,
            salaried,
            own_dealer: None,
            memory: Memory::default(),
            state: State::Away,
            stake: 0,
            reason: None,
            sessions: 0,
        }
    }
}

/// The 24 house gamblers, with 30 to 150 USDC each.
pub fn population(rng: &mut Rng) -> Vec<Gambler> {
    gambler_rules::LINEUP
        .iter()
        .map(|(name, persona)| {
            let balance = u128::from(30 + rng.below(121)) * USDC;
            Gambler::new(name, *persona, balance, true)
        })
        .collect()
}

#[derive(Serialize)]
pub struct GamblerFrame {
    pub id: String,
    pub state: &'static str,
    pub dealer_id: Option<String>,
    pub seat: Option<usize>,
    pub reason_code: Option<&'static str>,
    pub reason: Option<String>,
    pub balance: String,
    pub session_net: String,
}

/// The gamblers on the floor right now (those away are left out).
pub fn frames(world: &World) -> Vec<GamblerFrame> {
    world
        .gamblers
        .iter()
        .filter_map(|g| {
            let (state, dealer, seated, net) = match &g.state {
                State::Away => return None,
                State::Walking { .. } => ("walking", None, false, 0),
                State::Deciding { choice, .. } => ("deciding", *choice, false, 0),
                State::Seated(s) => ("seated", Some(s.dealer), true, s.net),
                State::Leaving { dealer, .. } => ("leaving", *dealer, false, 0),
            };
            let dealer_id = dealer.map(|d| world.dealers[d].id.clone());
            let seat = dealer_id
                .as_deref()
                .filter(|_| seated)
                .and_then(|id| world.floor.seat_of(id));
            Some(GamblerFrame {
                id: g.id.clone(),
                state,
                dealer_id,
                seat,
                reason_code: g.reason.as_ref().map(|(code, _)| *code),
                reason: g.reason.as_ref().map(|(_, text)| text.clone()),
                balance: g.balance.to_string(),
                session_net: net.to_string(),
            })
        })
        .collect()
}

pub fn tick_all(world: &mut World) {
    for index in 0..world.gamblers.len() {
        let state = std::mem::replace(&mut world.gamblers[index].state, State::Away);
        let next = step(world, index, state);
        world.gamblers[index].state = next;
    }
}

fn step(world: &mut World, g: usize, state: State) -> State {
    let now = world.now;
    match state {
        State::Away => {
            let gambler = &world.gamblers[g];
            if now % ARRIVAL_SECS != 0
                || !arrives(gambler.persona, gambler.balance, now, &mut world.rng)
            {
                return State::Away;
            }
            let stake = desired_stake(gambler.persona, gambler.balance, &mut world.rng);
            let gambler = &mut world.gamblers[g];
            gambler.stake = stake;
            gambler.reason = None;
            State::Walking {
                until: now + WALK_SECS,
            }
        }
        State::Walking { until } if now >= until => decide(world, g),
        State::Deciding { until, choice } if now >= until => match choice {
            Some(dealer) => open_session(world, g, dealer),
            None => leave(world, None),
        },
        State::Seated(session) => play(world, g, session),
        State::Leaving { until, .. } if now >= until => State::Away,
        other => other,
    }
}

/// Seated, open tables with a usable max bet (not the gambler's own), in seat order.
fn tables(world: &World, own: Option<usize>) -> Vec<(usize, usize)> {
    world
        .floor
        .seats
        .iter()
        .enumerate()
        .filter_map(|(seat, s)| {
            let dealer = world.dealer_index(&s.as_ref()?.dealer_id)?;
            let d = &world.dealers[dealer];
            (d.open && d.offer.max_bet >= MIN_BET && Some(dealer) != own).then_some((dealer, seat))
        })
        .collect()
}

fn decide(world: &mut World, g: usize) -> State {
    let now = world.now;
    let gambler = &world.gamblers[g];
    let found = tables(world, gambler.own_dealer);
    let views: Vec<TableView> = found
        .iter()
        .map(|&(dealer, seat)| {
            let d = &world.dealers[dealer];
            TableView {
                dealer_id: &d.id,
                name: &d.name,
                game: d.game,
                seat,
                edge_bp: d.edge_bp(now),
                boosting: d.offer.boost_until > now,
                max_bet: d.offer.max_bet,
            }
        })
        .collect();
    let decision = choose_table(
        gambler.persona,
        gambler.balance,
        gambler.stake,
        &views,
        &gambler.memory,
        world.floor.jackpot,
        &mut world.rng,
    );
    let choice = decision.table.map(|i| found[i].0);
    world.gamblers[g].reason = Some((decision.reason.code(), decision.text));
    State::Deciding {
        until: now + DECIDE_SECS,
        choice,
    }
}

fn leave(world: &World, dealer: Option<usize>) -> State {
    State::Leaving {
        until: world.now + LEAVE_SECS,
        dealer,
    }
}

fn random_seed(rng: &mut Rng) -> [u8; 32] {
    let mut seed = [0u8; 32];
    for byte in &mut seed {
        *byte = rng.below(256) as u8;
    }
    seed
}

fn open_session(world: &mut World, g: usize, dealer: usize) -> State {
    let now = world.now;
    let d = &world.dealers[dealer];
    let still_there = d.open && world.floor.seat_of(&d.id).is_some();
    let gambler = &world.gamblers[g];
    let plan = still_there
        .then(|| {
            plan_session(
                gambler.persona,
                gambler.stake,
                d.offer.max_bet,
                gambler.balance,
                &mut world.rng,
            )
        })
        .flatten();
    let Some(plan) = plan else {
        world.gamblers[g].reason = Some((
            GamblerReason::NothingWorthIt.code(),
            format!("{} is no longer taking my bets", d.name),
        ));
        return leave(world, Some(dealer));
    };
    let gambler = &mut world.gamblers[g];
    gambler.sessions += 1;
    State::Seated(Session {
        dealer,
        rake_bp: d.offer.effective_rake_bp(d.game, now),
        stake: plan.stake,
        rounds_left: plan.rounds,
        lock: plan.lock,
        max_win: session_max_win(plan.lock, d.pool.free()),
        net: 0,
        server_seed: random_seed(&mut world.rng),
        client_seed: format!("{}-{}", gambler.id, gambler.sessions),
        nonce: 0,
    })
}

/// A bet that cannot win much: what a gambler falls back to when the session's max win
/// refuses its first idea.
fn safe_bet(game: Game) -> Bet {
    match game {
        Game::Dice => Bet::Dice(DiceBet {
            chance_bp: 5_000,
            over: true,
        }),
        Game::Roulette => Bet::Roulette(RouletteBet::Red),
        Game::Blackjack => Bet::Blackjack,
    }
}

/// Whether the session may still take this bet: losses within the lock, and the worst case
/// within the max win (the session server refuses anything else).
fn allowed(session: &Session, balance: u128, game: Game, bet: &Bet) -> bool {
    let worst = worst_case_payout(game, session.stake, bet);
    let lost = (-session.net).max(0) as u128;
    let gain_room = session.max_win as i128 - session.net;
    lost + session.stake <= session.lock
        && balance >= session.stake
        && (worst.saturating_sub(session.stake) as i128) <= gain_room
}

fn play(world: &mut World, g: usize, mut session: Session) -> State {
    let now = world.now;
    let dealer = session.dealer;
    let d = &world.dealers[dealer];
    let seated = world.floor.seat_of(&d.id).is_some();
    let game = d.game;
    let persona = world.gamblers[g].persona;
    let balance = world.gamblers[g].balance;
    let mut bet = pick_bet(persona, game, &mut world.rng);
    if !allowed(&session, balance, game, &bet) {
        bet = safe_bet(game);
    }
    if session.rounds_left == 0 || !seated || !d.open || !allowed(&session, balance, game, &bet) {
        return end_session(world, g, session);
    }
    let worst = worst_case_payout(game, session.stake, &bet);
    if world.dealers[dealer]
        .pool
        .open_bet(session.stake, worst)
        .is_err()
    {
        return end_session(world, g, session);
    }
    world.gamblers[g].balance -= session.stake;
    let seed = round_seed(&session.server_seed, &session.client_seed, session.nonce);
    let (wager, payout) = match bet {
        Bet::Blackjack => play_hand(world, g, &session),
        _ => {
            let round = resolve_round(game, &bet, session.stake, session.rake_bp, &seed)
                .expect("gambler_rules picks valid bets");
            (session.stake, round.payout)
        }
    };
    world.dealers[dealer]
        .pool
        .settle(wager, worst, payout)
        .expect("payout within the round's reserve");
    world.dealers[dealer].record_bet(now, wager, payout);
    world.gamblers[g].balance += payout;
    session.net += payout as i128 - wager as i128;
    session.nonce += 1;
    session.rounds_left -= 1;
    // The jackpot draws from the round's own seed (docs/sessions.md, step 5).
    let won = draw_jackpot(&mut world.floor.jackpot, &seed, wager);
    if won > 0 {
        world.gamblers[g].balance += won;
        let text = format!(
            "{} hits the jackpot: {} tUSDC",
            world.gamblers[g].name,
            usdc(won)
        );
        let id = world.dealers[dealer].id.clone();
        world.push_event(&id, "jackpot", text);
    }
    State::Seated(session)
}

/// Plays a blackjack hand perfectly from the session's seeds; returns (wagered, payout). The
/// stake is already taken; a double takes the same again, if the lock allows it.
fn play_hand(world: &mut World, g: usize, session: &Session) -> (u128, u128) {
    let dealer = session.dealer;
    let (seed, client) = (&session.server_seed, session.client_seed.as_str());
    let mut hand = BjSession::deal(seed, client, session.nonce, session.stake, session.rake_bp);
    while !hand.is_done() {
        let lost = (-session.net).max(0) as u128;
        let can_double =
            world.gamblers[g].balance >= session.stake && lost + 2 * session.stake <= session.lock;
        let action = match world.strategies.get(session.rake_bp).decide(&hand.state) {
            BjMove::Double if can_double => {
                world.dealers[dealer]
                    .pool
                    .add_stake(session.stake)
                    .expect("double stake");
                world.gamblers[g].balance -= session.stake;
                BjAction::Double
            }
            BjMove::Double | BjMove::Hit => BjAction::Hit,
            BjMove::Stand => BjAction::Stand,
        };
        hand.act(action, seed, client)
            .expect("the strategy only picks legal moves");
    }
    let round = hand.finish().expect("the hand is done");
    (round.wager(), round.payout)
}

fn end_session(world: &mut World, g: usize, session: Session) -> State {
    let d = &world.dealers[session.dealer];
    let gambler = &mut world.gamblers[g];
    gambler.memory.remember(&d.id, session.net, session.lock);
    let text = match session.net {
        net if net > 0 => format!("up {} at {}, cashing out", usdc(net as u128), d.name),
        net if net < 0 => format!(
            "down {} at {}, done for now",
            usdc(net.unsigned_abs()),
            d.name
        ),
        _ => format!("broke even at {}", d.name),
    };
    gambler.reason = Some(("session_over", text));
    leave(world, Some(session.dealer))
}
