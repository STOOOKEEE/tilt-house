//! Sandbox tests of the floor contract (v2) against a mock NEP-141 token (`tests/mock-ft`). The
//! test plays the session server: it holds the server key, draws the seed, plays rounds with
//! `core_rules::session` and signs tickets and states like the real server.

use core_rules::session::{
    replay_round, server_seed_hash, session_max_win, state_message, ticket_message, CompactRound,
    Hash32, SessionPublic, SessionState, SessionTicket, SettleBatch,
};
use core_rules::{Bet, DiceBet, Game, RouletteBet, RouletteSpot};
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::network::Sandbox;
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
    let [floor_wasm, ft_wasm] = wasms().await;
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
        from.call(self.ft.id(), "ft_transfer_call")
            .args_json(
                json!({"receiver_id": self.floor.id(), "amount": amount.to_string(), "msg": ""}),
            )
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
        Ok(())
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
        Ok(who
            .call(self.floor.id(), method)
            .args_json(args)
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
        assert!(result.is_failure(), "{method} should fail with {error:?}");
        let message = format!("{:?}", result.into_result().unwrap_err());
        assert!(
            message.contains(error),
            "{method}: expected {error:?}, got {message}"
        );
        Ok(())
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
        self.nonce += 1;
        let round = replay_round(&self.seed, &self.public(), self.nonce, bet, stake, &[]).unwrap();
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
    let dealer = env.dealer(dealer_id).await?;
    let lock = 10 * USDC;
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
        max_bet: USDC,
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
    env.ok(
        player,
        "open_session",
        json!({"ticket": ticket, "server_sig": sig}),
    )
    .await?;
    Ok(play)
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
    // 99 tUSDC/h: the 2 h prepay leaves the pool 2 tUSDC, a few minutes more of rent.
    env.ok(
        &alice,
        "bid_for_seat",
        json!({"dealer_id": "alice-dice", "rent_per_hour": "99000000"}),
    )
    .await?;
    assert_eq!(
        amount(&env.dealer("alice-dice").await?["bankroll"]),
        2 * USDC
    );
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
    let last = history.as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["kind"], "evicted");
    assert_eq!(last["detail"], "unpaid_rent");
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
