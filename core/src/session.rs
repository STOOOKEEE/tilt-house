//! # Provably fair sessions (docs/sessions.md)
//!
//! Shared by the session server (plays the rounds), the contract (checks signatures and the hash
//! chain at settle, the seed at close) and the verifiers: the bytes signed and hashed here are the
//! protocol, so every side must build them with these functions.
//!
//! - Round seeds: `HMAC-SHA256(server_seed, client_seed || ":" || nonce)` for step 0, with
//!   `":" || step` appended for the later steps of a blackjack hand. The server commits to
//!   `sha256(server_seed)` before the player picks `client_seed`, so neither side controls a draw.
//! - Hash chain: `chain_0 = server_seed_hash`, `chain_n = sha256(chain_{n-1} || borsh(round_n))`.
//!   It binds every round (bet, stake, actions, outcome, payout) in order; the server signs it in
//!   every `SessionState`, so a settle cannot drop, reorder or rewrite a round the player saw.
//! - Signatures: ed25519 over `domain || borsh(payload)`; the domain keeps a ticket from ever
//!   being accepted as a state and the reverse.
//!
//! Amounts are integer base units (`u128`), JSON decimal strings; 32-byte values are JSON hex.

use std::fmt;

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::poker::{verify_poker_round, Card, HandHistory};
use crate::{
    apply_rake, bj_deal, bj_double, bj_gross, bj_hit, bj_stand, bj_wager, dice_gross, dice_roll,
    roulette, roulette_gross, roulette_spin, worst_case_payout, Bet, BjError, BjState, Game, Rng,
    BP,
};

/// A session may win at most this many times its lock (before the pool share cap below).
pub const SESSION_WIN_MULTIPLE: u128 = 10;
/// ...and at most this share of the dealer pool's free bankroll at open, so a few sessions can
/// never reserve a whole pool.
pub const SESSION_POOL_SHARE_BP: u128 = 1_000;
/// Smallest stake per round; same as the contract's `MIN_BET`, which keeps integer rounding of
/// the rake within the edge bounds (`rake_bounds`).
pub const SESSION_MIN_BET: u128 = 100_000;
/// A ticket must be opened on chain within this time, so a stale offer cannot be frozen later.
pub const TICKET_TTL_SECS: u64 = 120;
/// Settle at least this often (rounds, seconds), and at close.
pub const SETTLE_EVERY_ROUNDS: u64 = 50;
pub const SETTLE_EVERY_SECS: u64 = 60;
/// Without a settle for this long, the player may force-close with the last signed state.
pub const SESSION_TIMEOUT_SECS: u64 = 600;
/// A settled session whose seed is not revealed within this time pays the player `lock + max_win`.
pub const REVEAL_TIMEOUT_SECS: u64 = 3_600;
/// Client seeds are short printable text.
pub const MAX_CLIENT_SEED_LEN: usize = 64;

pub const TICKET_DOMAIN: &[u8] = b"tilt-house/session-ticket/v1";
pub const STATE_DOMAIN: &[u8] = b"tilt-house/session-state/v1";

pub type Hash32 = [u8; 32];

/// SHA-256 block size, the HMAC key pad length.
const BLOCK: usize = 64;

pub fn sha256(bytes: &[u8]) -> Hash32 {
    Sha256::digest(bytes).into()
}

/// The commitment published before play.
pub fn server_seed_hash(server_seed: &Hash32) -> Hash32 {
    sha256(server_seed)
}

/// Seed of one step of round `nonce`. Step 0 is the whole round for dice and roulette and the
/// deal for blackjack; step k ≥ 1 is the k-th player action of the hand.
pub fn step_seed(server_seed: &Hash32, client_seed: &str, nonce: u64, step: u32) -> Hash32 {
    let mut message = format!("{client_seed}:{nonce}");
    if step > 0 {
        message.push_str(&format!(":{step}"));
    }
    hmac_sha256(server_seed, message.as_bytes())
}

/// RFC 2104 HMAC with a 32-byte key (shorter than the block, so it is just zero-padded). Written
/// out rather than pulled from a crate: it is a few lines and cannot fail.
pub(crate) fn hmac_sha256(key: &Hash32, message: &[u8]) -> Hash32 {
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for (i, byte) in key.iter().enumerate() {
        ipad[i] ^= byte;
        opad[i] ^= byte;
    }
    let inner = Sha256::new()
        .chain_update(ipad)
        .chain_update(message)
        .finalize();
    Sha256::new()
        .chain_update(opad)
        .chain_update(inner)
        .finalize()
        .into()
}

