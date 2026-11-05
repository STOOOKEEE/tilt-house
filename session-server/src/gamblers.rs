//! The NPC gamblers (docs/tycoon.md), live. Every choice comes from `core_rules::gambler_rules`;
//! this module only walks each gambler through its visit and plays its sessions in-process
//! through `App` (create → `open_session` signed with the gambler's own key → rounds → close).
//! Salaries are the contract's/keeper's: balances are only read.
//!
//! A visit: off the floor → walking in (1 min) → deciding in front of a table (30 s) → seated,
//! one round every `ROUND_SECS` → leaving (1 min) → off the floor. Arrivals are drawn once a
//! minute. Each gambler runs as its own task with its own `Rng`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{anyhow, Context};
use axum::http::StatusCode;
use core_rules::floor::SEATS;
use core_rules::gambler_rules::{
    arrives, choose_table, desired_stake, parts, pick_bet, plan_session, score, GamblerReason,
    Memory, Persona, SessionPlan, TableView, LINEUP,
};
use core_rules::session::{sha256, BjAction, SESSION_MIN_BET};
use core_rules::{Bet, BjMove, BjStrategy, DiceBet, Game, Rng, RouletteBet};
use serde::{Deserialize, Serialize};
use tokio::time::{sleep, Instant};

use crate::app::{now, ApiError, App, CreateReply, CreateRequest};
use crate::chain::{Chain, FloorInfo, FloorTable};
use crate::keys::{random_bytes, Signer};
use crate::session::RoundRequest;

const WALK_SECS: u64 = 60;
const DECIDE_SECS: u64 = 30;
const LEAVE_SECS: u64 = 60;
const ARRIVAL_SECS: u64 = 60;
/// A seated gambler plays a round this often, so the floor shows it at the table for minutes.
const ROUND_SECS: u64 = 3;
/// Balances change on chain (salary, sessions): re-read this often while off the floor.
const BALANCE_REFRESH_SECS: u64 = 900;
const FOOTFALL_WINDOW_SECS: u64 = 3_600;
/// The footfall endpoint is public: reuse one floor read for this long.
const FLOOR_CACHE_SECS: u64 = 5;
/// `g-<name>` + this is the gambler's NEAR account.
const ACCOUNT_SUFFIX: &str = ".tilthouse.testnet";
const MEMORY_FILE: &str = "gamblers.json";

/// Wall-clock seconds that follow tokio's clock, so tests can run an hour in paused time.
#[derive(Clone, Copy, Debug)]
pub struct Clock {
    unix_at_start: u64,
    start: Instant,
}

impl Clock {
    pub fn system() -> Self {
        Self::starting_at(now())
    }

    pub fn starting_at(unix: u64) -> Self {
        Self {
            unix_at_start: unix,
            start: Instant::now(),
        }
    }

