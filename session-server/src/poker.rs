//! Poker tables (docs/poker-api.md): No-Limit Hold'em at the floor's poker dealers. A seat is a
//! session at that dealer (buy-in = lock, stack = session balance); each finished hand becomes one
//! round in the session of every player who put chips in, written together
//! (`App::record_poker_hand`). Rules, deck and NPC strategy are core's (`core_rules::poker`,
//! `core_rules::poker_npc`); this module seats players, runs the hand's clock, keeps hole cards
//! private and publishes the state.
//!
//! Each table has a driver task, started on first use, that deals, plays timeouts and NPC turns,
//! records hands and fills or empties the NPC seats. The table state sits behind one async lock;
//! the driver never holds it across a chain call or a disk write.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use core_rules::poker::{
    deck_for, next_button, Card, Hand, HandHistory, HandResult, HandStart, Legal, PokerAction, Pot,
    SeatStart, Street, TableConfig, MAX_SEATS, MIN_PLAYERS,
};
use core_rules::poker_npc::Style;
use core_rules::session::{
    client_seed_is_valid, hex32, sha256, CompactRound, Hash32, SESSION_MIN_BET,
};
use core_rules::{Game, Rng};
use serde::{Deserialize, Serialize};
use tokio::sync::{watch, Mutex as AsyncMutex, Notify};
use tokio::time::Instant;

use crate::app::{ApiError, App, CreateRequest, PokerSeat, SignedState};
use crate::chain::Chain;
use crate::gamblers::{Gamblers, PokerNpc};
use crate::keys::random_bytes;

const SEATS: usize = MAX_SEATS as usize;
/// Blinds of every poker table: 0.1 / 0.2 chips, so buy-ins of 4 to 20 chips (core's 20-100 BB).
pub const BIG_BLIND: u128 = 2 * SESSION_MIN_BET;
/// A player who lets the clock run out this many hands in a row is stood up.
const MAX_TIMEOUTS: u8 = 2;
/// The public table list reads the floor from chain; reuse one read this long.
const FLOOR_CACHE: Duration = Duration::from_secs(5);
/// The driver checks its clock at least this often (actions and joins wake it at once).
const DRIVER_IDLE: Duration = Duration::from_secs(1);
/// After an NPC fails to sit (chain refusal, empty wallet, RPC limit), wait this long before
/// calling one in again: retrying at once floods the RPC (every try reads the chain).
const NPC_RETRY: Duration = Duration::from_secs(30);

/// The biggest buy-in at a dealer whose max bet is `dealer_max_bet`: the contract takes a poker
/// lock only up to the ticket's max bet.
fn max_buy_in(dealer_max_bet: u128) -> u128 {
    table_config()
        .max_buy_in()
        .min(crate::app::ticket_max_bet(dealer_max_bet))
}

/// The stakes of every poker table.
pub fn table_config() -> TableConfig {
    TableConfig::standard(BIG_BLIND)
}

/// Timings; tests shorten them.
#[derive(Clone, Copy, Debug)]
pub struct PokerConfig {
    /// Time to act before the server checks (when free) or folds for you.
    pub action: Duration,
    /// Time for the client seeds after the commitment is published.
    pub seeding: Duration,
    /// Pause between hands (results on screen), and before the first hand after a seat fills.
    pub pause: Duration,
    /// An NPC acts this long after its turn starts, so humans can follow.
    pub npc_think: Duration,
    /// A poll with `since` = current version waits this long for a change.
    pub poll_hold: Duration,
}

