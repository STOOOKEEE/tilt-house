//! Unit tests on the mocked VM: timers, blackjack moves, storage caps and logs. The VRF answer
//! is signed here with a test key, like the sandbox tests do.

use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, Gas, NearToken, PromiseResult, RuntimeFeesConfig};
use sha2::{Digest, Sha256};

use crate::{
    House, Status, ABANDON_AFTER_SECS, HISTORY_PER_DEALER, REFUND_AFTER_SECS, ROUNDS_PER_PLAYER,
};

const USDC: u128 = 1_000_000;
const T0: u64 = 1_800_000_000;

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn house_id() -> AccountId {
    account("house.test")
}

fn key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn context(predecessor: &str, now: u64) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(house_id())
        .predecessor_account_id(account(predecessor))
        .signer_account_id(account(predecessor))
        .block_timestamp(now * 1_000_000_000)
        .prepaid_gas(Gas::from_tgas(300))
        .account_balance(NearToken::from_near(100));
    builder
}

fn at(predecessor: &str, now: u64) {
    testing_env!(context(predecessor, now).build());
}

fn with_yocto(predecessor: &str, now: u64) {
    testing_env!(context(predecessor, now)
        .attached_deposit(NearToken::from_yoctonear(1))
        .build());
}

/// The callback context: called by the contract itself, with OutLayer's answer.
fn answering(raw: Vec<u8>, now: u64) {
    testing_env!(
        context("house.test", now).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(raw)]
    );
}

fn signed(alpha: &str) -> Vec<u8> {
    let signature = key().sign(alpha.as_bytes()).to_bytes();
    json!({"results": [{
        "alpha": alpha,
        "signature_hex": hex::encode(signature),
        "value": hex::encode(Sha256::digest(signature)),
    }]})
    .to_string()
    .into_bytes()
}

fn answer(house: &mut House, round_id: u64, step: u32, signer: &str, now: u64) {
    answering(
        signed(&format!("vrf:9:{signer}:round-{round_id}-{step}")),
        now,
    );
    house.on_vrf(round_id, step);
}

/// A house with dealers ada (dice) and eve (blackjack), 2 000 USDC each, and alice holding
/// 100 USDC.
fn house() -> House {
    at("owner.test", T0);
    let mut house = House::new(
        account("owner.test"),
        account("token.test"),
        account("outlayer.test"),
        hex::encode(key().verifying_key().to_bytes()),
        json!({"Project": {"project_id": "p", "version_key": "v"}}),
    );
    at("token.test", T0);
    house
        .ft_on_transfer(account("owner.test"), U128(4_000 * USDC), String::new())
        .detach();
    house
        .ft_on_transfer(account("alice.test"), U128(100 * USDC), String::new())
        .detach();
    at("owner.test", T0);
    for (id, game) in [("ada", "dice"), ("eve", "blackjack")] {
        house.add_dealer(
            id.to_string(),
            id.to_uppercase(),
            game.to_string(),
            "promoter".to_string(),
            account(&format!("{id}.test")),
            U128(2_000 * USDC),
        );
    }
    house
}

fn balance(house: &House, who: &str) -> u128 {
    house.get_player(account(who)).balance.0
}

fn dice(house: &mut House, who: &str, now: u64) -> u64 {
    at(who, now);
    house.bet_dice("ada".to_string(), U128(USDC / 2), 5_000, true)
}

#[test]
fn dice_round_settles_with_a_signed_answer() {
    let mut house = house();
    let id = dice(&mut house, "alice.test", T0);
    assert_eq!(house.get_round(id).unwrap().status, Status::WaitingVrf);
    assert_eq!(house.dealer("ada").pool.reserved, USDC);
    answer(&mut house, id, 0, "alice.test", T0 + 6);
    let round = house.get_round(id).unwrap();
    assert_eq!(round.status, Status::Settled);
    let payout = round.payout.unwrap().0;
    assert_eq!(
        balance(&house, "alice.test"),
        100 * USDC - USDC / 2 + payout
    );
    let ada = house.dealer("ada");
    assert_eq!((ada.pool.reserved, ada.pool.open_stakes), (0, 0));
    assert_eq!(ada.pool.bankroll, 2_000 * USDC + USDC / 2 - payout);
    // A second answer for the same step is ignored.
    answer(&mut house, id, 0, "alice.test", T0 + 7);
    assert_eq!(
        balance(&house, "alice.test"),
        100 * USDC - USDC / 2 + payout
    );
}