    pub fn now(&self) -> u64 {
        self.unix_at_start + self.start.elapsed().as_secs()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GamblerState {
    Away,
    Walking,
    Deciding,
    Seated,
    Leaving,
}

/// One entry of `GET /gamblers/floor` (docs/gamblers-api.md).
#[derive(Clone, Debug, Serialize)]
pub struct GamblerSnapshot {
    pub id: String,
    pub name: String,
    pub persona: Persona,
    pub state: GamblerState,
    pub dealer_id: Option<String>,
    pub seat: Option<usize>,
    pub reason_code: Option<&'static str>,
    pub reason: Option<String>,
    #[serde(with = "core_rules::amount_str")]
    pub balance: u128,
    #[serde(with = "core_rules::amount_str")]
    pub session_net: i128,
}

#[derive(Debug, Serialize)]
pub struct Arrival {
    pub persona: Persona,
    pub score: i32,
    pub chose: bool,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct FootfallReply {
    pub dealer_id: String,
    pub passed_1h: usize,
    pub sat_1h: usize,
    pub arrivals_1h: Vec<Arrival>,
}

/// What an arrival saw and chose, kept an hour to score any table against it later.
struct ArrivalRecord {
    at: u64,
    gambler: String,
    persona: Persona,
    stake: u128,
    memory: Memory,
    jackpot: u128,
    on_floor: Vec<String>,
    chose: Option<String>,
    reason: String,
}

struct Member {
    id: String,
    name: String,
    persona: Persona,
    account: String,
    /// NEAR secret key; `None` in `--no-chain` mode.
    key: Option<String>,
}

pub struct Gamblers<C> {
    app: Arc<App<C>>,
    clock: Clock,
    memory_path: PathBuf,
    members: Vec<Member>,
    snapshots: Mutex<Vec<GamblerSnapshot>>,
    memories: Mutex<HashMap<String, Memory>>,
    arrivals: Mutex<VecDeque<ArrivalRecord>>,
    floor_cache: tokio::sync::Mutex<Option<(Instant, Arc<FloorInfo>)>>,
    seed: [u8; 32],
}

/// The NEAR account of a lineup name: `g-mia.tilthouse.testnet`.
pub fn account_of(name: &str) -> String {
    format!("{}{ACCOUNT_SUFFIX}", gambler_id(name))
}

fn gambler_id(name: &str) -> String {
    format!("g-{}", name.to_lowercase())
}

/// The near-cli legacy keychain file of an account (`<dir>/<account>.json`).
#[derive(Deserialize)]
struct KeyFile {
    private_key: String,
}

fn load_key(dir: &Path, account: &str) -> anyhow::Result<String> {
    let path = dir.join(format!("{account}.json"));
    let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let file: KeyFile = serde_json::from_str(&text).context("parse key file")?;
    Signer::from_near_secret(&file.private_key)?;
    Ok(file.private_key)
}

impl<C: Chain> Gamblers<C> {
    /// The lineup. With `keys_dir`, a gambler whose key is missing or bad sits out (logged);
    /// without (`--no-chain`), everyone plays. `seed` drives every gambler's draws.
    pub fn new(
        app: Arc<App<C>>,
        clock: Clock,
        data_dir: &Path,
        keys_dir: Option<&Path>,
        seed: [u8; 32],
    ) -> anyhow::Result<Self> {
        let mut members = Vec::new();
        for &(name, persona) in &LINEUP {
            let account = account_of(name);
            let key = match keys_dir.map(|dir| load_key(dir, &account)) {
                None => None,
                Some(Ok(key)) => Some(key),
                Some(Err(err)) => {
                    eprintln!("gambler {account} sits out: {err:#}");
                    continue;
                }
            };
            members.push(Member {
                id: gambler_id(name),
                name: name.to_string(),
                persona,
                account,
                key,
            });
        }
        let snapshots = members
            .iter()
            .map(|m| GamblerSnapshot {
                id: m.id.clone(),
                name: m.name.clone(),
                persona: m.persona,
                state: GamblerState::Away,
                dealer_id: None,
                seat: None,
                reason_code: None,
                reason: None,
                balance: 0,
                session_net: 0,
            })
            .collect();
        let memory_path = data_dir.join(MEMORY_FILE);
        let memories = match fs::read_to_string(&memory_path) {
            Ok(text) => serde_json::from_str(&text)
                .with_context(|| format!("parse {}", memory_path.display()))?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(err) => return Err(err).context(memory_path.display().to_string()),
        };
        Ok(Self {
            app,
            clock,
            memory_path,
            members,
            snapshots: Mutex::new(snapshots),
            memories: Mutex::new(memories),
            arrivals: Mutex::new(VecDeque::new()),
            floor_cache: tokio::sync::Mutex::new(None),
            seed,
        })
    }

    /// Starts every gambler's task.
    pub fn start(self: &Arc<Self>) {
        for index in 0..self.members.len() {
            let runner = Arc::clone(self);
            tokio::spawn(async move { runner.live(index).await });
        }
    }

    /// `GET /gamblers/floor`: everyone not away.
    pub fn floor_snapshot(&self) -> Vec<GamblerSnapshot> {
        lock(&self.snapshots)
            .iter()
            .filter(|s| s.state != GamblerState::Away)
            .cloned()
            .collect()
    }

    /// `GET /gamblers/footfall`. Each arrival of the last hour is scored against the table's
    /// offer *now* (noise left out), so an owner sees what its current offer would draw.
    pub async fn footfall(&self, dealer_id: &str) -> Result<FootfallReply, ApiError> {
        let floor = self.floor().await.map_err(|err| {
            eprintln!("footfall floor read: {err:#}");
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "chain unavailable, retry later",
            )
        })?;
        let table = floor
            .tables
            .iter()
            .find(|t| t.dealer_id == dealer_id)
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "unknown dealer"))?;
        let at = self.clock.now();
        let view = self.table_view(table, at);
        let mut arrivals = lock(&self.arrivals);
        prune(&mut arrivals, at);
        let mut sat = HashSet::new();
        let mut passed = HashSet::new();
        let arrivals_1h = arrivals
            .iter()
            .map(|record| {
                let chose = record.chose.as_deref() == Some(dealer_id);
                if chose {
                    sat.insert(record.gambler.as_str());
                } else if record.on_floor.iter().any(|id| id == dealer_id) {
                    passed.insert(record.gambler.as_str());
                }
                let p = parts(
                    &view,
                    record.stake,
                    record.memory.loyalty(dealer_id),
                    record.jackpot,
                );
                Arrival {
                    persona: record.persona,
                    score: score(record.persona, &p, 0),
                    chose,
                    reason: record.reason.clone(),
                }
            })
            .collect();
        Ok(FootfallReply {
            dealer_id: dealer_id.to_string(),
            passed_1h: passed.len(),
            sat_1h: sat.len(),
            arrivals_1h,
        })
    }

