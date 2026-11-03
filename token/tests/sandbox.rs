//! End to end on a local sandbox: mint with registration, the daily cap, unlimited seeding and a
//! plain NEP-141 transfer.

use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::json;

const ONE_TUSDC: u128 = 1_000_000;

async fn balance(token: &Contract, account: &Account) -> u128 {
    let b: String = token
        .view("ft_balance_of")
        .args_json(json!({ "account_id": account.id() }))
        .await
        .unwrap()
        .json()
        .unwrap();
    b.parse().unwrap()
}

async fn mint(minter: &Account, token: &Contract, to: &Account, amount: u128) -> bool {
    minter
        .call(token.id(), "mint_to")
        .args_json(json!({ "account_id": to.id(), "amount": amount.to_string() }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await
        .unwrap()
        .is_success()
}

#[tokio::test]
async fn mint_cap_unlimited_and_transfer() -> anyhow::Result<()> {
    let wasm = near_workspaces::compile_project("./").await?;
    let worker = near_workspaces::sandbox().await?;
    let token = worker.dev_deploy(&wasm).await?;
    let root = worker.root_account()?;
    let new_account = |name: &'static str| {
        let root = root.clone();
        async move {
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(10))
                .transact()
                .await
                .unwrap()
                .into_result()
                .unwrap()
        }
    };
    let owner = new_account("owner").await;
    let minter = new_account("minter").await;
    let player = new_account("player").await;
    let pool = new_account("pool").await;

    token
        .call("new")
        .args_json(json!({ "owner_id": owner.id(), "minter_id": minter.id() }))
        .transact()
        .await?
        .into_result()?;

    let meta: serde_json::Value = token.view("ft_metadata").await?.json()?;
    assert_eq!(meta["symbol"], "tUSDC");
    assert_eq!(meta["decimals"], 6);

    // Players: 1,000 tUSDC per 24 h, registered on first mint.
    assert!(mint(&minter, &token, &player, 1_000 * ONE_TUSDC).await);
    assert!(!mint(&minter, &token, &player, 1).await);
    assert_eq!(balance(&token, &player).await, 1_000 * ONE_TUSDC);

    // Only the minter mints.
    assert!(!mint(&player, &token, &player, 1).await);

    // Owner lifts the cap for a dealer pool.
    owner
        .call(token.id(), "set_unlimited")
        .args_json(json!({ "account_id": pool.id(), "unlimited": true }))
        .transact()
        .await?
        .into_result()?;
    assert!(mint(&minter, &token, &pool, 2_000 * ONE_TUSDC).await);
    assert!(mint(&minter, &token, &pool, 2_000 * ONE_TUSDC).await);
    assert_eq!(balance(&token, &pool).await, 4_000 * ONE_TUSDC);

    // Standard NEP-141 transfer between registered accounts.
    player
        .call(token.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": pool.id(), "amount": (250 * ONE_TUSDC).to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(balance(&token, &player).await, 750 * ONE_TUSDC);
    assert_eq!(balance(&token, &pool).await, 4_250 * ONE_TUSDC);

    let supply: String = token.view("ft_total_supply").await?.json()?;
    assert_eq!(supply, (5_000 * ONE_TUSDC).to_string());
    Ok(())
}