/// `HMAC-SHA256(server_seed, client_seed || ":" || nonce)`; also the seed of the jackpot draw.
pub fn round_seed(server_seed: &Hash32, client_seed: &str, nonce: u64) -> Hash32 {
    step_seed(server_seed, client_seed, nonce, 0)
}

/// Client seeds are 1..=64 printable ASCII characters other than `:` (the seed separator).
pub fn client_seed_is_valid(client_seed: &str) -> bool {
    (1..=MAX_CLIENT_SEED_LEN).contains(&client_seed.len())
        && client_seed
            .bytes()
            .all(|b| b.is_ascii_graphic() && b != b':')
}

/// Most a session may win: `min(lock × SESSION_WIN_MULTIPLE, pool_free × SESSION_POOL_SHARE_BP)`.
pub fn session_max_win(lock: u128, pool_free: u128) -> u128 {
    lock.saturating_mul(SESSION_WIN_MULTIPLE)
        .min(pool_free.saturating_mul(SESSION_POOL_SHARE_BP) / BP)
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
#[serde(rename_all = "snake_case")]
pub enum BjAction {
    Hit,
    Stand,
    Double,
}

/// What the draw produced.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Dice {
        roll: u32,
    },
    Roulette {
        pocket: u8,
    },
    Blackjack(BjState),
    /// A player's view of a poker hand: the hand's commitment, the hash of its full public
    /// history (`poker::HandHistory::hash`, which replays it), the player's seat and the board.
    Poker {
        #[serde(with = "hex32")]
        hand_seed_hash: Hash32,
        #[serde(with = "hex32")]
        history_hash: Hash32,
        seat: u8,
        board: Vec<Card>,
    },
}

/// One finished round as published in the settle tx args and hashed into the chain.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct CompactRound {
    pub nonce: u64,
    pub bet: Bet,
    /// Initial stake (a doubled blackjack hand wagers twice this).
    #[serde(with = "crate::amount_str")]
    pub stake: u128,
    /// Blackjack actions after the deal, in order; empty for dice and roulette.
    pub actions: Vec<BjAction>,
    pub outcome: Outcome,
    /// What the player got back, after rake.
    #[serde(with = "crate::amount_str")]
    pub payout: u128,
}

impl CompactRound {
    /// Total the player had at risk on this round.
    pub fn wager(&self) -> u128 {
        match &self.outcome {
            Outcome::Blackjack(state) => bj_wager(state, self.stake),
            _ => self.stake,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundOutcome {
    pub outcome: Outcome,
    pub payout: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoundError {
    /// The bet is for another game or out of its rules.
    InvalidBet,
    /// Blackjack is played step by step with `BjSession`.
    MultiStep,
    Blackjack(BjError),
    /// A poker round replays from its hand history (`poker::verify_poker_round`).
    PokerHand,
}

impl fmt::Display for RoundError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidBet => f.write_str("invalid bet for this game"),
            Self::MultiStep => f.write_str("blackjack is played step by step"),
            Self::Blackjack(err) => err.fmt(f),
            Self::PokerHand => f.write_str("a poker round replays from its hand history"),
        }
    }
}

impl std::error::Error for RoundError {}

/// Whether a round may stake `stake` on `bet` at a table whose max bet is `max_bet`: the round's
/// total within `SESSION_MIN_BET..=max_bet`; for a multi-spot spin, every spot at least
/// `SESSION_MIN_BET` (each is raked alone, and the minimum keeps that rounding within the edge
/// bounds) and the spots adding up to exactly `stake`.
pub fn stake_is_valid(bet: &Bet, stake: u128, max_bet: u128) -> bool {
    if let Bet::Poker { .. } = bet {
        // A hand's stake is what the player put in: nothing after a fold without a blind, and
        // blinds may be under `SESSION_MIN_BET`. The rake is of the pot, so no rounding bound.
        return stake <= max_bet;
    }
    if !(SESSION_MIN_BET..=max_bet).contains(&stake) {
        return false;
    }
    match bet {
        Bet::RouletteSpots(spots) => {
            spots.iter().all(|spot| spot.stake >= SESSION_MIN_BET)
                && roulette::spots_total(spots) == Some(stake)
        }
        _ => true,
    }
}

/// Resolves a one-step round (dice, roulette) from its round seed.
pub fn resolve_round(
    game: Game,
    bet: &Bet,
    stake: u128,
    rake_bp: u16,
    round_seed: &Hash32,
) -> Result<RoundOutcome, RoundError> {
    if bet.game() != game || !bet.is_valid() {
        return Err(RoundError::InvalidBet);
    }
    let mut rng = Rng::new(*round_seed);
    let (outcome, payout) = match bet {
        Bet::Dice(dice) => {
            let roll = dice_roll(&mut rng);
            let gross = dice_gross(stake, dice, roll);
            (Outcome::Dice { roll }, apply_rake(gross, stake, rake_bp))
        }
        Bet::Roulette(single) => {
            let pocket = roulette_spin(&mut rng);
            let gross = roulette_gross(stake, single, pocket);
            (
                Outcome::Roulette { pocket },
                apply_rake(gross, stake, rake_bp),
            )
        }
        Bet::RouletteSpots(spots) => {
            if roulette::spots_total(spots) != Some(stake) {
                return Err(RoundError::InvalidBet);
            }
            // One draw, exactly as a single-bet spin of the same nonce would make.
            let pocket = roulette_spin(&mut rng);
            let payout = roulette::spots_payout(spots, pocket, rake_bp);
            (Outcome::Roulette { pocket }, payout)
        }
        Bet::Blackjack => return Err(RoundError::MultiStep),
        Bet::Poker { .. } => return Err(RoundError::PokerHand),
    };
    Ok(RoundOutcome { outcome, payout })
}

/// A blackjack hand in play. Step 0 deals; each action uses the seed of the next step.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct BjSession {
    pub nonce: u64,
    #[serde(with = "crate::amount_str")]
    pub stake: u128,
    pub rake_bp: u16,
    pub actions: Vec<BjAction>,
    pub state: BjState,
}

