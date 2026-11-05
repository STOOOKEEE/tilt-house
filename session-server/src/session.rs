//! One session's state machine (docs/sessions.md step 3). Pure: no I/O, time passed in.
//! Every change is an `Event`: `play` validates a request and returns the event, the caller
//! persists it, then `apply` makes it real. Reloading the log replays the same `apply`.

use core_rules::session::{
    replay_round, state_message, worst_balance_after, BjAction, BjSession, CompactRound, Hash32,
    SessionPublic, SessionState, SessionTicket, SettleBatch, SESSION_MIN_BET, SETTLE_EVERY_ROUNDS,
    SETTLE_EVERY_SECS,
};
use core_rules::{Bet, BjError};
use serde::{Deserialize, Serialize};

use crate::keys::Signer;
use crate::store::Event;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Open,
    Closing,
    Closed,
}

/// `{"nonce": 1, "bet": {"dice": {...}}, "stake": "1000000"}` starts round `nonce`;
/// `{"nonce": 1, "action": "hit"}` plays the live blackjack hand of round `nonce`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum RoundRequest {
    Bet {
        nonce: u64,
        bet: Bet,
        #[serde(with = "core_rules::amount_str")]
        stake: u128,
    },
    Action {
        nonce: u64,
        action: BjAction,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlayError {
    NotOpen,
    WrongNonce {
        expected: u64,
    },
    HandInProgress,
    NoHand,
    InvalidBet,
    StakeOutOfRange {
        min: u128,
        max: u128,
    },
    /// The stake (or a double) is more than the session balance: the player can never lose more
    /// than the lock.
    OverLock,
    /// If this bet won, the session would be up more than its reserved `max_win`.
    OverMaxWin,
    Blackjack(BjError),
}

impl std::fmt::Display for PlayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotOpen => f.write_str("session is closing or closed"),
            Self::WrongNonce { expected } => write!(f, "expected nonce {expected}"),
            Self::HandInProgress => f.write_str("finish the blackjack hand first"),
            Self::NoHand => f.write_str("no blackjack hand in progress for this nonce"),
            Self::InvalidBet => f.write_str("invalid bet for this table"),
            Self::StakeOutOfRange { min, max } => write!(f, "stake must be in {min}..={max}"),
            Self::OverLock => f.write_str("stake exceeds the session balance"),
            Self::OverMaxWin => f.write_str("a win would exceed the session's max win"),
            Self::Blackjack(err) => err.fmt(f),
        }
    }
}

pub struct Session {
    pub ticket: SessionTicket,
    pub ticket_sig: [u8; 64],
    pub token: String,
    pub server_seed: Hash32,
    /// `open_session` seen on chain; no round is played before.
    pub opened: bool,
    /// Latest signed state and its signature.
    pub state: SessionState,
    pub state_sig: [u8; 64],
    /// Every finished round; `rounds[n - 1]` has nonce n.
    pub rounds: Vec<CompactRound>,
    pub hand: Option<BjSession>,
    pub settled_upto: u64,
    pub last_settle_at: u64,
    pub last_activity: u64,
    pub phase: Phase,
    /// A chain call (settle or close) is in flight; in memory only.
    pub chain_busy: bool,
}

impl Session {
    pub fn new(
        ticket: SessionTicket,
        server_seed: Hash32,
        token: String,
        at: u64,
        signer: &Signer,
    ) -> Self {
        let state = SessionState {
            session_id: ticket.session_id.clone(),
            nonce: 0,
            balance: ticket.lock,
            chain: ticket.server_seed_hash,
        };
        let ticket_sig = signer.sign(&core_rules::session::ticket_message(&ticket));
        let state_sig = signer.sign(&state_message(&state));
        Self {
            ticket,
            ticket_sig,
            token,
            server_seed,
            opened: false,
            state,
            state_sig,
            rounds: Vec::new(),
            hand: None,
            settled_upto: 0,
            last_settle_at: at,
            last_activity: at,
            phase: Phase::Open,
            chain_busy: false,
        }
    }

