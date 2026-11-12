//! Sandbox tests of the floor contract (v2) against a mock NEP-141 token (`tests/mock-ft`). The
//! test plays the session server: it holds the server key, draws the seed, plays rounds with
//! `core_rules::session` and signs tickets and states like the real server.

use core_rules::poker::{Hand, HandStart, PokerAction, SeatStart, TableConfig};
use core_rules::session::{
    replay_round, server_seed_hash, session_max_win, state_message, ticket_message, CompactRound,
    Hash32, SessionPublic, SessionState, SessionTicket, SettleBatch,
};
use core_rules::{Bet, DiceBet, Game, RouletteBet, RouletteSpot};
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use tokio::sync::OnceCell;

const USDC: u128 = 1_000_000;
const SEED: u128 = 2_000 * USDC;
const TABLE_SEED: u128 = 200 * USDC;
const GAS: Gas = Gas::from_tgas(300);
const LAUNCH: [(&str, &str, &str); 5] = [
    ("ada", "dice", "greedy"),
    ("bruno", "dice", "promoter"),
    ("chloe", "roulette", "cautious"),
    ("dmitri", "roulette", "greedy"),
    ("eve", "blackjack", "promoter"),
];

static WASMS: OnceCell<[Vec<u8>; 2]> = OnceCell::const_new();

async fn wasms() -> &'static [Vec<u8>; 2] {
    WASMS
        .get_or_init(|| async {
            [
                near_workspaces::compile_project("./").await.unwrap(),
                near_workspaces::compile_project("./tests/mock-ft")
                    .await
                    .unwrap(),
            ]
        })
        .await
}

fn amount(value: &Value) -> u128 {
    value.as_str().expect("amount string").parse().unwrap()
}

fn expect_failure(result: ExecutionFinalResult, method: &str, error: &str) -> anyhow::Result<()> {
    assert!(result.is_failure(), "{method} should fail with {error:?}");
    let message = format!("{:?}", result.into_result().unwrap_err());
    assert!(
        message.contains(error),
        "{method}: expected {error:?}, got {message}"
    );
    Ok(())
}

fn server_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

struct Env {
    worker: Worker<Sandbox>,
    floor: Contract,
    ft: Contract,
    owner: Account,
    server: SigningKey,
}

/// Floor with `dealers` NPC dealers (from `LAUNCH`), each seeded with 2,000 tUSDC and seated.
async fn setup(dealers: usize) -> anyhow::Result<Env> {
    setup_code(&wasms().await[0], dealers).await
}

/// `setup` with the floor running `floor_wasm` (an older release for the upgrade test).
async fn setup_code(floor_wasm: &[u8], dealers: usize) -> anyhow::Result<Env> {
    let ft_wasm = &wasms().await[1];
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let ft = worker.dev_deploy(ft_wasm).await?;
    ft.call("new").transact().await?.into_result()?;
    let floor = worker.dev_deploy(floor_wasm).await?;
    let server = server_key();
    floor
        .call("new")
        .args_json(json!({
            "owner": owner.id(),
            "token": ft.id(),
            "keeper": owner.id(),
            "server_pubkey_hex": hex::encode(server.verifying_key().to_bytes()),
        }))
        .transact()
        .await?
        .into_result()?;
    let env = Env {
        worker,
        floor,
        ft,
        owner,
        server,
    };
    env.mint(env.floor.id().as_str(), 0).await?;
    env.mint(env.owner.id().as_str(), 10_000 * USDC).await?;
    env.deposit(&env.owner.clone(), 10_000 * USDC).await?;
    let mut ids = Vec::new();
    for (id, game, temperament) in &LAUNCH[..dealers] {
        env.ok(
            &env.owner,
            "add_dealer",
            json!({
                "id": id, "name": id.to_uppercase(), "game": game, "temperament": temperament,
                "look": null, "dealer_account": env.owner.id(), "seed_amount": SEED.to_string(),
            }),
        )
        .await?;
        ids.push(*id);
    }
    if !ids.is_empty() {
        env.ok(&env.owner, "launch_floor", json!({ "dealer_ids": ids }))
            .await?;
    }
    Ok(env)
}

impl Env {
    async fn mint(&self, account: &str, amount: u128) -> anyhow::Result<()> {
        self.ft
            .call("mint")
            .args_json(json!({"account_id": account, "amount": amount.to_string()}))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn deposit(&self, from: &Account, amount: u128) -> anyhow::Result<()> {
        self.transfer_call(from, amount, "").await
    }

    /// A new player holding `balance` in the floor.
    async fn player(&self, balance: u128) -> anyhow::Result<Account> {
        let player = self.worker.dev_create_account().await?;
        self.mint(player.id().as_str(), balance).await?;
        self.deposit(&player, balance).await?;
        Ok(player)
    }

    async fn call(
        &self,
        who: &Account,
        method: &str,
        args: Value,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.call_with(who, method, args, NearToken::from_yoctonear(0))
            .await
    }

    async fn call_with(
        &self,
        who: &Account,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(self.floor.id(), method)
            .args_json(args)
            .deposit(deposit)
            .gas(GAS)
            .transact()
            .await?)
    }

    async fn ok(&self, who: &Account, method: &str, args: Value) -> anyhow::Result<()> {
        let result = self.call(who, method, args).await?;
        assert!(
            result.is_success(),
            "{method} failed: {:?}",
            result.failures()
        );
        Ok(())
    }

    /// Calls `method` and expects it to fail with a message containing `error`.
    async fn fails(
        &self,
        who: &Account,
        method: &str,
        args: Value,
        error: &str,
    ) -> anyhow::Result<()> {
        let result = self.call(who, method, args).await?;
        expect_failure(result, method, error)
    }

    /// `fails` for the 1 yocto (full-access key) methods.
    async fn fails_yocto(
        &self,
        who: &Account,
        method: &str,
        args: Value,
        error: &str,
    ) -> anyhow::Result<()> {
        let result = self
            .call_with(who, method, args, NearToken::from_yoctonear(1))
            .await?;
        expect_failure(result, method, error)
    }