    fn table_view<'a>(&self, table: &'a FloorTable, at: u64) -> TableView<'a> {
        TableView {
            dealer_id: &table.dealer_id,
            name: &table.name,
            game: table.game,
            // Off the floor: an out-of-range seat, which draws no traffic.
            seat: table.seat.unwrap_or(SEATS),
            edge_bp: table.edge_bp,
            boosting: table.boost_until > at,
            max_bet: table.max_bet,
        }
    }

    async fn floor(&self) -> anyhow::Result<Arc<FloorInfo>> {
        let mut cache = self.floor_cache.lock().await;
        if let Some((read_at, floor)) = cache.as_ref() {
            if read_at.elapsed() < Duration::from_secs(FLOOR_CACHE_SECS) {
                return Ok(Arc::clone(floor));
            }
        }
        let floor = Arc::new(self.app.chain().floor().await?);
        *cache = Some((Instant::now(), Arc::clone(&floor)));
        Ok(floor)
    }

    fn update(&self, index: usize, change: impl FnOnce(&mut GamblerSnapshot)) {
        if let Some(snapshot) = lock(&self.snapshots).get_mut(index) {
            change(snapshot);
        }
    }

    fn show(&self, index: usize, state: GamblerState, table: Option<&FloorTable>) {
        self.update(index, |s| {
            s.state = state;
            s.dealer_id = table.map(|t| t.dealer_id.clone());
            s.seat = table.and_then(|t| t.seat);
            if state != GamblerState::Seated {
                s.session_net = 0;
            }
        });
    }

    fn say(&self, index: usize, code: &'static str, text: String) {
        self.update(index, |s| {
            s.reason_code = Some(code);
            s.reason = Some(text);
        });
    }

    async fn read_balance(&self, index: usize) -> Option<u128> {
        let account = &self.members[index].account;
        match self.app.chain().balance(account).await {
            Ok(balance) => {
                self.update(index, |s| s.balance = balance);
                Some(balance)
            }
            Err(err) => {
                eprintln!("balance of {account}: {err:#}");
                None
            }
        }
    }

    async fn live(self: Arc<Self>, index: usize) {
        let mut seed = self.seed.to_vec();
        seed.extend_from_slice(&(index as u64).to_le_bytes());
        let mut rng = Rng::new(sha256(&seed));
        let mut balance = self.read_balance(index).await.unwrap_or(0);
        let mut balance_at = self.clock.now();
        loop {
            let at = self.clock.now();
            sleep(Duration::from_secs(ARRIVAL_SECS - at % ARRIVAL_SECS)).await;
            let at = self.clock.now();
            if at.saturating_sub(balance_at) >= BALANCE_REFRESH_SECS {
                balance = self.read_balance(index).await.unwrap_or(balance);
                balance_at = at;
            }
            if !arrives(self.members[index].persona, balance, at, &mut rng) {
                continue;
            }
            if let Err(err) = self.visit(index, balance, &mut rng).await {
                eprintln!("gambler {}: {err:#}", self.members[index].id);
            }
            self.update(index, |s| s.state = GamblerState::Leaving);
            sleep(Duration::from_secs(LEAVE_SECS)).await;
            self.show(index, GamblerState::Away, None);
            balance = self.read_balance(index).await.unwrap_or(balance);
            balance_at = self.clock.now();
        }
    }

    /// Walk in, pick a table, play there. Returns when the gambler turns to leave.
    async fn visit(&self, index: usize, balance: u128, rng: &mut Rng) -> anyhow::Result<()> {
        let member = &self.members[index];
        let stake = desired_stake(member.persona, balance, rng);
        self.update(index, |s| {
            s.reason_code = None;
            s.reason = None;
        });
        self.show(index, GamblerState::Walking, None);
        sleep(Duration::from_secs(WALK_SECS)).await;

        let floor = self.floor().await?;
        let at = self.clock.now();
        let mut seated: Vec<&FloorTable> = floor
            .tables
            .iter()
            .filter(|t| t.open && t.seat.is_some() && t.max_bet >= SESSION_MIN_BET)
            .collect();
        seated.sort_by_key(|t| t.seat);
        let views: Vec<TableView> = seated.iter().map(|t| self.table_view(t, at)).collect();
        let memory = lock(&self.memories)
            .get(&member.id)
            .cloned()
            .unwrap_or_default();
        let decision = choose_table(
            member.persona,
            balance,
            stake,
            &views,
            &memory,
            floor.jackpot,
            rng,
        );
        let chosen = decision.table.and_then(|i| seated.get(i).copied());
        self.record_arrival(ArrivalRecord {
            at,
            gambler: member.id.clone(),
            persona: member.persona,
            stake,
            memory,
            jackpot: floor.jackpot,
            on_floor: seated.iter().map(|t| t.dealer_id.clone()).collect(),
            chose: chosen.map(|t| t.dealer_id.clone()),
            reason: decision.text.clone(),
        });
        self.say(index, decision.reason.code(), decision.text);
        self.show(index, GamblerState::Deciding, chosen);
        sleep(Duration::from_secs(DECIDE_SECS)).await;

        let Some(table) = chosen else {
            return Ok(());
        };
        let Some(plan) = plan_session(member.persona, stake, table.max_bet, balance, rng) else {
            self.say(
                index,
                GamblerReason::NothingWorthIt.code(),
                format!("{} is no longer taking my bets", table.name),
            );
            return Ok(());
        };
        let net = self.play_session(index, table, plan, balance, rng).await?;
        self.remember(&member.id, &table.dealer_id, net, plan.lock)?;
        let text = match net {
            n if n > 0 => format!(
                "up {} at {}, cashing out",
                usdc(n.unsigned_abs()),
                table.name
            ),
            n if n < 0 => format!(
                "down {} at {}, done for now",
                usdc(n.unsigned_abs()),
                table.name
            ),
            _ => format!("broke even at {}", table.name),
        };
        self.say(index, "session_over", text);
        Ok(())
    }

    fn record_arrival(&self, record: ArrivalRecord) {
        let mut arrivals = lock(&self.arrivals);
        prune(&mut arrivals, record.at);
        arrivals.push_back(record);
    }

    /// Opens a session for `plan`, plays it to the end and closes it; returns the net result.
    async fn play_session(
        &self,
        index: usize,
        table: &FloorTable,
        plan: SessionPlan,
        balance: u128,
        rng: &mut Rng,
    ) -> anyhow::Result<i128> {
        let member = &self.members[index];
        let session = self
            .app
            .create(CreateRequest {
                player: member.account.clone(),
                dealer_id: table.dealer_id.clone(),
                lock: plan.lock,
                client_seed: format!("{}-{}", member.id, hex::encode(random_bytes::<8>()?)),
            })
            .await
            .map_err(api)?;
        self.app
            .chain()
            .open_session(
                &member.account,
                member.key.as_deref(),
                &session.ticket,
                &session.ticket_signature,
            )
            .await
            .context("open_session")?;
        self.show(index, GamblerState::Seated, Some(table));
        self.update(index, |s| s.balance = balance.saturating_sub(plan.lock));
        let strategy =
            (table.game == Game::Blackjack).then(|| BjStrategy::optimal(session.ticket.rake_bp));
        let mut net: i128 = 0;
        for nonce in 1..=u64::from(plan.rounds) {
            sleep(Duration::from_secs(ROUND_SECS)).await;
            let bet = pick_bet(member.persona, table.game, rng);
            // The server refuses what the session's limits cannot take; any refusal ends it.
            let Ok(session_balance) = self
                .round(&session, nonce, bet, plan.stake, strategy.as_ref())
                .await
            else {
                break;
            };
            net = signed_diff(session_balance, plan.lock);
            self.update(index, |s| s.session_net = net);
        }
        if let Err(err) = self.app.close(&session.session_id, &session.token).await {
            // Settle/reveal retried by the app's tick; the result is already signed.
            eprintln!("close {}: {}", session.session_id, err.message);
        }
        Ok(net)
    }

    /// Plays one round (a whole hand for blackjack); returns the session balance after it.
    async fn round(
        &self,
        session: &CreateReply,
        nonce: u64,
        bet: Bet,
        stake: u128,
        strategy: Option<&BjStrategy>,
    ) -> Result<u128, ApiError> {
        let play = |request| self.app.play(&session.session_id, &session.token, request);
        let modest = modest_bet(&bet);
        let retry = bet != modest;
        let mut reply = match play(RoundRequest::Bet { nonce, bet, stake }).await {
            Err(err) if err.status == StatusCode::BAD_REQUEST && retry => {
                let bet = modest;
                play(RoundRequest::Bet { nonce, bet, stake }).await?
            }
            other => other?,
        };
        while !reply.done {
            let state = reply
                .hand
                .as_ref()
                .map(|hand| hand.state.clone())
                .unwrap_or_default();
            let action = match strategy.map(|s| s.decide(&state)) {
                Some(BjMove::Double) => BjAction::Double,
                Some(BjMove::Hit) => BjAction::Hit,
                _ => BjAction::Stand,
            };
            reply = match play(RoundRequest::Action { nonce, action }).await {
                // Not enough left in the session to double: hit instead.
                Err(err) if action == BjAction::Double && err.status == StatusCode::BAD_REQUEST => {
                    play(RoundRequest::Action {
                        nonce,
                        action: BjAction::Hit,
                    })
                    .await?
                }
                other => other?,
            };
        }
        Ok(reply.state.state.balance)
    }

    /// Loyalty update after a session, persisted at once (the next visit must remember it).
    fn remember(
        &self,
        gambler: &str,
        dealer_id: &str,
        net: i128,
        lock_amount: u128,
    ) -> anyhow::Result<()> {
        let text = {
            let mut memories = lock(&self.memories);
            memories
                .entry(gambler.to_string())
                .or_default()
                .remember(dealer_id, net, lock_amount);
            serde_json::to_string(&*memories)?
        };
        let tmp = self.memory_path.with_extension("json.tmp");
        fs::write(&tmp, text).with_context(|| format!("write {}", tmp.display()))?;
        fs::rename(&tmp, &self.memory_path)
            .with_context(|| format!("replace {}", self.memory_path.display()))
    }
}