impl BjSession {
    pub fn deal(
        server_seed: &Hash32,
        client_seed: &str,
        nonce: u64,
        stake: u128,
        rake_bp: u16,
    ) -> Self {
        let mut rng = Rng::new(round_seed(server_seed, client_seed, nonce));
        Self {
            nonce,
            stake,
            rake_bp,
            actions: Vec::new(),
            state: bj_deal(&mut rng),
        }
    }

    pub fn act(
        &mut self,
        action: BjAction,
        server_seed: &Hash32,
        client_seed: &str,
    ) -> Result<(), BjError> {
        let step = u32::try_from(self.actions.len() + 1).map_err(|_| BjError::Done)?;
        let mut rng = Rng::new(step_seed(server_seed, client_seed, self.nonce, step));
        match action {
            BjAction::Hit => bj_hit(&mut self.state, &mut rng)?,
            BjAction::Stand => bj_stand(&mut self.state, &mut rng)?,
            BjAction::Double => bj_double(&mut self.state, &mut rng)?,
        }
        self.actions.push(action);
        Ok(())
    }

    pub fn is_done(&self) -> bool {
        self.state.done
    }

    pub fn wager(&self) -> u128 {
        bj_wager(&self.state, self.stake)
    }

    /// The finished round, or `None` while the hand is live.
    pub fn finish(&self) -> Option<CompactRound> {
        if !self.state.done {
            return None;
        }
        let payout = apply_rake(
            bj_gross(&self.state, self.stake),
            self.wager(),
            self.rake_bp,
        );
        Some(CompactRound {
            nonce: self.nonce,
            bet: Bet::Blackjack,
            stake: self.stake,
            actions: self.actions.clone(),
            outcome: Outcome::Blackjack(self.state.clone()),
            payout,
        })
    }
}

/// Replays a round from the seeds and the player's choices (bet, stake, blackjack actions).
pub fn replay_round(
    server_seed: &Hash32,
    session: &SessionPublic<'_>,
    nonce: u64,
    bet: &Bet,
    stake: u128,
    actions: &[BjAction],
) -> Result<CompactRound, RoundError> {
    let SessionPublic {
        client_seed,
        game,
        rake_bp,
        ..
    } = *session;
    if bet.game() != game || !bet.is_valid() {
        return Err(RoundError::InvalidBet);
    }
    if *bet != Bet::Blackjack {
        let seed = round_seed(server_seed, client_seed, nonce);
        let RoundOutcome { outcome, payout } = resolve_round(game, bet, stake, rake_bp, &seed)?;
        return Ok(CompactRound {
            nonce,
            bet: bet.clone(),
            stake,
            actions: Vec::new(),
            outcome,
            payout,
        });
    }
    let mut hand = BjSession::deal(server_seed, client_seed, nonce, stake, rake_bp);
    for &action in actions {
        hand.act(action, server_seed, client_seed)
            .map_err(RoundError::Blackjack)?;
    }
    hand.finish().ok_or(RoundError::Blackjack(BjError::Done))
}

