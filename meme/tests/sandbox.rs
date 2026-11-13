//! $TILT end to end on a local sandbox, against a mock floor (`tests/mock-floor`) that forwards
//! day reports and receives `start_tilt_hour`: launch supply, the daily mint (pro rata, caps,
//! streak) and burn, every refused report, the Tilt Hour cross-contract call and its failure,
//! welcome claims, unauthorized callers and the log.

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use tilt_house_meme::rules::{Economics, LAUNCH, ONE_TILT};
use tokio::sync::OnceCell;

const ONE_TUSDC: u128 = 1_000_000;
const REGISTRATION: NearToken = NearToken::from_millinear(2);

static WASMS: OnceCell<[Vec<u8>; 2]> = OnceCell::const_new();

async fn wasms() -> &'static [Vec<u8>; 2] {
    WASMS
        .get_or_init(|| async {
            [
                near_workspaces::compile_project("./").await.unwrap(),
                near_workspaces::compile_project("./tests/mock-floor")
                    .await
                    .unwrap(),
            ]
        })
        .await
}

struct Setup {
    worker: Worker<Sandbox>,
    tilt: Contract,
    floor: Contract,
    operator: Account,
    house: Account,
}

impl Setup {
    async fn new(economics: &Economics) -> anyhow::Result<Self> {
        let [tilt_wasm, floor_wasm] = wasms().await;
        let worker = near_workspaces::sandbox().await?;
        let tilt = worker.dev_deploy(tilt_wasm).await?;
        let floor = worker.dev_deploy(floor_wasm).await?;
        let operator = worker.dev_create_account().await?;
        let house = worker.dev_create_account().await?;
        floor
            .call("new")
            .args_json(json!({ "tilt": tilt.id() }))
            .transact()
            .await?
            .into_result()?;
        tilt.call("new")
            .args_json(json!({
                "floor": floor.id(),
                "welcome_operator": operator.id(),
                "house_receiver": house.id(),
                "economics": economics,
            }))
            .transact()
            .await?
            .into_result()?;
        Ok(Self {
            worker,
            tilt,
            floor,
            operator,
            house,
        })
    }

    async fn account(&self) -> anyhow::Result<Account> {
        Ok(self.worker.dev_create_account().await?)
    }

    async fn state(&self) -> anyhow::Result<Value> {
        Ok(self.tilt.view("get_state").await?.json()?)
    }

    async fn balance(&self, account: &near_workspaces::AccountId) -> anyhow::Result<u128> {
        let b: String = self
            .tilt
            .view("ft_balance_of")
            .args_json(json!({ "account_id": account }))
            .await?
            .json()?;
        Ok(b.parse()?)
    }

    async fn close_day(
        &self,
        day: u64,
        players_net: i128,
        wagers: &[(&Account, u128)],
    ) -> anyhow::Result<ExecutionFinalResult> {
        let wagers: Vec<Value> = wagers
            .iter()
            .map(|(a, w)| json!([a.id(), w.to_string()]))
            .collect();
        Ok(self
            .floor
            .call("close_day")
            .args_json(
                json!({ "day": day, "players_net": players_net.to_string(), "wagers": wagers }),
            )
            .gas(near_workspaces::types::Gas::from_tgas(300))
            .transact()
            .await?)
    }

    async fn claim(&self, signer: &Account, who: &Account) -> anyhow::Result<ExecutionFinalResult> {
        Ok(signer
            .call(self.tilt.id(), "claim_welcome_for")
            .args_json(json!({ "account_id": who.id() }))
            .deposit(REGISTRATION)
            .transact()
            .await?)
    }

    async fn burn(&self, who: &Account, amount: u128) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(self.tilt.id(), "burn_for_tilt_hour")
            .args_json(json!({ "amount": amount.to_string() }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(near_workspaces::types::Gas::from_tgas(100))
            .transact()
            .await?)
    }

    async fn log(&self) -> anyhow::Result<Vec<Value>> {
        Ok(self
            .tilt
            .view("get_log")
            .args_json(json!({ "limit": 100 }))
            .await?
            .json()?)
    }
}

fn amount(value: &Value) -> u128 {
    value.as_str().expect("amount string").parse().unwrap()
}

fn expect_failure(result: ExecutionFinalResult, error: &str) {
    assert!(result.is_failure(), "expected failure {error:?}");
    let message = format!("{:?}", result.into_result().unwrap_err());
    assert!(message.contains(error), "expected {error:?}, got {message}");
}