    /// `ft_transfer_call` of `amount` to the floor with `msg`; the token refunds a refused one.
    async fn transfer_call(&self, from: &Account, amount: u128, msg: &str) -> anyhow::Result<()> {
        from.call(self.ft.id(), "ft_transfer_call")
            .args_json(
                json!({"receiver_id": self.floor.id(), "amount": amount.to_string(), "msg": msg}),
            )
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn wallet(&self, account: &Account) -> anyhow::Result<u128> {
        let held: Value = self
            .ft
            .view("ft_balance_of")
            .args_json(json!({"account_id": account.id()}))
            .await?
            .json()?;
        Ok(amount(&held))
    }

    async fn shares(&self, account: &Account, dealer_id: &str) -> anyhow::Result<u128> {
        let shares = self
            .view(
                "mt_balance_of",
                json!({"account_id": account.id(), "token_id": dealer_id}),
            )
            .await?;
        Ok(amount(&shares))
    }

    async fn view(&self, method: &str, args: Value) -> anyhow::Result<Value> {
        Ok(self.floor.view(method).args_json(args).await?.json()?)
    }

    async fn dealer(&self, id: &str) -> anyhow::Result<Value> {
        let lobby = self.view("get_lobby", json!({})).await?;
        Ok(lobby
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == id)
            .cloned()
            .expect("dealer in lobby"))
    }

    async fn balance(&self, account: &Account) -> anyhow::Result<u128> {
        let player = self
            .view("get_player", json!({"account_id": account.id()}))
            .await?;
        Ok(amount(&player["balance"]))
    }

    async fn now(&self) -> anyhow::Result<u64> {
        Ok(self.worker.view_block().await?.timestamp() / 1_000_000_000)
    }

    /// Moves block time forward by at least `secs`.
    async fn wait_secs(&self, secs: u64) -> anyhow::Result<()> {
        let target = self.now().await? + secs;
        while self.now().await? < target {
            let left = target - self.now().await?;
            self.worker.fast_forward(left.max(1)).await?;
        }
        Ok(())
    }

    async fn seat_balance(&self, account: &Account, seat: u8) -> anyhow::Result<u128> {
        let balance = self
            .view(
                "mt_balance_of",
                json!({"account_id": account.id(), "token_id": format!("seat-{seat}")}),
            )
            .await?;
        Ok(amount(&balance))
    }

    fn sign(&self, message: &[u8]) -> String {
        hex::encode(self.server.sign(message).to_bytes())
    }

    /// Opens a table for `owner` and returns nothing (id `id`, dice, 200 tUSDC).
    async fn open_table(&self, owner: &Account, id: &str) -> anyhow::Result<()> {
        self.ok(
            owner,
            "open_table",
            json!({
                "id": id, "name": "My Table", "game": "dice", "temperament": "promoter",
                "look": "top-hat", "seed_amount": TABLE_SEED.to_string(),
            }),
        )
        .await?;
        Ok(())
    }
}

/// The session server's side of one session: seed, rounds played and signed state.
struct Play {
    id: String,
    game: Game,
    seed: Hash32,
    client_seed: String,
    lock: u128,
    rake_bp: u16,
    max_bet: u128,
    max_win: u128,
    balance: u128,
    chain: Hash32,
    nonce: u64,
    pending: Vec<CompactRound>,
}

impl Play {
    fn public(&self) -> SessionPublic<'_> {
        SessionPublic {
            server_seed_hash: server_seed_hash(&self.seed),
            client_seed: &self.client_seed,
            game: self.game,
            rake_bp: self.rake_bp,
            lock: self.lock,
        }
    }

    /// Plays one coin-flip dice round of `stake`.
    fn round(&mut self, stake: u128) {
        let bet = Bet::Dice(DiceBet {
            chance_bp: 5000,
            over: true,
        });
        self.play(&bet, stake);
    }

    fn play(&mut self, bet: &Bet, stake: u128) {
        let round =
            replay_round(&self.seed, &self.public(), self.nonce + 1, bet, stake, &[]).unwrap();
        self.push(round);
    }

    /// Records a round played elsewhere (a poker hand's line for this player).
    fn push(&mut self, round: CompactRound) {
        self.nonce += 1;
        assert_eq!(round.nonce, self.nonce);
        self.balance = self.balance - round.wager() + round.payout;
        self.chain = core_rules::session::chain_step(&self.chain, &round);
        self.pending.push(round);
    }

    fn state(&self) -> SessionState {
        SessionState {
            session_id: self.id.clone(),
            nonce: self.nonce,
            balance: self.balance,
            chain: self.chain,
        }
    }

    fn batch(&mut self, env: &Env) -> SettleBatch {
        let sig = env.server.sign(&state_message(&self.state())).to_bytes();
        SettleBatch {
            session_id: self.id.clone(),
            upto_nonce: self.nonce,
            balance: self.balance,
            chain: self.chain,
            rounds: std::mem::take(&mut self.pending),
            server_sig: sig,
        }
    }
}

/// Opens a 10 tUSDC session at `dealer_id` (its game) for `player`, as the server would offer it.
async fn open(
    env: &Env,
    player: &Account,
    dealer_id: &str,
    id: &str,
    seed_byte: u8,
) -> anyhow::Result<Play> {
    let (play, args) = offer(env, player, dealer_id, id, seed_byte, 10 * USDC, USDC).await?;
    env.ok(player, "open_session", args).await?;
    Ok(play)
}

/// The server's side and the signed `open_session` args of a session of `lock` and `max_bet`.
async fn offer(
    env: &Env,
    player: &Account,
    dealer_id: &str,
    id: &str,
    seed_byte: u8,
    lock: u128,
    max_bet: u128,
) -> anyhow::Result<(Play, Value)> {
    let dealer = env.dealer(dealer_id).await?;
    let free = amount(&dealer["bankroll"]) - amount(&dealer["reserved"]);
    let seed = [seed_byte; 32];
    let game: Game = serde_json::from_value(dealer["game"].clone())?;
    let play = Play {
        id: id.to_string(),
        game,
        seed,
        client_seed: "lucky-7".to_string(),
        lock,
        rake_bp: dealer["rake_bp"].as_u64().unwrap() as u16,
        max_bet,
        max_win: session_max_win(lock, free),
        balance: lock,
        chain: server_seed_hash(&seed),
        nonce: 0,
        pending: Vec::new(),
    };
    let ticket = SessionTicket {
        session_id: play.id.clone(),
        player: player.id().to_string(),
        dealer_id: dealer_id.to_string(),
        game,
        lock,
        server_seed_hash: server_seed_hash(&seed),
        client_seed: play.client_seed.clone(),
        rake_bp: play.rake_bp,
        max_bet: play.max_bet,
        max_win: play.max_win,
        expires_at: env.now().await? + 120,
    };
    let sig = env.sign(&ticket_message(&ticket));
    Ok((play, json!({"ticket": ticket, "server_sig": sig})))
}

