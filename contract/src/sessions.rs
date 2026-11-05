//! Provably fair sessions (docs/sessions.md). The session server plays the rounds off chain; the
//! contract holds the player's lock in escrow, reserves the session's max win on the dealer's
//! pool, applies signed batches of rounds, draws the jackpot for each round and pays out at
//! close, with a forced exit if the server stops answering.
//!
//! Books: `escrow` is the player's session balance at the last settled state; the pool reserves
//! `reserve = lock + max_win − escrow`, the most the session can still take from it.

use core_rules::session::{
    chain_step, client_seed_is_valid, server_seed_hash, session_max_win, state_message,
    ticket_message, CompactRound, Hash32, SessionState, SessionTicket, SettleBatch,
    REVEAL_TIMEOUT_SECS, SESSION_MIN_BET, SESSION_TIMEOUT_SECS,
};
use core_rules::{draw_jackpot, rake_bounds, worst_case_payout, Game, Pool};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::serde::de::DeserializeOwned;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, require, AccountId};

use crate::dealers::LogKind;
use crate::{emit, fail, now, parse_hex, House, HouseExt, Player, SESSIONS_PER_PLAYER};

const MAX_SESSION_ID_LEN: usize = 64;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Open,
    /// Paid out from the player's last signed state; the reserve waits for the seed.
    ForceClosed,
    /// Seed revealed, everything paid.
    Closed,
    /// The seed was never revealed: the player took the whole reserve.
    Forfeited,
}

impl SessionStatus {
    pub fn is_done(self) -> bool {
        matches!(self, Self::Closed | Self::Forfeited)
    }
}

// Plain borsh derives: core types carry no `BorshSchema` for the contract ABI.
#[derive(Clone, BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Session {
    pub id: String,
    pub player: AccountId,
    pub dealer_id: String,
    pub game: Game,
    pub lock: u128,
    pub rake_bp: u16,
    pub max_bet: u128,
    pub max_win: u128,
    pub server_seed_hash: Hash32,
    pub client_seed: String,
    pub status: SessionStatus,
    pub opened_at: u64,
    /// Last open or settle: the timeouts run from here.
    pub last_settle_at: u64,
    pub closed_at: u64,
    pub settled_nonce: u64,
    pub chain: Hash32,
    pub escrow: u128,
    pub reserve: u128,
    pub wagered: u128,
    pub paid: u128,
    pub jackpot_won: u128,
    /// Paid to the player's balance (jackpots excluded).
    pub paid_out: u128,
    pub server_seed: Option<Hash32>,
}

impl Session {
    fn ceiling(&self) -> u128 {
        self.lock.saturating_add(self.max_win)
    }

    pub fn force_close_after(&self) -> u64 {
        self.last_settle_at.saturating_add(SESSION_TIMEOUT_SECS)
    }

    pub fn claim_after(&self) -> u64 {
        self.last_settle_at.saturating_add(REVEAL_TIMEOUT_SECS)
    }
}

fn from_json<T: DeserializeOwned>(value: Value, what: &str) -> T {
    serde_json::from_value(value).unwrap_or_else(|e| fail(&format!("{what}: {e}")))
}

