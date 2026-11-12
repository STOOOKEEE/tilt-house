//! # No-limit hold'em (docs/poker-rules.md)
//!
//! Pure rules, shared by the session server (deals and runs the hands), the verifiers (replay a
//! finished hand from its public history) and the NPC players (`poker_npc`).
//!
//! - **Deck.** `deck_for(hand_seed, client_seeds)`: a Fisher–Yates shuffle driven by
//!   `Rng::new(HMAC-SHA256(hand_seed, "tilt-house/poker-deck/v1" || ":" || seed_1 || ":" || …))`,
//!   client seeds in seat order. Client seeds never contain `:`, so the message is unambiguous.
//! - **Deal.** One card at a time from the seat left of the button, twice round; then burn, flop
//!   (3), burn, turn, burn, river. With `n` players: hole cards at `deck[p]` and `deck[p + n]` for
//!   deal position `p`, board at `deck[2n+1..2n+4]`, `deck[2n+5]`, `deck[2n+7]`.
//! - **Betting.** Blinds (heads-up: the button posts the small blind and acts first preflop, last
//!   after), min bet one big blind, min raise the last full raise, all-ins for less allowed; an
//!   all-in short of a full raise does not reopen the betting to players who already acted.
//! - **Settling.** `settle_hand`: uncalled chips go back, side pots by contribution level, ties
//!   split with odd chips to the first winner left of the button, rake `rake_bp` of the pot capped
//!   at `rake_cap`, only once a flop was dealt ("no flop, no drop"). Per seat `(put_in, won)` with
//!   `Σ won + rake == Σ put_in`.
//! - **History.** `HandHistory` (start, revealed seed, actions) replays the whole hand with
//!   `replay_hand`; each player's session round commits to it by hash (`Outcome::Poker`).
//!
//! Amounts are integer base units (`u128`), JSON decimal strings. Seats are numbered `0..MAX_SEATS`.

use std::fmt;
use std::str::FromStr;

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};

use crate::session::{
    client_seed_is_valid, hex32, hmac_sha256, sha256, CompactRound, Hash32, Outcome,
};
use crate::{Bet, Rng, BP};

/// Seats at a table, and so most players in one hand.
pub const MAX_SEATS: u8 = 6;
/// A hand needs at least two players.
pub const MIN_PLAYERS: usize = 2;
/// Highest rake a seat may carry, in bp of the pot (`rake_bounds(Game::Poker)`).
pub const MAX_RAKE_BP: u16 = 500;
/// Usual rake cap per hand, in big blinds (`TableConfig::standard`).
pub const RAKE_CAP_BB: u128 = 3;
/// Buy-in range, in big blinds.
pub const MIN_BUY_IN_BB: u128 = 20;
pub const MAX_BUY_IN_BB: u128 = 100;
/// Table names are short, like client seeds.
pub const MAX_TABLE_LEN: usize = 64;
/// Domain of the deck seed, so it can never collide with a session round seed.
pub const DECK_DOMAIN: &str = "tilt-house/poker-deck/v1";

const RANKS: &[u8; 13] = b"23456789TJQKA";
const SUITS: &[u8; 4] = b"cdhs";

// ---------------------------------------------------------------------------------------------
// Cards and deck
// ---------------------------------------------------------------------------------------------

/// A card `0..52`: rank `index / 4` (0 = deuce … 12 = ace), suit `index % 4` (clubs, diamonds,
/// hearts, spades). Borsh: one byte. JSON: `"As"`, `"Td"`, `"7c"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, BorshSerialize)]
pub struct Card(u8);

impl Card {
    pub fn new(index: u8) -> Option<Self> {
        (index < 52).then_some(Self(index))
    }

    pub fn index(self) -> u8 {
        self.0
    }

    /// 0 = deuce … 12 = ace.
    pub fn rank(self) -> u8 {
        self.0 / 4
    }

    /// 0 = clubs, 1 = diamonds, 2 = hearts, 3 = spades.
    pub fn suit(self) -> u8 {
        self.0 % 4
    }
}

impl fmt::Display for Card {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let rank = RANKS[usize::from(self.rank())] as char;
        let suit = SUITS[usize::from(self.suit())] as char;
        write!(f, "{rank}{suit}")
    }
}

impl FromStr for Card {
    type Err = PokerError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let bytes = text.as_bytes();
        if bytes.len() != 2 {
            return Err(PokerError::BadCard);
        }
        let rank = RANKS.iter().position(|&r| r == bytes[0]);
        let suit = SUITS.iter().position(|&s| s == bytes[1]);
        match (rank, suit) {
            (Some(rank), Some(suit)) => Ok(Self((rank * 4 + suit) as u8)),
            _ => Err(PokerError::BadCard),
        }
    }
}

impl BorshDeserialize for Card {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let index = u8::deserialize_reader(reader)?;
        Self::new(index).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "card index out of range")
        })
    }
}

impl Serialize for Card {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Card {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = <String as Deserialize>::deserialize(deserializer)?;
        text.parse().map_err(de::Error::custom)
    }
}

/// Seed of the shuffle: `HMAC-SHA256(hand_seed, DECK_DOMAIN || ":" || seed_1 || ":" || … )`.
pub fn deck_seed<S: AsRef<str>>(hand_seed: &Hash32, client_seeds: &[S]) -> Hash32 {
    let mut message = DECK_DOMAIN.to_string();
    for seed in client_seeds {
        message.push(':');
        message.push_str(seed.as_ref());
    }
    hmac_sha256(hand_seed, message.as_bytes())
}

/// The shuffled deck of a hand: Fisher–Yates from the top (`i` = 51 down to 1 swaps `i` with
/// `below(i + 1)`) over the sorted deck, drawing from `Rng::new(deck_seed(..))`.
pub fn deck_for<S: AsRef<str>>(hand_seed: &Hash32, client_seeds: &[S]) -> [Card; 52] {
    let mut deck: [Card; 52] = std::array::from_fn(|i| Card(i as u8));
    let mut rng = Rng::new(deck_seed(hand_seed, client_seeds));
    for i in (1..52usize).rev() {
        let j = rng.below(i as u32 + 1) as usize;
        deck.swap(i, j);
    }
    deck
}

// ---------------------------------------------------------------------------------------------
// Hand evaluation
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandCategory {
    HighCard,
    Pair,
    TwoPair,
    Trips,
    Straight,
    Flush,
    FullHouse,
    Quads,
    StraightFlush,
}

impl HandCategory {
    const ALL: [Self; 9] = [
        Self::HighCard,
        Self::Pair,
        Self::TwoPair,
        Self::Trips,
        Self::Straight,
        Self::Flush,
        Self::FullHouse,
        Self::Quads,
        Self::StraightFlush,
    ];
}

/// Strength of the best five-card hand: higher wins, equal splits. Packed as
/// `category << 20 | r1 << 16 | r2 << 12 | r3 << 8 | r4 << 4 | r5`, the ranks (0 = deuce … 12 =
/// ace) that break ties within the category, most significant first (a straight or straight flush
/// keeps only its top card; the wheel's top card is the five).
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    BorshSerialize,
    BorshDeserialize,
    Serialize,
    Deserialize,
)]
pub struct HandValue(pub u32);

impl HandValue {
    fn new(category: HandCategory, ranks: &[u8]) -> Self {
        let mut value = (category as u32) << 20;
        for (i, &rank) in ranks.iter().take(5).enumerate() {
            value |= u32::from(rank) << (16 - 4 * i);
        }
        Self(value)
    }

    pub fn category(self) -> HandCategory {
        HandCategory::ALL[((self.0 >> 20) as usize).min(8)]
    }
}

/// Top card of the highest straight in a 13-bit rank mask, the ace also playing low.
fn straight_high(mask: u16) -> Option<u8> {
    // Bit 0 is the ace played low, bits 1..=13 the ranks deuce..ace.
    let extended = (u32::from(mask) << 1) | u32::from((mask >> 12) & 1);
    (4..=13u8)
        .rev()
        .find(|&top| (extended >> (top - 4)) & 0x1F == 0x1F)
        .map(|top| top - 1)
}

/// Ranks present in `mask`, highest first.
fn ranks_desc(mask: u16) -> impl Iterator<Item = u8> {
    (0..13u8).rev().filter(move |r| mask & (1 << r) != 0)
}

