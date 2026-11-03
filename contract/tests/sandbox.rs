//! Sandbox tests of the house contract against a mock OutLayer (`tests/mock-outlayer`) and a
//! mock NEP-141 token (`tests/mock-ft`). The test holds the VRF signing key: it reads each
//! pending request from the mock, signs `vrf:{id}:{sender}:{seed}` like OutLayer's worker, and
//! resumes the house's callback with that output (or with a forged one).

use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::OnceCell;

const USDC: u128 = 1_000_000;
const MIN_BET: u128 = USDC / 10;
const PLAY_GAS: Gas = Gas::from_tgas(300);
const SEED: u128 = 2_000 * USDC;

static WASMS: OnceCell<[Vec<u8>; 3]> = OnceCell::const_new();

async fn wasms() -> &'static [Vec<u8>; 3] {
    WASMS
        .get_or_init(|| async {
            [
                near_workspaces::compile_project("./").await.unwrap(),
                near_workspaces::compile_project("./tests/mock-outlayer")
                    .await
                    .unwrap(),
                near_workspaces::compile_project("./tests/mock-ft")
                    .await
                    .unwrap(),
            ]
        })
        .await
}

struct Env {
    worker: Worker<Sandbox>,
    house: Contract,
    outlayer: Contract,
    ft: Contract,
    owner: Account,
    key: SigningKey,
}

fn vrf_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