fn valid_session_id(id: &str) -> bool {
    (1..=MAX_SESSION_ID_LEN).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Moves the session's escrow to `balance`: the difference comes from (or goes to) the pool,
/// keeping `reserve = lock + max_win − escrow`. `balance ≤ lock + max_win` is checked first, so
/// a win never exceeds the reserve the pool set aside.
fn rebalance(session: &mut Session, pool: &mut Pool, balance: u128) {
    require!(balance <= session.ceiling(), "balance above lock + max_win");
    if balance > session.escrow {
        let win = balance - session.escrow;
        require!(
            win <= session.reserve && win <= pool.reserved && win <= pool.bankroll,
            "pool accounting"
        );
        pool.bankroll -= win;
        pool.reserved -= win;
        session.reserve -= win;
    } else {
        let loss = session.escrow - balance;
        pool.bankroll = pool
            .bankroll
            .checked_add(loss)
            .unwrap_or_else(|| fail("pool overflow"));
        pool.reserved = pool
            .reserved
            .checked_add(loss)
            .unwrap_or_else(|| fail("pool overflow"));
        session.reserve = session.reserve.saturating_add(loss);
    }
    session.escrow = balance;
}

/// Frees what the pool still reserves for the session (back to its free bankroll).
fn release_reserve(session: &mut Session, pool: &mut Pool) {
    require!(session.reserve <= pool.reserved, "pool accounting");
    pool.reserved -= session.reserve;
    session.reserve = 0;
}

/// The pool loses what it still reserves for the session: it joins the escrow, so the player
/// ends with `lock + max_win` in total (escrow + reserve + paid out always add up to it).
fn forfeit_reserve(session: &mut Session, pool: &mut Pool) {
    let reserve = session.reserve;
    require!(
        reserve <= pool.reserved && reserve <= pool.bankroll,
        "pool accounting"
    );
    pool.bankroll -= reserve;
    pool.reserved -= reserve;
    session.reserve = 0;
    session.escrow = session
        .escrow
        .checked_add(reserve)
        .unwrap_or_else(|| fail("escrow overflow"));
}

/// The rounds checked against the session rules; returns `(wagered, paid, chains)` where
/// `chains[i]` is the hash chain right after round i.
fn check_rounds(session: &Session, batch: &SettleBatch) -> (u128, u128, Vec<Hash32>) {
    require!(
        !batch.rounds.is_empty(),
        "a settle needs at least one round"
    );
    let mut running = session.escrow;
    let mut chain = session.chain;
    let mut chains = Vec::with_capacity(batch.rounds.len());
    let (mut wagered, mut paid) = (0u128, 0u128);
    for (i, round) in batch.rounds.iter().enumerate() {
        let expected = session.settled_nonce + 1 + i as u64;
        require!(
            round.nonce == expected,
            "round nonces must follow the last settle"
        );
        check_round(session, round);
        let wager = round.wager();
        require!(
            wager <= running,
            "a round wagered more than the session balance"
        );
        running = running - wager + round.payout;
        require!(running <= session.ceiling(), "balance above lock + max_win");
        wagered = wagered.saturating_add(wager);
        paid = paid.saturating_add(round.payout);
        chain = chain_step(&chain, round);
        chains.push(chain);
    }
    require!(
        batch.upto_nonce == session.settled_nonce + batch.rounds.len() as u64,
        "upto_nonce is not the last round"
    );
    require!(
        running == batch.balance,
        "balance does not follow from the rounds"
    );
    require!(chain == batch.chain, "hash chain broken");
    (wagered, paid, chains)
}

fn check_round(session: &Session, round: &CompactRound) {
    require!(
        round.bet.game() == session.game && round.bet.is_valid(),
        "a round's bet is not valid for this game"
    );
    require!(
        round.stake >= SESSION_MIN_BET && round.stake <= session.max_bet,
        "a round's stake is outside the session's limits"
    );
    require!(
        round.payout <= worst_case_payout(session.game, round.stake, &round.bet),
        "a round pays more than its bet can"
    );
}

#[near]
impl House {
    /// The player opens the session the server offered (`ticket`, signed by the server).
    pub fn open_session(&mut self, ticket: Value, server_sig: String) {
        let ticket: SessionTicket = from_json(ticket, "ticket");
        let sig = parse_hex::<64>(&server_sig, "server_sig");
        self.check_server_sig(&ticket_message(&ticket), &sig);
        let now = now();
        require!(now <= ticket.expires_at, "the ticket has expired");
        let player_id = env::predecessor_account_id();
        require!(
            ticket.player == player_id.as_str(),
            "the ticket is for another player"
        );
        require!(valid_session_id(&ticket.session_id), "bad session id");
        require!(
            !self.sessions.contains_key(&ticket.session_id),
            "session id already used"
        );
        require!(
            client_seed_is_valid(&ticket.client_seed),
            "client seed: 1-64 printable characters, no ':'"
        );
        let mut player = self.player(&player_id);
        require!(
            player.open_session.is_none(),
            "close your open session first"
        );
        let mut dealer = self.dealer(&ticket.dealer_id);
        self.settle_rent(&mut dealer, now);
        require!(
            self.floor.seat_of(&dealer.id).is_some(),
            "the table is not on the floor"
        );
        require!(dealer.is_open(), "the table is closed");
        require!(ticket.game == dealer.game, "wrong game for this table");
        let (min_rake, max_rake) = rake_bounds(dealer.game);
        require!(
            (min_rake..=max_rake).contains(&ticket.rake_bp)
                && ticket.rake_bp >= dealer.offer.effective_rake_bp(dealer.game, now),
            "rake differs from the table's offer"
        );
        require!(
            ticket.max_bet >= SESSION_MIN_BET && ticket.max_bet <= dealer.max_bet(),
            "max bet above what the table offers"
        );
        require!(ticket.lock >= SESSION_MIN_BET, "lock below the minimum bet");
        require!(
            ticket.max_win <= session_max_win(ticket.lock, dealer.pool.free()),
            "max win above what the pool can reserve"
        );
        require!(player.balance >= ticket.lock, "not enough balance");
        player.balance -= ticket.lock;
        dealer.pool.reserved = dealer
            .pool
            .reserved
            .checked_add(ticket.max_win)
            .unwrap_or_else(|| fail("pool overflow"));
        dealer.open_sessions = dealer.open_sessions.saturating_add(1);
        dealer.record_session(now);
        let session = Session {
            id: ticket.session_id.clone(),
            player: player_id.clone(),
            dealer_id: dealer.id.clone(),
            game: dealer.game,
            lock: ticket.lock,
            rake_bp: ticket.rake_bp,
            max_bet: ticket.max_bet,
            max_win: ticket.max_win,
            server_seed_hash: ticket.server_seed_hash,
            client_seed: ticket.client_seed.clone(),
            status: SessionStatus::Open,
            opened_at: now,
            last_settle_at: now,
            closed_at: 0,
            settled_nonce: 0,
            chain: ticket.server_seed_hash,
            escrow: ticket.lock,
            reserve: ticket.max_win,
            wagered: 0,
            paid: 0,
            jackpot_won: 0,
            paid_out: 0,
            server_seed: None,
        };
        player.open_session = Some(session.id.clone());
        self.remember_session(&mut player, &session.id);
        self.save_player(&player_id, player);
        self.save_dealer(dealer);
        emit(
            "session_opened",
            json!({
                "session_id": session.id,
                "player": session.player,
                "dealer_id": session.dealer_id,
                "lock": session.lock.to_string(),
                "max_win": session.max_win.to_string(),
                "rake_bp": session.rake_bp,
                "max_bet": session.max_bet.to_string(),
            }),
        );
        self.sessions.insert(session.id.clone(), session);
    }

    /// Anyone (the server): applies a signed batch of rounds. The rounds stay public in the
    /// transaction args; outcomes are checked against the seed at close (by verifiers).
    pub fn settle_session(&mut self, batch: Value) {
        let batch: SettleBatch = from_json(batch, "batch");
        let mut session = self.session(&batch.session_id);
        require!(
            session.status == SessionStatus::Open,
            "the session is not open"
        );
        let (wagered, paid, chains) = check_rounds(&session, &batch);
        let state = SessionState {
            session_id: batch.session_id.clone(),
            nonce: batch.upto_nonce,
            balance: batch.balance,
            chain: batch.chain,
        };
        self.check_server_sig(&state_message(&state), &batch.server_sig);
        let now = now();
        let mut dealer = self.dealer(&session.dealer_id);
        self.settle_rent(&mut dealer, now);
        rebalance(&mut session, &mut dealer.pool, batch.balance);
        let rounds = batch.rounds.len();
        dealer.record_rounds(
            now,
            u32::try_from(rounds).unwrap_or(u32::MAX),
            wagered,
            paid,
        );
        session.settled_nonce = batch.upto_nonce;
        session.chain = batch.chain;
        session.last_settle_at = now;
        session.wagered = session.wagered.saturating_add(wagered);
        session.paid = session.paid.saturating_add(paid);
        for (round, chain) in batch.rounds.iter().zip(&chains) {
            let won = draw_jackpot(&mut self.floor.jackpot, chain, round.wager());
            if won > 0 {
                session.jackpot_won = session.jackpot_won.saturating_add(won);
                self.pay_jackpot(&mut dealer, &session, round.nonce, won);
            }
        }
        self.save_dealer(dealer);
        emit(
            "session_settled",
            json!({
                "session_id": session.id,
                "upto_nonce": session.settled_nonce,
                "balance": session.escrow.to_string(),
                "rounds": rounds,
            }),
        );
        self.sessions.insert(session.id.clone(), session);
    }

    /// Reveals the server seed and ends the session; the last settled state counts. Knowing the
    /// seed is the authorization: the server closes after its final settle, or hands the seed to
    /// the player, who closes through the relayer (docs/sessions.md step 5).
    pub fn close_session(&mut self, session_id: String, server_seed: String) {
        let seed = parse_hex::<32>(&server_seed, "server_seed");
        let mut session = self.session(&session_id);
        require!(
            server_seed_hash(&seed) == session.server_seed_hash,
            "the seed does not match its hash"
        );
        let now = now();
        let mut dealer = self.dealer(&session.dealer_id);
        self.settle_rent(&mut dealer, now);
        match session.status {
            SessionStatus::Open => {
                self.pay_escrow(&mut session);
                dealer.open_sessions = dealer.open_sessions.saturating_sub(1);
            }
            SessionStatus::ForceClosed => {}
            _ => fail("the session is already closed"),
        }
        release_reserve(&mut session, &mut dealer.pool);
        session.status = SessionStatus::Closed;
        session.server_seed = Some(seed);
        session.closed_at = now;
        self.save_dealer(dealer);
        emit(
            "session_revealed",
            json!({
                "session_id": session.id,
                "server_seed": server_seed.to_lowercase(),
                "paid_out": session.paid_out.to_string(),
            }),
        );
        self.sessions.insert(session.id.clone(), session);
    }

    /// The player exits with the server's last signed state once the server has been silent for
    /// `SESSION_TIMEOUT_SECS`. The reserve stays held until the seed is revealed.
    pub fn force_close(&mut self, session_id: String, state: Value, server_sig: String) {
        let state: SessionState = from_json(state, "state");
        let sig = parse_hex::<64>(&server_sig, "server_sig");
        let mut session = self.session(&session_id);
        require!(
            session.status == SessionStatus::Open,
            "the session is not open"
        );
        require!(
            env::predecessor_account_id() == session.player,
            "only the player can force-close"
        );
        let now = now();
        require!(
            now >= session.force_close_after(),
            "the server still has time to settle"
        );
        require!(state.session_id == session.id, "state of another session");
        self.check_server_sig(&state_message(&state), &sig);
        require!(
            state.nonce >= session.settled_nonce,
            "state older than the last settle"
        );
        if state.nonce == session.settled_nonce {
            require!(
                state.balance == session.escrow && state.chain == session.chain,
                "state differs from the settled one"
            );
        }
        let mut dealer = self.dealer(&session.dealer_id);
        self.settle_rent(&mut dealer, now);
        rebalance(&mut session, &mut dealer.pool, state.balance);
        session.settled_nonce = state.nonce;
        session.chain = state.chain;
        // The reveal timer of `claim_unrevealed` runs from here.
        session.last_settle_at = now;
        self.pay_escrow(&mut session);
        dealer.open_sessions = dealer.open_sessions.saturating_sub(1);
        if state.nonce == 0 {
            // No round was played: nothing to reveal.
            release_reserve(&mut session, &mut dealer.pool);
            session.status = SessionStatus::Closed;
            session.closed_at = now;
        } else {
            session.status = SessionStatus::ForceClosed;
        }
        self.save_dealer(dealer);
        emit(
            "session_force_closed",
            json!({
                "session_id": session.id,
                "nonce": state.nonce,
                "balance": state.balance.to_string(),
            }),
        );
        self.sessions.insert(session.id.clone(), session);
    }

    /// The server never revealed the seed of a session with rounds: the player takes
    /// `lock + max_win` in total (the server loses for hiding its seed).
    pub fn claim_unrevealed(&mut self, session_id: String) {
        let mut session = self.session(&session_id);
        require!(
            matches!(
                session.status,
                SessionStatus::Open | SessionStatus::ForceClosed
            ),
            "the session is closed"
        );
        require!(
            env::predecessor_account_id() == session.player,
            "only the player can claim"
        );
        require!(session.settled_nonce > 0, "no round to reveal");
        let now = now();
        require!(
            now >= session.claim_after(),
            "the server still has time to reveal"
        );
        let mut dealer = self.dealer(&session.dealer_id);
        self.settle_rent(&mut dealer, now);
        if session.status == SessionStatus::Open {
            dealer.open_sessions = dealer.open_sessions.saturating_sub(1);
        }
        forfeit_reserve(&mut session, &mut dealer.pool);
        self.pay_escrow(&mut session);
        session.status = SessionStatus::Forfeited;
        session.closed_at = now;
        self.save_dealer(dealer);
        emit(
            "session_forfeited",
            json!({ "session_id": session.id, "paid": session.paid_out.to_string() }),
        );
        self.sessions.insert(session.id.clone(), session);
    }
}

impl House {
    pub(crate) fn session(&self, id: &str) -> Session {
        self.sessions
            .get(id)
            .cloned()
            .unwrap_or_else(|| fail("unknown session"))
    }

    fn check_server_sig(&self, message: &[u8], sig: &[u8; 64]) {
        require!(
            env::ed25519_verify(sig, message, &self.server_pubkey),
            "bad server signature"
        );
    }

    /// Escrow to the player's balance; the player's open session slot is freed.
    fn pay_escrow(&mut self, session: &mut Session) {
        let amount = session.escrow;
        session.escrow = 0;
        session.paid_out = session.paid_out.saturating_add(amount);
        let mut player = self.player(&session.player);
        player.balance = player
            .balance
            .checked_add(amount)
            .unwrap_or_else(|| fail("balance overflow"));
        if player.open_session.as_deref() == Some(session.id.as_str()) {
            player.open_session = None;
        }
        self.save_player(&session.player, player);
    }

    fn pay_jackpot(
        &mut self,
        dealer: &mut crate::Dealer,
        session: &Session,
        nonce: u64,
        amount: u128,
    ) {
        self.credit(&session.player, amount);
        self.log(
            dealer,
            LogKind::Jackpot,
            Some(session.player.clone()),
            amount,
            session.id.clone(),
        );
        emit(
            "jackpot",
            json!({
                "account_id": session.player,
                "dealer_id": dealer.id,
                "session_id": session.id,
                "nonce": nonce,
                "amount": amount.to_string(),
            }),
        );
    }

    /// Keeps the last `SESSIONS_PER_PLAYER` ids; older finished sessions leave storage.
    fn remember_session(&mut self, player: &mut Player, id: &str) {
        player.sessions.push(id.to_string());
        while player.sessions.len() > SESSIONS_PER_PLAYER {
            let oldest = &player.sessions[0];
            let done = self.sessions.get(oldest).is_none_or(|s| s.status.is_done());
            if !done {
                break;
            }
            self.sessions.remove(oldest);
            player.sessions.remove(0);
        }
    }
}
