//! Sessions in memory, persisted through the event log, settled and closed on chain.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail};
use axum::http::StatusCode;
use core_rules::rake_bounds;
use core_rules::session::{
    client_seed_is_valid, hex32, hex64, server_seed_hash, session_max_win, sha256, BjSession,
    CompactRound, SessionState, SessionTicket, SESSION_MIN_BET, SESSION_TIMEOUT_SECS,
    TICKET_TTL_SECS,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::chain::Chain;
use crate::keys::{random_bytes, Signer};
use crate::session::{Phase, PlayError, RoundRequest, Session};
use crate::store::{Event, Store};

/// The server closes a session idle this long, well before the player could force-close it.
pub const IDLE_CLOSE_SECS: u64 = SESSION_TIMEOUT_SECS / 2;
/// After a ticket expires it can no longer be opened; give the chain this long to show an open
/// sent just before expiry.
const EXPIRY_GRACE_SECS: u64 = 60;
const MAX_ID_LEN: usize = 64;
/// Share of the pool's free money (and of the table's max bet) a ticket is sized on (see `create`).
const POOL_FREE_HEADROOM_PCT: u128 = 80;

type Shared = Arc<AsyncMutex<Session>>;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn internal(err: anyhow::Error) -> Self {
        eprintln!("internal error: {err:#}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    }

    fn chain(err: anyhow::Error) -> Self {
        eprintln!("chain error: {err:#}");
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "chain unavailable, retry later",
        )
    }
}

impl From<PlayError> for ApiError {
    fn from(err: PlayError) -> Self {
        let status = match err {
            PlayError::NotOpen
            | PlayError::WrongNonce { .. }
            | PlayError::HandInProgress
            | PlayError::NoHand => StatusCode::CONFLICT,
            _ => StatusCode::BAD_REQUEST,
        };
        Self::new(status, err.to_string())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRequest {
    pub player: String,
    pub dealer_id: String,
    #[serde(with = "core_rules::amount_str")]
    pub lock: u128,
    pub client_seed: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SignedState {
    #[serde(flatten)]
    pub state: SessionState,
    #[serde(with = "hex64")]
    pub signature: [u8; 64],
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateReply {
    pub session_id: String,
    /// Bearer token for rounds and close; the session id becomes public on chain, this does not.
    pub token: String,
    pub server_public_key: String,
    /// The offer and commitment, as `open_session` takes them.
    pub ticket: SessionTicket,
    #[serde(with = "hex64")]
    pub ticket_signature: [u8; 64],
    pub state: SignedState,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RoundReply {
    /// `false` while a blackjack hand waits for an action (`hand` set, `round` null).
    pub done: bool,
    pub round: Option<CompactRound>,
    pub hand: Option<BjSession>,
    /// Latest signed state (the one before the hand while a hand is live).
    pub state: SignedState,
}

#[derive(Debug, Serialize)]
pub struct SessionView {
    pub ticket: SessionTicket,
    #[serde(with = "hex64")]
    pub ticket_signature: [u8; 64],
    pub phase: Phase,
    pub opened: bool,
    pub settled_upto: u64,
    pub state: SignedState,
    pub hand: Option<BjSession>,
    pub last_round: Option<CompactRound>,
    /// Revealed once closed.
    pub server_seed: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CloseReply {
    #[serde(with = "hex32")]
    pub server_seed: [u8; 32],
    pub ticket: SessionTicket,
    pub state: SignedState,
    pub rounds: Vec<CompactRound>,
}

pub struct App<C> {
    signer: Signer,
    chain: C,
    store: Store,
    sessions: Mutex<HashMap<String, Shared>>,
}

impl<C: Chain> App<C> {
    /// Rebuilds every session from the log.
    pub fn load(
        signer: Signer,
        chain: C,
        store: Store,
        events: Vec<Event>,
    ) -> anyhow::Result<Self> {
        let mut sessions: HashMap<String, Session> = HashMap::new();
        for event in events {
            if let Event::Created {
                ticket,
                server_seed,
                token,
                at,
            } = event
            {
                let id = ticket.session_id.clone();
                let session = Session::new(ticket, server_seed, token, at, &signer);
                if sessions.insert(id.clone(), session).is_some() {
                    bail!("session {id} created twice");
                }
                continue;
            }
            let session = sessions
                .get_mut(event.session_id())
                .ok_or_else(|| anyhow!("event for unknown session {}", event.session_id()))?;
            session.apply(&event, &signer)?;
        }
        let sessions = sessions
            .into_iter()
            .map(|(id, s)| (id, Arc::new(AsyncMutex::new(s))))
            .collect();
        Ok(Self {
            signer,
            chain,
            store,
            sessions: Mutex::new(sessions),
        })
    }

    pub fn public_key(&self) -> String {
        self.signer.public_key()
    }

    pub fn chain(&self) -> &C {
        &self.chain
    }

    fn get(&self, id: &str) -> Result<Shared, ApiError> {
        self.sessions
            .lock()
            .map_err(|_| ApiError::internal(anyhow!("sessions lock poisoned")))?
            .get(id)
            .cloned()
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no such session"))
    }

    fn all(&self) -> Vec<Shared> {
        self.sessions
            .lock()
            .map(|map| map.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Persists then applies: nothing is visible that is not written. Rounds and hands are synced
    /// by the next session event's fsync; use `record_durable` when the player sees them.
    fn record(&self, session: &mut Session, event: Event) -> anyhow::Result<()> {
        self.store.append(&event)?;
        session.apply(&event, &self.signer)
    }

    /// Persists, waits until on disk, then applies (which signs the new state).
    async fn record_durable(&self, session: &mut Session, event: Event) -> anyhow::Result<()> {
        let seq = self.store.append(&event)?;
        self.store.durable(seq).await?;
        session.apply(&event, &self.signer)
    }

    fn signed(session: &Session) -> SignedState {
        SignedState {
            state: session.state.clone(),
            signature: session.state_sig,
        }
    }

    pub async fn create(&self, request: CreateRequest) -> Result<CreateReply, ApiError> {
        validate_create(&request)?;
        let dealer = self
            .chain
            .dealer(&request.dealer_id)
            .await
            .map_err(ApiError::chain)?
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no such dealer"))?;
        let (min_rake, max_rake) = rake_bounds(dealer.game);
        if !(min_rake..=max_rake).contains(&dealer.rake_bp) {
            return Err(ApiError::chain(anyhow!("dealer rake out of bounds")));
        }
        // Sessions opened at the same table between this read and the player's open_session
        // reserve part of the pool; size the ticket on what remains after a few of them, or the
        // contract refuses it.
        let pool_free = dealer.pool_free * POOL_FREE_HEADROOM_PCT / 100;
        let max_win = session_max_win(request.lock, pool_free);
        // The table's max bet also shrinks as the pool reserves: same headroom.
        let max_bet = dealer.max_bet * POOL_FREE_HEADROOM_PCT / 100;
        if !dealer.open || max_bet < SESSION_MIN_BET || max_win == 0 {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "this table takes no bets now",
            ));
        }
        let server_seed = random_bytes::<32>().map_err(ApiError::internal)?;
        let at = now();
        let ticket = SessionTicket {
            session_id: hex::encode(random_bytes::<16>().map_err(ApiError::internal)?),
            player: request.player,
            dealer_id: request.dealer_id,
            game: dealer.game,
            lock: request.lock,
            server_seed_hash: server_seed_hash(&server_seed),
            client_seed: request.client_seed,
            rake_bp: dealer.rake_bp,
            max_bet,
            max_win,
            expires_at: at + TICKET_TTL_SECS,
        };
        let token = hex::encode(random_bytes::<32>().map_err(ApiError::internal)?);
        let event = Event::Created {
            ticket: ticket.clone(),
            server_seed,
            token: token.clone(),
            at,
        };
        self.store.append(&event).map_err(ApiError::internal)?;
        let session = Session::new(ticket, server_seed, token.clone(), at, &self.signer);
        let reply = CreateReply {
            session_id: session.ticket.session_id.clone(),
            token,
            server_public_key: self.public_key(),
            ticket: session.ticket.clone(),
            ticket_signature: session.ticket_sig,
            state: Self::signed(&session),
        };
        self.sessions
            .lock()
            .map_err(|_| ApiError::internal(anyhow!("sessions lock poisoned")))?
            .insert(reply.session_id.clone(), Arc::new(AsyncMutex::new(session)));
        Ok(reply)
    }

    pub async fn play(
        self: &Arc<Self>,
        id: &str,
        token: &str,
        request: RoundRequest,
    ) -> Result<RoundReply, ApiError> {
        let shared = self.get(id)?;
        let mut session = shared.lock().await;
        authorize(&session, token)?;
        if !session.opened {
            self.confirm_open(&mut session).await?;
        }
        let event = session.play(&request, now())?;
        self.record_durable(&mut session, event)
            .await
            .map_err(ApiError::internal)?;
        let reply = RoundReply {
            done: session.hand.is_none(),
            round: session
                .hand
                .is_none()
                .then(|| session.rounds.last().cloned())
                .flatten(),
            hand: session.hand.clone(),
            state: Self::signed(&session),
        };
        if session.settle_due(now()) && !session.chain_busy {
            let app = Arc::clone(self);
            let shared = Arc::clone(&shared);
            tokio::spawn(async move { app.settle_logged(&shared).await });
        }
        Ok(reply)
    }

    async fn confirm_open(&self, session: &mut Session) -> Result<(), ApiError> {
        let opened = self
            .chain
            .session_opened(&session.ticket.session_id)
            .await
            .map_err(ApiError::chain)?;
        if !opened {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "session not open on chain yet",
            ));
        }
        let event = Event::Opened {
            session_id: session.ticket.session_id.clone(),
            at: now(),
        };
        self.record(session, event).map_err(ApiError::internal)
    }

    pub async fn view(&self, id: &str) -> Result<SessionView, ApiError> {
        let shared = self.get(id)?;
        let session = shared.lock().await;
        Ok(SessionView {
            ticket: session.ticket.clone(),
            ticket_signature: session.ticket_sig,
            phase: session.phase,
            opened: session.opened,
            settled_upto: session.settled_upto,
            state: Self::signed(&session),
            hand: session.hand.clone(),
            last_round: session.rounds.last().cloned(),
            server_seed: matches!(session.phase, Phase::Closing | Phase::Closed)
                .then(|| hex::encode(session.server_seed)),
        })
    }

    pub async fn close(&self, id: &str, token: &str) -> Result<CloseReply, ApiError> {
        let shared = self.get(id)?;
        {
            let mut session = shared.lock().await;
            authorize(&session, token)?;
            self.begin_close(&mut session).map_err(ApiError::internal)?;
        }
        // The player leaves at once: no round can be played once closing, so the seed is safe to
        // show now. The final settle and the reveal on chain are run by `tick` (and retried).
        let session = shared.lock().await;
        Ok(CloseReply {
            server_seed: session.server_seed,
            ticket: session.ticket.clone(),
            state: Self::signed(&session),
            rounds: session.rounds.clone(),
        })
    }

    /// Stops play: a live hand stands, then the session is marked closing.
    fn begin_close(&self, session: &mut Session) -> anyhow::Result<()> {
        if session.phase != Phase::Open {
            return Ok(());
        }
        if let Some(event) = session.stand_for_close(now()) {
            self.record(session, event)?;
        }
        let event = Event::Closing {
            session_id: session.ticket.session_id.clone(),
            at: now(),
        };
        self.record(session, event)
    }

    /// Final settle, then reveal on chain. A session never opened on chain closes locally.
    async fn finish_close(&self, shared: &Shared) -> anyhow::Result<()> {
        let (id, opened, seed) = {
            let session = shared.lock().await;
            if session.phase == Phase::Closed {
                return Ok(());
            }
            (
                session.ticket.session_id.clone(),
                session.opened,
                session.server_seed,
            )
        };
        if !opened && !self.chain.session_opened(&id).await? {
            let mut session = shared.lock().await;
            return self.record(
                &mut session,
                Event::Closed {
                    session_id: id,
                    at: now(),
                },
            );
        }
        self.settle(shared).await?;
        {
            let mut session = shared.lock().await;
            if session.chain_busy || session.pending_batch().is_some() {
                bail!("settle still pending");
            }
            session.chain_busy = true;
        }
        let result = self.chain.close(&id, &seed).await;
        let mut session = shared.lock().await;
        session.chain_busy = false;
        result?;
        self.record(
            &mut session,
            Event::Closed {
                session_id: id,
                at: now(),
            },
        )
    }

    /// Sends the unsettled rounds, if any.
    async fn settle(&self, shared: &Shared) -> anyhow::Result<()> {
        let batch = {
            let mut session = shared.lock().await;
            if session.chain_busy {
                bail!("chain call in flight");
            }
            let Some(batch) = session.pending_batch() else {
                return Ok(());
            };
            session.chain_busy = true;
            batch
        };
        let result = self.chain.settle(&batch).await;
        let mut session = shared.lock().await;
        session.chain_busy = false;
        result?;
        let event = Event::Settled {
            session_id: batch.session_id,
            upto_nonce: batch.upto_nonce,
            at: now(),
        };
        self.record(&mut session, event)
    }

    async fn settle_logged(&self, shared: &Shared) {
        if let Err(err) = self.settle(shared).await {
            eprintln!("settle: {err:#}");
        }
    }

    /// Periodic work (every second): due settles, closes (retried, or of idle sessions), expired
    /// tickets.
    pub async fn tick(self: &Arc<Self>) {
        let at = now();
        for shared in self.all() {
            let Ok(mut session) = shared.try_lock() else {
                continue;
            };
            if session.phase == Phase::Closed || session.chain_busy {
                continue;
            }
            let idle =
                session.opened && at.saturating_sub(session.last_activity) >= IDLE_CLOSE_SECS;
            let expired =
                !session.opened && at > session.ticket.expires_at.saturating_add(EXPIRY_GRACE_SECS);
            if idle || expired {
                if let Err(err) = self.begin_close(&mut session) {
                    eprintln!("auto close {}: {err:#}", session.ticket.session_id);
                    continue;
                }
            }
            let closing = session.phase == Phase::Closing;
            let settle = session.settle_due(at);
            drop(session);
            let app = Arc::clone(self);
            let shared = Arc::clone(&shared);
            if closing {
                tokio::spawn(async move {
                    if let Err(err) = app.finish_close(&shared).await {
                        eprintln!("close: {err:#}");
                    }
                });
            } else if settle {
                tokio::spawn(async move { app.settle_logged(&shared).await });
            }
        }
    }
}

fn authorize(session: &Session, token: &str) -> Result<(), ApiError> {
    // Comparing digests keeps the comparison time independent of the secret.
    if sha256(token.as_bytes()) == sha256(session.token.as_bytes()) {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::UNAUTHORIZED, "bad session token"))
    }
}

fn validate_create(request: &CreateRequest) -> Result<(), ApiError> {
    let bad = |message: &str| Err(ApiError::new(StatusCode::BAD_REQUEST, message));
    if !is_account_id(&request.player) {
        return bad("player is not a NEAR account id");
    }
    if request.dealer_id.is_empty() || request.dealer_id.len() > MAX_ID_LEN {
        return bad("bad dealer_id");
    }
    if !client_seed_is_valid(&request.client_seed) {
        return bad("client_seed must be 1-64 printable characters without ':'");
    }
    if request.lock < SESSION_MIN_BET {
        return bad("lock below the minimum bet");
    }
    Ok(())
}

/// NEAR account ids: 2-64 chars of `a-z0-9`, parts separated by single `-`, `_` or `.`.
pub fn is_account_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    let separator = |b: u8| matches!(b, b'-' | b'_' | b'.');
    (2..=64).contains(&bytes.len())
        && bytes
            .iter()
            .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || separator(b))
        && !separator(bytes[0])
        && !separator(bytes[bytes.len() - 1])
        && !bytes.windows(2).any(|w| separator(w[0]) && separator(w[1]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_ids() {
        for ok in ["alice.testnet", "a1", "tilt-house.testnet", "a_b.near"] {
            assert!(is_account_id(ok), "{ok}");
        }
        for bad in [
            "a",
            "Alice.testnet",
            ".a",
            "a.",
            "a..b",
            "a-.b",
            &"a".repeat(65),
        ] {
            assert!(!is_account_id(bad), "{bad}");
        }
    }
}