/// `sha256(prev || borsh(round))`.
pub fn chain_step(prev: &Hash32, round: &CompactRound) -> Hash32 {
    let mut hasher = Sha256::new();
    hasher.update(prev);
    // Borsh of these types cannot fail (no maps, no I/O): writing into a Vec is infallible.
    hasher.update(borsh::to_vec(round).unwrap_or_default());
    hasher.finalize().into()
}

/// What the server signs at start. `open_session` must check the signature over exactly these
/// fields (from its args), refuse after `expires_at`, freeze `game`/`rake_bp`/`max_bet` for the
/// session and reserve `max_win` after checking it is at most `session_max_win(lock, pool.free)`.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct SessionTicket {
    pub session_id: String,
    pub player: String,
    pub dealer_id: String,
    pub game: Game,
    #[serde(with = "crate::amount_str")]
    pub lock: u128,
    #[serde(with = "hex32")]
    pub server_seed_hash: Hash32,
    pub client_seed: String,
    pub rake_bp: u16,
    #[serde(with = "crate::amount_str")]
    pub max_bet: u128,
    #[serde(with = "crate::amount_str")]
    pub max_win: u128,
    /// Unix seconds.
    pub expires_at: u64,
}

/// The state the server signs after every round (nonce 0: the opening state, balance = lock,
/// chain = server_seed_hash). Settle and force_close take this signature.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct SessionState {
    pub session_id: String,
    pub nonce: u64,
    #[serde(with = "crate::amount_str")]
    pub balance: u128,
    #[serde(with = "hex32")]
    pub chain: Hash32,
}

fn signed_message<T: BorshSerialize>(domain: &[u8], payload: &T) -> Vec<u8> {
    let mut message = domain.to_vec();
    // Borsh into a Vec cannot fail for these types.
    message.extend(borsh::to_vec(payload).unwrap_or_default());
    message
}

/// Bytes the server signs (ed25519) for a ticket.
pub fn ticket_message(ticket: &SessionTicket) -> Vec<u8> {
    signed_message(TICKET_DOMAIN, ticket)
}

/// Bytes the server signs (ed25519) for a state.
pub fn state_message(state: &SessionState) -> Vec<u8> {
    signed_message(STATE_DOMAIN, state)
}

/// Args of `settle_session`, also one entry of the verifier's input. `rounds` are the rounds
/// after the previous settle, up to `upto_nonce`; `balance` and `chain` are the signed state
/// at `upto_nonce`.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct SettleBatch {
    pub session_id: String,
    pub upto_nonce: u64,
    #[serde(with = "crate::amount_str")]
    pub balance: u128,
    #[serde(with = "hex32")]
    pub chain: Hash32,
    pub rounds: Vec<CompactRound>,
    /// ed25519 signature over `state_message` of that state, hex.
    #[serde(with = "hex64")]
    pub server_sig: [u8; 64],
}

/// The public facts of a session from its open tx.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionPublic<'a> {
    pub server_seed_hash: Hash32,
    pub client_seed: &'a str,
    pub game: Game,
    pub rake_bp: u16,
    pub lock: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    pub rounds: u64,
    pub wagered: u128,
    pub paid: u128,
    pub balance: u128,
    pub chain: Hash32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VerifyError {
    /// `sha256(server_seed)` is not the committed hash.
    WrongSeed,
    /// Rounds are not numbered 1, 2, 3… across batches.
    NonceGap { expected: u64, got: u64 },
    /// A round's outcome or payout is not what the seeds give.
    TamperedRound { nonce: u64 },
    /// A batch's chain does not hash its rounds onto the previous chain.
    BrokenChain { upto_nonce: u64 },
    /// A batch's balance does not follow from its rounds, or a round wagered more than the balance.
    WrongBalance { upto_nonce: u64 },
}

impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongSeed => f.write_str("server seed does not match its hash"),
            Self::NonceGap { expected, got } => {
                write!(f, "expected round {expected}, got round {got}")
            }
            Self::TamperedRound { nonce } => write!(f, "round {nonce} does not replay"),
            Self::BrokenChain { upto_nonce } => {
                write!(f, "hash chain broken in the batch up to round {upto_nonce}")
            }
            Self::WrongBalance { upto_nonce } => {
                write!(f, "balance wrong in the batch up to round {upto_nonce}")
            }
        }
    }
}

impl std::error::Error for VerifyError {}