/// Every token the floor holds is somebody's: balances + pools + jackpot (no open session).
async fn assert_conserved(env: &Env, accounts: &[&Account], deposited: u128) -> anyhow::Result<()> {
    let mut total = 0;
    for account in accounts {
        total += env.balance(account).await?;
    }
    for dealer in env.view("get_lobby", json!({})).await?.as_array().unwrap() {
        total += amount(&dealer["bankroll"]);
    }
    total += amount(&env.view("get_floor", json!({})).await?["jackpot"]);
    assert_eq!(total, deposited);
    let held: Value = env
        .ft
        .view("ft_balance_of")
        .args_json(json!({"account_id": env.floor.id()}))
        .await?
        .json()?;
    assert_eq!(amount(&held), deposited);
    Ok(())
}

#[tokio::test]
async fn session_open_settle_close_reveals_a_verifiable_seed() -> anyhow::Result<()> {
    let env = setup(1).await?;
    let player = env.player(50 * USDC).await?;
    let mut play = open(&env, &player, "ada", "s-1", 1).await?;
    assert_eq!(env.balance(&player).await?, 40 * USDC);
    let session = env
        .view("get_session", json!({"session_id": "s-1"}))
        .await?;
    assert_eq!(session["status"], "open");
    assert_eq!(amount(&session["reserve"]), play.max_win);
    let reserved = amount(&env.dealer("ada").await?["reserved"]);
    assert_eq!(reserved, play.max_win);

    for _ in 0..6 {
        play.round(USDC / 2);
    }
    // A batch signed by another key, or whose balance was rewritten, is refused.
    let mut forged = play.batch(&env);
    play.pending = forged.rounds.clone();
    forged.server_sig = SigningKey::from_bytes(&[9u8; 32])
        .sign(&state_message(&play.state()))
        .to_bytes();
    env.fails(
        &env.owner,
        "settle_session",
        json!({"batch": forged}),
        "bad server signature",
    )
    .await?;
    let mut tampered = play.batch(&env);
    play.pending = tampered.rounds.clone();
    tampered.rounds[0].payout += USDC;
    env.fails(
        &env.owner,
        "settle_session",
        json!({"batch": tampered}),
        "balance does not follow",
    )
    .await?;

    let first = play.batch(&env);
    env.ok(&env.owner, "settle_session", json!({"batch": first}))
        .await?;
    for _ in 0..4 {
        play.round(USDC);
    }
    let second = play.batch(&env);
    env.ok(&env.owner, "settle_session", json!({"batch": second}))
        .await?;
    let session = env
        .view("get_session", json!({"session_id": "s-1"}))
        .await?;
    assert_eq!(session["settled_nonce"], 10);
    assert_eq!(amount(&session["balance"]), play.balance);
    assert_eq!(
        amount(&session["reserve"]),
        play.lock + play.max_win - play.balance,
        "the pool always reserves what the session can still win"
    );
    let stats = &env.dealer("ada").await?["stats"];
    assert_eq!(stats["bets_1h"], 10);
    assert_eq!(stats["gamblers_1h"], 1);

    // A wrong seed cannot close; the right one closes and is published.
    env.fails(
        &player,
        "close_session",
        json!({"session_id": "s-1", "server_seed": hex::encode([2u8; 32])}),
        "does not match",
    )
    .await?;
    // The server closes after its final settle: knowing the seed is the authorization.
    env.ok(
        &env.owner,
        "close_session",
        json!({"session_id": "s-1", "server_seed": hex::encode(play.seed)}),
    )
    .await?;
    let session = env
        .view("get_session", json!({"session_id": "s-1"}))
        .await?;
    assert_eq!(session["status"], "closed");
    assert_eq!(env.balance(&player).await?, 40 * USDC + play.balance);
    assert_eq!(amount(&env.dealer("ada").await?["reserved"]), 0);
    assert_conserved(&env, &[&env.owner, &player], 10_050 * USDC).await?;

    // Anyone can now replay the whole session from public data.
    let revealed: Hash32 = hex::decode(session["server_seed"].as_str().unwrap())?
        .try_into()
        .unwrap();
    let summary =
        core_rules::session::verify_session(&revealed, &play.public(), &[first, second]).unwrap();
    assert_eq!(summary.balance, play.balance);
    assert_eq!(summary.rounds, 10);
    Ok(())
}

/// Several chips, one spin: the contract checks the spots' total against the stake and the
/// table limits, and the settled rounds replay after the reveal.
#[tokio::test]
async fn multi_spot_roulette_rounds_settle_and_verify() -> anyhow::Result<()> {
    let env = setup(3).await?;
    let player = env.player(50 * USDC).await?;
    let mut play = open(&env, &player, "chloe", "s-r", 3).await?;
    let spot = |bet, stake| RouletteSpot { bet, stake };
    let chips = Bet::RouletteSpots(vec![
        spot(RouletteBet::Straight(17), USDC / 10),
        spot(RouletteBet::Split(7, 10), USDC / 10),
        spot(RouletteBet::Corner(8), USDC / 5),
        spot(RouletteBet::Red, USDC / 5),
    ]);
    for _ in 0..5 {
        play.play(&chips, 6 * USDC / 10);
    }

    // A stake that is not the spots' total is refused before anything moves.
    let mut wrong = play.batch(&env);
    play.pending = wrong.rounds.clone();
    wrong.rounds[0].stake += 1;
    env.fails(
        &env.owner,
        "settle_session",
        json!({"batch": wrong}),
        "outside the session's limits",
    )
    .await?;

    let batch = play.batch(&env);
    env.ok(&env.owner, "settle_session", json!({"batch": batch}))
        .await?;
    let session = env
        .view("get_session", json!({"session_id": "s-r"}))
        .await?;
    assert_eq!(amount(&session["balance"]), play.balance);
    env.ok(
        &env.owner,
        "close_session",
        json!({"session_id": "s-r", "server_seed": hex::encode(play.seed)}),
    )
    .await?;
    let summary =
        core_rules::session::verify_session(&play.seed, &play.public(), &[batch]).unwrap();
    assert_eq!(summary.wagered, 5 * 6 * USDC / 10);
    assert_eq!(summary.balance, play.balance);
    Ok(())
}