/// Best five-card hand among `cards` (seven at showdown; fewer gives the best of what is there).
pub fn evaluate(cards: &[Card]) -> HandValue {
    let mut counts = [0u8; 13];
    let mut suits = [0u16; 4];
    let mut mask = 0u16;
    for card in cards {
        counts[usize::from(card.rank())] += 1;
        suits[usize::from(card.suit())] |= 1 << card.rank();
        mask |= 1 << card.rank();
    }
    let with_count = |n: u8| {
        (0..13u8)
            .rev()
            .filter(move |&r| counts[usize::from(r)] == n)
    };
    let kickers = |skip: &[u8], n: usize| -> Vec<u8> {
        ranks_desc(mask)
            .filter(|r| !skip.contains(r))
            .take(n)
            .collect()
    };
    let flush = suits.iter().copied().find(|s| s.count_ones() >= 5);

    if let Some(high) = flush.and_then(straight_high) {
        return HandValue::new(HandCategory::StraightFlush, &[high]);
    }
    if let Some(quad) = with_count(4).next() {
        let mut ranks = vec![quad];
        ranks.extend(kickers(&[quad], 1));
        return HandValue::new(HandCategory::Quads, &ranks);
    }
    let trips: Vec<u8> = with_count(3).collect();
    let pairs: Vec<u8> = with_count(2).collect();
    if let Some(&three) = trips.first() {
        // The pair of a full house may be a second set of trips.
        let two = trips
            .get(1)
            .copied()
            .into_iter()
            .chain(pairs.first().copied())
            .max();
        if let Some(two) = two {
            return HandValue::new(HandCategory::FullHouse, &[three, two]);
        }
    }
    if let Some(suited) = flush {
        let ranks: Vec<u8> = ranks_desc(suited).take(5).collect();
        return HandValue::new(HandCategory::Flush, &ranks);
    }
    if let Some(high) = straight_high(mask) {
        return HandValue::new(HandCategory::Straight, &[high]);
    }
    if let Some(&three) = trips.first() {
        let mut ranks = vec![three];
        ranks.extend(kickers(&[three], 2));
        return HandValue::new(HandCategory::Trips, &ranks);
    }
    if let [high, low, ..] = pairs[..] {
        let mut ranks = vec![high, low];
        ranks.extend(kickers(&[high, low], 1));
        return HandValue::new(HandCategory::TwoPair, &ranks);
    }
    if let Some(&pair) = pairs.first() {
        let mut ranks = vec![pair];
        ranks.extend(kickers(&[pair], 3));
        return HandValue::new(HandCategory::Pair, &ranks);
    }
    HandValue::new(HandCategory::HighCard, &kickers(&[], 5))
}

// ---------------------------------------------------------------------------------------------
// Table and hand setup
// ---------------------------------------------------------------------------------------------

/// Stakes of a table, fixed for its hands.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct TableConfig {
    #[serde(with = "crate::amount_str")]
    pub small_blind: u128,
    #[serde(with = "crate::amount_str")]
    pub big_blind: u128,
    /// Most rake one hand may take.
    #[serde(with = "crate::amount_str")]
    pub rake_cap: u128,
}

impl TableConfig {
    /// Small blind half the big blind (rounded down), rake cap `RAKE_CAP_BB` big blinds.
    pub fn standard(big_blind: u128) -> Self {
        Self {
            small_blind: big_blind / 2,
            big_blind,
            rake_cap: big_blind.saturating_mul(RAKE_CAP_BB),
        }
    }

    pub fn is_valid(&self) -> bool {
        self.small_blind > 0 && self.small_blind <= self.big_blind
    }

    pub fn min_buy_in(&self) -> u128 {
        self.big_blind.saturating_mul(MIN_BUY_IN_BB)
    }

    pub fn max_buy_in(&self) -> u128 {
        self.big_blind.saturating_mul(MAX_BUY_IN_BB)
    }
}

/// One player dealt into a hand.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct SeatStart {
    pub seat: u8,
    pub player: String,
    /// Chips in front of the player when the hand starts.
    #[serde(with = "crate::amount_str")]
    pub stack: u128,
    /// The player's seed for this hand, mixed into the deck.
    pub client_seed: String,
    /// The rake of the player's session ticket. The hand takes the lowest of the table, so no
    /// player ever pays more than the rake it agreed to.
    pub rake_bp: u16,
}

/// Everything public before the deal.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct HandStart {
    pub table: String,
    pub hand: u64,
    pub config: TableConfig,
    /// Seat number of the button.
    pub button: u8,
    /// Players in increasing seat order (also the order of the client seeds in the deck seed).
    pub seats: Vec<SeatStart>,
    /// `sha256(hand_seed)`, published before the client seeds are taken.
    #[serde(with = "hex32")]
    pub hand_seed_hash: Hash32,
}

impl HandStart {
    /// The hand's rake: the lowest of its players' tickets.
    pub fn rake_bp(&self) -> u16 {
        self.seats.iter().map(|s| s.rake_bp).min().unwrap_or(0)
    }

    fn validate(&self) -> Result<(), PokerError> {
        let bad = |why| Err(PokerError::InvalidStart(why));
        if self.table.is_empty() || self.table.len() > MAX_TABLE_LEN {
            return bad("table name");
        }
        if !self.config.is_valid() {
            return bad("blinds");
        }
        if !(MIN_PLAYERS..=usize::from(MAX_SEATS)).contains(&self.seats.len()) {
            return bad("player count");
        }
        if !self.seats.windows(2).all(|w| w[0].seat < w[1].seat) {
            return bad("seats must be distinct and in increasing order");
        }
        for seat in &self.seats {
            if seat.seat >= MAX_SEATS {
                return bad("seat number");
            }
            if seat.stack == 0 {
                return bad("empty stack");
            }
            if !client_seed_is_valid(&seat.client_seed) {
                return bad("client seed");
            }
            if seat.rake_bp > MAX_RAKE_BP {
                return bad("rake");
            }
        }
        if !self.seats.iter().any(|s| s.seat == self.button) {
            return bad("button must be on a player");
        }
        Ok(())
    }
}