/// Replays a whole session from public data and the revealed seed. Signatures are the
/// contract's job (it checked them at settle); this checks fairness and bookkeeping.
pub fn verify_session(
    server_seed: &Hash32,
    session: &SessionPublic<'_>,
    batches: &[SettleBatch],
) -> Result<Summary, VerifyError> {
    verify_batches(server_seed, session, batches, |round| {
        replay_round(
            server_seed,
            session,
            round.nonce,
            &round.bet,
            round.stake,
            &round.actions,
        )
        .ok()
    })
}

/// `verify_session` for a poker session of `player`: each round must be the player's line of
/// one of the published `hands` (`poker::verify_poker_round`), which replay from their seeds.
pub fn verify_poker_session(
    server_seed: &Hash32,
    session: &SessionPublic<'_>,
    player: &str,
    batches: &[SettleBatch],
    hands: &[HandHistory],
) -> Result<Summary, VerifyError> {
    verify_batches(server_seed, session, batches, |round| {
        let Bet::Poker { table, hand } = &round.bet else {
            return None;
        };
        if session.game != Game::Poker {
            return None;
        }
        let history = hands
            .iter()
            .find(|h| h.start.table == *table && h.start.hand == *hand)?;
        verify_poker_round(round, history, player).ok()?;
        Some(round.clone())
    })
}

/// The bookkeeping shared by the verifiers; `replay` gives what a round should have been.
fn verify_batches(
    server_seed: &Hash32,
    session: &SessionPublic<'_>,
    batches: &[SettleBatch],
    replay: impl Fn(&CompactRound) -> Option<CompactRound>,
) -> Result<Summary, VerifyError> {
    if server_seed_hash(server_seed) != session.server_seed_hash {
        return Err(VerifyError::WrongSeed);
    }
    let mut summary = Summary {
        rounds: 0,
        wagered: 0,
        paid: 0,
        balance: session.lock,
        chain: session.server_seed_hash,
    };
    for batch in batches {
        for round in &batch.rounds {
            verify_round(&replay, round, &mut summary, batch.upto_nonce)?;
        }
        if summary.rounds != batch.upto_nonce {
            return Err(VerifyError::NonceGap {
                expected: summary.rounds,
                got: batch.upto_nonce,
            });
        }
        if summary.chain != batch.chain {
            return Err(VerifyError::BrokenChain {
                upto_nonce: batch.upto_nonce,
            });
        }
        if summary.balance != batch.balance {
            return Err(VerifyError::WrongBalance {
                upto_nonce: batch.upto_nonce,
            });
        }
    }
    Ok(summary)
}

fn verify_round(
    replay: &impl Fn(&CompactRound) -> Option<CompactRound>,
    round: &CompactRound,
    summary: &mut Summary,
    upto_nonce: u64,
) -> Result<(), VerifyError> {
    let expected = summary.rounds + 1;
    if round.nonce != expected {
        return Err(VerifyError::NonceGap {
            expected,
            got: round.nonce,
        });
    }
    let replayed = replay(round).ok_or(VerifyError::TamperedRound { nonce: round.nonce })?;
    if replayed != *round {
        return Err(VerifyError::TamperedRound { nonce: round.nonce });
    }
    let wager = round.wager();
    summary.balance = summary
        .balance
        .checked_sub(wager)
        .and_then(|b| b.checked_add(round.payout))
        .ok_or(VerifyError::WrongBalance { upto_nonce })?;
    summary.rounds = expected;
    summary.wagered = summary.wagered.saturating_add(wager);
    summary.paid = summary.paid.saturating_add(round.payout);
    summary.chain = chain_step(&summary.chain, round);
    Ok(())
}

/// Most the player's balance can reach if this bet wins, before rake (stake already counted).
/// The server refuses the bet when this exceeds `lock + max_win`.
pub fn worst_balance_after(balance: u128, game: Game, stake: u128, bet: &Bet) -> u128 {
    balance
        .saturating_sub(stake)
        .saturating_add(worst_case_payout(game, stake, bet))
}

/// Serde: 32 bytes as lowercase hex.
pub mod hex32 {
    use serde::{de, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8; 32], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex::encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<[u8; 32], D::Error> {
        let text = String::deserialize(deserializer)?;
        let mut out = [0u8; 32];
        hex::decode_to_slice(text, &mut out).map_err(de::Error::custom)?;
        Ok(out)
    }
}

/// Serde: 64 bytes (an ed25519 signature) as lowercase hex.
pub mod hex64 {
    use serde::{de, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8; 64], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex::encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<[u8; 64], D::Error> {
        let text = String::deserialize(deserializer)?;
        let mut out = [0u8; 64];
        hex::decode_to_slice(text, &mut out).map_err(de::Error::custom)?;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DiceBet, RouletteBet, RouletteSpot};