#[tokio::test]
async fn open_table_bid_and_outbid_eviction() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let alice = env.player(TABLE_SEED + 10 * USDC).await?;
    let bob = env.player(TABLE_SEED + 10 * USDC).await?;
    env.open_table(&alice, "alice-dice").await?;
    env.open_table(&bob, "bob-dice").await?;
    let table = env.dealer("alice-dice").await?;
    assert_eq!(table["controller"], alice.id().as_str());
    assert_eq!(table["seated"], false);
    assert_eq!(env.balance(&alice).await?, 10 * USDC);

    // Seat 6 is the only one left; its minimum is 0.6 tUSDC/h.
    env.ok(
        &alice,
        "bid_for_seat",
        json!({"dealer_id": "alice-dice", "rent_per_hour": "600000"}),
    )
    .await?;
    let table = env.dealer("alice-dice").await?;
    assert_eq!(table["seat"], 6);
    assert_eq!(env.seat_balance(&alice, 6).await?, 1);
    let floor = env.view("get_floor", json!({})).await?;
    assert!(
        amount(&floor["jackpot"]) >= 1_200_000,
        "the 2 h prepay went to the jackpot"
    );

    // Only the controller may bid; a full floor needs 110 % of the lowest rent.
    env.fails(
        &alice,
        "bid_for_seat",
        json!({"dealer_id": "bob-dice", "rent_per_hour": "5000000"}),
        "controller",
    )
    .await?;
    env.fails(
        &bob,
        "bid_for_seat",
        json!({"dealer_id": "bob-dice", "rent_per_hour": "600000"}),
        "bid at least",
    )
    .await?;
    env.ok(
        &bob,
        "bid_for_seat",
        json!({"dealer_id": "bob-dice", "rent_per_hour": "700000"}),
    )
    .await?;
    let evicted = env.dealer("alice-dice").await?;
    assert_eq!(evicted["seated"], false);
    assert!(evicted["cooldown_until"].as_u64().unwrap() > env.now().await?);
    assert_eq!(env.dealer("bob-dice").await?["seat"], 6);
    assert_eq!(env.seat_balance(&alice, 6).await?, 0);
    assert_eq!(env.seat_balance(&bob, 6).await?, 1);
    let history = env
        .view(
            "get_history",
            json!({"dealer_id": "alice-dice", "from": null, "limit": 5}),
        )
        .await?;
    let last = history.as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["kind"], "evicted");
    assert_eq!(last["detail"], "outbid");
    env.fails(
        &alice,
        "bid_for_seat",
        json!({"dealer_id": "alice-dice", "rent_per_hour": "5000000"}),
        "cannot bid again",
    )
    .await?;

    // Owner controls: a manual offer stays inside core's bounds and turns autopilot off.
    env.ok(
        &bob,
        "set_offer",
        json!({"dealer_id": "bob-dice", "rake_bp": 9999, "max_bet": "1000000000000", "boost_secs": 0}),
    )
    .await?;
    let table = env.dealer("bob-dice").await?;
    assert_eq!(table["autopilot"], false);
    assert!(table["total_edge_bp"].as_u64().unwrap() <= 500);
    // Editing the offer mid-boost keeps the owner's boost (regression: it was cancelled, and
    // the hourly limit then refused a new one).
    env.ok(
        &bob,
        "set_offer",
        json!({"dealer_id": "bob-dice", "rake_bp": 200, "max_bet": "1000000", "boost_secs": 600}),
    )
    .await?;
    let boosted = env.dealer("bob-dice").await?;
    assert!(boosted["boost_until"].as_u64().unwrap() > 0);
    env.ok(
        &bob,
        "set_offer",
        json!({"dealer_id": "bob-dice", "rake_bp": 300, "max_bet": "1000000", "boost_secs": 0}),
    )
    .await?;
    let edited = env.dealer("bob-dice").await?;
    assert_eq!(edited["offer_rake_bp"], 300);
    assert_eq!(edited["boost_until"], boosted["boost_until"]);
    assert_eq!(edited["last_boost_at"], boosted["last_boost_at"]);
    env.fails(
        &env.owner,
        "reprice",
        json!({"dealer_id": "bob-dice"}),
        "manual pricing",
    )
    .await?;
    env.ok(
        &bob,
        "set_autopilot",
        json!({"dealer_id": "bob-dice", "temperament": "cautious"}),
    )
    .await?;
    assert_eq!(env.dealer("bob-dice").await?["temperament"], "cautious");
    // The keeper drives the NPC dealers.
    env.ok(&env.owner, "reprice", json!({"dealer_id": "ada"}))
        .await?;
    env.ok(&env.owner, "rent_bid", json!({"dealer_id": "ada"}))
        .await?;
    env.fails(
        &env.owner,
        "rent_bid",
        json!({"dealer_id": "bob-dice"}),
        "only NPC",
    )
    .await?;
    Ok(())
}