    fn public(&self) -> SessionPublic<'_> {
        SessionPublic {
            server_seed_hash: self.ticket.server_seed_hash,
            client_seed: &self.ticket.client_seed,
            game: self.ticket.game,
            rake_bp: self.ticket.rake_bp,
            lock: self.ticket.lock,
        }
    }

    /// Validates a round request against the session's limits and computes its event.
    pub fn play(&self, request: &RoundRequest, at: u64) -> Result<Event, PlayError> {
        if self.phase != Phase::Open {
            return Err(PlayError::NotOpen);
        }
        match *request {
            RoundRequest::Bet { nonce, bet, stake } => self.new_round(nonce, &bet, stake, at),
            RoundRequest::Action { nonce, action } => self.act(nonce, action, at),
        }
    }

    fn new_round(&self, nonce: u64, bet: &Bet, stake: u128, at: u64) -> Result<Event, PlayError> {
        if self.hand.is_some() {
            return Err(PlayError::HandInProgress);
        }
        let expected = self.state.nonce + 1;
        if nonce != expected {
            return Err(PlayError::WrongNonce { expected });
        }
        self.check_bet(bet, stake)?;
        if *bet == Bet::Blackjack {
            let hand = BjSession::deal(
                &self.server_seed,
                &self.ticket.client_seed,
                nonce,
                stake,
                self.ticket.rake_bp,
            );
            return Ok(self.hand_event(hand, at));
        }
        let round = replay_round(&self.server_seed, &self.public(), nonce, bet, stake, &[])
            .map_err(|_| PlayError::InvalidBet)?;
        Ok(self.round_event(round, at))
    }

    /// The limits of docs/sessions.md: table max bet, never more than the balance (the lock
    /// bounds the loss), never a win past `max_win`. Blackjack's worst case already counts a
    /// winning double, so doubling never needs a new check against `max_win`.
    fn check_bet(&self, bet: &Bet, stake: u128) -> Result<(), PlayError> {
        if bet.game() != self.ticket.game || !bet.is_valid() {
            return Err(PlayError::InvalidBet);
        }
        let max = self.ticket.max_bet;
        if !(SESSION_MIN_BET..=max).contains(&stake) {
            return Err(PlayError::StakeOutOfRange {
                min: SESSION_MIN_BET,
                max,
            });
        }
        if stake > self.state.balance {
            return Err(PlayError::OverLock);
        }
        let ceiling = self.ticket.lock.saturating_add(self.ticket.max_win);
        if worst_balance_after(self.state.balance, self.ticket.game, stake, bet) > ceiling {
            return Err(PlayError::OverMaxWin);
        }
        Ok(())
    }

    fn act(&self, nonce: u64, action: BjAction, at: u64) -> Result<Event, PlayError> {
        let Some(hand) = self.hand.as_ref().filter(|hand| hand.nonce == nonce) else {
            return Err(PlayError::NoHand);
        };
        if action == BjAction::Double && hand.stake.saturating_mul(2) > self.state.balance {
            return Err(PlayError::OverLock);
        }
        let mut hand = hand.clone();
        hand.act(action, &self.server_seed, &self.ticket.client_seed)
            .map_err(PlayError::Blackjack)?;
        Ok(self.hand_event(hand, at))
    }

    /// At close a live hand stands, so the player cannot walk away from a bad hand.
    pub fn stand_for_close(&self, at: u64) -> Option<Event> {
        let mut hand = self.hand.clone()?;
        // Standing a live hand always ends it; a done hand was never kept live.
        hand.act(BjAction::Stand, &self.server_seed, &self.ticket.client_seed)
            .ok()?;
        Some(self.hand_event(hand, at))
    }

    fn hand_event(&self, hand: BjSession, at: u64) -> Event {
        match hand.finish() {
            Some(round) => self.round_event(round, at),
            None => Event::Hand {
                session_id: self.ticket.session_id.clone(),
                hand,
                at,
            },
        }
    }

    fn round_event(&self, round: CompactRound, at: u64) -> Event {
        Event::Round {
            session_id: self.ticket.session_id.clone(),
            round,
            at,
        }
    }

    /// Applies a persisted event. Errors only on a log that contradicts itself.
    pub fn apply(&mut self, event: &Event, signer: &Signer) -> anyhow::Result<()> {
        match event {
            Event::Created { .. } => anyhow::bail!("session created twice"),
            Event::Opened { .. } => self.opened = true,
            Event::Hand { hand, at, .. } => {
                self.hand = Some(hand.clone());
                self.last_activity = *at;
            }
            Event::Round { round, at, .. } => {
                self.apply_round(round)?;
                self.state_sig = signer.sign(&state_message(&self.state));
                self.last_activity = *at;
            }
            Event::Settled { upto_nonce, at, .. } => {
                self.settled_upto = self.settled_upto.max(*upto_nonce);
                self.last_settle_at = *at;
            }
            Event::Closing { .. } => self.phase = Phase::Closing,
            Event::Closed { .. } => self.phase = Phase::Closed,
        }
        Ok(())
    }

    fn apply_round(&mut self, round: &CompactRound) -> anyhow::Result<()> {
        anyhow::ensure!(round.nonce == self.state.nonce + 1, "round out of order");
        self.state.balance = self
            .state
            .balance
            .checked_sub(round.wager())
            .and_then(|b| b.checked_add(round.payout))
            .ok_or_else(|| anyhow::anyhow!("round {} breaks the balance", round.nonce))?;
        self.state.nonce = round.nonce;
        self.state.chain = core_rules::session::chain_step(&self.state.chain, round);
        self.rounds.push(round.clone());
        self.hand = None;
        Ok(())
    }

    fn pending(&self) -> u64 {
        self.state.nonce - self.settled_upto
    }

    pub fn settle_due(&self, now: u64) -> bool {
        let pending = self.pending();
        pending >= SETTLE_EVERY_ROUNDS
            || (pending > 0 && now.saturating_sub(self.last_settle_at) >= SETTLE_EVERY_SECS)
    }

    /// Rounds not yet settled, with the signed state that ends them.
    pub fn pending_batch(&self) -> Option<SettleBatch> {
        if self.pending() == 0 {
            return None;
        }
        let from = usize::try_from(self.settled_upto).ok()?;
        Some(SettleBatch {
            session_id: self.ticket.session_id.clone(),
            upto_nonce: self.state.nonce,
            balance: self.state.balance,
            chain: self.state.chain,
            rounds: self.rounds.get(from..)?.to_vec(),
            server_sig: self.state_sig,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_rules::session::{server_seed_hash, verify_session};
    use core_rules::{DiceBet, Game, RouletteBet};

    const LOCK: u128 = 10_000_000;

    fn session(game: Game, max_win: u128) -> (Session, Signer) {
        let signer = Signer::random().unwrap();
        let seed = [3; 32];
        let ticket = SessionTicket {
            session_id: "s1".into(),
            player: "alice.testnet".into(),
            dealer_id: "d".into(),
            game,
            lock: LOCK,
            server_seed_hash: server_seed_hash(&seed),
            client_seed: "c".into(),
            rake_bp: 100,
            max_bet: 5_000_000,
            max_win,
            expires_at: 100,
        };
        let session = Session::new(ticket, seed, "t".into(), 0, &signer);
        (session, signer)
    }

    fn dice(chance_bp: u16) -> Bet {
        Bet::Dice(DiceBet {
            chance_bp,
            over: false,
        })
    }

    fn bet(nonce: u64, bet: Bet, stake: u128) -> RoundRequest {
        RoundRequest::Bet { nonce, bet, stake }
    }

    fn play(
        session: &mut Session,
        signer: &Signer,
        request: RoundRequest,
    ) -> Result<Event, PlayError> {
        let event = session.play(&request, 1)?;
        session.apply(&event, signer).unwrap();
        Ok(event)
    }

    #[test]
    fn refuses_bets_past_the_limits() {
        let (mut s, signer) = session(Game::Dice, 20_000_000);
        // Table max bet.
        assert!(matches!(
            s.play(&bet(1, dice(5_000), 5_000_001), 1),
            Err(PlayError::StakeOutOfRange { .. })
        ));
        assert!(matches!(
            s.play(&bet(1, dice(5_000), SESSION_MIN_BET - 1), 1),
            Err(PlayError::StakeOutOfRange { .. })
        ));
        // 1 % chance at 1 USDC pays 100 USDC: more than the 20 USDC max win.
        assert_eq!(
            s.play(&bet(1, dice(100), 1_000_000), 1),
            Err(PlayError::OverMaxWin)
        );
        assert_eq!(
            s.play(&bet(1, Bet::Roulette(RouletteBet::Red), 1_000_000), 1),
            Err(PlayError::InvalidBet)
        );
        assert_eq!(
            s.play(&bet(2, dice(5_000), 1_000_000), 1),
            Err(PlayError::WrongNonce { expected: 1 })
        );
        // Within every limit: accepted.
        play(&mut s, &signer, bet(1, dice(5_000), 1_000_000)).unwrap();
    }

    #[test]
    fn stake_above_balance_is_over_lock() {
        let (mut s, _) = session(Game::Dice, 20_000_000);
        s.state.balance = 1_000_000;
        assert_eq!(
            s.play(&bet(1, dice(5_000), 2_000_000), 1),
            Err(PlayError::OverLock)
        );
    }

    #[test]
    fn rounds_chain_and_verify() {
        let (mut s, signer) = session(Game::Dice, 100_000_000);
        for nonce in 1..=60 {
            play(&mut s, &signer, bet(nonce, dice(5_000), 100_000)).unwrap();
        }
        assert!(s.settle_due(0));
        let batch = s.pending_batch().unwrap();
        assert_eq!(batch.rounds.len(), 60);
        let summary = verify_session(&s.server_seed, &s.public(), &[batch]).unwrap();
        assert_eq!(summary.balance, s.state.balance);
    }

    #[test]
    fn blackjack_hand_then_close_stands() {
        let (mut s, signer) = session(Game::Blackjack, 100_000_000);
        // Deal until a hand stays live.
        let mut nonce = 1;
        loop {
            play(&mut s, &signer, bet(nonce, Bet::Blackjack, 1_000_000)).unwrap();
            if s.hand.is_some() {
                break;
            }
            nonce += 1;
        }
        assert_eq!(
            s.play(&bet(nonce + 1, Bet::Blackjack, 1_000_000), 1),
            Err(PlayError::HandInProgress)
        );
        assert_eq!(
            s.play(
                &RoundRequest::Action {
                    nonce: nonce + 1,
                    action: BjAction::Hit
                },
                1
            ),
            Err(PlayError::NoHand)
        );
        let event = s.stand_for_close(2).unwrap();
        s.apply(&event, &signer).unwrap();
        assert!(s.hand.is_none());
        assert_eq!(s.state.nonce, nonce);
        let batch = s.pending_batch().unwrap();
        verify_session(&s.server_seed, &s.public(), &[batch]).unwrap();
    }

    #[test]
    fn double_needs_the_balance() {
        let (mut s, signer) = session(Game::Blackjack, 100_000_000);
        s.state.balance = 1_500_000;
        let mut nonce = 1;
        loop {
            s.state.balance = 1_500_000;
            play(&mut s, &signer, bet(nonce, Bet::Blackjack, 1_000_000)).unwrap();
            if s.hand.is_some() {
                break;
            }
            nonce += 1;
        }
        assert_eq!(
            s.play(
                &RoundRequest::Action {
                    nonce,
                    action: BjAction::Double
                },
                1
            ),
            Err(PlayError::OverLock)
        );
    }

    #[test]
    fn request_json_shapes() {
        let bet: RoundRequest = serde_json::from_str(
            r#"{"nonce":1,"bet":{"dice":{"chance_bp":5000,"over":true}},"stake":"100000"}"#,
        )
        .unwrap();
        assert!(matches!(
            bet,
            RoundRequest::Bet {
                nonce: 1,
                stake: 100_000,
                ..
            }
        ));
        let action: RoundRequest =
            serde_json::from_str(r#"{"nonce":3,"action":"double"}"#).unwrap();
        assert_eq!(
            action,
            RoundRequest::Action {
                nonce: 3,
                action: BjAction::Double
            }
        );
    }
}