/// The low-variance bet of the same game, tried when the session's max win refuses a long shot.
fn modest_bet(bet: &Bet) -> Bet {
    match bet {
        Bet::Dice(_) => Bet::Dice(DiceBet {
            chance_bp: 5_000,
            over: true,
        }),
        Bet::Roulette(_) | Bet::RouletteSpots(_) => Bet::Roulette(RouletteBet::Red),
        Bet::Blackjack => Bet::Blackjack,
    }
}

fn signed_diff(a: u128, b: u128) -> i128 {
    if a >= b {
        i128::try_from(a - b).unwrap_or(i128::MAX)
    } else {
        i128::try_from(b - a).map_or(i128::MIN, |d| -d)
    }
}

/// "12.5" from 12_500_000 base units, like the reasons in gambler_rules.
fn usdc(amount: u128) -> String {
    format!("{}.{}", amount / 1_000_000, amount % 1_000_000 / 100_000)
}

fn prune(arrivals: &mut VecDeque<ArrivalRecord>, at: u64) {
    while arrivals
        .front()
        .is_some_and(|a| at.saturating_sub(a.at) > FOOTFALL_WINDOW_SECS)
    {
        arrivals.pop_front();
    }
}

/// The runner's maps hold plain data; a panic elsewhere leaves them usable.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn api(err: ApiError) -> anyhow::Error {
    anyhow!("{}: {}", err.status, err.message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounts_and_diffs() {
        assert_eq!(account_of("Mia"), "g-mia.tilthouse.testnet");
        assert_eq!(signed_diff(5, 3), 2);
        assert_eq!(signed_diff(3, 5), -2);
        assert_eq!(usdc(12_500_000), "12.5");
    }

    #[test]
    fn loads_near_cli_key_files() {
        let dir = tempfile::tempdir().unwrap();
        let key = format!("ed25519:{}", bs58::encode([7u8; 32]).into_string());
        fs::write(
            dir.path().join("g-mia.tilthouse.testnet.json"),
            format!(r#"{{"account_id":"g-mia.tilthouse.testnet","private_key":"{key}"}}"#),
        )
        .unwrap();
        assert_eq!(
            load_key(dir.path(), "g-mia.tilthouse.testnet").unwrap(),
            key
        );
        assert!(load_key(dir.path(), "g-noah.tilthouse.testnet").is_err());
    }
}