async fn setup() -> anyhow::Result<Env> {
    let [house_wasm, outlayer_wasm, ft_wasm] = wasms().await;
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let ft = worker.dev_deploy(ft_wasm).await?;
    ft.call("new").transact().await?.into_result()?;
    let outlayer = worker.dev_deploy(outlayer_wasm).await?;
    outlayer.call("new").transact().await?.into_result()?;
    let house = worker.dev_deploy(house_wasm).await?;
    let key = vrf_key();
    house
        .call("new")
        .args_json(json!({
            "owner": owner.id(),
            "token": ft.id(),
            "outlayer": outlayer.id(),
            "vrf_pubkey_hex": hex::encode(key.verifying_key().to_bytes()),
            "vrf_source": {"Project": {"project_id": "tilthouse.testnet/tilt-vrf", "version_key": "898b"}},
        }))
        .transact()
        .await?
        .into_result()?;
    let env = Env {
        worker,
        house,
        outlayer,
        ft,
        owner,
        key,
    };
    env.mint(env.house.id().as_str(), 0).await?;
    env.mint(env.owner.id().as_str(), 10_000 * USDC).await?;
    env.deposit(&env.owner.clone(), 10_000 * USDC, "")
        .await?
        .into_result()?;
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

    async fn deposit(
        &self,
        from: &Account,
        amount: u128,
        msg: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(from
            .call(self.ft.id(), "ft_transfer_call")
            .args_json(
                json!({"receiver_id": self.house.id(), "amount": amount.to_string(), "msg": msg}),
            )
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    /// A new player holding `balance` in the house.
    async fn player(&self, balance: u128) -> anyhow::Result<Account> {
        let player = self.worker.dev_create_account().await?;
        self.mint(player.id().as_str(), balance).await?;
        self.deposit(&player, balance, "").await?.into_result()?;
        Ok(player)
    }

    /// Adds a dealer whose account is a fresh sub-account; returns that account.
    async fn add_dealer(
        &self,
        id: &str,
        game: &str,
        temperament: &str,
        seed: u128,
    ) -> anyhow::Result<Account> {
        let account = self
            .owner
            .create_subaccount(id)
            .initial_balance(NearToken::from_near(1))
            .transact()
            .await?
            .into_result()?;
        self.owner
            .call(self.house.id(), "add_dealer")
            .args_json(json!({
                "id": id, "name": id.to_uppercase(), "game": game, "temperament": temperament,
                "dealer_account": account.id(), "seed_amount": seed.to_string(),
            }))
            .transact()
            .await?
            .into_result()?;
        Ok(account)
    }

    async fn view(&self, method: &str, args: Value) -> anyhow::Result<Value> {
        Ok(self.house.view(method).args_json(args).await?.json()?)
    }

    async fn dealer(&self, id: &str) -> anyhow::Result<Value> {
        let lobby = self.view("get_lobby", json!({})).await?;
        let dealer = lobby
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == id)
            .cloned();
        Ok(dealer.expect("dealer in lobby"))
    }

    async fn balance(&self, account: &Account) -> anyhow::Result<u128> {
        let player = self
            .view("get_player", json!({"account_id": account.id()}))
            .await?;
        Ok(amount(&player["balance"]))
    }

    async fn round(&self, round_id: u64) -> anyhow::Result<Value> {
        self.view("get_round", json!({"round_id": round_id})).await
    }

    /// Waits for the mock to hold exactly one pending request and returns it.
    async fn pending(&self) -> anyhow::Result<Value> {
        for _ in 0..60 {
            let pending: Value = self.outlayer.view("get_pending").await?.json()?;
            if let Some(request) = pending.as_array().and_then(|a| a.first()) {
                return Ok(request.clone());
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        anyhow::bail!("no VRF request reached the mock")
    }

    /// The output OutLayer's worker would give for `alpha`, signed with `key`.
    fn output(&self, alpha: &str, key: &SigningKey) -> String {
        let signature = key.sign(alpha.as_bytes()).to_bytes();
        let value = hex::encode(Sha256::digest(signature));
        json!({"results": [{"alpha": alpha, "signature_hex": hex::encode(signature), "value": value}]}).to_string()
    }

    fn honest_output(&self, request: &Value) -> String {
        let alpha = format!(
            "vrf:{}:{}:{}",
            request["request_id"],
            request["sender_id"].as_str().unwrap(),
            request["seed"].as_str().unwrap()
        );
        self.output(&alpha, &self.key)
    }

    async fn resolve(&self, request: &Value, output: &str) -> anyhow::Result<()> {
        self.outlayer
            .call("resolve")
            .args_json(json!({"request_id": request["request_id"], "output": output}))
            .gas(Gas::from_tgas(100))
            .transact_async()
            .await?
            .await?
            .into_result()?;
        Ok(())
    }

    /// Sends a play call, answers its VRF request with `answer(request)`, waits until the
    /// house's callback has run, and returns the player's round id.
    async fn play_with(
        &self,
        player: &Account,
        method: &str,
        args: Value,
        answer: impl FnOnce(&Value) -> String,
    ) -> anyhow::Result<u64> {
        let status = player
            .call(self.house.id(), method)
            .args_json(args)
            .gas(PLAY_GAS)
            .transact_async()
            .await?;
        let request = self.pending().await?;
        self.resolve(&request, &answer(&request)).await?;
        let result = status.await?;
        assert!(result.is_success(), "{method}: {result:?}");
        self.answered(player).await
    }

    async fn play(&self, player: &Account, method: &str, args: Value) -> anyhow::Result<u64> {
        self.play_with(player, method, args, |r| self.honest_output(r))
            .await
    }

    /// The resumed callback runs after the play transaction reports done: poll the round.
    async fn answered(&self, player: &Account) -> anyhow::Result<u64> {
        let view = self
            .view("get_player", json!({"account_id": player.id()}))
            .await?;
        let id = view["last_round"].as_u64().expect("a round");
        for _ in 0..60 {
            if self.round(id).await?["status"] != "waiting_vrf" {
                return Ok(id);
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        anyhow::bail!("round {id} never got its VRF answer")
    }
}

fn amount(value: &Value) -> u128 {
    value.as_str().expect("amount string").parse().unwrap()
}

/// Bankroll + every player's balance + open stakes never changes inside the house.
async fn assert_settled(
    env: &Env,
    round: &Value,
    before: u128,
    player: &Account,
) -> anyhow::Result<()> {
    assert_eq!(round["status"], "settled", "{round}");
    let payout = amount(&round["payout"]);
    let wager = amount(&round["wager"]);
    assert_eq!(env.balance(player).await?, before - wager + payout);
    assert_eq!(
        round["proofs"].as_array().unwrap().len() as u64,
        round["step"].as_u64().unwrap() + 1
    );
    Ok(())
}

#[tokio::test]
async fn dice_and_roulette_rounds_settle() -> anyhow::Result<()> {
    let env = setup().await?;
    env.add_dealer("ada", "dice", "greedy", SEED).await?;
    env.add_dealer("chloe", "roulette", "cautious", SEED)
        .await?;
    let player = env.player(100 * USDC).await?;

    let before = env.balance(&player).await?;
    let id = env
        .play(
            &player,
            "bet_dice",
            json!({"dealer_id": "ada", "stake": "500000", "chance_bp": 5000, "over": true}),
        )
        .await?;
    let round = env.round(id).await?;
    assert!(round["roll"].as_u64().unwrap() < 10_000);
    assert_settled(&env, &round, before, &player).await?;
    let ada = env.dealer("ada").await?;
    assert_eq!(
        amount(&ada["bankroll"]),
        SEED + 500_000 - amount(&round["payout"])
    );
    assert_eq!(amount(&ada["reserved"]), 0);
    assert_eq!(ada["stats"]["bets_1h"], 1);

    let before = env.balance(&player).await?;
    let id = env
        .play(
            &player,
            "bet_roulette",
            json!({"dealer_id": "chloe", "stake": "500000", "bet": {"dozen": 2}}),
        )
        .await?;
    let round = env.round(id).await?;
    assert!(round["pocket"].as_u64().unwrap() <= 36);
    assert_settled(&env, &round, before, &player).await?;

    // Below the table minimum, wrong game, bad bet: refused before any VRF request.
    for (method, args) in [
        (
            "bet_dice",
            json!({"dealer_id": "ada", "stake": (MIN_BET - 1).to_string(), "chance_bp": 5000, "over": true}),
        ),
        (
            "bet_roulette",
            json!({"dealer_id": "ada", "stake": "1000000", "bet": "red"}),
        ),
        (
            "bet_roulette",
            json!({"dealer_id": "chloe", "stake": "500000", "bet": {"straight": 37}}),
        ),
    ] {
        let result = player
            .call(env.house.id(), method)
            .args_json(args)
            .gas(PLAY_GAS)
            .transact()
            .await?;
        assert!(result.is_failure(), "{method} should fail");
    }
    Ok(())
}

#[tokio::test]
async fn blackjack_hand_plays_step_by_step() -> anyhow::Result<()> {
    let env = setup().await?;
    env.add_dealer("eve", "blackjack", "promoter", SEED).await?;
    let player = env.player(100 * USDC).await?;
    let stranger = env.player(10 * USDC).await?;
    let before = env.balance(&player).await?;

    let id = env
        .play(
            &player,
            "bj_deal",
            json!({"dealer_id": "eve", "stake": "1000000"}),
        )
        .await?;
    let mut round = env.round(id).await?;
    if round["status"] == "player_turn" {
        // Only the player may move a live hand.
        let foreign = stranger
            .call(env.house.id(), "bj_stand")
            .args_json(json!({"round_id": id}))
            .gas(PLAY_GAS)
            .transact()
            .await?;
        assert!(foreign.is_failure());
        env.play(&player, "bj_stand", json!({"round_id": id}))
            .await?;
        round = env.round(id).await?;
        assert_eq!(round["step"], 1);
    }
    assert!(round["bj"]["done"].as_bool().unwrap());
    assert_settled(&env, &round, before, &player).await?;
    assert_eq!(amount(&env.dealer("eve").await?["reserved"]), 0);
    Ok(())
}

#[tokio::test]
async fn invest_and_divest_respect_open_bets() -> anyhow::Result<()> {
    let env = setup().await?;
    env.add_dealer("ada", "dice", "greedy", 1_000 * USDC)
        .await?;
    let player = env.player(100 * USDC).await?;
    let lp = env.worker.dev_create_account().await?;
    env.mint(lp.id().as_str(), 500 * USDC).await?;
    env.deposit(&lp, 500 * USDC, r#"{"invest":"ada"}"#)
        .await?
        .into_result()?;
    let lp_shares: u128 = env
        .house
        .view("mt_balance_of")
        .args_json(json!({"account_id": lp.id(), "token_id": "ada"}))
        .await?
        .json::<String>()?
        .parse()?;
    assert_eq!(lp_shares, 500 * USDC * 1_000_000);

    // An open bet reserves its worst case; leave the VRF request pending.
    let stake = env.dealer("ada").await?["max_bet"]
        .as_str()
        .unwrap()
        .parse::<u128>()?;
    let status = player
        .call(env.house.id(), "bet_dice")
        .args_json(json!({"dealer_id": "ada", "stake": stake.to_string(), "chance_bp": 100, "over": false}))
        .gas(PLAY_GAS)
        .transact_async()
        .await?;
    let request = env.pending().await?;
    let ada = env.dealer("ada").await?;
    let reserved = amount(&ada["reserved"]);
    assert_eq!(reserved, stake * 100);
    assert!(amount(&ada["share_price_sell"]) < amount(&ada["share_price_buy"]));

    // Everybody sells everything: what backs the open bet stays in the pool.
    let owner_shares = 1_000 * USDC * 1_000_000;
    for (account, shares) in [(&env.owner, owner_shares), (&lp, lp_shares)] {
        account
            .call(env.house.id(), "divest")
            .args_json(json!({"dealer_id": "ada", "shares": shares.to_string()}))
            .transact()
            .await?
            .into_result()?;
    }
    let ada = env.dealer("ada").await?;
    assert_eq!(amount(&ada["shares"]), 0);
    assert_eq!(amount(&ada["bankroll"]), reserved);
    let free = 1_500 * USDC - reserved;
    assert_eq!(env.balance(&lp).await?, free - free * 2 / 3);
    let over = lp
        .call(env.house.id(), "divest")
        .args_json(json!({"dealer_id": "ada", "shares": "1"}))
        .transact()
        .await?;
    assert!(over.is_failure());

    env.resolve(&request, &env.honest_output(&request)).await?;
    assert!(status.await?.is_success());
    let id = env.answered(&player).await?;
    assert_eq!(env.round(id).await?["status"], "settled");
    let ada = env.dealer("ada").await?;
    assert_eq!(amount(&ada["reserved"]), 0);
    Ok(())
}

#[tokio::test]
async fn bust_closes_the_table_and_invest_reopens_it() -> anyhow::Result<()> {
    let env = setup().await?;
    env.add_dealer("ada", "dice", "greedy", 20 * USDC).await?;
    let player = env.player(10 * USDC).await?;
    assert_eq!(env.dealer("ada").await?["open"], true);

    // The pool falls under what a minimum dice bet needs (0.10 × 100 = 10 USDC).
    env.owner
        .call(env.house.id(), "divest")
        .args_json(json!({"dealer_id": "ada", "shares": (15 * USDC * 1_000_000).to_string()}))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(env.dealer("ada").await?["open"], false);
    let refused = player
        .call(env.house.id(), "bet_dice")
        .args_json(json!({"dealer_id": "ada", "stake": MIN_BET.to_string(), "chance_bp": 5000, "over": true}))
        .gas(PLAY_GAS)
        .transact()
        .await?;
    assert!(refused.is_failure());

    // A rescuer reopens it.
    player
        .call(env.house.id(), "invest")
        .args_json(json!({"dealer_id": "ada", "amount": (6 * USDC).to_string()}))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(env.dealer("ada").await?["open"], true);
    let history = env
        .view(
            "get_history",
            json!({"dealer_id": "ada", "from": null, "limit": 50}),
        )
        .await?;
    let kinds: Vec<&str> = history
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["invest", "divest", "bust", "invest", "reopen"]);
    Ok(())
}

#[tokio::test]
async fn stuck_round_is_refunded_after_timeout() -> anyhow::Result<()> {
    let env = setup().await?;
    env.add_dealer("ada", "dice", "greedy", SEED).await?;
    let player = env.player(10 * USDC).await?;
    let before = env.balance(&player).await?;
    env.outlayer
        .call("set_hang")
        .args_json(json!({"hang": true}))
        .transact()
        .await?
        .into_result()?;
    let _bet = player
        .call(env.house.id(), "bet_dice")
        .args_json(json!({"dealer_id": "ada", "stake": "500000", "chance_bp": 5000, "over": true}))
        .gas(PLAY_GAS)
        .transact_async()
        .await?;
    let request = env.pending().await?;
    let id = env
        .view("get_player", json!({"account_id": player.id()}))
        .await?["open_round"]
        .as_u64()
        .unwrap();
    // Sent async then awaited: after a fast-forward, a blocking broadcast can hit the RPC timeout.
    let refund = |account: &Account| {
        let call = account
            .call(env.house.id(), "refund_stuck_round")
            .args_json(json!({"round_id": id}));
        async move { anyhow::Ok(call.transact_async().await?.await?) }
    };
    assert!(refund(&player).await?.is_failure(), "too early");

    // OutLayer never answers (the mock re-yields past every yield timeout): move the clock
    // past 120 s.
    let start = env.worker.view_block().await?.timestamp();
    let mut elapsed = 0;
    while elapsed < 125 {
        env.worker.fast_forward(100).await?;
        elapsed = (env.worker.view_block().await?.timestamp() - start) / 1_000_000_000;
        if elapsed < 115 {
            assert!(
                refund(&player).await?.is_failure(),
                "refunded after {elapsed} s"
            );
        }
    }
    assert_eq!(env.round(id).await?["status"], "waiting_vrf");
    let stranger = env.worker.dev_create_account().await?;
    refund(&stranger).await?.into_result()?;
    assert_eq!(env.round(id).await?["status"], "refunded");
    assert_eq!(env.balance(&player).await?, before);
    let ada = env.dealer("ada").await?;
    assert_eq!(amount(&ada["reserved"]), 0);
    assert_eq!(amount(&ada["open_stakes"]), 0);
    assert_eq!(amount(&ada["bankroll"]), SEED);

    // A late answer changes nothing.
    // (The bet transaction's own status is not awaited: its receipt chain spans the whole
    // fast-forward and the RPC status call times out.)
    env.resolve(&request, &env.honest_output(&request)).await?;
    let pending: Value = env.outlayer.view("get_pending").await?.json()?;
    assert_eq!(pending, json!([]), "the mock delivered the answer");
    // The house's callback lands a few blocks after the mock's.
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    assert_eq!(env.round(id).await?["status"], "refunded");
    assert_eq!(env.balance(&player).await?, before);
    Ok(())
}

#[tokio::test]
async fn forged_or_foreign_vrf_output_is_rejected() -> anyhow::Result<()> {
    let env = setup().await?;
    env.add_dealer("ada", "dice", "greedy", SEED).await?;
    let player = env.player(10 * USDC).await?;
    let bet = json!({"dealer_id": "ada", "stake": "500000", "chance_bp": 5000, "over": true});

    // A valid proof from a settled round, kept to replay it.
    let mut replay = String::new();
    let first = env
        .play_with(&player, "bet_dice", bet.clone(), |r| {
            let output = env.honest_output(r);
            replay = output.clone();
            output
        })
        .await;
    assert_eq!(env.round(first?).await?["status"], "settled");
    let before = env.balance(&player).await?;

    let other_key = SigningKey::from_bytes(&[8u8; 32]);
    let forgeries: [Box<dyn Fn(&Value) -> String + '_>; 5] = [
        // Signed by someone else's key.
        Box::new(|r| {
            let alpha = format!(
                "vrf:{}:{}:{}",
                r["request_id"],
                r["sender_id"].as_str().unwrap(),
                r["seed"].as_str().unwrap()
            );
            env.output(&alpha, &other_key)
        }),
        // Another round's proof.
        Box::new(|_| replay.clone()),
        // Right round, requested by another sender.
        Box::new(|r| {
            env.output(
                &format!(
                    "vrf:{}:mallory.test.near:{}",
                    r["request_id"],
                    r["seed"].as_str().unwrap()
                ),
                &env.key,
            )
        }),
        // Right sender, a seed that only starts like this round's.
        Box::new(|r| {
            env.output(
                &format!(
                    "vrf:{}:{}:{}0",
                    r["request_id"],
                    r["sender_id"].as_str().unwrap(),
                    r["seed"].as_str().unwrap()
                ),
                &env.key,
            )
        }),
        // OutLayer failed.
        Box::new(|_| "null".to_string()),
    ];
    for forge in forgeries.iter() {
        let id = env
            .play_with(&player, "bet_dice", bet.clone(), forge)
            .await?;
        let round = env.round(id).await?;
        assert_eq!(round["status"], "failed", "{round}");
        assert!(round["payout"].is_null());
        // Refundable at once, stake back, reserve released.
        player
            .call(env.house.id(), "refund_stuck_round")
            .args_json(json!({"round_id": id}))
            .transact()
            .await?
            .into_result()?;
        assert_eq!(env.balance(&player).await?, before);
        assert_eq!(amount(&env.dealer("ada").await?["reserved"]), 0);
    }
    Ok(())
}

#[tokio::test]
async fn reprice_only_by_the_dealer_account() -> anyhow::Result<()> {
    let env = setup().await?;
    let ada = env.add_dealer("ada", "dice", "greedy", SEED).await?;
    let stranger = env.worker.dev_create_account().await?;
    for account in [&stranger, &env.owner] {
        let result = account
            .call(env.house.id(), "reprice")
            .args_json(json!({"dealer_id": "ada"}))
            .transact()
            .await?;
        assert!(result.is_failure());
    }
    let offer: Value = ada
        .call(env.house.id(), "reprice")
        .args_json(json!({"dealer_id": "ada"}))
        .transact()
        .await?
        .json()?;
    let rake = offer["rake_bp"].as_u64().unwrap();
    assert!((100..=495).contains(&rake), "{offer}");
    Ok(())
}

#[tokio::test]
async fn withdraw_rolls_back_when_the_transfer_fails() -> anyhow::Result<()> {
    let env = setup().await?;
    let player = env.player(10 * USDC).await?;
    let withdraw = |amount: u128| {
        player
            .call(env.house.id(), "withdraw")
            .args_json(json!({"amount": amount.to_string()}))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(100))
            .transact()
    };
    env.ft
        .call("set_fail_transfers")
        .args_json(json!({"fail": true}))
        .transact()
        .await?
        .into_result()?;
    let failed = withdraw(4 * USDC).await?;
    assert!(failed.receipt_failures().len() == 1, "{failed:?}");
    assert_eq!(env.balance(&player).await?, 10 * USDC);

    env.ft
        .call("set_fail_transfers")
        .args_json(json!({"fail": false}))
        .transact()
        .await?
        .into_result()?;
    withdraw(4 * USDC).await?.into_result()?;
    assert_eq!(env.balance(&player).await?, 6 * USDC);
    let on_token: String = env
        .ft
        .view("ft_balance_of")
        .args_json(json!({"account_id": player.id()}))
        .await?
        .json()?;
    assert_eq!(on_token, (4 * USDC).to_string());

    // Without the yocto (a function-call key) a withdraw is refused.
    let keyless = player
        .call(env.house.id(), "withdraw")
        .args_json(json!({"amount": "1"}))
        .transact()
        .await?;
    assert!(keyless.is_failure());
    Ok(())
}

#[tokio::test]
async fn lp_shares_transfer_as_nep245() -> anyhow::Result<()> {
    let env = setup().await?;
    env.add_dealer("ada", "dice", "greedy", SEED).await?;
    let friend = env.worker.dev_create_account().await?;
    let result = env
        .owner
        .call(env.house.id(), "mt_transfer")
        .args_json(json!({"receiver_id": friend.id(), "token_id": "ada", "amount": "1000", "approval": null, "memo": "gift"}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let event = result
        .logs()
        .into_iter()
        .find_map(|log| log.strip_prefix("EVENT_JSON:").map(str::to_string))
        .expect("event");
    let event: Value = serde_json::from_str(&event)?;
    assert_eq!(event["standard"], "nep245");
    assert_eq!(event["event"], "mt_transfer");
    assert_eq!(event["data"][0]["amounts"][0], "1000");
    let balances: Vec<String> = env
        .house
        .view("mt_batch_balance_of")
        .args_json(json!({"account_id": friend.id(), "token_ids": ["ada", "nobody"]}))
        .await?
        .json()?;
    assert_eq!(balances, ["1000", "0"]);
    let player = env
        .view("get_player", json!({"account_id": friend.id()}))
        .await?;
    assert_eq!(player["lp"][0]["dealer_id"], "ada");
    Ok(())
}