#[tokio::test]
async fn launch_daily_mint_caps_burn_and_guards() -> anyhow::Result<()> {
    // Day cap below 3 × player cap so both caps bind in this test.
    let economics = Economics {
        day_cap: near_sdk::json_types::U128(800 * ONE_TILT),
        ..LAUNCH
    };
    let s = Setup::new(&economics).await?;
    let (alice, bob, carol) = (s.account().await?, s.account().await?, s.account().await?);

    // Launch: treasury in the contract, house allocation to the receiver, nothing else.
    let meta: Value = s.tilt.view("ft_metadata").await?.json()?;
    assert_eq!(
        (
            meta["name"].as_str(),
            meta["symbol"].as_str(),
            meta["decimals"].as_u64()
        ),
        (Some("Tilt"), Some("TILT"), Some(6))
    );
    let params: Value = s.tilt.view("get_params").await?.json()?;
    assert_eq!(params["floor"], json!(s.floor.id()));
    assert_eq!(amount(&params["day_cap"]), 800 * ONE_TILT);
    assert_eq!(params["max_players"], 50);
    let state = s.state().await?;
    assert_eq!(amount(&state["treasury"]), LAUNCH.treasury_initial.0);
    assert_eq!(
        amount(&state["total_supply"]),
        LAUNCH.treasury_initial.0 + LAUNCH.house_allocation.0
    );
    assert_eq!(s.balance(s.house.id()).await?, LAUNCH.house_allocation.0);
    let today = state["today"].as_u64().unwrap();
    let (d1, d2, d3) = (today - 3, today - 2, today - 1);

    // Only the floor reports.
    let direct = alice
        .call(s.tilt.id(), "report_day")
        .args_json(json!({ "day": d1, "players_net": "1", "wagers": [] }))
        .transact()
        .await?;
    expect_failure(direct, "Only the floor can report a day");

    // Day 1, humans +100 tUSDC: 1,000 TILT cut to the 800 day cap; carol's 90 % share is capped
    // at 500, the others get 5 % each. Nobody was registered: the contract pays their storage.
    let r = s
        .close_day(
            d1,
            100 * ONE_TUSDC as i128,
            &[
                (&carol, 9_000 * ONE_TUSDC),
                (&alice, 500 * ONE_TUSDC),
                (&bob, 500 * ONE_TUSDC),
            ],
        )
        .await?;
    assert!(r.is_success(), "{r:?}");
    assert_eq!(s.balance(carol.id()).await?, 500 * ONE_TILT);
    assert_eq!(s.balance(alice.id()).await?, 40 * ONE_TILT);
    assert_eq!(s.balance(bob.id()).await?, 40 * ONE_TILT);
    let state = s.state().await?;
    assert_eq!(
        (
            state["streak"].as_u64(),
            state["last_reported_day"].as_u64()
        ),
        (Some(1), Some(d1))
    );
    assert_eq!(
        amount(&state["minted_total"]),
        LAUNCH.treasury_initial.0 + LAUNCH.house_allocation.0 + 580 * ONE_TILT
    );

    // Once per day, in order.
    expect_failure(s.close_day(d1, 1, &[]).await?, "Day already reported");
    // Not before the day ends.
    expect_failure(s.close_day(today, 1, &[]).await?, "The day has not ended");
    // At most 50 players, no duplicates, positive wagers.
    let crowd: Vec<Account> = {
        let mut v = Vec::new();
        for _ in 0..51 {
            v.push(s.account().await?);
        }
        v
    };
    let wagers: Vec<(&Account, u128)> = crowd.iter().map(|a| (a, ONE_TUSDC)).collect();
    expect_failure(
        s.close_day(d2, 1, &wagers).await?,
        "At most 50 players per day",
    );
    expect_failure(
        s.close_day(d2, 1, &[(&alice, 1), (&alice, 2)]).await?,
        "Duplicate player",
    );
    expect_failure(
        s.close_day(d2, 1, &[(&alice, 0)]).await?,
        "Each wager must be positive",
    );

    // Day 2, humans +10,000 tUSDC with 50 players: the 800 TILT day cap binds, split evenly.
    let r = s
        .close_day(d2, 10_000 * ONE_TUSDC as i128, &wagers[..50])
        .await?;
    assert!(r.is_success(), "{r:?}");
    // The worst case (50 new accounts registered and minted) fits the floor's 150 Tgas.
    let report_gas = r
        .receipt_outcomes()
        .iter()
        .filter(|o| o.executor_id == *s.tilt.id())
        .map(|o| o.gas_burnt.as_tgas())
        .max()
        .unwrap();
    assert!(
        report_gas < 100,
        "report_day of 50 new players burnt {report_gas} Tgas"
    );
    assert_eq!(s.balance(crowd[0].id()).await?, 16 * ONE_TILT);
    assert_eq!(s.balance(crowd[49].id()).await?, 16 * ONE_TILT);
    let state = s.state().await?;
    assert_eq!(
        (state["streak"].as_u64(), state["longest_streak"].as_u64()),
        (Some(2), Some(2))
    );

    // Day 3, the house wins: 1 % of the treasury burns, the streak resets, the record stays.
    let supply_before = amount(&state["total_supply"]);
    let r = s
        .close_day(d3, -50 * ONE_TUSDC as i128, &[(&alice, ONE_TUSDC)])
        .await?;
    assert!(r.is_success(), "{r:?}");
    let state = s.state().await?;
    let burned = LAUNCH.treasury_initial.0 / 100;
    assert_eq!(
        amount(&state["treasury"]),
        LAUNCH.treasury_initial.0 - burned
    );
    assert_eq!(amount(&state["total_supply"]), supply_before - burned);
    assert_eq!(amount(&state["burned_total"]), burned);
    assert_eq!(s.balance(alice.id()).await?, 40 * ONE_TILT);
    assert_eq!(
        (
            state["streak"].as_u64(),
            state["longest_streak"].as_u64(),
            state["longest_streak_day"].as_u64()
        ),
        (Some(0), Some(2), Some(d2))
    );

    // The log: launch mints, then each day's streak entry and its mints or burn.
    let log = s.log().await?;
    let line = |e: &Value| {
        format!(
            "{} {}",
            e["kind"].as_str().unwrap(),
            e["reason"].as_str().unwrap()
        )
    };
    let lines: Vec<String> = log.iter().map(line).collect();
    assert_eq!(
        lines[..6],
        [
            "mint launch",
            "mint launch",
            "streak grow",
            "mint daily",
            "mint daily",
            "mint daily"
        ]
    );
    assert_eq!(lines[6], "streak grow");
    assert_eq!(lines[lines.len() - 2..], ["streak reset", "burn daily"]);
    assert_eq!(log.len(), 6 + 1 + 50 + 2);
    assert_eq!(log[3]["account"], json!(carol.id()));
    assert_eq!(amount(&log[3]["amount"]), 500 * ONE_TILT);
    assert_eq!(log.last().unwrap()["day"].as_u64(), Some(d3));
    // Paging by sequence number.
    let page: Vec<Value> = s
        .tilt
        .view("get_log")
        .args_json(json!({ "from": 57, "limit": 5 }))
        .await?
        .json()?;
    assert_eq!(
        page.iter()
            .map(|e| e["seq"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [57, 58]
    );
    Ok(())
}

#[tokio::test]
async fn tilt_hour_calls_the_floor_and_logs_a_refusal() -> anyhow::Result<()> {
    let economics = Economics {
        tilt_hour_amount: near_sdk::json_types::U128(100 * ONE_TILT),
        tilt_hour_min_burners: 2,
        tilt_hour_min_burn: near_sdk::json_types::U128(20 * ONE_TILT),
        ..LAUNCH
    };
    let s = Setup::new(&economics).await?;
    let (a, b, c) = (s.account().await?, s.account().await?, s.account().await?);
    for who in [&a, &b, &c] {
        assert!(s.claim(&s.operator, who).await?.is_success());
    }

    // Dust and missing yocto are refused.
    expect_failure(
        s.burn(&a, ONE_TILT).await?,
        "Burn at least tilt_hour_min_burn",
    );
    let no_yocto = a
        .call(s.tilt.id(), "burn_for_tilt_hour")
        .args_json(json!({ "amount": (20 * ONE_TILT).to_string() }))
        .transact()
        .await?;
    expect_failure(no_yocto, "Requires attached deposit of exactly 1 yoctoNEAR");

    // One holder alone never starts it, whatever it burns.
    let r = s.burn(&c, 100 * ONE_TILT).await?;
    assert!(!r.json::<bool>()?);
    let state = s.state().await?;
    assert_eq!(
        (
            amount(&state["tilt_hour"]["burned"]),
            state["tilt_hour"]["burners"].as_u64()
        ),
        (100 * ONE_TILT, Some(1))
    );
    // A second burner completes the round: TILT calls the floor.
    let r = s.burn(&a, 20 * ONE_TILT).await?;
    assert!(r.is_success(), "{r:?}");
    assert!(r.json::<bool>()?);
    let hours: u32 = s.floor.view("tilt_hours").await?.json()?;
    assert_eq!(hours, 1);
    let state = s.state().await?;
    assert_eq!(state["tilt_hour"]["triggers"].as_u64(), Some(1));
    assert_eq!(state["tilt_hour"]["round"].as_u64(), Some(1));
    assert_eq!(amount(&state["tilt_hour"]["burned"]), 0);
    assert!(state["tilt_hour"]["last_started_ns"].is_string());
    assert_eq!(s.balance(c.id()).await?, 0);
    assert_eq!(s.balance(a.id()).await?, 80 * ONE_TILT);

    // The floor refuses the next one: the burn stays done, the log says it failed.
    s.floor
        .call("set_fail_tilt_hour")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;
    assert!(!s.burn(&a, 50 * ONE_TILT).await?.json::<bool>()?);
    let r = s.burn(&b, 50 * ONE_TILT).await?;
    assert!(r.is_success(), "{r:?}");
    assert!(!r.json::<bool>()?);
    let hours: u32 = s.floor.view("tilt_hours").await?.json()?;
    assert_eq!(hours, 1);
    assert_eq!(s.balance(b.id()).await?, 50 * ONE_TILT);
    let state = s.state().await?;
    assert_eq!(state["tilt_hour"]["triggers"].as_u64(), Some(2));

    let log = s.log().await?;
    let tilt_hour: Vec<&str> = log
        .iter()
        .filter(|e| e["kind"] == "tilt_hour")
        .map(|e| e["reason"].as_str().unwrap())
        .collect();
    assert_eq!(tilt_hour, ["triggered", "started", "triggered", "failed"]);
    let burns = log
        .iter()
        .filter(|e| e["kind"] == "burn" && e["reason"] == "tilt_hour")
        .count();
    assert_eq!(burns, 4);

    // Nobody but TILT itself can call the callback.
    let fake = a
        .call(s.tilt.id(), "on_tilt_hour_started")
        .args_json(json!({ "round": 9, "burned": "1" }))
        .transact()
        .await?;
    expect_failure(fake, "is private");
    Ok(())
}

#[tokio::test]
async fn welcome_once_per_account_daily_cap_and_pool() -> anyhow::Result<()> {
    let economics = Economics {
        welcome_pool: near_sdk::json_types::U128(250 * ONE_TILT),
        welcome_daily_claims: 4,
        ..LAUNCH
    };
    let s = Setup::new(&economics).await?;
    let accounts = [
        s.account().await?,
        s.account().await?,
        s.account().await?,
        s.account().await?,
        s.account().await?,
    ];

    // Only the welcome operator.
    expect_failure(
        s.claim(&accounts[0], &accounts[0]).await?,
        "Only the welcome operator can claim",
    );

    let r = s.claim(&s.operator, &accounts[0]).await?;
    assert!(r.is_success(), "{r:?}");
    assert_eq!(amount(&r.json::<Value>()?), 100 * ONE_TILT);
    // Once per account.
    expect_failure(
        s.claim(&s.operator, &accounts[0]).await?,
        "Welcome already claimed",
    );
    let welcomed: bool = s
        .tilt
        .view("has_claimed_welcome")
        .args_json(json!({ "account_id": accounts[0].id() }))
        .await?
        .json()?;
    assert!(welcomed);

    // Without a registration deposit an unregistered account is refused.
    let r = s
        .operator
        .call(s.tilt.id(), "claim_welcome_for")
        .args_json(json!({ "account_id": accounts[4].id() }))
        .transact()
        .await?;
    expect_failure(r, "Attach at least");

    assert!(s.claim(&s.operator, &accounts[1]).await?.is_success());
    // The pool has 50 left: the third claim gets the rest, the fourth nothing.
    let r = s.claim(&s.operator, &accounts[2]).await?;
    assert_eq!(amount(&r.json::<Value>()?), 50 * ONE_TILT);
    expect_failure(
        s.claim(&s.operator, &accounts[3]).await?,
        "Welcome pool is empty",
    );
    let state = s.state().await?;
    assert_eq!(
        (
            amount(&state["welcome_remaining"]),
            state["welcome_claims"].as_u64()
        ),
        (0, Some(3))
    );

    // Daily cap, on a fresh launch with room in the pool.
    let economics = Economics {
        welcome_daily_claims: 2,
        ..LAUNCH
    };
    let s = Setup::new(&economics).await?;
    let accounts = [s.account().await?, s.account().await?, s.account().await?];
    assert!(s.claim(&s.operator, &accounts[0]).await?.is_success());
    assert!(s.claim(&s.operator, &accounts[1]).await?.is_success());
    expect_failure(
        s.claim(&s.operator, &accounts[2]).await?,
        "Daily welcome cap reached",
    );
    Ok(())
}