#[test]
fn answer_from_a_foreign_signer_fails_the_round() {
    let mut house = house();
    let id = dice(&mut house, "alice.test", T0);
    answer(&mut house, id, 0, "mallory.test", T0 + 6);
    let round = house.get_round(id).unwrap();
    assert_eq!(round.status, Status::Failed);
    assert!(round.error.unwrap().contains("not for round-1-0"));
}

#[test]
fn failed_request_execution_fails_the_round() {
    let mut house = house();
    let id = dice(&mut house, "alice.test", T0);
    testing_env!(
        context("house.test", T0 + 6).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    house.on_vrf(id, 0);
    assert_eq!(house.get_round(id).unwrap().status, Status::Failed);
    at("bob.test", T0 + 7);
    house.refund_stuck_round(id);
    assert_eq!(balance(&house, "alice.test"), 100 * USDC);
}

#[test]
#[should_panic(expected = "round is not refundable")]
fn refund_waits_120_seconds() {
    let mut house = house();
    let id = dice(&mut house, "alice.test", T0);
    at("bob.test", T0 + REFUND_AFTER_SECS - 1);
    house.refund_stuck_round(id);
}

#[test]
fn refund_after_120_seconds_returns_the_stake() {
    let mut house = house();
    let id = dice(&mut house, "alice.test", T0);
    at("bob.test", T0 + REFUND_AFTER_SECS);
    house.refund_stuck_round(id);
    assert_eq!(house.get_round(id).unwrap().status, Status::Refunded);
    assert_eq!(balance(&house, "alice.test"), 100 * USDC);
    assert_eq!(house.dealer("ada").pool.reserved, 0);
    assert_eq!(house.get_player(account("alice.test")).open_round, None);
    // A late answer changes nothing.
    answer(&mut house, id, 0, "alice.test", T0 + REFUND_AFTER_SECS + 1);
    assert_eq!(house.get_round(id).unwrap().status, Status::Refunded);
}

#[test]
#[should_panic(expected = "finish your open round first")]
fn one_open_round_per_player() {
    let mut house = house();
    dice(&mut house, "alice.test", T0);
    dice(&mut house, "alice.test", T0 + 1);
}

#[test]
#[should_panic(expected = "attach at least 150 TGas")]
fn play_needs_enough_gas_for_the_vrf() {
    let mut house = house();
    testing_env!(context("alice.test", T0)
        .prepaid_gas(Gas::from_tgas(100))
        .build());
    house.bet_dice("ada".to_string(), U128(USDC / 2), 5_000, true);
}

/// Deals until the hand is in the player's turn (a natural settles at once).
fn live_hand(house: &mut House) -> u64 {
    for i in 0..20 {
        let now = T0 + i * 10;
        at("alice.test", now);
        let id = house.bj_deal("eve".to_string(), U128(USDC));
        answer(house, id, 0, "alice.test", now + 1);
        if house.get_round(id).unwrap().status == Status::PlayerTurn {
            return id;
        }
    }
    panic!("no live hand in 20 deals");
}

#[test]
fn blackjack_double_takes_a_second_stake_then_settles() {
    let mut house = house();
    let id = live_hand(&mut house);
    let before = balance(&house, "alice.test");
    let now = house.get_round(id).unwrap().updated_at;
    at("alice.test", now);
    house.bj_double(id);
    assert_eq!(balance(&house, "alice.test"), before - USDC);
    assert_eq!(house.get_round(id).unwrap().wager.0, 2 * USDC);
    answer(&mut house, id, 1, "alice.test", now + 1);
    let round = house.get_round(id).unwrap();
    assert_eq!(round.status, Status::Settled);
    assert_eq!(round.proofs.len(), 2);
    assert_eq!(round.bj.unwrap()["player"].as_array().unwrap().len(), 3);
    assert_eq!(
        balance(&house, "alice.test"),
        before - USDC + round.payout.unwrap().0
    );
    assert_eq!(house.dealer("eve").pool.reserved, 0);
}

#[test]
#[should_panic(expected = "only the player can move this hand")]
fn stranger_cannot_hit() {
    let mut house = house();
    let id = live_hand(&mut house);
    at("bob.test", T0 + 10_000);
    house.bj_hit(id);
}

#[test]
fn abandoned_hand_can_be_stood_by_anyone() {
    let mut house = house();
    let id = live_hand(&mut house);
    let since = house.get_round(id).unwrap().updated_at;
    at("bob.test", since + ABANDON_AFTER_SECS);
    house.bj_stand(id);
    // The stand's VRF alpha names the stranger, who signed the request.
    answer(
        &mut house,
        id,
        1,
        "bob.test",
        since + ABANDON_AFTER_SECS + 1,
    );
    assert_eq!(house.get_round(id).unwrap().status, Status::Settled);
}

#[test]
#[should_panic(expected = "only the player can move this hand")]
fn hand_is_not_abandoned_before_the_timeout() {
    let mut house = house();
    let id = live_hand(&mut house);
    let since = house.get_round(id).unwrap().updated_at;
    at("bob.test", since + ABANDON_AFTER_SECS - 1);
    house.bj_stand(id);
}

#[test]
fn player_history_keeps_the_last_rounds_only() {
    let mut house = house();
    let mut first = 0;
    for i in 0..(ROUNDS_PER_PLAYER as u64 + 3) {
        let now = T0 + i * 10;
        let id = dice(&mut house, "alice.test", now);
        if i == 0 {
            first = id;
        }
        answer(&mut house, id, 0, "alice.test", now + 1);
    }
    let player = house.get_player(account("alice.test"));
    assert_eq!(player.rounds.len(), ROUNDS_PER_PLAYER);
    assert_eq!(player.last_round, player.rounds.last().copied());
    assert!(house.get_round(first).is_none());
}

#[test]
fn dealer_log_is_a_ring_of_the_last_entries() {
    let mut house = house();
    for i in 0..(HISTORY_PER_DEALER + 20) {
        at("alice.test", T0 + i);
        house.invest("ada".to_string(), U128(USDC / 10));
    }
    let latest = house.get_history("ada".to_string(), None, 10);
    assert_eq!(latest.len(), 10);
    assert_eq!(latest.last().unwrap().seq, HISTORY_PER_DEALER + 20);
    assert_eq!(latest[0].kind, "invest");
    let oldest = house.get_history("ada".to_string(), Some(0), 5);
    assert_eq!(oldest[0].seq, 21, "entries 0..=20 were overwritten");
    assert_eq!(house.get_history("ada".to_string(), None, 500).len(), 50);
}

#[test]
fn reprice_logs_reason_changes() {
    let mut house = house();
    // Nobody played for 20 minutes: the promoter cuts its rake and boosts.
    at("ada.test", T0 + 3_700);
    let offer = house.reprice("ada".to_string());
    assert_eq!(offer["reason"], "idle");
    let log = house.get_history("ada".to_string(), None, 50);
    let last = log.last().unwrap();
    assert_eq!(last.kind, "boost");
    assert!(last.boost_until > T0 + 3_700);
    assert_eq!(house.get_lobby()[0].rake_bp, 100);
}

#[test]
#[should_panic(expected = "only the dealer's account can reprice")]
fn reprice_by_the_owner_is_rejected() {
    let mut house = house();
    at("owner.test", T0);
    house.reprice("ada".to_string());
}

#[test]
#[should_panic(expected = "only the house token is accepted")]
fn deposits_only_from_the_house_token() {
    let mut house = house();
    at("fake-token.test", T0);
    house
        .ft_on_transfer(account("alice.test"), U128(USDC), String::new())
        .detach();
}

#[test]
#[should_panic(expected = "msg must be")]
fn unknown_deposit_msg_is_refused() {
    let mut house = house();
    at("token.test", T0);
    house
        .ft_on_transfer(
            account("alice.test"),
            U128(USDC),
            "{\"buy\":\"ada\"}".to_string(),
        )
        .detach();
}

#[test]
fn deposit_can_invest_directly() {
    let mut house = house();
    at("token.test", T0);
    house
        .ft_on_transfer(
            account("bob.test"),
            U128(USDC),
            "{\"invest\":\"ada\"}".to_string(),
        )
        .detach();
    let bob = house.get_player(account("bob.test"));
    assert_eq!(bob.balance.0, 0);
    assert_eq!(bob.lp[0].dealer_id, "ada");
    assert_eq!(bob.lp[0].value.0, USDC);
}

#[test]
#[should_panic(expected = "attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_needs_one_yocto() {
    let mut house = house();
    at("alice.test", T0);
    house.withdraw(U128(USDC));
}

#[test]
fn withdraw_debits_now() {
    let mut house = house();
    with_yocto("alice.test", T0);
    house.withdraw(U128(USDC));
    assert_eq!(balance(&house, "alice.test"), 99 * USDC);
}

#[test]
fn lobby_prices_follow_the_pool() {
    let mut house = house();
    let ada = &house.get_lobby()[0];
    assert_eq!(ada.share_price_buy.0, 1_000_000);
    assert_eq!(ada.share_price_sell.0, 1_000_000);
    assert!(ada.open);
    dice(&mut house, "alice.test", T0);
    let ada = &house.get_lobby()[0];
    // Buy counts the open stake, sell excludes the reserve.
    assert!(ada.share_price_buy.0 > 1_000_000);
    assert!(ada.share_price_sell.0 < 1_000_000);
}