/// The button of the next hand: the next seated seat after `previous`, clockwise (increasing
/// seat numbers, wrapping). `seated` need not be sorted. `None` when nobody is seated.
pub fn next_button(seated: &[u8], previous: u8) -> Option<u8> {
    let after = seated.iter().copied().filter(|&s| s > previous).min();
    after.or_else(|| seated.iter().copied().min())
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

/// A player's move. `RaiseTo` is a bet when nobody has bet this street; its amount is the total
/// the player will have in front this street. JSON: `"fold"`, `{"raise_to": "400000"}`.
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
pub enum PokerAction {
    Fold,
    Check,
    Call,
    RaiseTo(#[serde(with = "crate::amount_str")] u128),
    /// Every chip: a raise to the whole stack when a raise is allowed, else a call for the stack.
    AllIn,
}

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
pub struct ActionRecord {
    pub seat: u8,
    pub action: PokerAction,
}

/// What the player to act may do. Folding is always allowed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Legal {
    pub seat: u8,
    pub can_check: bool,
    /// Chips a call adds (capped at the stack); 0 when checking is possible.
    #[serde(with = "crate::amount_str")]
    pub call: u128,
    /// Bet/raise range as `RaiseTo` totals, when the player may bet or raise.
    pub raise: Option<RaiseRange>,
    /// Chips behind.
    #[serde(with = "crate::amount_str")]
    pub stack: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RaiseRange {
    #[serde(with = "crate::amount_str")]
    pub min_to: u128,
    /// Everything: the player's chips this street plus its stack.
    #[serde(with = "crate::amount_str")]
    pub max_to: u128,
}

impl Legal {
    pub fn allows(&self, action: PokerAction) -> bool {
        match action {
            PokerAction::Fold => true,
            PokerAction::Check => self.can_check,
            PokerAction::Call => !self.can_check,
            PokerAction::RaiseTo(to) => self
                .raise
                .is_some_and(|r| (r.min_to..=r.max_to).contains(&to)),
            PokerAction::AllIn => self.all_in_action().is_some(),
        }
    }

    /// What `AllIn` stands for here, if it is legal.
    fn all_in_action(&self) -> Option<PokerAction> {
        match self.raise {
            Some(range) => Some(PokerAction::RaiseTo(range.max_to)),
            // Without a raise, all in is only a call that takes the whole stack.
            None => (self.call > 0 && self.call == self.stack).then_some(PokerAction::Call),
        }
    }
}

#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    BorshSerialize,
    BorshDeserialize,
    Serialize,
    Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Street {
    Preflop,
    Flop,
    Turn,
    River,
    Showdown,
}

impl Street {
    fn next(self) -> Self {
        match self {
            Self::Preflop => Self::Flop,
            Self::Flop => Self::Turn,
            Self::Turn => Self::River,
            Self::River | Self::Showdown => Self::Showdown,
        }
    }

    /// Board cards dealt by this street.
    pub fn board_len(self) -> usize {
        match self {
            Self::Preflop => 0,
            Self::Flop => 3,
            Self::Turn => 4,
            Self::River | Self::Showdown => 5,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PokerError {
    InvalidStart(&'static str),
    /// `sha256(hand_seed)` is not the published commitment.
    WrongSeed,
    BadCard,
    HandOver,
    NotYourTurn,
    IllegalAction,
    /// No player left in the hand to win a pot.
    NoPlayers,
    /// Several players share a pot but some of them have no hand to compare.
    MissingHand,
    /// A history whose actions stop before the hand ends.
    Unfinished,
    /// A session round does not match the hand it claims.
    RoundMismatch,
}

impl fmt::Display for PokerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidStart(why) => write!(f, "invalid hand start: {why}"),
            Self::WrongSeed => f.write_str("hand seed does not match its commitment"),
            Self::BadCard => f.write_str("not a card"),
            Self::HandOver => f.write_str("the hand is over"),
            Self::NotYourTurn => f.write_str("not this seat's turn"),
            Self::IllegalAction => f.write_str("illegal action"),
            Self::NoPlayers => f.write_str("no player left in the hand"),
            Self::MissingHand => f.write_str("a pot has players without a hand"),
            Self::Unfinished => f.write_str("the hand is not finished"),
            Self::RoundMismatch => f.write_str("the round does not match the hand"),
        }
    }
}

impl std::error::Error for PokerError {}

// ---------------------------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------------------------

/// One player at the end of a hand, input of `settle_hand`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettleSeat {
    pub seat: u8,
    /// Everything the player committed, uncalled chips included.
    pub committed: u128,
    pub folded: bool,
    /// Showdown strength; needed for every player still in when a pot has several.
    pub value: Option<HandValue>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pot {
    /// After rake.
    #[serde(with = "crate::amount_str")]
    pub amount: u128,
    pub eligible: Vec<u8>,
    pub winners: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeatSettlement {
    pub seat: u8,
    /// Chips that stayed in the pot (uncalled chips returned): the session round's stake.
    #[serde(with = "crate::amount_str")]
    pub put_in: u128,
    /// Chips won after rake: the session round's payout.
    #[serde(with = "crate::amount_str")]
    pub won: u128,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settlement {
    /// Same order as the input.
    pub seats: Vec<SeatSettlement>,
    /// Main pot first, then side pots.
    pub pots: Vec<Pot>,
    #[serde(with = "crate::amount_str")]
    pub rake: u128,
}

/// The rake of a pot: `rake_bp` of it (rounded down), at most `rake_cap`, nothing without a flop.
pub fn rake_for(pot: u128, rake_bp: u16, rake_cap: u128, flop_seen: bool) -> u128 {
    if !flop_seen {
        return 0;
    }
    let cut = pot
        .checked_mul(u128::from(rake_bp))
        .map(|scaled| scaled / BP)
        .unwrap_or(rake_cap);
    cut.min(rake_cap)
}

/// Pots by contribution level: for each distinct amount committed by a player still in, the
/// chips every player put in up to that level, eligible to those still in who reached it.
/// Folded chips above the highest level (only possible when everyone else folded) join the last
/// pot. `seats` as in `settle_hand`; amounts before rake, winners empty.
pub fn build_pots(seats: &[SettleSeat]) -> Vec<Pot> {
    let mut levels: Vec<u128> = seats
        .iter()
        .filter(|s| !s.folded && s.committed > 0)
        .map(|s| s.committed)
        .collect();
    levels.sort_unstable();
    levels.dedup();
    let mut pots = Vec::new();
    let mut below = 0u128;
    for &level in &levels {
        let amount = seats
            .iter()
            .map(|s| s.committed.min(level) - s.committed.min(below))
            .sum();
        let eligible = seats
            .iter()
            .filter(|s| !s.folded && s.committed >= level)
            .map(|s| s.seat)
            .collect();
        pots.push(Pot {
            amount,
            eligible,
            winners: Vec::new(),
        });
        below = level;
    }
    let rest: u128 = seats
        .iter()
        .map(|s| s.committed.saturating_sub(below))
        .sum();
    if rest > 0 {
        match pots.last_mut() {
            Some(last) => last.amount += rest,
            None => pots.push(Pot {
                amount: rest,
                eligible: Vec::new(),
                winners: Vec::new(),
            }),
        }
    }
    pots
}

/// Settles a finished hand. `seats` in deal order (first seat left of the button first), which
/// decides who gets odd chips of a split pot. The highest commitment above everyone else's is
/// uncalled and goes back before the pots are built; the rake comes out of the main pot first.
pub fn settle_hand(
    seats: &[SettleSeat],
    rake_bp: u16,
    rake_cap: u128,
    flop_seen: bool,
) -> Result<Settlement, PokerError> {
    if seats.iter().all(|s| s.folded) {
        return Err(PokerError::NoPlayers);
    }
    let mut seats = seats.to_vec();
    return_uncalled(&mut seats);
    let mut pots = build_pots(&seats);
    let total: u128 = seats.iter().map(|s| s.committed).sum();
    let rake = rake_for(total, rake_bp, rake_cap, flop_seen);
    let mut owed = rake;
    for pot in &mut pots {
        let cut = owed.min(pot.amount);
        pot.amount -= cut;
        owed -= cut;
    }
    let mut won = vec![0u128; seats.len()];
    for pot in &mut pots {
        pot.winners = pot_winners(&seats, &pot.eligible)?;
        let count = pot.winners.len() as u128;
        if count == 0 {
            return Err(PokerError::NoPlayers);
        }
        let share = pot.amount / count;
        let odd = (pot.amount % count) as usize;
        for (i, winner) in pot.winners.iter().enumerate() {
            let at = seats.iter().position(|s| s.seat == *winner).unwrap_or(0);
            won[at] += share + u128::from(i < odd);
        }
    }
    Ok(Settlement {
        seats: seats
            .iter()
            .zip(won)
            .map(|(s, won)| SeatSettlement {
                seat: s.seat,
                put_in: s.committed,
                won,
            })
            .collect(),
        pots,
        rake,
    })
}

/// Lowers the single highest commitment to the second highest.
fn return_uncalled(seats: &mut [SettleSeat]) {
    let Some(top) = (0..seats.len()).max_by_key(|&i| seats[i].committed) else {
        return;
    };
    let second = (0..seats.len())
        .filter(|&i| i != top)
        .map(|i| seats[i].committed)
        .max()
        .unwrap_or(0);
    seats[top].committed = seats[top].committed.min(second);
}

/// Best hands among `eligible`, in deal order. A lone player needs no hand.
fn pot_winners(seats: &[SettleSeat], eligible: &[u8]) -> Result<Vec<u8>, PokerError> {
    let contenders: Vec<&SettleSeat> = seats
        .iter()
        .filter(|s| eligible.contains(&s.seat))
        .collect();
    if contenders.len() <= 1 {
        return Ok(contenders.iter().map(|s| s.seat).collect());
    }
    let values = contenders
        .iter()
        .map(|s| s.value.ok_or(PokerError::MissingHand))
        .collect::<Result<Vec<_>, _>>()?;
    let best = values.iter().copied().max().ok_or(PokerError::NoPlayers)?;
    Ok(contenders
        .iter()
        .zip(values)
        .filter(|(_, v)| *v == best)
        .map(|(s, _)| s.seat)
        .collect())
}

// ---------------------------------------------------------------------------------------------
// The hand state machine
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Default)]
struct SeatState {
    stack: u128,
    street_in: u128,
    total_in: u128,
    folded: bool,
    all_in: bool,
    /// Acted this street (posting a blind is not acting).
    acted: bool,
    /// The bet level when the player last acted: a raise is reopened to it only by at least a
    /// full raise above that level.
    acted_at: u128,
}

impl SeatState {
    fn live(&self) -> bool {
        !self.folded
    }

    fn can_act(&self) -> bool {
        !self.folded && !self.all_in
    }
}

/// One player's line in the hand result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeatResult {
    pub seat: u8,
    pub player: String,
    #[serde(with = "crate::amount_str")]
    pub put_in: u128,
    #[serde(with = "crate::amount_str")]
    pub won: u128,
    #[serde(with = "crate::amount_str")]
    pub stack_after: u128,
    /// Hole cards of the players still in at a showdown.
    pub shown: Option<[Card; 2]>,
    pub value: Option<HandValue>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandResult {
    pub board: Vec<Card>,
    /// Whether the hand went to a showdown (else everyone else folded).
    pub showdown: bool,
    pub pots: Vec<Pot>,
    #[serde(with = "crate::amount_str")]
    pub rake: u128,
    /// Seat order.
    pub seats: Vec<SeatResult>,
}

/// Public state of the hand for one player's screen (no hole cards).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandView {
    pub table: String,
    pub hand: u64,
    pub button: u8,
    pub small_blind_seat: u8,
    pub big_blind_seat: u8,
    #[serde(with = "crate::amount_str")]
    pub big_blind: u128,
    pub street: Street,
    pub board: Vec<Card>,
    /// Live pots from everything committed so far (uncalled chips not yet returned, no rake).
    pub pots: Vec<Pot>,
    #[serde(with = "crate::amount_str")]
    pub current_bet: u128,
    pub to_act: Option<u8>,
    pub legal: Option<Legal>,
    pub seats: Vec<SeatView>,
    pub done: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeatView {
    pub seat: u8,
    pub player: String,
    #[serde(with = "crate::amount_str")]
    pub stack: u128,
    #[serde(with = "crate::amount_str")]
    pub street_in: u128,
    #[serde(with = "crate::amount_str")]
    pub total_in: u128,
    pub folded: bool,
    pub all_in: bool,
}

/// The public record that replays a hand: everything published at its end.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct HandHistory {
    pub start: HandStart,
    #[serde(with = "hex32")]
    pub hand_seed: Hash32,
    /// Every action after the blinds, in order.
    pub actions: Vec<ActionRecord>,
}

impl HandHistory {
    /// `sha256(borsh(history))`, what each player's session round commits to.
    pub fn hash(&self) -> Hash32 {
        // Borsh into a Vec cannot fail for these types.
        sha256(&borsh::to_vec(self).unwrap_or_default())
    }
}

/// A hand in play. Holds the deck, so it stays on the server until the end.
#[derive(Clone, Debug)]
pub struct Hand {
    start: HandStart,
    hand_seed: Hash32,
    deck: [Card; 52],
    seats: Vec<SeatState>,
    button: usize,
    street: Street,
    current_bet: u128,
    /// Size of the last full bet or raise this street (one big blind to start).
    min_raise: u128,
    to_act: Option<usize>,
    flop_seen: bool,
    actions: Vec<ActionRecord>,
    result: Option<HandResult>,
}

impl Hand {
    /// Deals the hand and posts the blinds. Fails on an invalid start or a seed that does not
    /// match the commitment.
    pub fn new(start: HandStart, hand_seed: Hash32) -> Result<Self, PokerError> {
        start.validate()?;
        if sha256(&hand_seed) != start.hand_seed_hash {
            return Err(PokerError::WrongSeed);
        }
        let seeds: Vec<&str> = start.seats.iter().map(|s| s.client_seed.as_str()).collect();
        let deck = deck_for(&hand_seed, &seeds);
        let button = start
            .seats
            .iter()
            .position(|s| s.seat == start.button)
            .ok_or(PokerError::InvalidStart("button must be on a player"))?;
        let seats = start
            .seats
            .iter()
            .map(|s| SeatState {
                stack: s.stack,
                ..SeatState::default()
            })
            .collect();
        let big_blind = start.config.big_blind;
        let small_blind = start.config.small_blind;
        let mut hand = Self {
            start,
            hand_seed,
            deck,
            seats,
            button,
            street: Street::Preflop,
            current_bet: big_blind,
            min_raise: big_blind,
            to_act: None,
            flop_seen: false,
            actions: Vec::new(),
            result: None,
        };
        let (sb, bb) = hand.blind_positions();
        hand.pay(sb, small_blind);
        hand.pay(bb, big_blind);
        // A short big blind still sets the price: the others call the full big blind.
        let first = if hand.seats.len() == 2 {
            sb
        } else {
            hand.next(bb)
        };
        hand.continue_from(first);
        Ok(hand)
    }

    fn n(&self) -> usize {
        self.seats.len()
    }

    fn next(&self, i: usize) -> usize {
        (i + 1) % self.n()
    }

    /// Heads-up the button posts the small blind.
    fn blind_positions(&self) -> (usize, usize) {
        let sb = if self.n() == 2 {
            self.button
        } else {
            self.next(self.button)
        };
        (sb, self.next(sb))
    }

    fn index_of(&self, seat: u8) -> Option<usize> {
        self.start.seats.iter().position(|s| s.seat == seat)
    }

    fn pay(&mut self, i: usize, amount: u128) {
        let state = &mut self.seats[i];
        let paid = amount.min(state.stack);
        state.stack -= paid;
        state.street_in += paid;
        state.total_in += paid;
        if state.stack == 0 {
            state.all_in = true;
        }
    }

    pub fn start(&self) -> &HandStart {
        &self.start
    }

    pub fn street(&self) -> Street {
        self.street
    }

    pub fn is_done(&self) -> bool {
        self.result.is_some()
    }

    pub fn result(&self) -> Option<&HandResult> {
        self.result.as_ref()
    }

    /// Seat whose turn it is.
    pub fn to_act(&self) -> Option<u8> {
        self.to_act.map(|i| self.start.seats[i].seat)
    }

    /// Position of seat index `i` in the deal, from the seat left of the button.
    fn deal_position(&self, i: usize) -> usize {
        (i + self.n() - self.next(self.button)) % self.n()
    }

    fn hole_at(&self, i: usize) -> [Card; 2] {
        let p = self.deal_position(i);
        [self.deck[p], self.deck[p + self.n()]]
    }

    /// A player's hole cards: send them to their owner only.
    pub fn hole(&self, seat: u8) -> Option<[Card; 2]> {
        self.index_of(seat).map(|i| self.hole_at(i))
    }

    fn board_cards(&self, len: usize) -> Vec<Card> {
        let base = 2 * self.n();
        [base + 1, base + 2, base + 3, base + 5, base + 7]
            .iter()
            .take(len)
            .map(|&i| self.deck[i])
            .collect()
    }

    /// Board dealt so far.
    pub fn board(&self) -> Vec<Card> {
        self.board_cards(self.street.board_len())
    }

    /// The moves open to the player to act.
    pub fn legal(&self) -> Option<Legal> {
        let i = self.to_act?;
        let state = &self.seats[i];
        let to_call = self.current_bet.saturating_sub(state.street_in);
        let max_to = state.street_in + state.stack;
        let reopened = !state.acted || self.current_bet - state.acted_at >= self.min_raise;
        // Raising when every opponent is all in would only bet against nobody.
        let someone_to_call = self
            .seats
            .iter()
            .enumerate()
            .any(|(j, s)| j != i && s.can_act());
        let raise =
            (reopened && someone_to_call && max_to > self.current_bet).then(|| RaiseRange {
                min_to: (self.current_bet + self.min_raise).min(max_to),
                max_to,
            });
        Some(Legal {
            seat: self.start.seats[i].seat,
            can_check: to_call == 0,
            call: to_call.min(state.stack),
            raise,
            stack: state.stack,
        })
    }

    /// Plays one action of the seat to act.
    pub fn act(&mut self, seat: u8, action: PokerAction) -> Result<(), PokerError> {
        if self.is_done() {
            return Err(PokerError::HandOver);
        }
        let i = self.to_act.ok_or(PokerError::HandOver)?;
        if self.start.seats[i].seat != seat {
            return Err(PokerError::NotYourTurn);
        }
        let legal = self.legal().ok_or(PokerError::HandOver)?;
        if !legal.allows(action) {
            return Err(PokerError::IllegalAction);
        }
        let effective = match action {
            PokerAction::AllIn => legal.all_in_action().ok_or(PokerError::IllegalAction)?,
            other => other,
        };
        match effective {
            PokerAction::Fold => self.seats[i].folded = true,
            PokerAction::Check => {}
            PokerAction::Call => self.pay(i, legal.call),
            PokerAction::RaiseTo(to) => {
                let raise = to - self.current_bet;
                self.pay(i, to - self.seats[i].street_in);
                if raise >= self.min_raise {
                    self.min_raise = raise;
                }
                self.current_bet = to;
            }
            PokerAction::AllIn => return Err(PokerError::IllegalAction),
        }
        self.seats[i].acted = true;
        self.seats[i].acted_at = self.current_bet;
        self.actions.push(ActionRecord { seat, action });
        if self.seats.iter().filter(|s| s.live()).count() == 1 {
            self.finish(false);
        } else {
            let from = self.next(i);
            self.continue_from(from);
        }
        Ok(())
    }

    /// First seat from `from` (clockwise) that still has to act this street.
    fn find_actor(&self, from: usize) -> Option<usize> {
        let able: Vec<usize> = (0..self.n()).filter(|&i| self.seats[i].can_act()).collect();
        if let [only] = able[..] {
            // Alone with chips behind: act only to answer a bet.
            return (self.seats[only].street_in < self.current_bet).then_some(only);
        }
        (0..self.n()).map(|k| (from + k) % self.n()).find(|&i| {
            let s = &self.seats[i];
            s.can_act() && (!s.acted || s.street_in < self.current_bet)
        })
    }

    /// Hands the turn to the next player, or closes streets until someone has to act (running
    /// the board out when nobody can bet) or the showdown.
    fn continue_from(&mut self, from: usize) {
        if let Some(i) = self.find_actor(from) {
            self.to_act = Some(i);
            return;
        }
        loop {
            for s in &mut self.seats {
                s.street_in = 0;
                s.acted = false;
                s.acted_at = 0;
            }
            self.current_bet = 0;
            self.min_raise = self.start.config.big_blind;
            self.street = self.street.next();
            if self.street == Street::Flop {
                self.flop_seen = true;
            }
            if self.street == Street::Showdown {
                self.finish(true);
                return;
            }
            let first = self.next(self.button);
            if let Some(i) = self.find_actor(first) {
                self.to_act = Some(i);
                return;
            }
        }
    }

    fn finish(&mut self, showdown: bool) {
        self.to_act = None;
        let board = self.board();
        let order: Vec<usize> = (0..self.n())
            .map(|k| (self.button + 1 + k) % self.n())
            .collect();
        let inputs: Vec<SettleSeat> = order
            .iter()
            .map(|&i| {
                let state = &self.seats[i];
                let value = (showdown && state.live()).then(|| {
                    let mut cards = self.hole_at(i).to_vec();
                    cards.extend(&board);
                    evaluate(&cards)
                });
                SettleSeat {
                    seat: self.start.seats[i].seat,
                    committed: state.total_in,
                    folded: state.folded,
                    value,
                }
            })
            .collect();
        // Every input has a live player and showdown values for all live ones: cannot fail.
        let settlement = settle_hand(
            &inputs,
            self.start.rake_bp(),
            self.start.config.rake_cap,
            self.flop_seen,
        )
        .unwrap_or_else(|err| unreachable!("a played hand always settles: {err}"));
        let seats = (0..self.n())
            .map(|i| {
                let start = &self.start.seats[i];
                let line = settlement
                    .seats
                    .iter()
                    .find(|s| s.seat == start.seat)
                    .copied()
                    .unwrap_or(SeatSettlement {
                        seat: start.seat,
                        put_in: 0,
                        won: 0,
                    });
                let shown_input = inputs.iter().find(|s| s.seat == start.seat);
                let value = shown_input.and_then(|s| s.value);
                SeatResult {
                    seat: start.seat,
                    player: start.player.clone(),
                    put_in: line.put_in,
                    won: line.won,
                    stack_after: start.stack - line.put_in + line.won,
                    shown: value.map(|_| self.hole_at(i)),
                    value,
                }
            })
            .collect();
        self.result = Some(HandResult {
            board,
            showdown,
            pots: settlement.pots,
            rake: settlement.rake,
            seats,
        });
    }

    /// Public state for the table's screens.
    pub fn view(&self) -> HandView {
        let (sb, bb) = self.blind_positions();
        let order: Vec<usize> = (0..self.n())
            .map(|k| (self.button + 1 + k) % self.n())
            .collect();
        let committed: Vec<SettleSeat> = order
            .iter()
            .map(|&i| SettleSeat {
                seat: self.start.seats[i].seat,
                committed: self.seats[i].total_in,
                folded: self.seats[i].folded,
                value: None,
            })
            .collect();
        HandView {
            table: self.start.table.clone(),
            hand: self.start.hand,
            button: self.start.button,
            small_blind_seat: self.start.seats[sb].seat,
            big_blind_seat: self.start.seats[bb].seat,
            big_blind: self.start.config.big_blind,
            street: self.street,
            board: self.board(),
            pots: match &self.result {
                Some(result) => result.pots.clone(),
                None => build_pots(&committed),
            },
            current_bet: self.current_bet,
            to_act: self.to_act(),
            legal: self.legal(),
            seats: self
                .start
                .seats
                .iter()
                .zip(&self.seats)
                .map(|(start, state)| SeatView {
                    seat: start.seat,
                    player: start.player.clone(),
                    stack: state.stack,
                    street_in: state.street_in,
                    total_in: state.total_in,
                    folded: state.folded,
                    all_in: state.all_in,
                })
                .collect(),
            done: self.is_done(),
        }
    }

    /// The full public record, once the hand is over (it reveals the seed, so every hole card).
    pub fn history(&self) -> Option<HandHistory> {
        self.is_done().then(|| HandHistory {
            start: self.start.clone(),
            hand_seed: self.hand_seed,
            actions: self.actions.clone(),
        })
    }

    /// A player's session round for this finished hand: stake = chips put in, payout = chips won.
    pub fn round_for(&self, seat: u8, nonce: u64) -> Option<CompactRound> {
        let result = self.result.as_ref()?;
        let line = result.seats.iter().find(|s| s.seat == seat)?;
        let history = self.history()?;
        Some(CompactRound {
            nonce,
            bet: Bet::Poker {
                table: self.start.table.clone(),
                hand: self.start.hand,
            },
            stake: line.put_in,
            actions: Vec::new(),
            outcome: Outcome::Poker {
                hand_seed_hash: self.start.hand_seed_hash,
                history_hash: history.hash(),
                seat,
                board: result.board.clone(),
            },
            payout: line.won,
        })
    }
}

/// Replays a published hand; fails unless its actions are legal and finish it.
pub fn replay_hand(history: &HandHistory) -> Result<Hand, PokerError> {
    let mut hand = Hand::new(history.start.clone(), history.hand_seed)?;
    for record in &history.actions {
        hand.act(record.seat, record.action)?;
    }
    if !hand.is_done() {
        return Err(PokerError::Unfinished);
    }
    Ok(hand)
}

/// Checks that `round` is `player`'s round of the hand in `history`: same table, hand, seat,
/// commitment, history hash, board, stake and payout.
pub fn verify_poker_round(
    round: &CompactRound,
    history: &HandHistory,
    player: &str,
) -> Result<(), PokerError> {
    let Outcome::Poker { seat, .. } = round.outcome else {
        return Err(PokerError::RoundMismatch);
    };
    let owner = history.start.seats.iter().find(|s| s.seat == seat);
    if owner.is_none_or(|s| s.player != player) {
        return Err(PokerError::RoundMismatch);
    }
    let hand = replay_hand(history)?;
    let expected = hand
        .round_for(seat, round.nonce)
        .ok_or(PokerError::RoundMismatch)?;
    if expected != *round {
        return Err(PokerError::RoundMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{
        chain_step, server_seed_hash, verify_poker_session, SessionPublic, SettleBatch,
    };
    use crate::Game;

    fn cards(text: &str) -> Vec<Card> {
        text.split_whitespace()
            .map(|c| c.parse().unwrap())
            .collect()
    }

    fn value(text: &str) -> HandValue {
        evaluate(&cards(text))
    }

    const BIG: u128 = 100;

    fn config() -> TableConfig {
        TableConfig {
            small_blind: 50,
            big_blind: BIG,
            rake_cap: 300,
        }
    }

    fn start_with(stacks: &[u128], button: u8, hand_seed: &Hash32) -> HandStart {
        HandStart {
            table: "poker-demo".into(),
            hand: 7,
            config: config(),
            button,
            seats: stacks
                .iter()
                .enumerate()
                .map(|(i, &stack)| SeatStart {
                    seat: i as u8,
                    player: format!("p{i}.testnet"),
                    stack,
                    client_seed: format!("seed-{i}"),
                    rake_bp: 500,
                })
                .collect(),
            hand_seed_hash: sha256(hand_seed),
        }
    }

    fn new_hand(stacks: &[u128], button: u8) -> Hand {
        let seed = [9u8; 32];
        Hand::new(start_with(stacks, button, &seed), seed).unwrap()
    }

    // ---- cards and deck ----

    #[test]
    fn cards_round_trip() {
        for i in 0..52u8 {
            let card = Card::new(i).unwrap();
            assert_eq!(card.to_string().parse::<Card>().unwrap(), card);
            let json = serde_json::to_string(&card).unwrap();
            assert_eq!(serde_json::from_str::<Card>(&json).unwrap(), card);
            assert_eq!(borsh::to_vec(&card).unwrap(), vec![i]);
        }
        assert_eq!(Card::new(0).unwrap().to_string(), "2c");
        assert_eq!(Card::new(51).unwrap().to_string(), "As");
        assert_eq!("Td".parse::<Card>().unwrap().index(), 8 * 4 + 1);
        assert!(Card::new(52).is_none());
        assert!(borsh::from_slice::<Card>(&[52]).is_err());
        assert!("1s".parse::<Card>().is_err() && "Ax".parse::<Card>().is_err());
    }

    #[test]
    fn deck_is_a_permutation_fixed_by_every_seed() {
        let seed = [1u8; 32];
        let deck = deck_for(&seed, &["a", "b"]);
        let mut sorted = deck.to_vec();
        sorted.sort();
        assert_eq!(
            sorted,
            (0..52).map(|i| Card::new(i).unwrap()).collect::<Vec<_>>()
        );
        assert_eq!(deck, deck_for(&seed, &["a", "b"]));
        assert_ne!(deck, deck_for(&seed, &["b", "a"]));
        assert_ne!(deck, deck_for(&seed, &["a", "c"]));
        assert_ne!(deck, deck_for(&[2u8; 32], &["a", "b"]));
    }

    #[test]
    fn appended_variants_keep_old_encodings() {
        assert_eq!(borsh::to_vec(&Game::Blackjack).unwrap(), vec![2]);
        assert_eq!(borsh::to_vec(&Game::Poker).unwrap(), vec![3]);
        assert_eq!(serde_json::to_string(&Game::Poker).unwrap(), "\"poker\"");
        let bet = Bet::Poker {
            table: "t".into(),
            hand: 1,
        };
        assert_eq!(borsh::to_vec(&bet).unwrap()[0], 4);
        assert_eq!(
            serde_json::to_string(&bet).unwrap(),
            r#"{"poker":{"table":"t","hand":1}}"#
        );
        let outcome = Outcome::Poker {
            hand_seed_hash: [0; 32],
            history_hash: [0; 32],
            seat: 0,
            board: Vec::new(),
        };
        assert_eq!(borsh::to_vec(&outcome).unwrap()[0], 3);
    }

    // ---- evaluator ----

    #[test]
    fn every_category() {
        let cases = [
            ("As Ks Qs Js Ts 2d 3c", HandCategory::StraightFlush),
            ("9h 9d 9s 9c Ah 2d 3c", HandCategory::Quads),
            ("Kh Kd Ks 2c 2h 7d 8c", HandCategory::FullHouse),
            ("Ah 9h 7h 4h 2h Kd Kc", HandCategory::Flush),
            ("9c Td Jh Qs Kc 2d 2h", HandCategory::Straight),
            ("7c 7d 7h Ks 2c 4d 9h", HandCategory::Trips),
            ("7c 7d 4h 4s Ac 2d 9h", HandCategory::TwoPair),
            ("7c 7d 4h 5s Ac 2d 9h", HandCategory::Pair),
            ("7c Jd 4h 5s Ac 2d 9h", HandCategory::HighCard),
        ];
        let mut previous = None;
        for (hand, category) in cases {
            let v = value(hand);
            assert_eq!(v.category(), category, "{hand}");
            if let Some(stronger) = previous {
                assert!(v < stronger, "{hand}");
            }
            previous = Some(v);
        }
    }

    #[test]
    fn wheels_and_broadway() {
        let wheel = value("Ac 2d 3h 4s 5c 9d Kh");
        let six_high = value("6c 2d 3h 4s 5c 9d Kh");
        let broadway = value("Ac Kd Qh Js Tc 2d 3h");
        assert_eq!(wheel.category(), HandCategory::Straight);
        assert!(wheel < six_high && six_high < broadway);
        let steel_wheel = value("Ah 2h 3h 4h 5h Kd Qc");
        assert_eq!(steel_wheel.category(), HandCategory::StraightFlush);
        assert!(steel_wheel < value("2h 3h 4h 5h 6h Kd Qc"));
        // K-A-2-3-4 does not wrap around.
        assert_eq!(
            value("Kc Ad 2h 3s 4c 9d 8h").category(),
            HandCategory::HighCard
        );
        // Straight flush picked from a suit while a higher plain straight exists.
        let sf = value("5d 6d 7d 8d 9d Tc Jh");
        assert_eq!(sf.category(), HandCategory::StraightFlush);
        assert_eq!(sf, value("5d 6d 7d 8d 9d 2c 3h"));
    }

    #[test]
    fn kickers_decide() {
        // Pair of aces, king kicker beats queen kicker.
        assert!(value("Ac Ad Kh 7s 5c 3d 2h") > value("Ac Ad Qh 7s 5c 3d 2h"));
        // Only five cards play: the sixth card does not count.
        assert_eq!(value("Ac Ad Kh Qs Jc 3d 2h"), value("Ac Ad Kh Qs Jc 4d 2h"));
        // Three pairs: the best two and the best remaining card.
        assert_eq!(value("Kc Kd 9h 9s 5c 5d Ah"), value("Kc Kd 9h 9s Ac 2d 3h"));
        assert!(value("Kc Kd 9h 9s 5c 5d 2h") > value("Kc Kd 9h 9s 4c 3d 2h"));
        // Two trips make a full house with the lower as the pair.
        assert_eq!(value("Kc Kd Kh 9s 9c 9d 2h"), value("Kc Kd Kh 9s 9c 3d 2h"));
        assert!(value("Kc Kd Kh 9s 9c 2d 2h") > value("Qc Qd Qh As Ac 2d 3h"));
        // Quads kicker.
        assert!(value("9h 9d 9s 9c Ah 2d 3c") > value("9h 9d 9s 9c Kh Qd 3c"));
        // Flush compares all five cards.
        assert!(value("Ah Th 7h 4h 3h Kd Kc") > value("Ah Th 7h 4h 2h Kd Kc"));
        // Trips kickers.
        assert!(value("7c 7d 7h As 2c 4d 9h") > value("7c 7d 7h Ks Qc 4d 9h"));
        // The same five cards tie, suits never matter.
        assert_eq!(value("Ac Kd Qh 9s 7c 3d 2h"), value("Ad Kh Qs 9c 7d 3c 2s"));
    }

    // ---- settling ----

    fn seat(seat: u8, committed: u128, folded: bool, hand: &str) -> SettleSeat {
        SettleSeat {
            seat,
            committed,
            folded,
            value: (!hand.is_empty()).then(|| value(hand)),
        }
    }

    fn assert_conserved(seats: &[SettleSeat], s: &Settlement) {
        let committed: u128 = seats.iter().map(|x| x.committed).sum();
        let put_in: u128 = s.seats.iter().map(|x| x.put_in).sum();
        let won: u128 = s.seats.iter().map(|x| x.won).sum();
        let returned: u128 = committed - put_in;
        assert_eq!(won + s.rake, put_in);
        assert_eq!(won + s.rake + returned, committed);
        assert_eq!(
            s.pots.iter().map(|p| p.amount).sum::<u128>() + s.rake,
            put_in
        );
    }

    #[test]
    fn side_pots_three_all_ins() {
        let board = "2c 7d 9h Js 4c";
        let seats = [
            seat(0, 100, false, &format!("Ac Ad {board}")),
            seat(1, 300, false, &format!("Kc Kd {board}")),
            seat(2, 500, false, &format!("Qc Qd {board}")),
        ];
        let s = settle_hand(&seats, 0, 0, true).unwrap();
        assert_eq!(
            s.seats,
            vec![
                SeatSettlement {
                    seat: 0,
                    put_in: 100,
                    won: 300
                },
                SeatSettlement {
                    seat: 1,
                    put_in: 300,
                    won: 400
                },
                // 200 uncalled chips come back.
                SeatSettlement {
                    seat: 2,
                    put_in: 300,
                    won: 0
                },
            ]
        );
        assert_eq!(s.pots[0].eligible, vec![0, 1, 2]);
        assert_eq!(s.pots[1].eligible, vec![1, 2]);
        assert_eq!(s.pots[1].winners, vec![1]);
        assert_conserved(&seats, &s);
    }

    #[test]
    fn side_pot_with_a_folded_player_and_rake() {
        let board = "2c 7d 9h Js 4c";
        // Seat 0 all in for 100; seats 1 and 2 bet on; seat 2 folds the river to seat 1.
        let seats = [
            seat(0, 100, false, &format!("Ac Ad {board}")),
            seat(1, 700, false, &format!("Kc Kd {board}")),
            seat(2, 500, true, ""),
        ];
        let s = settle_hand(&seats, 500, 1_000, true).unwrap();
        // 1100 in after 200 returned: rake 5 % = 55, out of the main pot (300 → 245).
        assert_eq!(s.rake, 55);
        assert_eq!(s.pots[0].amount, 245);
        assert_eq!(s.pots[0].winners, vec![0]);
        assert_eq!(s.pots[1].amount, 800);
        assert_eq!(s.pots[1].winners, vec![1]);
        assert_eq!(s.seats[1].put_in, 500);
        assert_conserved(&seats, &s);
    }

    #[test]
    fn split_pot_odd_chip_goes_left_of_the_button() {
        let board = "As Ks Qs Js Ts";
        let seats = [
            seat(3, 101, false, &format!("2c 3d {board}")),
            seat(5, 101, false, &format!("4c 5d {board}")),
            seat(0, 101, true, ""),
        ];
        let s = settle_hand(&seats, 0, 0, true).unwrap();
        assert_eq!(s.pots[0].winners, vec![3, 5]);
        assert_eq!(s.seats[0].won, 152);
        assert_eq!(s.seats[1].won, 151);
        assert_conserved(&seats, &s);
    }

    #[test]
    fn rake_is_capped_and_needs_a_flop() {
        assert_eq!(rake_for(10_000, 500, 300, true), 300);
        assert_eq!(rake_for(1_000, 500, 300, true), 50);
        assert_eq!(rake_for(1_019, 500, 300, true), 50);
        assert_eq!(rake_for(10_000, 500, 300, false), 0);
        assert_eq!(rake_for(u128::MAX, 500, 300, true), 300);
        let seats = [seat(0, 150, false, ""), seat(1, 100, true, "")];
        let s = settle_hand(&seats, 500, 300, false).unwrap();
        assert_eq!((s.rake, s.seats[0].put_in, s.seats[0].won), (0, 100, 200));
    }

    #[test]
    fn settle_refuses_impossible_inputs() {
        assert_eq!(
            settle_hand(&[seat(0, 10, true, ""), seat(1, 10, true, "")], 0, 0, true),
            Err(PokerError::NoPlayers)
        );
        assert_eq!(
            settle_hand(
                &[seat(0, 10, false, ""), seat(1, 10, false, "")],
                0,
                0,
                true
            ),
            Err(PokerError::MissingHand)
        );
    }

    // ---- the state machine ----

    #[test]
    fn heads_up_button_posts_small_blind_and_acts_first() {
        let mut hand = new_hand(&[1_000, 1_000], 1);
        let view = hand.view();
        assert_eq!((view.small_blind_seat, view.big_blind_seat), (1, 0));
        assert_eq!(hand.to_act(), Some(1));
        hand.act(1, PokerAction::Call).unwrap();
        // The big blind has its option.
        let legal = hand.legal().unwrap();
        assert!(legal.can_check && legal.raise.is_some());
        hand.act(0, PokerAction::Check).unwrap();
        // After the flop the big blind (non-button) acts first.
        assert_eq!(hand.street(), Street::Flop);
        assert_eq!(hand.board().len(), 3);
        assert_eq!(hand.to_act(), Some(0));
    }

    #[test]
    fn walk_returns_the_uncalled_blind_without_rake() {
        let mut hand = new_hand(&[1_000, 1_000, 1_000], 0);
        // Seat 1 small blind, 2 big blind, 0 first to act.
        assert_eq!(hand.to_act(), Some(0));
        hand.act(0, PokerAction::Fold).unwrap();
        hand.act(1, PokerAction::Fold).unwrap();
        let result = hand.result().unwrap();
        assert_eq!(result.rake, 0);
        assert!(!result.showdown);
        assert_eq!(result.seats[2].put_in, 50);
        assert_eq!(result.seats[2].won, 100);
        assert_eq!(result.seats[2].stack_after, 1_050);
        assert_eq!(result.seats[1].stack_after, 950);
        assert_eq!(hand.act(2, PokerAction::Check), Err(PokerError::HandOver));
    }

    #[test]
    fn min_raise_and_turn_order_are_enforced() {
        let mut hand = new_hand(&[10_000, 10_000, 10_000], 0);
        assert_eq!(hand.act(1, PokerAction::Call), Err(PokerError::NotYourTurn));
        assert_eq!(
            hand.act(0, PokerAction::Check),
            Err(PokerError::IllegalAction)
        );
        // Min raise to 200 (one big blind more).
        assert_eq!(
            hand.act(0, PokerAction::RaiseTo(199)),
            Err(PokerError::IllegalAction)
        );
        hand.act(0, PokerAction::RaiseTo(500)).unwrap();
        // Raised by 400: next min is 900.
        let legal = hand.legal().unwrap();
        assert_eq!(legal.raise.unwrap().min_to, 900);
        assert_eq!(legal.call, 450);
        assert_eq!(
            hand.act(1, PokerAction::RaiseTo(899)),
            Err(PokerError::IllegalAction)
        );
        hand.act(1, PokerAction::RaiseTo(900)).unwrap();
        assert_eq!(hand.legal().unwrap().raise.unwrap().max_to, 10_000);
    }

    #[test]
    fn short_all_in_does_not_reopen_the_betting() {
        // Seat 2 has only 250 behind.
        let mut hand = new_hand(&[10_000, 10_000, 250, 10_000], 3);
        // Button 3: seat 0 small blind, seat 1 big blind, seat 2 first.
        hand.act(2, PokerAction::Call).unwrap();
        hand.act(3, PokerAction::Call).unwrap();
        hand.act(0, PokerAction::Call).unwrap();
        hand.act(1, PokerAction::Check).unwrap();
        // Flop: seat 0 first. Bet 100, seat 1 calls, seat 2 all in for 150 total (short raise).
        hand.act(0, PokerAction::RaiseTo(100)).unwrap();
        hand.act(1, PokerAction::Call).unwrap();
        hand.act(2, PokerAction::AllIn).unwrap();
        // Seat 3 has not acted: it may raise.
        assert_eq!(hand.legal().unwrap().raise.unwrap().min_to, 250);
        hand.act(3, PokerAction::Call).unwrap();
        // Seats 0 and 1 already acted and face only 50 more: call or fold.
        let legal = hand.legal().unwrap();
        assert_eq!((legal.seat, legal.call, legal.raise), (0, 50, None));
        assert_eq!(
            hand.act(0, PokerAction::RaiseTo(400)),
            Err(PokerError::IllegalAction)
        );
        assert_eq!(
            hand.act(0, PokerAction::AllIn),
            Err(PokerError::IllegalAction)
        );
        hand.act(0, PokerAction::Call).unwrap();
        hand.act(1, PokerAction::Call).unwrap();
        assert_eq!(hand.street(), Street::Turn);
    }

    #[test]
    fn all_in_preflop_runs_the_board_out() {
        let mut hand = new_hand(&[1_000, 3_000], 0);
        hand.act(0, PokerAction::AllIn).unwrap();
        hand.act(1, PokerAction::Call).unwrap();
        let result = hand.result().unwrap();
        assert!(result.showdown);
        assert_eq!(result.board.len(), 5);
        assert_eq!(result.seats[1].put_in, 1_000);
        // Rake 5 % capped at 300: 100.
        assert_eq!(result.rake, 100);
        assert!(result.seats.iter().all(|s| s.shown.is_some()));
    }

    #[test]
    fn bad_starts_are_refused() {
        let seed = [9u8; 32];
        let good = start_with(&[1_000, 1_000], 0, &seed);
        assert_eq!(
            Hand::new(good.clone(), [8u8; 32]).unwrap_err(),
            PokerError::WrongSeed
        );
        let mut one = good.clone();
        one.seats.pop();
        assert!(Hand::new(one, seed).is_err());
        let mut button = good.clone();
        button.button = 4;
        assert!(Hand::new(button, seed).is_err());
        let mut order = good.clone();
        order.seats.swap(0, 1);
        assert!(Hand::new(order, seed).is_err());
        let mut seed_text = good.clone();
        seed_text.seats[0].client_seed = "a:b".into();
        assert!(Hand::new(seed_text, seed).is_err());
        let mut rake = good;
        rake.seats[0].rake_bp = MAX_RAKE_BP + 1;
        assert!(Hand::new(rake, seed).is_err());
    }

    #[test]
    fn next_button_wraps() {
        assert_eq!(next_button(&[0, 2, 5], 2), Some(5));
        assert_eq!(next_button(&[5, 0, 2], 5), Some(0));
        assert_eq!(next_button(&[3], 3), Some(3));
        assert_eq!(next_button(&[], 3), None);
    }

    // ---- properties over random hands ----

    /// A random legal move.
    fn random_action(legal: &Legal, rng: &mut Rng) -> PokerAction {
        loop {
            let action = match rng.below(6) {
                0 => PokerAction::Fold,
                1 => PokerAction::Check,
                2 | 3 => PokerAction::Call,
                4 => match legal.raise {
                    Some(r) => {
                        let span = (r.max_to - r.min_to).min(u128::from(u32::MAX - 1)) as u32;
                        PokerAction::RaiseTo(r.min_to + u128::from(rng.below(span + 1)))
                    }
                    None => continue,
                },
                _ => PokerAction::AllIn,
            };
            if legal.allows(action) {
                return action;
            }
        }
    }

    fn random_start(rng: &mut Rng, k: u32) -> (HandStart, Hash32) {
        let players = 2 + rng.below(5) as usize;
        let mut seats: Vec<u8> = (0..MAX_SEATS).collect();
        for i in (1..seats.len()).rev() {
            let j = rng.below(i as u32 + 1) as usize;
            seats.swap(i, j);
        }
        let mut chosen = seats[..players].to_vec();
        chosen.sort_unstable();
        let mut hand_seed = [0u8; 32];
        hand_seed[..4].copy_from_slice(&k.to_le_bytes());
        let start = HandStart {
            table: "prop".into(),
            hand: u64::from(k),
            config: TableConfig {
                small_blind: 1 + u128::from(rng.below(50)),
                big_blind: 50 + u128::from(rng.below(50)),
                rake_cap: u128::from(rng.below(500)),
            },
            button: chosen[rng.below(players as u32) as usize],
            seats: chosen
                .iter()
                .map(|&seat| SeatStart {
                    seat,
                    player: format!("p{seat}"),
                    // Short stacks too, under a blind.
                    stack: 1 + u128::from(rng.below(5_000)),
                    client_seed: format!("c{seat}-{k}"),
                    rake_bp: rng.below(u32::from(MAX_RAKE_BP) + 1) as u16,
                })
                .collect(),
            hand_seed_hash: sha256(&hand_seed),
        };
        (start, hand_seed)
    }

    fn play_random(start: HandStart, seed: Hash32, rng: &mut Rng) -> Hand {
        let mut hand = Hand::new(start, seed).unwrap();
        let mut moves = 0;
        while let Some(legal) = hand.legal() {
            let action = random_action(&legal, rng);
            hand.act(legal.seat, action).unwrap();
            moves += 1;
            assert!(moves < 200, "a hand must end");
        }
        assert!(hand.is_done());
        hand
    }

    #[test]
    fn random_hands_conserve_chips_and_replay() {
        let mut rng = Rng::new(*b"poker property test seed 0000001");
        for k in 0..3_000 {
            let (start, seed) = random_start(&mut rng, k);
            let hand = play_random(start.clone(), seed, &mut rng);
            let result = hand.result().unwrap();
            let put_in: u128 = result.seats.iter().map(|s| s.put_in).sum();
            let won: u128 = result.seats.iter().map(|s| s.won).sum();
            assert_eq!(won + result.rake, put_in);
            let before: u128 = start.seats.iter().map(|s| s.stack).sum();
            let after: u128 = result.seats.iter().map(|s| s.stack_after).sum();
            assert_eq!(after + result.rake, before);
            assert!(result.rake <= start.config.rake_cap);
            for (line, seat) in result.seats.iter().zip(&start.seats) {
                assert!(line.put_in <= seat.stack);
                assert!(line.won <= worst_case_payout_check(line.put_in));
            }
            let history = hand.history().unwrap();
            let replayed = replay_hand(&history).unwrap();
            assert_eq!(replayed.result(), hand.result());
            for seat in &start.seats {
                let round = hand.round_for(seat.seat, 1).unwrap();
                verify_poker_round(&round, &history, &seat.player).unwrap();
                assert!(round.bet.is_valid() && round.bet.game() == Game::Poker);
            }
            let json = serde_json::to_string(&history).unwrap();
            assert_eq!(serde_json::from_str::<HandHistory>(&json).unwrap(), history);
        }
    }

    fn worst_case_payout_check(stake: u128) -> u128 {
        crate::worst_case_payout(
            Game::Poker,
            stake,
            &Bet::Poker {
                table: "prop".into(),
                hand: 0,
            },
        )
    }

    #[test]
    fn tampered_history_or_round_is_caught() {
        let mut rng = Rng::new(*b"poker tamper test seed 000000001");
        let (start, seed) = random_start(&mut rng, 1);
        let hand = play_random(start.clone(), seed, &mut rng);
        let history = hand.history().unwrap();
        let player = &start.seats[0].player;
        let round = hand.round_for(start.seats[0].seat, 3).unwrap();
        verify_poker_round(&round, &history, player).unwrap();
        let mut richer = round.clone();
        richer.payout += 1;
        assert!(verify_poker_round(&richer, &history, player).is_err());
        assert!(verify_poker_round(&round, &history, "someone.else").is_err());
        let mut other_seed = history.clone();
        other_seed.hand_seed[0] ^= 1;
        assert_eq!(replay_hand(&other_seed).unwrap_err(), PokerError::WrongSeed);
        let mut cut = history.clone();
        cut.actions.pop();
        assert!(replay_hand(&cut).is_err());
    }

    #[test]
    fn poker_session_verifies_from_hand_histories() {
        let server_seed = [4u8; 32];
        let public = SessionPublic {
            server_seed_hash: server_seed_hash(&server_seed),
            client_seed: "player-seed",
            game: Game::Poker,
            rake_bp: 500,
            lock: 1_000,
        };
        let mut rng = Rng::new(*b"poker session test seed 00000001");
        let mut hands = Vec::new();
        let mut rounds = Vec::new();
        let mut balance = public.lock;
        let mut chain = public.server_seed_hash;
        for k in 1..=5u64 {
            let hand_seed = [k as u8; 32];
            let mut start = start_with(&[balance, 5_000, 5_000], (k % 3) as u8, &hand_seed);
            start.hand = k;
            let hand = play_random(start, hand_seed, &mut rng);
            let round = hand.round_for(0, k).unwrap();
            balance = balance - round.stake + round.payout;
            chain = chain_step(&chain, &round);
            rounds.push(round);
            hands.push(hand.history().unwrap());
            if balance == 0 {
                break;
            }
        }
        let batch = SettleBatch {
            session_id: "s".into(),
            upto_nonce: rounds.len() as u64,
            balance,
            chain,
            rounds,
            server_sig: [0; 64],
        };
        let summary = verify_poker_session(
            &server_seed,
            &public,
            "p0.testnet",
            std::slice::from_ref(&batch),
            &hands,
        )
        .unwrap();
        assert_eq!(summary.balance, balance);
        // The ordinary verifier cannot replay poker rounds alone.
        assert!(crate::session::verify_session(
            &server_seed,
            &public,
            std::slice::from_ref(&batch)
        )
        .is_err());
        assert!(
            verify_poker_session(&server_seed, &public, "p1.testnet", &[batch], &hands).is_err()
        );
    }
}