#[tokio::test]
async fn seat_sale_moves_the_seat_and_the_price() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let alice = env.player(TABLE_SEED + 10 * USDC).await?;
    let bob = env.player(TABLE_SEED + 10 * USDC).await?;
    env.open_table(&alice, "alice-dice").await?;
    env.open_table(&bob, "bob-dice").await?;
    env.ok(
        &alice,
        "bid_for_seat",
        json!({"dealer_id": "alice-dice", "rent_per_hour": "600000"}),
    )
    .await?;
    env.ok(
        &alice,
        "list_seat",
        json!({"dealer_id": "alice-dice", "price": "5000000"}),
    )
    .await?;
    assert_eq!(env.dealer("alice-dice").await?["ask"], "5000000");
    env.fails(
        &bob,
        "buy_seat",
        json!({"seat": 6, "dealer_id": "bob-dice", "max_price": "4000000"}),
        "",
    )
    .await?;
    env.ok(
        &bob,
        "buy_seat",
        json!({"seat": 6, "dealer_id": "bob-dice", "max_price": "5000000"}),
    )
    .await?;
    assert_eq!(env.balance(&bob).await?, 5 * USDC);
    assert_eq!(env.balance(&alice).await?, 15 * USDC);
    assert_eq!(env.dealer("bob-dice").await?["seat"], 6);
    let seller = env.dealer("alice-dice").await?;
    assert_eq!(seller["seated"], false);
    assert_eq!(seller["cooldown_until"], 0, "a sale is not an eviction");
    assert_eq!(env.seat_balance(&bob, 6).await?, 1);
    assert_eq!(env.seat_balance(&alice, 6).await?, 0);
    // Seat leases never move by plain transfer.
    let transfer = bob
        .call(env.floor.id(), "mt_transfer")
        .args_json(json!({"receiver_id": alice.id(), "token_id": "seat-6", "amount": "1", "approval": null}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(transfer.is_failure());
    // A buyer cannot pay with money it does not have.
    let carol = env.player(TABLE_SEED).await?;
    env.open_table(&carol, "carol-dice").await?;
    env.ok(
        &bob,
        "list_seat",
        json!({"dealer_id": "bob-dice", "price": "1000000"}),
    )
    .await?;
    env.fails(
        &carol,
        "buy_seat",
        json!({"seat": 6, "dealer_id": "carol-dice", "max_price": "1000000"}),
        "not enough balance",
    )
    .await?;
    assert_eq!(env.balance(&carol).await?, 0);
    Ok(())
}

#[tokio::test]
async fn unpaid_rent_evicts_and_feeds_the_jackpot() -> anyhow::Result<()> {
    let env = setup(0).await?;
    let alice = env.player(TABLE_SEED).await?;
    env.open_table(&alice, "alice-dice").await?;
    // Regression: 99 tUSDC/h left the pool 2 tUSDC after the 2 h prepay, under what a 0.10
    // minimum dice bet needs: the table took a seat it could not play at (seen on testnet,
    // qa-min evicting Chloe, 2026-11-07).
    env.fails(
        &alice,
        "bid_for_seat",
        json!({"dealer_id": "alice-dice", "rent_per_hour": "99000000"}),
        "could not cover a minimum bet",
    )
    .await?;
    // 95 tUSDC/h: the prepay leaves 10 tUSDC (just open), a few minutes more of rent.
    env.ok(
        &alice,
        "bid_for_seat",
        json!({"dealer_id": "alice-dice", "rent_per_hour": "95000000"}),
    )
    .await?;
    assert_eq!(
        amount(&env.dealer("alice-dice").await?["bankroll"]),
        10 * USDC
    );
    assert_eq!(env.dealer("alice-dice").await?["open"], true);
    env.wait_secs(2 * 3600 + 600).await?;
    env.ok(&alice, "collect_rent", json!({})).await?;
    let table = env.dealer("alice-dice").await?;
    assert_eq!(table["seated"], false);
    assert_eq!(
        amount(&table["bankroll"]),
        0,
        "pays what it can, never below zero"
    );
    let floor = env.view("get_floor", json!({})).await?;
    assert_eq!(amount(&floor["jackpot"]), TABLE_SEED);
    let history = env
        .view(
            "get_history",
            json!({"dealer_id": "alice-dice", "from": null, "limit": 50}),
        )
        .await?;
    // The eviction empties the pool, so the table also logs that it closed (`bust`).
    let kinds: Vec<&str> = history
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .take(2)
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["bust", "evicted"]);
    let evicted = &history.as_array().unwrap()[history.as_array().unwrap().len() - 2];
    assert_eq!(evicted["detail"], "unpaid_rent");
    Ok(())
}

#[tokio::test]
async fn force_close_after_timeout_then_claim_unrevealed() -> anyhow::Result<()> {
    let env = setup(1).await?;
    let player = env.player(50 * USDC).await?;
    let mut play = open(&env, &player, "ada", "s-1", 3).await?;
    for _ in 0..3 {
        play.round(USDC);
    }
    let state = play.state();
    let sig = env.sign(&state_message(&state));
    let args = json!({"session_id": "s-1", "state": state, "server_sig": sig});
    env.fails(&player, "force_close", args.clone(), "still has time")
        .await?;
    env.fails(
        &player,
        "open_session",
        json!({"ticket": {}, "server_sig": ""}),
        "ticket",
    )
    .await?;
    env.wait_secs(600).await?;
    env.fails(&env.owner, "force_close", args.clone(), "only the player")
        .await?;
    let mut lie = state.clone();
    lie.balance = play.lock + play.max_win;
    let forged = json!({"session_id": "s-1", "state": lie, "server_sig": sig});
    env.fails(&player, "force_close", forged, "bad server signature")
        .await?;
    env.ok(&player, "force_close", args).await?;
    let session = env
        .view("get_session", json!({"session_id": "s-1"}))
        .await?;
    assert_eq!(session["status"], "force_closed");
    assert_eq!(env.balance(&player).await?, 40 * USDC + play.balance);
    assert_eq!(
        amount(&env.dealer("ada").await?["reserved"]),
        play.lock + play.max_win - play.balance,
        "the reserve waits for the seed"
    );
    // The server never reveals: after the reveal timeout the player takes lock + max_win.
    env.fails(
        &player,
        "claim_unrevealed",
        json!({"session_id": "s-1"}),
        "still has time",
    )
    .await?;
    env.wait_secs(3600).await?;
    env.ok(&player, "claim_unrevealed", json!({"session_id": "s-1"}))
        .await?;
    assert_eq!(
        env.balance(&player).await?,
        40 * USDC + play.lock + play.max_win
    );
    assert_eq!(amount(&env.dealer("ada").await?["reserved"]), 0);
    assert_eq!(
        env.view("get_session", json!({"session_id": "s-1"}))
            .await?["status"],
        "forfeited"
    );
    Ok(())
}