impl Default for PokerConfig {
    fn default() -> Self {
        Self {
            action: Duration::from_secs(20),
            seeding: Duration::from_secs(3),
            pause: Duration::from_secs(4),
            npc_think: Duration::from_millis(1_200),
            poll_hold: Duration::from_secs(10),
        }
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Unix ms of an instant (deadlines are in the future, or just passed).
fn unix_ms_at(at: Instant) -> u64 {
    let left = at.saturating_duration_since(Instant::now());
    unix_ms().saturating_add(duration_ms(left))
}

fn duration_ms(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

// ---------------------------------------------------------------------------------------------
// Views (docs/poker-api.md)

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SeatView {
    pub seat: usize,
    pub player: String,
    pub name: String,
    pub npc: bool,
    /// All the player's chips at the table (in play and behind), not counting `bet`.
    #[serde(with = "core_rules::amount_str")]
    pub stack: u128,
    #[serde(with = "core_rules::amount_str")]
    pub bet: u128,
    #[serde(with = "core_rules::amount_str")]
    pub total_in: u128,
    pub folded: bool,
    pub all_in: bool,
    pub in_hand: bool,
    pub waiting: bool,
    pub leaving: bool,
    pub last_action: Option<PokerAction>,
    /// Cards shown at the showdown; never someone's live hole cards.
    pub cards: Option<[Card; 2]>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandPhase {
    Seeding,
    Preflop,
    Flop,
    Turn,
    River,
    Showdown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HandView {
    pub number: u64,
    pub phase: HandPhase,
    #[serde(with = "hex32")]
    pub commitment: Hash32,
    /// Seats dealt into this hand.
    pub seats: Vec<usize>,
    pub seeds_in: Vec<usize>,
    pub button: usize,
    pub small_blind_seat: Option<usize>,
    pub big_blind_seat: Option<usize>,
    pub board: Vec<Card>,
    pub pots: Vec<Pot>,
    #[serde(with = "core_rules::amount_str")]
    pub current_bet: u128,
    pub to_act: Option<usize>,
    pub deadline: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct YouView {
    /// `None` while queued for a seat an NPC is giving up.
    pub seat: Option<usize>,
    pub session_id: String,
    pub hole: Option<[Card; 2]>,
    /// Non-null exactly when it is your turn.
    pub legal: Option<Legal>,
    /// Your session's latest signed state (your proof of the stack, as for the other tables).
    pub state: Option<SignedState>,
    /// The round your latest recorded hand became in your session.
    pub last_round: Option<CompactRound>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConfigView {
    #[serde(with = "core_rules::amount_str")]
    pub small_blind: u128,
    #[serde(with = "core_rules::amount_str")]
    pub big_blind: u128,
    #[serde(with = "core_rules::amount_str")]
    pub rake_cap: u128,
    #[serde(with = "core_rules::amount_str")]
    pub min_buy_in: u128,
    #[serde(with = "core_rules::amount_str")]
    pub max_buy_in: u128,
    pub rake_bp: u16,
    pub action_ms: u64,
    pub seed_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TableState {
    pub table_id: String,
    pub name: String,
    pub version: u64,
    pub seats: Vec<Option<SeatView>>,
    /// Humans waiting for a seat an NPC gives up at the end of the hand.
    pub queued: usize,
    pub config: ConfigView,
    pub hand: Option<HandView>,
    pub last_hand: Option<Arc<HandRecord>>,
    pub you: Option<YouView>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TableSummary {
    pub table_id: String,
    pub name: String,
    pub seats: usize,
    pub humans: usize,
    pub npcs: usize,
    #[serde(with = "core_rules::amount_str")]
    pub small_blind: u128,
    #[serde(with = "core_rules::amount_str")]
    pub big_blind: u128,
    #[serde(with = "core_rules::amount_str")]
    pub min_buy_in: u128,
    #[serde(with = "core_rules::amount_str")]
    pub max_buy_in: u128,
    pub rake_bp: u16,
    pub hand_number: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlayerResult {
    pub seat: usize,
    pub player: String,
    pub name: String,
    pub npc: bool,
    pub session_id: String,
    pub hole: [Card; 2],
    /// Chips put in the pot.
    #[serde(with = "core_rules::amount_str")]
    pub stake: u128,
    /// Chips won, after rake.
    #[serde(with = "core_rules::amount_str")]
    pub payout: u128,
    /// The session round this hand became; `None` for a player who put nothing in (no round).
    pub nonce: Option<u64>,
}

/// A finished hand, fully revealed: core's `history` replays it (`replay_hand`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HandRecord {
    pub number: u64,
    #[serde(with = "hex32")]
    pub commitment: Hash32,
    #[serde(with = "hex32")]
    pub hand_seed: Hash32,
    pub history: HandHistory,
    /// `history.hash()`, what each player's session round commits to.
    #[serde(with = "hex32")]
    pub history_hash: Hash32,
    pub deck: Vec<Card>,
    pub players: Vec<PlayerResult>,
    pub result: HandResult,
    pub ended_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JoinReply {
    pub seat: Option<usize>,
    pub waiting: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LeaveReply {
    pub left: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinRequest {
    pub session_id: String,
    pub seat: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeedRequest {
    pub hand: u64,
    pub client_seed: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionRequest {
    pub hand: u64,
    pub action: PokerAction,
}

// ---------------------------------------------------------------------------------------------
// Table state

#[derive(Clone, Debug)]
struct NpcSeat {
    npc: PokerNpc,
    rng: Rng,
}

#[derive(Clone, Debug)]
struct Seat {
    session_id: String,
    /// sha256 of the session token; `None` for NPCs (played in-process).
    token_hash: Option<Hash32>,
    player: String,
    name: String,
    npc: Option<NpcSeat>,
    /// Session balance (updated once a hand is recorded).
    stack: u128,
    /// The ticket's max bet: at most this much is in play in one hand (the contract's limit on
    /// a round's stake); the rest stays behind.
    max_in_play: u128,
    /// `lock + max_win`: no hand may leave the stack above it.
    ceiling: u128,
    rake_bp: u16,
    session_seed: String,
    /// Dealt in from the next hand.
    waiting: bool,
    leaving: bool,
    timeouts: u8,
    /// Balance when seated, for the NPC's result on the floor.
    buy_in: u128,
}

impl Seat {
    fn from_session(info: &PokerSeat, token: Option<&str>, name: String) -> Self {
        Self {
            session_id: info.session_id.clone(),
            token_hash: token.map(|t| sha256(t.as_bytes())),
            player: info.player.clone(),
            name,
            npc: None,
            stack: info.balance,
            max_in_play: info.max_bet,
            ceiling: info.ceiling,
            rake_bp: info.rake_bp,
            session_seed: info.client_seed.clone(),
            waiting: true,
            leaving: false,
            timeouts: 0,
            buy_in: info.balance,
        }
    }

    fn in_play(&self) -> u128 {
        self.stack.min(self.max_in_play)
    }
}

enum Stage {
    /// Commitment out, client seeds coming in.
    Seeding,
    Playing(Box<Hand>),
    /// Done; the rounds are being written (no action accepted).
    Recording(Box<Hand>),
}

struct Live {
    number: u64,
    seed: Hash32,
    commitment: Hash32,
    /// Seats dealt in, increasing.
    dealt: Vec<usize>,
    seeds: BTreeMap<usize, String>,
    button: usize,
    stage: Stage,
    /// Each seat's last action this street.
    last: BTreeMap<usize, PokerAction>,
    /// Seeding end or the current turn's clock.
    deadline: Instant,
    turn_started: Instant,
}

impl Live {
    fn hand(&self) -> Option<&Hand> {
        match &self.stage {
            Stage::Seeding => None,
            Stage::Playing(hand) | Stage::Recording(hand) => Some(hand),
        }
    }
}

type Close = (String, Option<PokerNpc>, i128);

/// What the driver does outside the table lock.
#[derive(Default)]
struct Effects {
    /// Sessions to stand up and close (with the NPC to give back and its result).
    close: Vec<Close>,
    npc_joins: usize,
    record: Option<Vec<(String, CompactRound)>>,
}

struct Table {
    id: String,
    name: String,
    floor_seat: Option<usize>,
    stakes: TableConfig,
    /// Biggest buy-in the contract takes now: the stakes' maximum, capped at the ticket's max
    /// bet (refreshed with the floor on `GET /poker/tables`).
    max_buy_in: u128,
    rake_bp: u16,
    config: PokerConfig,
    seats: Vec<Option<Seat>>,
    queue: VecDeque<Seat>,
    hand: Option<Live>,
    last_hand: Option<Arc<HandRecord>>,
    hand_number: u64,
    button: Option<usize>,
    next_hand_at: Instant,
    npc_joining: usize,
    /// No NPC is called in before this (see `NPC_RETRY`).
    npc_retry_at: Instant,
    version: u64,
    rng: Rng,
}

fn seat_u8(seat: usize) -> u8 {
    u8::try_from(seat).unwrap_or(u8::MAX)
}

impl Table {
    fn changed(&mut self) {
        self.version += 1;
    }

    fn humans(&self) -> usize {
        self.seats
            .iter()
            .flatten()
            .filter(|s| s.npc.is_none() && !s.leaving)
            .count()
            + self.queue.len()
    }

    fn npcs(&self) -> usize {
        self.seats
            .iter()
            .flatten()
            .filter(|s| s.npc.is_some() && !s.leaving)
            .count()
    }

    fn free_seats(&self) -> usize {
        self.seats.iter().filter(|s| s.is_none()).count()
    }

    fn free_seat(&self, wanted: Option<usize>) -> Option<usize> {
        match wanted {
            Some(seat) => (seat < SEATS && self.seats[seat].is_none()).then_some(seat),
            None => self.seats.iter().position(Option::is_none),
        }
    }

    fn in_hand(&self, seat: usize) -> bool {
        self.hand.as_ref().is_some_and(|h| h.dealt.contains(&seat))
    }

    fn seat_of_token(&self, token: &str) -> Option<usize> {
        let hash = sha256(token.as_bytes());
        self.seats
            .iter()
            .position(|s| s.as_ref().is_some_and(|s| s.token_hash == Some(hash)))
    }

    /// Empties `seat` if it holds a leaver not in the hand.
    fn remove_leaver(&mut self, seat: usize, effects: &mut Effects) {
        let leave = self.seats[seat]
            .as_ref()
            .is_some_and(|s| s.leaving && !self.in_hand(seat));
        if leave {
            if let Some(s) = self.seats[seat].take() {
                effects.close.push(close_of(&s));
            }
            self.changed();
        }
    }

    /// Between hands: removes leavers, seats queued humans (an NPC gives up its seat to a human
    /// who needs it: anti-bumhunting), and calls NPCs in or sends them away per core's rule.
    fn reseat(&mut self, now: Instant, effects: &mut Effects) {
        for seat in 0..SEATS {
            self.remove_leaver(seat, effects);
        }
        while !self.queue.is_empty() {
            let seat = self.free_seat(None).or_else(|| {
                let npc = (0..SEATS).rev().find(|&i| {
                    self.seats[i]
                        .as_ref()
                        .is_some_and(|s| s.npc.is_some() && !self.in_hand(i))
                })?;
                let s = self.seats[npc].take()?;
                effects.close.push(close_of(&s));
                Some(npc)
            });
            let Some(seat) = seat else {
                // Every NPC is in the hand: the last one leaves when it ends.
                if let Some(s) = self.seats.iter_mut().flatten().rfind(|s| s.npc.is_some()) {
                    s.leaving = true;
                }
                break;
            };
            self.seats[seat] = self.queue.pop_front();
            self.changed();
        }
        let change = npc_seats_change(
            self.humans(),
            self.npcs() + self.npc_joining,
            self.free_seats(),
        );
        if change > 0 {
            if now < self.npc_retry_at {
                return;
            }
            effects.npc_joins += change.unsigned_abs();
            self.npc_joining += change.unsigned_abs();
            return;
        }
        let mut extra = change.unsigned_abs();
        for seat in (0..SEATS).rev() {
            if extra == 0 {
                break;
            }
            if let Some(s) = self.seats[seat].as_mut() {
                if s.npc.is_some() && !s.leaving {
                    s.leaving = true;
                    extra -= 1;
                    self.remove_leaver(seat, effects);
                    self.changed();
                }
            }
        }
    }

    /// One step of the clock: deals, ends seeding, plays timeouts and NPC turns, ends hands.
    fn step(&mut self, now: Instant, effects: &mut Effects) {
        match self.hand.as_ref().map(|h| &h.stage) {
            None => {
                self.reseat(now, effects);
                if now >= self.next_hand_at {
                    self.start_hand(now);
                }
            }
            Some(Stage::Seeding) => {
                let done = self.hand.as_ref().is_some_and(|live| {
                    now >= live.deadline || live.dealt.iter().all(|s| live.seeds.contains_key(s))
                });
                if done {
                    self.deal(now);
                }
            }
            Some(Stage::Playing(_)) => self.play_clock(now, effects),
            Some(Stage::Recording(_)) => {}
        }
    }

    fn start_hand(&mut self, now: Instant) {
        let candidates: Vec<usize> = (0..SEATS)
            .filter(|&i| {
                self.seats[i]
                    .as_ref()
                    .is_some_and(|s| !s.leaving && s.stack >= self.stakes.big_blind)
            })
            .collect();
        // Nobody may play a hand that could leave them above `lock + max_win`: the contract
        // would refuse the round. They are stood up with their stack instead.
        let in_play: Vec<(usize, u128)> = candidates
            .iter()
            .filter_map(|&i| self.seats[i].as_ref().map(|s| (i, s.in_play())))
            .collect();
        let mut dealt = Vec::new();
        for &(i, own) in &in_play {
            let most_won: u128 = in_play
                .iter()
                .filter(|(j, _)| *j != i)
                .map(|(_, other)| (*other).min(own))
                .sum();
            let Some(seat) = self.seats[i].as_mut() else {
                continue;
            };
            if seat.stack.saturating_add(most_won) > seat.ceiling {
                seat.leaving = true;
                self.version += 1;
            } else {
                dealt.push(i);
            }
        }
        // Bots never play among themselves.
        let humans = dealt
            .iter()
            .filter(|&&i| self.seats[i].as_ref().is_some_and(|s| s.npc.is_none()))
            .count();
        if dealt.len() < MIN_PLAYERS || humans == 0 {
            return;
        }
        let Ok(seed) = random_bytes::<32>() else {
            eprintln!("poker {}: no randomness, hand not dealt", self.id);
            return;
        };
        let seated: Vec<u8> = dealt.iter().map(|&i| seat_u8(i)).collect();
        let button = match self.button {
            Some(previous) => next_button(&seated, seat_u8(previous)).map(usize::from),
            None => dealt
                .get(self.rng.below(dealt.len() as u32) as usize)
                .copied(),
        }
        .unwrap_or(dealt[0]);
        self.hand_number += 1;
        // NPC seeds are fixed before the commitment: the server, which knows the hand seed,
        // must not choose any seed after seeing it.
        let mut seeds = BTreeMap::new();
        for &i in &dealt {
            if let Some(s) = self.seats[i].as_mut() {
                s.waiting = false;
                if let Some(npc) = &s.npc {
                    seeds.insert(i, format!("{}-{}", npc.npc.id, self.hand_number));
                }
            }
        }
        self.button = Some(button);
        self.hand = Some(Live {
            number: self.hand_number,
            seed,
            commitment: sha256(&seed),
            dealt,
            seeds,
            button,
            stage: Stage::Seeding,
            last: BTreeMap::new(),
            deadline: now + self.config.seeding,
            turn_started: now,
        });
        self.changed();
    }

    fn deal(&mut self, now: Instant) {
        let Some(live) = self.hand.as_mut() else {
            return;
        };
        let mut seats = Vec::with_capacity(live.dealt.len());
        for &i in &live.dealt {
            let Some(s) = self.seats[i].as_ref() else {
                continue;
            };
            let client_seed = live
                .seeds
                .entry(i)
                .or_insert_with(|| default_seed(&s.session_seed, live.number))
                .clone();
            seats.push(SeatStart {
                seat: seat_u8(i),
                player: s.player.clone(),
                stack: s.in_play(),
                client_seed,
                rake_bp: s.rake_bp,
            });
        }
        let start = HandStart {
            table: self.id.clone(),
            hand: live.number,
            config: self.stakes.clone(),
            button: seat_u8(live.button),
            seats,
            hand_seed_hash: live.commitment,
        };
        match Hand::new(start, live.seed) {
            Ok(hand) => {
                live.stage = Stage::Playing(Box::new(hand));
                live.turn_started = now;
                live.deadline = now + self.config.action;
            }
            Err(err) => {
                // Nothing was bet: the hand is dropped and nobody's stack moves.
                eprintln!("poker {}: hand {} not dealt: {err}", self.id, live.number);
                self.hand = None;
                self.next_hand_at = now + self.config.pause;
            }
        }
        self.changed();
    }

    /// Leavers fold at their turn, NPCs act after their think time, the clock acts for the rest;
    /// a finished hand goes to recording.
    fn play_clock(&mut self, now: Instant, effects: &mut Effects) {
        loop {
            let Some(live) = self.hand.as_mut() else {
                return;
            };
            let Stage::Playing(hand) = &mut live.stage else {
                return;
            };
            let (Some(seat), Some(legal)) = (hand.to_act(), hand.legal()) else {
                break;
            };
            let i = usize::from(seat);
            let fallback = if legal.can_check {
                PokerAction::Check
            } else {
                PokerAction::Fold
            };
            let action = match self.seats[i].as_mut() {
                // A dealt seat is never emptied before the hand ends; fold defensively.
                None => PokerAction::Fold,
                Some(s) if s.leaving => PokerAction::Fold,
                Some(s) => match s.npc.as_mut() {
                    Some(npc) => {
                        if now < live.turn_started + self.config.npc_think {
                            return;
                        }
                        let hole = hand.hole(seat);
                        hole.map_or(fallback, |hole| {
                            npc_decide(&hand.view(), hole, &npc.npc, &mut npc.rng)
                        })
                    }
                    None => {
                        if now < live.deadline {
                            return;
                        }
                        s.timeouts += 1;
                        if s.timeouts >= MAX_TIMEOUTS {
                            s.leaving = true;
                        }
                        fallback
                    }
                },
            };
            let street = hand.street();
            if let Err(err) = hand.act(seat, action) {
                // An NPC choice the rules refuse: never stall the table.
                eprintln!("poker {}: seat {seat} {action:?}: {err}", self.id);
                if hand.act(seat, fallback).is_err() {
                    return;
                }
            }
            note_action(live, street, i, action);
            live.turn_started = now;
            live.deadline = now + self.config.action;
            self.version += 1;
        }
        self.finish_if_done(effects);
    }

    /// A finished hand moves to recording with the round of each player who put chips in.
    fn finish_if_done(&mut self, effects: &mut Effects) {
        let Some(live) = self.hand.as_mut() else {
            return;
        };
        let Stage::Playing(hand) = &live.stage else {
            return;
        };
        let Some(result) = hand.result() else {
            return;
        };
        let mut rounds: Vec<(String, CompactRound)> = Vec::new();
        for line in result.seats.iter().filter(|line| line.put_in > 0) {
            let (Some(s), Some(round)) = (
                self.seats[usize::from(line.seat)].as_ref(),
                hand.round_for(line.seat, 0),
            ) else {
                continue;
            };
            rounds.push((s.session_id.clone(), round));
        }
        // Losers first (see `Store::append_rounds`).
        rounds.sort_by_key(|(_, round)| round.payout >= round.stake);
        effects.record = Some(rounds);
        let Stage::Playing(hand) = std::mem::replace(&mut live.stage, Stage::Seeding) else {
            return;
        };
        live.stage = Stage::Recording(hand);
        self.changed();
    }

    /// After the write: stacks move to the recorded balances (or, if refused, the hand is void
    /// and nobody's stack moves), the history is published, the pause starts.
    fn end_hand(&mut self, recorded: Result<Vec<(String, u64)>, ApiError>, now: Instant) {
        let Some(live) = self.hand.take() else {
            return;
        };
        self.next_hand_at = now + self.config.pause;
        self.changed();
        let Stage::Recording(hand) = live.stage else {
            return;
        };
        let (Some(result), Some(history)) = (hand.result().cloned(), hand.history()) else {
            return;
        };
        let nonces: HashMap<String, u64> = match recorded {
            Ok(nonces) => nonces.into_iter().collect(),
            Err(err) => {
                eprintln!(
                    "poker {}: hand {} void, not recorded: {}",
                    self.id, live.number, err.message
                );
                return;
            }
        };
        let mut players = Vec::new();
        for line in &result.seats {
            let i = usize::from(line.seat);
            // Every seat of the result was dealt, so has hole cards.
            let (Some(s), Some(hole)) = (self.seats[i].as_mut(), hand.hole(line.seat)) else {
                continue;
            };
            s.stack = s.stack - line.put_in + line.won;
            if s.stack < self.stakes.big_blind {
                s.leaving = true;
            }
            players.push(PlayerResult {
                seat: i,
                player: s.player.clone(),
                name: s.name.clone(),
                npc: s.npc.is_some(),
                session_id: s.session_id.clone(),
                hole,
                stake: line.put_in,
                payout: line.won,
                nonce: nonces.get(&s.session_id).copied(),
            });
        }
        let seeds: Vec<&str> = history
            .start
            .seats
            .iter()
            .map(|s| s.client_seed.as_str())
            .collect();
        self.last_hand = Some(Arc::new(HandRecord {
            number: live.number,
            commitment: live.commitment,
            hand_seed: live.seed,
            history_hash: history.hash(),
            deck: deck_for(&live.seed, &seeds).to_vec(),
            history,
            players,
            result,
            ended_at: unix_ms(),
        }));
    }

    /// When the clock needs the driver next.
    fn next_wake(&self, now: Instant) -> Instant {
        let at = match &self.hand {
            None => self.next_hand_at,
            Some(live) => match &live.stage {
                Stage::Recording(_) => now + DRIVER_IDLE,
                Stage::Seeding => live.deadline,
                Stage::Playing(hand) => {
                    let quick = hand
                        .to_act()
                        .and_then(|seat| self.seats[usize::from(seat)].as_ref())
                        .is_none_or(|s| s.npc.is_some() || s.leaving);
                    if quick {
                        live.turn_started + self.config.npc_think
                    } else {
                        live.deadline
                    }
                }
            },
        };
        at.clamp(now, now + DRIVER_IDLE)
    }

    fn view(&self, viewer: Option<usize>, queued: Option<&Seat>) -> TableState {
        let live = self.hand.as_ref();
        let hand = live.and_then(Live::hand);
        let core_view = hand.map(Hand::view);
        let shown = |i: usize| {
            hand?
                .result()?
                .seats
                .iter()
                .find(|line| usize::from(line.seat) == i)?
                .shown
        };
        let seats = (0..SEATS)
            .map(|i| {
                let s = self.seats[i].as_ref()?;
                let state = core_view
                    .as_ref()
                    .and_then(|v| v.seats.iter().find(|st| usize::from(st.seat) == i));
                // In a hand the chips behind (over the in-play cap) are not in the engine.
                let stack = match state {
                    Some(st) => s.stack - s.in_play() + st.stack,
                    None => s.stack,
                };
                Some(SeatView {
                    seat: i,
                    player: s.player.clone(),
                    name: s.name.clone(),
                    npc: s.npc.is_some(),
                    stack,
                    bet: state.map_or(0, |st| st.street_in),
                    total_in: state.map_or(0, |st| st.total_in),
                    folded: state.is_some_and(|st| st.folded),
                    all_in: state.is_some_and(|st| st.all_in),
                    in_hand: self.in_hand(i),
                    waiting: s.waiting,
                    leaving: s.leaving,
                    last_action: live.and_then(|l| l.last.get(&i).copied()),
                    cards: shown(i),
                })
            })
            .collect();
        let you = match (viewer, queued) {
            (Some(i), _) => self.seats[i].as_ref().map(|s| YouView {
                seat: Some(i),
                session_id: s.session_id.clone(),
                hole: hand.and_then(|h| h.hole(seat_u8(i))),
                legal: match live.map(|l| &l.stage) {
                    Some(Stage::Playing(h)) if h.to_act() == Some(seat_u8(i)) => h.legal(),
                    _ => None,
                },
                state: None,
                last_round: None,
            }),
            (None, Some(q)) => Some(YouView {
                seat: None,
                session_id: q.session_id.clone(),
                hole: None,
                legal: None,
                state: None,
                last_round: None,
            }),
            (None, None) => None,
        };
        TableState {
            table_id: self.id.clone(),
            name: self.name.clone(),
            version: self.version,
            seats,
            queued: self.queue.len(),
            config: ConfigView {
                small_blind: self.stakes.small_blind,
                big_blind: self.stakes.big_blind,
                rake_cap: self.stakes.rake_cap,
                min_buy_in: self.stakes.min_buy_in(),
                max_buy_in: self.max_buy_in,
                rake_bp: self.rake_bp,
                action_ms: duration_ms(self.config.action),
                seed_ms: duration_ms(self.config.seeding),
            },
            hand: live.map(|l| hand_view(l, core_view.as_ref())),
            last_hand: self.last_hand.clone(),
            you,
        }
    }

    fn summary(&self) -> TableSummary {
        TableSummary {
            table_id: self.id.clone(),
            name: self.name.clone(),
            seats: SEATS,
            humans: self.humans(),
            npcs: self.npcs(),
            small_blind: self.stakes.small_blind,
            big_blind: self.stakes.big_blind,
            min_buy_in: self.stakes.min_buy_in(),
            max_buy_in: self.max_buy_in,
            rake_bp: self.rake_bp,
            hand_number: self.hand_number,
        }
    }
}

fn note_action(live: &mut Live, street_before: Street, seat: usize, action: PokerAction) {
    let street_now = live.hand().map_or(street_before, Hand::street);
    if street_now == street_before {
        live.last.insert(seat, action);
    } else {
        live.last.clear();
    }
}

fn hand_view(live: &Live, view: Option<&core_rules::poker::HandView>) -> HandView {
    let phase = match view.map(|v| v.street) {
        None => HandPhase::Seeding,
        Some(Street::Preflop) => HandPhase::Preflop,
        Some(Street::Flop) => HandPhase::Flop,
        Some(Street::Turn) => HandPhase::Turn,
        Some(Street::River) => HandPhase::River,
        Some(Street::Showdown) => HandPhase::Showdown,
    };
    let to_act = match &live.stage {
        Stage::Playing(_) => view.and_then(|v| v.to_act).map(usize::from),
        _ => None,
    };
    let deadline = match &live.stage {
        Stage::Seeding => Some(unix_ms_at(live.deadline)),
        Stage::Playing(_) if to_act.is_some() => Some(unix_ms_at(live.deadline)),
        _ => None,
    };
    HandView {
        number: live.number,
        phase,
        commitment: live.commitment,
        seats: live.dealt.clone(),
        seeds_in: live.seeds.keys().copied().collect(),
        button: live.button,
        small_blind_seat: view.map(|v| usize::from(v.small_blind_seat)),
        big_blind_seat: view.map(|v| usize::from(v.big_blind_seat)),
        board: view.map(|v| v.board.clone()).unwrap_or_default(),
        pots: view.map(|v| v.pots.clone()).unwrap_or_default(),
        current_bet: view.map_or(0, |v| v.current_bet),
        to_act,
        deadline,
    }
}

/// A human's client seed for a hand it sent none for: public, so it adds no secrecy, but the
/// deck stays a function of every seat's seed.
fn default_seed(session_seed: &str, hand: u64) -> String {
    let seed = format!("{session_seed}-{hand}");
    if client_seed_is_valid(&seed) {
        seed
    } else {
        // Session seeds are up to 64 characters: hash a long one down.
        hex::encode(&sha256(seed.as_bytes())[..16])
    }
}

fn close_of(seat: &Seat) -> Close {
    let net = signed_diff(seat.stack, seat.buy_in);
    (
        seat.session_id.clone(),
        seat.npc.as_ref().map(|n| n.npc.clone()),
        net,
    )
}

fn signed_diff(a: u128, b: u128) -> i128 {
    if a >= b {
        i128::try_from(a - b).unwrap_or(i128::MAX)
    } else {
        i128::try_from(b - a).map_or(i128::MIN, |d| -d)
    }
}

/// Core's NPC strategy (core/src/poker_npc.rs).
fn npc_decide(
    view: &core_rules::poker::HandView,
    hole: [Card; 2],
    npc: &PokerNpc,
    rng: &mut Rng,
) -> PokerAction {
    core_rules::poker_npc::decide(view, hole, Style::of(npc.persona), rng)
}

/// Core's anti-bumhunting seat rule (core/src/poker_npc.rs).
fn npc_seats_change(humans: usize, npcs: usize, free_seats: usize) -> isize {
    core_rules::poker_npc::npc_seats_change(humans, npcs, free_seats)
}

// ---------------------------------------------------------------------------------------------
// Manager

struct Cell {
    table: AsyncMutex<Table>,
    version: watch::Sender<u64>,
    wake: Notify,
}

impl Cell {
    fn publish(&self, table: &Table) {
        self.version.send_if_modified(|v| {
            let changed = *v != table.version;
            *v = table.version;
            changed
        });
    }
}

/// (id, name, floor seat, max bet) of the poker dealers on the floor.
type Dealers = Vec<(String, String, Option<usize>, u128)>;

pub struct Poker<C> {
    app: Arc<App<C>>,
    gamblers: Arc<Gamblers<C>>,
    config: PokerConfig,
    tables: Mutex<HashMap<String, Arc<Cell>>>,
    floor_cache: AsyncMutex<Option<(Instant, Dealers)>>,
}

fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "no such poker table")
}

fn conflict(message: &str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, message)
}

fn unauthorized() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not seated at this table")
}

fn chain_down(err: anyhow::Error) -> ApiError {
    eprintln!("poker chain read: {err:#}");
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "chain unavailable, retry later",
    )
}

impl<C: Chain> Poker<C> {
    pub fn new(app: Arc<App<C>>, gamblers: Arc<Gamblers<C>>, config: PokerConfig) -> Self {
        Self {
            app,
            gamblers,
            config,
            tables: Mutex::new(HashMap::new()),
            floor_cache: AsyncMutex::new(None),
        }
    }

    /// The poker dealers seated on the floor: (id, name, floor seat).
    async fn poker_dealers(&self) -> Result<Dealers, ApiError> {
        let mut cache = self.floor_cache.lock().await;
        if let Some((at, dealers)) = cache.as_ref() {
            if at.elapsed() < FLOOR_CACHE {
                return Ok(dealers.clone());
            }
        }
        let floor = self.app.chain().floor().await.map_err(chain_down)?;
        let dealers: Dealers = floor
            .tables
            .into_iter()
            .filter(|t| t.game == Game::Poker && t.seat.is_some())
            .map(|t| (t.dealer_id, t.name, t.seat, t.max_bet))
            .collect();
        *cache = Some((Instant::now(), dealers.clone()));
        Ok(dealers)
    }

    fn tables_lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Cell>>> {
        self.tables
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The table of a poker dealer, created (with its driver) on first use.
    async fn cell(self: &Arc<Self>, id: &str) -> Result<Arc<Cell>, ApiError> {
        if let Some(cell) = self.tables_lock().get(id) {
            return Ok(Arc::clone(cell));
        }
        let (_, name, floor_seat, _) = self
            .poker_dealers()
            .await?
            .into_iter()
            .find(|(dealer_id, ..)| dealer_id == id)
            .ok_or_else(not_found)?;
        let dealer = self
            .app
            .chain()
            .dealer(id)
            .await
            .map_err(chain_down)?
            .ok_or_else(not_found)?;
        let seed = random_bytes::<32>().map_err(|_| conflict("no randomness, retry"))?;
        let table = Table {
            id: id.to_string(),
            name,
            floor_seat,
            stakes: table_config(),
            max_buy_in: max_buy_in(dealer.max_bet),
            rake_bp: dealer.rake_bp,
            config: self.config,
            seats: vec![None; SEATS],
            queue: VecDeque::new(),
            hand: None,
            last_hand: None,
            hand_number: 0,
            button: None,
            next_hand_at: Instant::now(),
            npc_joining: 0,
            npc_retry_at: Instant::now(),
            version: 1,
            rng: Rng::new(seed),
        };
        let (version, _) = watch::channel(table.version);
        let cell = Arc::new(Cell {
            table: AsyncMutex::new(table),
            version,
            wake: Notify::new(),
        });
        {
            let mut tables = self.tables_lock();
            if let Some(existing) = tables.get(id) {
                return Ok(Arc::clone(existing));
            }
            tables.insert(id.to_string(), Arc::clone(&cell));
        }
        let poker = Arc::clone(self);
        let driven = Arc::clone(&cell);
        tokio::spawn(async move { poker.drive(driven).await });
        Ok(cell)
    }

    /// `GET /poker/tables`.
    pub async fn list(self: &Arc<Self>) -> Result<Vec<TableSummary>, ApiError> {
        let mut out = Vec::new();
        for (id, _, _, max_bet) in self.poker_dealers().await? {
            let cell = self.cell(&id).await?;
            let mut table = cell.table.lock().await;
            table.max_buy_in = max_buy_in(max_bet);
            out.push(table.summary());
        }
        Ok(out)
    }

    /// `GET /poker/tables/{id}?since=`: holds while nothing changed (see `PokerConfig`).
    pub async fn state(
        self: &Arc<Self>,
        id: &str,
        token: Option<&str>,
        since: Option<u64>,
    ) -> Result<TableState, ApiError> {
        let cell = self.cell(id).await?;
        if let Some(since) = since {
            let mut rx = cell.version.subscribe();
            if *rx.borrow_and_update() == since {
                let _ = tokio::time::timeout(self.config.poll_hold, rx.changed()).await;
            }
        }
        let table = cell.table.lock().await;
        let seat = token.and_then(|t| table.seat_of_token(t));
        let queued = match (seat, token) {
            (None, Some(t)) => {
                let hash = sha256(t.as_bytes());
                table.queue.iter().find(|s| s.token_hash == Some(hash))
            }
            _ => None,
        };
        let mut view = table.view(seat, queued);
        drop(table);
        if let Some(you) = view.you.as_mut() {
            let (state, last_round) = self.app.poker_signed(&you.session_id).await?;
            you.state = Some(state);
            you.last_round = last_round;
        }
        Ok(view)
    }

    /// `POST /poker/tables/{id}/join`.
    pub async fn join(
        self: &Arc<Self>,
        id: &str,
        token: &str,
        request: JoinRequest,
    ) -> Result<JoinReply, ApiError> {
        if request.seat.is_some_and(|s| s >= SEATS) {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, "no such seat"));
        }
        let cell = self.cell(id).await?;
        let info = self.app.poker_seat(&request.session_id, token, id).await?;
        let result = {
            let mut table = cell.table.lock().await;
            let result = seat_human(&mut table, &info, token, request.seat);
            cell.publish(&table);
            result
        };
        if result.is_err() {
            self.app.poker_release(&request.session_id).await?;
        }
        cell.wake.notify_one();
        result
    }

    /// `POST /poker/tables/{id}/seed`.
    pub async fn seed(
        self: &Arc<Self>,
        id: &str,
        token: &str,
        request: SeedRequest,
    ) -> Result<(), ApiError> {
        if !client_seed_is_valid(&request.client_seed) {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "client_seed must be 1-64 printable characters without ':'",
            ));
        }
        let cell = self.cell(id).await?;
        let mut table = cell.table.lock().await;
        let seat = table.seat_of_token(token).ok_or_else(unauthorized)?;
        let live = table
            .hand
            .as_mut()
            .filter(|l| l.number == request.hand)
            .ok_or_else(|| conflict("no such hand in progress"))?;
        if !matches!(live.stage, Stage::Seeding) {
            return Err(conflict("seeding is over for this hand"));
        }
        if !live.dealt.contains(&seat) {
            return Err(conflict("you are not in this hand"));
        }
        if live.seeds.contains_key(&seat) {
            return Err(conflict("seed already sent for this hand"));
        }
        live.seeds.insert(seat, request.client_seed);
        table.changed();
        cell.publish(&table);
        drop(table);
        cell.wake.notify_one();
        Ok(())
    }

    /// `POST /poker/tables/{id}/action`.
    pub async fn act(
        self: &Arc<Self>,
        id: &str,
        token: &str,
        request: ActionRequest,
    ) -> Result<TableState, ApiError> {
        let cell = self.cell(id).await?;
        let mut table = cell.table.lock().await;
        let seat = table.seat_of_token(token).ok_or_else(unauthorized)?;
        let action_time = self.config.action;
        let live = table
            .hand
            .as_mut()
            .filter(|l| l.number == request.hand)
            .ok_or_else(|| conflict("no such hand in progress"))?;
        let Stage::Playing(hand) = &mut live.stage else {
            return Err(conflict("no betting now"));
        };
        if hand.to_act() != Some(seat_u8(seat)) {
            return Err(conflict("not your turn"));
        }
        let street = hand.street();
        hand.act(seat_u8(seat), request.action)
            .map_err(|err| ApiError::new(StatusCode::BAD_REQUEST, err.to_string()))?;
        note_action(live, street, seat, request.action);
        let now = Instant::now();
        live.turn_started = now;
        live.deadline = now + action_time;
        if let Some(s) = table.seats[seat].as_mut() {
            s.timeouts = 0;
        }
        table.changed();
        let view = table.view(Some(seat), None);
        cell.publish(&table);
        drop(table);
        cell.wake.notify_one();
        Ok(view)
    }

    /// `POST /poker/tables/{id}/leave`.
    pub async fn leave(self: &Arc<Self>, id: &str, token: &str) -> Result<LeaveReply, ApiError> {
        let cell = self.cell(id).await?;
        let mut table = cell.table.lock().await;
        let hash = sha256(token.as_bytes());
        let removed = if let Some(pos) = table.queue.iter().position(|s| s.token_hash == Some(hash))
        {
            table.queue.remove(pos)
        } else {
            let seat = table.seat_of_token(token).ok_or_else(unauthorized)?;
            if table.in_hand(seat) {
                if let Some(s) = table.seats[seat].as_mut() {
                    s.leaving = true;
                }
                table.changed();
                cell.publish(&table);
                drop(table);
                cell.wake.notify_one();
                return Ok(LeaveReply { left: false });
            }
            table.seats[seat].take()
        };
        table.changed();
        cell.publish(&table);
        drop(table);
        if let Some(s) = removed {
            self.close_seat(close_of(&s)).await;
        }
        cell.wake.notify_one();
        Ok(LeaveReply { left: true })
    }

    async fn close_seat(&self, (session_id, npc, net): Close) {
        if let Err(err) = self.app.poker_unseat_and_close(&session_id).await {
            eprintln!("poker close {session_id}: {}", err.message);
        }
        if let Some(npc) = npc {
            self.gamblers.poker_net(npc.index, net);
            self.gamblers.release_from_poker(npc.index).await;
        }
    }

    /// The table's clock: steps, then runs the effects outside the lock.
    async fn drive(self: Arc<Self>, cell: Arc<Cell>) {
        loop {
            let mut effects = Effects::default();
            let (id, wake_at) = {
                let mut table = cell.table.lock().await;
                let now = Instant::now();
                table.step(now, &mut effects);
                cell.publish(&table);
                (table.id.clone(), table.next_wake(now))
            };
            if let Some(rounds) = effects.record.take() {
                let recorded = self.app.record_poker_hand(&id, rounds).await;
                let mut table = cell.table.lock().await;
                table.end_hand(recorded, Instant::now());
                for s in table.seats.iter().flatten() {
                    if let Some(npc) = &s.npc {
                        self.gamblers
                            .poker_net(npc.npc.index, signed_diff(s.stack, s.buy_in));
                    }
                }
                cell.publish(&table);
                continue;
            }
            for close in effects.close {
                self.close_seat(close).await;
            }
            for _ in 0..effects.npc_joins {
                let poker = Arc::clone(&self);
                let cell = Arc::clone(&cell);
                tokio::spawn(async move { poker.npc_join(cell).await });
            }
            tokio::select! {
                () = tokio::time::sleep_until(wake_at) => {}
                () = cell.wake.notified() => {}
            }
        }
    }

    /// Calls a gambler in: its own session (buy-in from its own balance), opened with its key.
    async fn npc_join(self: Arc<Self>, cell: Arc<Cell>) {
        let (id, floor_seat, pick) = {
            let mut table = cell.table.lock().await;
            let pick = table.rng.below(u32::MAX);
            (table.id.clone(), table.floor_seat, pick)
        };
        let seated = match self.gamblers.claim_for_poker(&id, floor_seat, pick) {
            Some(npc) => self.npc_session(&cell, &id, npc).await,
            None => false,
        };
        let mut table = cell.table.lock().await;
        table.npc_joining = table.npc_joining.saturating_sub(1);
        if !seated {
            table.npc_retry_at = Instant::now() + NPC_RETRY;
        }
        table.changed();
        cell.publish(&table);
        drop(table);
        cell.wake.notify_one();
    }

    /// Seats a claimed NPC; false (and the NPC given back) when it cannot sit.
    async fn npc_session(&self, cell: &Cell, id: &str, npc: PokerNpc) -> bool {
        let stakes = table_config();
        let balance = self.gamblers.npc_balance(npc.index).await.unwrap_or(0);
        // The contract takes a poker buy-in only up to the ticket's max bet.
        let max_bet = match self.app.chain().dealer(id).await {
            Ok(Some(dealer)) => crate::app::ticket_max_bet(dealer.max_bet),
            Ok(None) => 0,
            Err(err) => {
                eprintln!("poker npc {}: dealer read: {err:#}", npc.id);
                0
            }
        };
        let buy_in = stakes.max_buy_in().min(balance).min(max_bet);
        if buy_in < stakes.min_buy_in() {
            self.gamblers.release_from_poker(npc.index).await;
            return false;
        }
        let session = match self.open_npc_session(id, &npc, buy_in).await {
            Ok(session) => session,
            Err(err) => {
                eprintln!("poker npc {}: {err:#}", npc.id);
                self.gamblers.release_from_poker(npc.index).await;
                return false;
            }
        };
        // The floor shows its wallet without the buy-in now in escrow.
        self.gamblers.npc_balance(npc.index).await;
        let info = match self.app.poker_seat_npc(&session, id).await {
            Ok(info) => info,
            Err(err) => {
                eprintln!("poker npc {} seat: {}", npc.id, err.message);
                self.close_seat((session, Some(npc), 0)).await;
                return false;
            }
        };
        let rng_seed = random_bytes::<32>().unwrap_or_else(|_| sha256(session.as_bytes()));
        let mut table = cell.table.lock().await;
        // Still wanted? Humans may have come or gone meanwhile (the joining count includes us).
        let wanted = npc_seats_change(
            table.humans(),
            (table.npcs() + table.npc_joining).saturating_sub(1),
            table.free_seats(),
        ) > 0;
        let free = table.free_seat(None);
        let (Some(seat), true) = (free, wanted) else {
            drop(table);
            self.close_seat((session, Some(npc), 0)).await;
            // Not wanted any more is no failure: no retry delay.
            return true;
        };
        let mut s = Seat::from_session(&info, None, npc.name.clone());
        s.npc = Some(NpcSeat {
            npc,
            rng: Rng::new(rng_seed),
        });
        table.seats[seat] = Some(s);
        if table.hand.is_none() {
            table.next_hand_at = table.next_hand_at.max(Instant::now() + self.config.pause);
        }
        table.changed();
        true
    }

    async fn open_npc_session(
        &self,
        id: &str,
        npc: &PokerNpc,
        buy_in: u128,
    ) -> anyhow::Result<String> {
        let reply = self
            .app
            .create(CreateRequest {
                player: npc.account.clone(),
                dealer_id: id.to_string(),
                lock: buy_in,
                client_seed: format!("{}-{}", npc.id, hex::encode(random_bytes::<8>()?)),
            })
            .await
            .map_err(|err| anyhow::anyhow!("{}: {}", err.status, err.message))?;
        self.app
            .chain()
            .open_session(
                &npc.account,
                npc.key.as_deref(),
                &reply.ticket,
                &reply.ticket_signature,
            )
            .await?;
        Ok(reply.session_id)
    }
}

/// Seats a human (or queues it for an NPC's seat); the session is already marked seated.
fn seat_human(
    table: &mut Table,
    info: &PokerSeat,
    token: &str,
    wanted: Option<usize>,
) -> Result<JoinReply, ApiError> {
    let same_player = table
        .seats
        .iter()
        .flatten()
        .chain(table.queue.iter())
        .any(|s| s.player == info.player);
    if same_player {
        return Err(conflict("this account already sits at this table"));
    }
    if info.balance < table.stakes.big_blind {
        return Err(conflict("session balance below the big blind"));
    }
    let seat = Seat::from_session(info, Some(token), info.player.clone());
    if let Some(free) = table.free_seat(wanted).or_else(|| table.free_seat(None)) {
        table.seats[free] = Some(seat);
        if table.hand.is_none() {
            table.next_hand_at = table.next_hand_at.max(Instant::now() + table.config.pause);
        }
        table.changed();
        return Ok(JoinReply {
            seat: Some(free),
            waiting: true,
        });
    }
    if !table.seats.iter().flatten().any(|s| s.npc.is_some()) {
        return Err(conflict("table full"));
    }
    table.queue.push_back(seat);
    table.changed();
    Ok(JoinReply {
        seat: None,
        waiting: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Faye on testnet (max bet 9.324): the contract takes buy-ins up to the ticket's max bet
    /// only, so the table must not advertise 20.
    #[test]
    fn max_buy_in_is_capped_at_the_ticket_max_bet() {
        assert_eq!(max_buy_in(9_324_000), 7_459_200);
        assert_eq!(max_buy_in(100_000_000), table_config().max_buy_in());
    }
}