    const SEED: Hash32 = [7; 32];
    const CLIENT: &str = "lucky-seven";
    const RAKE: u16 = 100;
    const LOCK: u128 = 10_000_000;

    fn dice_bet() -> Bet {
        Bet::Dice(DiceBet {
            chance_bp: 5_000,
            over: true,
        })
    }

    fn public() -> SessionPublic<'static> {
        SessionPublic {
            server_seed_hash: server_seed_hash(&SEED),
            client_seed: CLIENT,
            game: Game::Dice,
            rake_bp: RAKE,
            lock: LOCK,
        }
    }

    /// Plays `n` dice rounds and settles them in batches of `per_batch`.
    fn played(n: u64, per_batch: usize) -> Vec<SettleBatch> {
        let mut balance = LOCK;
        let mut chain = server_seed_hash(&SEED);
        let rounds: Vec<CompactRound> = (1..=n)
            .map(|nonce| replay_round(&SEED, &public(), nonce, &dice_bet(), 100_000, &[]).unwrap())
            .collect();
        rounds
            .chunks(per_batch)
            .map(|chunk| {
                for round in chunk {
                    balance = balance - round.wager() + round.payout;
                    chain = chain_step(&chain, round);
                }
                SettleBatch {
                    session_id: "s".into(),
                    upto_nonce: chunk.last().unwrap().nonce,
                    balance,
                    chain,
                    rounds: chunk.to_vec(),
                    server_sig: [0; 64],
                }
            })
            .collect()
    }

    #[test]
    fn round_seed_is_deterministic_and_separated() {
        assert_eq!(round_seed(&SEED, CLIENT, 1), round_seed(&SEED, CLIENT, 1));
        assert_ne!(round_seed(&SEED, CLIENT, 1), round_seed(&SEED, CLIENT, 2));
        assert_ne!(round_seed(&SEED, CLIENT, 1), round_seed(&SEED, "other", 1));
        assert_ne!(
            round_seed(&SEED, CLIENT, 1),
            round_seed(&[8; 32], CLIENT, 1)
        );
        assert_eq!(round_seed(&SEED, CLIENT, 3), step_seed(&SEED, CLIENT, 3, 0));
        assert_ne!(
            step_seed(&SEED, CLIENT, 3, 1),
            step_seed(&SEED, CLIENT, 3, 0)
        );
        // "a:1" + step 1 must not collide with "a" + nonce "1:1": `:` is refused in client seeds.
        assert!(!client_seed_is_valid("a:1"));
    }

    /// The hand-written HMAC matches the reference implementation.
    #[test]
    fn round_seed_is_standard_hmac() {
        use hmac::{Hmac, Mac};
        for (nonce, step, text) in [(1, 0, "lucky-seven:1"), (42, 3, "lucky-seven:42:3")] {
            let mut mac = Hmac::<Sha256>::new_from_slice(&SEED).unwrap();
            mac.update(text.as_bytes());
            let expected: Hash32 = mac.finalize().into_bytes().into();
            assert_eq!(step_seed(&SEED, CLIENT, nonce, step), expected);
        }
    }

    #[test]
    fn client_seed_rules() {
        assert!(client_seed_is_valid("abc-123_XYZ"));
        assert!(!client_seed_is_valid(""));
        assert!(!client_seed_is_valid("has space"));
        assert!(!client_seed_is_valid(&"x".repeat(65)));
    }

    #[test]
    fn max_win_is_the_smaller_cap() {
        assert_eq!(session_max_win(1_000, 1_000_000), 10_000);
        assert_eq!(session_max_win(1_000_000, 1_000_000), 100_000);
    }

    #[test]
    fn resolve_matches_the_game_rules() {
        let seed = round_seed(&SEED, CLIENT, 1);
        let out = resolve_round(Game::Dice, &dice_bet(), 100_000, RAKE, &seed).unwrap();
        let Outcome::Dice { roll } = out.outcome else {
            panic!("dice outcome expected")
        };
        let gross = dice_gross(
            100_000,
            &DiceBet {
                chance_bp: 5_000,
                over: true,
            },
            roll,
        );
        assert_eq!(out.payout, apply_rake(gross, 100_000, RAKE));

        let red = Bet::Roulette(RouletteBet::Red);
        assert!(resolve_round(Game::Roulette, &red, 100_000, 0, &seed).is_ok());
        assert_eq!(
            resolve_round(Game::Dice, &red, 100_000, 0, &seed),
            Err(RoundError::InvalidBet)
        );
        assert_eq!(
            resolve_round(Game::Blackjack, &Bet::Blackjack, 100_000, 0, &seed),
            Err(RoundError::MultiStep)
        );
    }

    #[test]
    fn blackjack_replays_from_actions() {
        // Find a hand that is still live after the deal, then hit until it ends.
        let nonce = (1..100)
            .find(|&n| !BjSession::deal(&SEED, CLIENT, n, 100_000, RAKE).is_done())
            .unwrap();
        let mut hand = BjSession::deal(&SEED, CLIENT, nonce, 100_000, RAKE);
        while !hand.is_done() {
            hand.act(BjAction::Hit, &SEED, CLIENT).unwrap();
        }
        assert_eq!(hand.act(BjAction::Hit, &SEED, CLIENT), Err(BjError::Done));
        let round = hand.finish().unwrap();
        let session = SessionPublic {
            game: Game::Blackjack,
            ..public()
        };
        let replayed = replay_round(
            &SEED,
            &session,
            nonce,
            &Bet::Blackjack,
            100_000,
            &round.actions,
        )
        .unwrap();
        assert_eq!(replayed, round);
    }

    fn spots(list: &[(RouletteBet, u128)]) -> Bet {
        Bet::RouletteSpots(
            list.iter()
                .map(|&(bet, stake)| RouletteSpot { bet, stake })
                .collect(),
        )
    }

    fn roulette_public() -> SessionPublic<'static> {
        SessionPublic {
            game: Game::Roulette,
            ..public()
        }
    }

    /// One spin for every spot, drawn like a single bet of the same nonce; the payout is what
    /// each spot would have paid alone on that nonce.
    #[test]
    fn spots_spin_once_and_pay_the_sum_of_their_singles() {
        let chips = [
            (RouletteBet::Red, 300_000),
            (RouletteBet::Split(7, 10), 100_000),
            (RouletteBet::Corner(8), 200_000),
            (RouletteBet::Dozen(1), 100_000),
        ];
        let bet = spots(&chips);
        for nonce in 1..=60 {
            let round = replay_round(&SEED, &roulette_public(), nonce, &bet, 700_000, &[]).unwrap();
            assert_eq!(round.wager(), 700_000);
            let mut paid = 0;
            for (single, stake) in chips {
                let alone = replay_round(
                    &SEED,
                    &roulette_public(),
                    nonce,
                    &Bet::Roulette(single),
                    stake,
                    &[],
                )
                .unwrap();
                assert_eq!(alone.outcome, round.outcome);
                paid += alone.payout;
            }
            assert_eq!(round.payout, paid, "nonce {nonce}");
        }
    }

    #[test]
    fn spots_need_their_exact_total() {
        let bet = spots(&[(RouletteBet::Red, 100_000), (RouletteBet::Black, 100_000)]);
        let seed = round_seed(&SEED, CLIENT, 1);
        assert_eq!(
            resolve_round(Game::Roulette, &bet, 199_999, RAKE, &seed),
            Err(RoundError::InvalidBet)
        );
        assert!(resolve_round(Game::Roulette, &bet, 200_000, RAKE, &seed).is_ok());
        assert_eq!(
            resolve_round(Game::Dice, &bet, 200_000, RAKE, &seed),
            Err(RoundError::InvalidBet)
        );
    }

    #[test]
    fn stake_limits_apply_per_spot_and_to_the_total() {
        let max = 1_000_000;
        let two = spots(&[
            (RouletteBet::Red, 400_000),
            (RouletteBet::Street(1), 600_000),
        ]);
        assert!(stake_is_valid(&two, 1_000_000, max));
        assert!(!stake_is_valid(&two, 900_000, max), "wrong total");
        let over = spots(&[(RouletteBet::Red, 600_000), (RouletteBet::Black, 600_000)]);
        assert!(!stake_is_valid(&over, 1_200_000, max), "total over max bet");
        let tiny = spots(&[(RouletteBet::Red, 99_999), (RouletteBet::Black, 200_000)]);
        assert!(!stake_is_valid(&tiny, 299_999, max), "spot under min bet");
        let red = Bet::Roulette(RouletteBet::Red);
        assert!(stake_is_valid(&red, SESSION_MIN_BET, max));
        assert!(!stake_is_valid(&red, SESSION_MIN_BET - 1, max));
        assert!(!stake_is_valid(&red, max + 1, max));
    }

    #[test]
    fn verify_replays_spot_rounds_and_catches_a_moved_chip() {
        let bet = spots(&[
            (RouletteBet::Straight(17), 100_000),
            (RouletteBet::SixLine(13), 200_000),
        ]);
        let mut balance = LOCK;
        let mut chain = server_seed_hash(&SEED);
        let rounds: Vec<CompactRound> = (1..=20)
            .map(|nonce| {
                replay_round(&SEED, &roulette_public(), nonce, &bet, 300_000, &[]).unwrap()
            })
            .collect();
        for round in &rounds {
            balance = balance - round.wager() + round.payout;
            chain = chain_step(&chain, round);
        }
        let batch = SettleBatch {
            session_id: "s".into(),
            upto_nonce: 20,
            balance,
            chain,
            rounds,
            server_sig: [0; 64],
        };
        let summary =
            verify_session(&SEED, &roulette_public(), std::slice::from_ref(&batch)).unwrap();
        assert_eq!(summary.wagered, 20 * 300_000);

        let mut moved = batch;
        moved.rounds[3].bet = spots(&[
            (RouletteBet::Straight(18), 100_000),
            (RouletteBet::SixLine(13), 200_000),
        ]);
        // If both chips lose, the moved one replays to the same payout; the chain still binds it.
        assert!(matches!(
            verify_session(&SEED, &roulette_public(), &[moved]),
            Err(VerifyError::TamperedRound { nonce: 4 } | VerifyError::BrokenChain { .. })
        ));
    }

    /// A round hashed before multi-spot spins existed keeps its exact bytes.
    #[test]
    fn old_round_bytes_are_unchanged() {
        let round = CompactRound {
            nonce: 2,
            bet: Bet::Roulette(RouletteBet::Straight(17)),
            stake: 100_000,
            actions: Vec::new(),
            outcome: Outcome::Roulette { pocket: 17 },
            payout: 3_600_000,
        };
        let mut golden = vec![2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 17];
        golden.extend(100_000u128.to_le_bytes());
        golden.extend([0, 0, 0, 0, 1, 17]);
        golden.extend(3_600_000u128.to_le_bytes());
        assert_eq!(borsh::to_vec(&round).unwrap(), golden);
    }

    #[test]
    fn verify_accepts_an_honest_session() {
        let batches = played(120, 50);
        let summary = verify_session(&SEED, &public(), &batches).unwrap();
        assert_eq!(summary.rounds, 120);
        assert_eq!(summary.chain, batches.last().unwrap().chain);
        assert_eq!(summary.balance, LOCK + summary.paid - summary.wagered);
    }

    #[test]
    fn verify_detects_a_wrong_seed() {
        assert_eq!(
            verify_session(&[8; 32], &public(), &played(3, 50)),
            Err(VerifyError::WrongSeed)
        );
    }

    #[test]
    fn verify_detects_a_tampered_round() {
        let mut batches = played(10, 50);
        let round = &mut batches[0].rounds[4];
        round.payout += 1;
        assert_eq!(
            verify_session(&SEED, &public(), &batches),
            Err(VerifyError::TamperedRound { nonce: 5 })
        );
        let mut batches = played(10, 50);
        if let Outcome::Dice { roll } = &mut batches[0].rounds[2].outcome {
            *roll = (*roll + 1) % 10_000;
        }
        assert_eq!(
            verify_session(&SEED, &public(), &batches),
            Err(VerifyError::TamperedRound { nonce: 3 })
        );
    }

    #[test]
    fn verify_detects_a_broken_chain() {
        let mut batches = played(10, 5);
        batches[1].chain[0] ^= 1;
        assert_eq!(
            verify_session(&SEED, &public(), &batches),
            Err(VerifyError::BrokenChain { upto_nonce: 10 })
        );
        // A dropped round shows as a nonce gap.
        let mut batches = played(10, 5);
        batches[1].rounds.remove(0);
        assert_eq!(
            verify_session(&SEED, &public(), &batches),
            Err(VerifyError::NonceGap {
                expected: 6,
                got: 7
            })
        );
    }

    #[test]
    fn verify_detects_a_wrong_balance() {
        let mut batches = played(10, 5);
        batches[0].balance += 1;
        assert_eq!(
            verify_session(&SEED, &public(), &batches),
            Err(VerifyError::WrongBalance { upto_nonce: 5 })
        );
    }

    #[test]
    fn signed_messages_are_domain_separated() {
        let state = SessionState {
            session_id: "s".into(),
            nonce: 1,
            balance: 5,
            chain: [1; 32],
        };
        assert!(state_message(&state).starts_with(STATE_DOMAIN));
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains(r#""balance":"5""#));
        assert!(json.contains(&hex::encode([1u8; 32])));
    }
}