/// NPC gamblers: a capped registry, every way out for their money refused but sessions, and a
/// salary only the keeper can pay, up to the balance cap.
#[tokio::test]
async fn npc_gamblers_only_play_sessions_and_take_salary_from_the_keeper() -> anyhow::Result<()> {
    let env = setup(1).await?;
    let npc = env.player(50 * USDC).await?;
    let stranger = env.player(10 * USDC).await?;
    env.fails(
        &stranger,
        "register_npcs",
        json!({"accounts": [npc.id()]}),
        "only the owner",
    )
    .await?;
    env.ok(
        &env.owner,
        "register_npcs",
        json!({"accounts": [npc.id(), npc.id()]}),
    )
    .await?;
    assert_eq!(env.view("get_npcs", json!({})).await?, json!([npc.id()]));
    let fillers: Vec<String> = (1..24).map(|i| format!("g-{i}.test.near")).collect();
    env.ok(&env.owner, "register_npcs", json!({ "accounts": fillers }))
        .await?;
    env.fails(
        &env.owner,
        "register_npcs",
        json!({"accounts": ["g-24.test.near"]}),
        "too many NPC gamblers",
    )
    .await?;
    let npcs = env.view("get_npcs", json!({})).await?;
    assert_eq!(npcs.as_array().unwrap().len(), 24);

    // Every way out but a session is refused.
    let refused = "NPC gamblers can only play sessions";
    env.fails_yocto(
        &npc,
        "withdraw",
        json!({"amount": USDC.to_string()}),
        refused,
    )
    .await?;
    env.fails(
        &npc,
        "invest",
        json!({"dealer_id": "ada", "amount": USDC.to_string()}),
        refused,
    )
    .await?;
    env.fails(
        &npc,
        "divest",
        json!({"dealer_id": "ada", "shares": "1"}),
        refused,
    )
    .await?;
    env.fails(
        &npc,
        "open_table",
        json!({
            "id": "npc-dice", "name": "NPC", "game": "dice", "temperament": "promoter",
            "look": "top-hat", "seed_amount": TABLE_SEED.to_string(),
        }),
        refused,
    )
    .await?;
    env.fails(
        &npc,
        "list_seat",
        json!({"dealer_id": "ada", "price": "1"}),
        refused,
    )
    .await?;
    env.fails(
        &npc,
        "buy_seat",
        json!({"seat": 1, "dealer_id": "ada", "max_price": "1"}),
        refused,
    )
    .await?;
    env.fails_yocto(
        &npc,
        "mt_transfer",
        json!({"receiver_id": stranger.id(), "token_id": "ada", "amount": "1", "approval": null}),
        refused,
    )
    .await?;
    // LP shares bought with a token transfer are refused too: the token refunds them.
    env.mint(npc.id().as_str(), USDC).await?;
    env.transfer_call(&npc, USDC, r#"{"invest":"ada"}"#).await?;
    assert_eq!(env.wallet(&npc).await?, USDC);
    assert_eq!(env.shares(&npc, "ada").await?, 0);
    assert_eq!(env.balance(&npc).await?, 50 * USDC);

    // Sessions are what NPCs are for.
    let mut play = open(&env, &npc, "ada", "s-npc", 5).await?;
    for _ in 0..3 {
        play.round(USDC);
    }
    env.ok(
        &env.owner,
        "settle_session",
        json!({"batch": play.batch(&env)}),
    )
    .await?;
    env.ok(
        &npc,
        "close_session",
        json!({"session_id": "s-npc", "server_seed": hex::encode(play.seed)}),
    )
    .await?;
    let after_session = 40 * USDC + play.balance;
    assert_eq!(env.balance(&npc).await?, after_session);

    // The keeper (the owner here) pays the salary into the NPC's floor balance.
    env.mint(env.owner.id().as_str(), 300 * USDC).await?;
    let credit = |account: &Account| json!({ "credit_npc": account.id() }).to_string();
    env.transfer_call(&env.owner, 5 * USDC, &credit(&npc))
        .await?;
    assert_eq!(env.balance(&npc).await?, after_session + 5 * USDC);
    // Refused (and refunded): another sender, an account that is not an NPC, above the cap.
    env.mint(stranger.id().as_str(), 5 * USDC).await?;
    env.transfer_call(&stranger, 5 * USDC, &credit(&npc))
        .await?;
    assert_eq!(env.wallet(&stranger).await?, 5 * USDC);
    env.transfer_call(&env.owner, 5 * USDC, &credit(&stranger))
        .await?;
    assert_eq!(env.balance(&stranger).await?, 10 * USDC);
    env.transfer_call(&env.owner, 200 * USDC, &credit(&npc))
        .await?;
    assert_eq!(env.balance(&npc).await?, after_session + 5 * USDC);
    assert_eq!(env.wallet(&env.owner).await?, 295 * USDC);
    assert_conserved(
        &env,
        &[&env.owner, &npc, &stranger],
        10_000 * USDC + 60 * USDC + 5 * USDC,
    )
    .await?;
    Ok(())
}

/// A controller renames its table, then retires it once it is off the floor, settled and
/// fully its own; the retired table takes no more money, seat or name.
#[tokio::test]
async fn controller_renames_and_retires_an_off_floor_table() -> anyhow::Result<()> {
    let env = setup(5).await?;
    let alice = env.player(TABLE_SEED + 10 * USDC).await?;
    let bob = env.player(TABLE_SEED + 10 * USDC).await?;
    let carol = env.player(50 * USDC).await?;
    env.open_table(&alice, "alice-dice").await?;
    env.open_table(&bob, "bob-dice").await?;
    let table = |name: &str| json!({"dealer_id": "alice-dice", "name": name});

    env.fails(&bob, "set_table_name", table("Bob's"), "controller")
        .await?;
    env.fails(&alice, "set_table_name", table(" padded"), "table name")
        .await?;
    env.ok(&alice, "set_table_name", table("Lucky Alice"))
        .await?;
    assert_eq!(env.dealer("alice-dice").await?["name"], "Lucky Alice");

    let alice_dice = json!({"dealer_id": "alice-dice"});
    env.ok(
        &alice,
        "bid_for_seat",
        json!({"dealer_id": "alice-dice", "rent_per_hour": "600000"}),
    )
    .await?;
    env.fails(&alice, "retire_table", alice_dice.clone(), "on the floor")
        .await?;
    // A new table offers small bets: the session takes the minimum.
    let min_bet = USDC / 10;
    let (mut play, args) = offer(&env, &carol, "alice-dice", "s-a", 6, 10 * USDC, min_bet).await?;
    env.ok(&carol, "open_session", args).await?;
    play.round(min_bet);
    env.ok(
        &env.owner,
        "settle_session",
        json!({"batch": play.batch(&env)}),
    )
    .await?;
    // Alice sells the seat: her table leaves the floor with Carol's session still open.
    env.ok(
        &alice,
        "list_seat",
        json!({"dealer_id": "alice-dice", "price": "1000000"}),
    )
    .await?;
    env.ok(
        &bob,
        "buy_seat",
        json!({"seat": 6, "dealer_id": "bob-dice", "max_price": "1000000"}),
    )
    .await?;
    env.fails(
        &alice,
        "retire_table",
        alice_dice.clone(),
        "sessions to settle",
    )
    .await?;
    env.ok(
        &env.owner,
        "close_session",
        json!({"session_id": "s-a", "server_seed": hex::encode(play.seed)}),
    )
    .await?;
    env.ok(
        &carol,
        "invest",
        json!({"dealer_id": "alice-dice", "amount": (5 * USDC).to_string()}),
    )
    .await?;
    env.fails(&alice, "retire_table", alice_dice.clone(), "other LPs")
        .await?;
    let carol_shares = env.shares(&carol, "alice-dice").await?;
    env.ok(
        &carol,
        "divest",
        json!({"dealer_id": "alice-dice", "shares": carol_shares.to_string()}),
    )
    .await?;
    env.fails(&bob, "retire_table", alice_dice.clone(), "controller")
        .await?;

    let before = env.balance(&alice).await?;
    let bankroll = amount(&env.dealer("alice-dice").await?["bankroll"]);
    env.ok(&alice, "retire_table", alice_dice.clone()).await?;
    assert_eq!(env.balance(&alice).await?, before + bankroll);
    assert_eq!(env.shares(&alice, "alice-dice").await?, 0);
    let lobby = env.view("get_lobby", json!({})).await?;
    assert!(lobby
        .as_array()
        .unwrap()
        .iter()
        .all(|d| d["id"] != "alice-dice"));
    let retired = env.view("get_retired", json!({})).await?;
    assert_eq!(retired[0]["id"], "alice-dice");
    assert_eq!(retired[0]["name"], "Lucky Alice");
    assert_eq!(retired[0]["bankroll"], "0");
    let alice_view = env
        .view("get_player", json!({"account_id": alice.id()}))
        .await?;
    assert_eq!(alice_view["tables"], json!([]));
    let history = env
        .view(
            "get_history",
            json!({"dealer_id": "alice-dice", "from": null, "limit": 1}),
        )
        .await?;
    assert_eq!(history[0]["kind"], "retired");
    assert_eq!(amount(&history[0]["amount"]), bankroll);

    // Retired for good: no money, seat or name, and the id stays taken.
    env.fails(&alice, "retire_table", alice_dice.clone(), "retired")
        .await?;
    env.fails(&alice, "set_table_name", table("Again"), "retired")
        .await?;
    env.fails(
        &alice,
        "bid_for_seat",
        json!({"dealer_id": "alice-dice", "rent_per_hour": "5000000"}),
        "retired",
    )
    .await?;
    env.fails(
        &carol,
        "invest",
        json!({"dealer_id": "alice-dice", "amount": USDC.to_string()}),
        "retired",
    )
    .await?;
    env.fails(
        &alice,
        "open_table",
        json!({
            "id": "alice-dice", "name": "Back", "game": "dice", "temperament": "promoter",
            "look": "top-hat", "seed_amount": TABLE_SEED.to_string(),
        }),
        "already used",
    )
    .await?;
    assert_conserved(
        &env,
        &[&env.owner, &alice, &bob, &carol],
        10_000 * USDC + 2 * (TABLE_SEED + 10 * USDC) + 50 * USDC,
    )
    .await?;
    Ok(())
}

/// The live v2 code (tests/fixtures/floor-v2.wasm, fetched from floor.tilthouse.testnet)
/// upgraded in place: `migrate` keeps every balance, table, log and open session.
#[tokio::test]
async fn upgrade_from_v2_keeps_every_balance_and_session() -> anyhow::Result<()> {
    let v2 = std::fs::read("tests/fixtures/floor-v2.wasm")?;
    let env = setup_code(&v2, 1).await?;
    let player = env.player(50 * USDC).await?;
    let alice = env.player(TABLE_SEED).await?;
    env.open_table(&alice, "alice-dice").await?;
    let mut play = open(&env, &player, "ada", "s-up", 8).await?;
    for _ in 0..3 {
        play.round(USDC);
    }
    env.ok(
        &env.owner,
        "settle_session",
        json!({"batch": play.batch(&env)}),
    )
    .await?;
    let player_args = json!({"account_id": player.id()});
    let session_args = json!({"session_id": "s-up"});
    let history_args = json!({"dealer_id": "ada", "from": 0, "limit": 50});
    let player_before = env.view("get_player", player_args.clone()).await?;
    let session_before = env.view("get_session", session_args.clone()).await?;
    let history_before = env.view("get_history", history_args.clone()).await?;
    let lobby_before = env.view("get_lobby", json!({})).await?;

    let code = &wasms().await[0];
    env.floor
        .as_account()
        .batch(env.floor.id())
        .deploy(code)
        .call(
            Function::new("migrate")
                .args_json(json!({}))
                .gas(Gas::from_tgas(100)),
        )
        .transact()
        .await?
        .into_result()?;

    assert_eq!(env.view("get_player", player_args).await?, player_before);
    assert_eq!(env.view("get_session", session_args).await?, session_before);
    assert_eq!(env.view("get_history", history_args).await?, history_before);
    let lobby = env.view("get_lobby", json!({})).await?;
    let lobby = lobby.as_array().unwrap();
    assert_eq!(lobby.len(), lobby_before.as_array().unwrap().len());
    for (after, before) in lobby.iter().zip(lobby_before.as_array().unwrap()) {
        for field in [
            "id",
            "name",
            "controller",
            "bankroll",
            "reserved",
            "shares",
            "seat",
        ] {
            assert_eq!(after[field], before[field], "{field} kept");
        }
    }
    assert_eq!(env.view("get_npcs", json!({})).await?, json!([]));
    assert_eq!(env.view("get_retired", json!({})).await?, json!([]));

    // Only the contract itself migrates, and only a v2 state.
    env.fails(&env.owner, "migrate", json!({}), "private")
        .await?;
    let again = env
        .floor
        .as_account()
        .call(env.floor.id(), "migrate")
        .args_json(json!({}))
        .transact()
        .await?;
    expect_failure(again, "migrate", "Cannot deserialize")?;

    // The session opened under v2 plays on and closes under v3; v3 methods run on old state.
    play.round(USDC);
    env.ok(
        &env.owner,
        "settle_session",
        json!({"batch": play.batch(&env)}),
    )
    .await?;
    env.ok(
        &env.owner,
        "close_session",
        json!({"session_id": "s-up", "server_seed": hex::encode(play.seed)}),
    )
    .await?;
    assert_eq!(env.balance(&player).await?, 40 * USDC + play.balance);
    env.ok(
        &env.owner,
        "register_npcs",
        json!({"accounts": ["g-1.test.near"]}),
    )
    .await?;
    env.ok(&alice, "retire_table", json!({"dealer_id": "alice-dice"}))
        .await?;
    assert_conserved(
        &env,
        &[&env.owner, &player, &alice],
        10_000 * USDC + 50 * USDC + TABLE_SEED,
    )
    .await?;
    Ok(())
}

/// Poker: two players' buy-ins are sessions at one poker table; one hand settles as one round
/// per player, the pool (with the rent it paid meanwhile) gains exactly the hand's rake, and
/// each session verifies off chain from the hand history.
#[tokio::test]
async fn poker_hand_settles_for_both_players_and_the_pool_keeps_the_rake() -> anyhow::Result<()> {
    let env = setup(0).await?;
    env.ok(
        &env.owner,
        "add_dealer",
        json!({
            "id": "faye", "name": "Faye", "game": "poker", "temperament": "cautious",
            "look": "top-hat", "dealer_account": env.owner.id(), "seed_amount": SEED.to_string(),
        }),
    )
    .await?;
    env.ok(&env.owner, "launch_floor", json!({"dealer_ids": ["faye"]}))
        .await?;
    let alice = env.player(50 * USDC).await?;
    let bob = env.player(50 * USDC).await?;
    let max_bet = amount(&env.dealer("faye").await?["max_bet"]);
    let buy_in = (10 * USDC).min(max_bet);
    let big_blind = USDC / 5;
    assert!(buy_in >= 20 * big_blind, "the table takes a minimum buy-in");

    // A buy-in bigger than one hand may take from a stack is refused.
    let (_, too_big) = offer(&env, &alice, "faye", "p-x", 9, buy_in, buy_in - 1).await?;
    env.fails(
        &alice,
        "open_session",
        too_big,
        "poker buy-in above the max bet",
    )
    .await?;
    let mut sessions = Vec::new();
    for (player, id, seed_byte) in [(&alice, "p-a", 10), (&bob, "p-b", 11)] {
        let (play, args) = offer(&env, player, "faye", id, seed_byte, buy_in, buy_in).await?;
        env.ok(player, "open_session", args).await?;
        sessions.push((player, play));
    }

    let seats = sessions
        .iter()
        .zip(1u8..)
        .map(|((player, play), seat)| SeatStart {
            seat,
            player: player.id().to_string(),
            stack: play.balance,
            client_seed: play.client_seed.clone(),
            rake_bp: play.rake_bp,
        })
        .collect();
    let hand_seed = [42u8; 32];
    let start = HandStart {
        table: "faye".to_string(),
        hand: 1,
        config: TableConfig::standard(big_blind),
        button: 1,
        seats,
        hand_seed_hash: server_seed_hash(&hand_seed),
    };
    let mut hand = Hand::new(start, hand_seed).map_err(|e| anyhow::anyhow!("{e}"))?;
    // Both all in: the hand runs to the river.
    for action in [PokerAction::AllIn, PokerAction::Call] {
        let seat = hand.to_act().expect("a player to act");
        hand.act(seat, action).map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    let rake = hand.result().expect("the hand is over").rake;
    assert!(rake > 0);
    let history = hand.history().expect("the hand is over");

    let pot_and_jackpot =
        |dealer: &Value, floor: &Value| amount(&dealer["bankroll"]) + amount(&floor["jackpot"]);
    let before = pot_and_jackpot(
        &env.dealer("faye").await?,
        &env.view("get_floor", json!({})).await?,
    );
    let mut batches = Vec::new();
    for ((_, play), seat) in sessions.iter_mut().zip(1u8..) {
        let round = hand
            .round_for(seat, play.nonce + 1)
            .expect("a line per seat");
        play.push(round);
        let batch = play.batch(&env);
        env.ok(&env.owner, "settle_session", json!({ "batch": batch }))
            .await?;
        batches.push(batch);
    }
    let mut jackpots = 0;
    for (_, play) in &sessions {
        let session = env
            .view("get_session", json!({"session_id": play.id}))
            .await?;
        jackpots += amount(&session["jackpot_won"]);
    }
    let after = pot_and_jackpot(
        &env.dealer("faye").await?,
        &env.view("get_floor", json!({})).await?,
    );
    assert_eq!(
        after + jackpots,
        before + rake,
        "the table (and the rent it paid) gained exactly the rake"
    );

    for ((player, play), batch) in sessions.iter().zip(&batches) {
        env.ok(
            &env.owner,
            "close_session",
            json!({"session_id": play.id, "server_seed": hex::encode(play.seed)}),
        )
        .await?;
        let summary = core_rules::session::verify_poker_session(
            &play.seed,
            &play.public(),
            player.id().as_str(),
            std::slice::from_ref(batch),
            std::slice::from_ref(&history),
        )
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        assert_eq!(summary.balance, play.balance);
    }
    assert_conserved(
        &env,
        &[&env.owner, &alice, &bob],
        10_000 * USDC + 100 * USDC,
    )
    .await?;
    Ok(())
}
