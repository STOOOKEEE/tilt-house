//! Rounds: the stake leaves the player's balance, the pool reserves the worst case, and each
//! step (a bet, or a blackjack deal / hit / double / stand) waits for its own VRF answer.

use core_rules::{
    apply_rake, bj_gross, dice_gross, dice_roll, roulette_gross, roulette_spin, worst_case_payout,
    Bet, BjError, BjState, DiceBet, Rng, RouletteBet,
};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value};
use near_sdk::{env, log, near, require, AccountId};

use crate::vrf::{self, MAX_OUTPUT_LEN, PLAY_GAS};
use crate::{
    fail, now, Dealer, House, HouseExt, Player, ABANDON_AFTER_SECS, MIN_BET, REFUND_AFTER_SECS,
    ROUNDS_PER_PLAYER,
};

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    WaitingVrf,
    PlayerTurn,
    /// The last VRF step came back missing or invalid: refundable now.
    Failed,
    Settled,
    Refunded,
}

/// What the pending VRF answer will be used for.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Step {
    /// Dice roll, roulette spin or blackjack deal.
    Bet,
    Hit,
    Double,
    Stand,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Proof {
    pub step: u32,
    pub alpha: String,
    pub signature_hex: String,
    pub output_hex: String,
}

// Plain borsh derives: core types carry no `BorshSchema` for the contract ABI.
#[derive(Clone, BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Round {
    pub id: u64,
    pub player: AccountId,
    pub dealer_id: String,
    pub bet: Bet,
    /// Initial stake.
    pub stake: u128,
    /// Total at risk: the stake, twice it after a blackjack double.
    pub wager: u128,
    /// Reserved in the pool until the round ends.
    pub worst: u128,
    /// Rake in force when the bet was placed.
    pub rake_bp: u16,
    pub status: Status,
    pub step: u32,
    pub pending: Step,
    /// Account that signed the transaction requesting the current step: OutLayer puts it in the
    /// alpha (for a relayed meta-transaction, the delegate sender).
    pub vrf_signer: AccountId,
    pub created_at: u64,
    /// Last change; the refund and abandon timers run from here.
    pub updated_at: u64,
    pub roll: Option<u32>,
    pub pocket: Option<u8>,
    pub bj: Option<BjState>,
    pub payout: Option<u128>,
    pub proofs: Vec<Proof>,
    pub error: Option<String>,
}

#[near]
impl House {
    pub fn bet_dice(&mut self, dealer_id: String, stake: U128, chance_bp: u16, over: bool) -> u64 {
        self.place_bet(dealer_id, stake.0, Bet::Dice(DiceBet { chance_bp, over }))
    }

    /// `bet`: core `RouletteBet` JSON (`"red"`, `{"straight": 17}`…).
    pub fn bet_roulette(&mut self, dealer_id: String, stake: U128, bet: Value) -> u64 {
        let bet: RouletteBet =
            serde_json::from_value(bet).unwrap_or_else(|_| fail("invalid roulette bet"));
        self.place_bet(dealer_id, stake.0, Bet::Roulette(bet))
    }

    pub fn bj_deal(&mut self, dealer_id: String, stake: U128) -> u64 {
        self.place_bet(dealer_id, stake.0, Bet::Blackjack)
    }

    pub fn bj_hit(&mut self, round_id: u64) {
        self.bj_move(round_id, Step::Hit);
    }

    pub fn bj_double(&mut self, round_id: u64) {
        self.bj_move(round_id, Step::Double);
    }

    pub fn bj_stand(&mut self, round_id: u64) {
        self.bj_move(round_id, Step::Stand);
    }

    /// Anyone may call: the money always goes back to the round's player.
    pub fn refund_stuck_round(&mut self, round_id: u64) {
        let round = self.round(round_id);
        let refundable = match round.status {
            Status::Failed => true,
            Status::WaitingVrf => now() >= round.updated_at.saturating_add(REFUND_AFTER_SECS),
            _ => false,
        };
        require!(refundable, "round is not refundable");
        self.refund(round);
    }

    /// OutLayer's answer for one step. Never panics: a missing, foreign or invalid answer marks
    /// the round failed (refundable), a late answer for a finished round is ignored.
    #[private]
    pub fn on_vrf(&mut self, round_id: u64, step: u32) {
        let result = env::promise_result_checked(0, MAX_OUTPUT_LEN);
        let Some(mut round) = self.rounds.get(&round_id).cloned() else {
            log!("round {round_id}: unknown, VRF answer ignored");
            return;
        };
        if round.status != Status::WaitingVrf || round.step != step {
            log!("round {round_id} step {step}: late VRF answer ignored");
            return;
        }
        let seed = vrf::seed(round_id, step);
        let verified = result
            .map_err(|e| format!("request_execution failed: {e:?}"))
            .and_then(|raw| vrf::verified_output(&raw, &seed, &round.vrf_signer, &self.vrf_pubkey));
        match verified {
            Ok((output, mut proof)) => {
                proof.step = step;
                round.proofs.push(proof);
                self.advance(round, output);
            }
            Err(reason) => {
                log!("round {round_id} step {step}: VRF rejected ({reason})");
                self.fail_round(round, reason);
            }
        }
    }
}

impl House {
    pub(crate) fn round(&self, round_id: u64) -> Round {
        self.rounds
            .get(&round_id)
            .cloned()
            .unwrap_or_else(|| fail("unknown round"))
    }

    fn place_bet(&mut self, dealer_id: String, stake: u128, bet: Bet) -> u64 {
        require_play_gas();
        require!(bet.is_valid(), "invalid bet");
        let mut dealer = self.dealer(&dealer_id);
        let game = dealer.game;
        require!(bet.game() == game, "this table plays another game");
        require!(dealer.is_open(), "the table is closed");
        require!(stake >= MIN_BET, "stake below the table minimum");
        require!(stake <= dealer.max_bet(), "stake above the table's max bet");
        let player_id = env::predecessor_account_id();
        let mut player = self.player(&player_id);
        require!(player.open_round.is_none(), "finish your open round first");
        require!(player.balance >= stake, "not enough balance");
        let worst = worst_case_payout(game, stake, &bet);
        dealer
            .pool
            .open_bet(stake, worst)
            .unwrap_or_else(|e| fail(&e.to_string()));
        player.balance -= stake;
        let now = now();
        let id = self.next_round_id;
        self.next_round_id += 1;
        player.open_round = Some(id);
        self.remember_round(&mut player, id);
        let round = Round {
            id,
            player: player_id.clone(),
            dealer_id: dealer_id.clone(),
            bet,
            stake,
            wager: stake,
            worst,
            rake_bp: dealer.offer.effective_rake_bp(game, now),
            status: Status::WaitingVrf,
            step: 0,
            pending: Step::Bet,
            vrf_signer: env::signer_account_id(),
            created_at: now,
            updated_at: now,
            roll: None,
            pocket: None,
            bj: None,
            payout: None,
            proofs: Vec::new(),
            error: None,
        };
        self.refresh_open(&mut dealer);
        self.dealers.insert(dealer_id, dealer);
        self.save_player(&player_id, player);
        self.rounds.insert(id, round);
        self.request_vrf(id, 0);
        id
    }

    /// Keeps the last `ROUNDS_PER_PLAYER` rounds; older ones are finished (only the newest can be
    /// open) and deleted to bound the storage the contract pays for.
    fn remember_round(&mut self, player: &mut Player, id: u64) {
        player.rounds.push(id);
        while player.rounds.len() > ROUNDS_PER_PLAYER {
            let old = player.rounds.remove(0);
            self.rounds.remove(&old);
        }
    }

    fn bj_move(&mut self, round_id: u64, step: Step) {
        require_play_gas();
        let mut round = self.round(round_id);
        require!(round.bet == Bet::Blackjack, "not a blackjack round");
        require!(round.status == Status::PlayerTurn, "not waiting for a move");
        let now = now();
        if env::predecessor_account_id() != round.player {
            let abandoned = now >= round.updated_at.saturating_add(ABANDON_AFTER_SECS);
            require!(
                step == Step::Stand && abandoned,
                "only the player can move this hand"
            );
        }
        if step == Step::Double {
            self.take_double(&mut round);
        }
        round.step += 1;
        round.pending = step;
        round.status = Status::WaitingVrf;
        round.vrf_signer = env::signer_account_id();
        round.updated_at = now;
        let step_index = round.step;
        self.rounds.insert(round_id, round);
        self.request_vrf(round_id, step_index);
    }

    /// The second stake of a double; its worst case was reserved at the deal.
    fn take_double(&mut self, round: &mut Round) {
        let first_two = round.bj.as_ref().is_some_and(|s| s.player.len() == 2);
        require!(first_two, "double is only allowed on the first two cards");
        self.debit(&round.player, round.stake);
        let mut dealer = self.dealer(&round.dealer_id);
        dealer
            .pool
            .add_stake(round.stake)
            .unwrap_or_else(|e| fail(&e.to_string()));
        self.dealers.insert(round.dealer_id.clone(), dealer);
        round.wager += round.stake;
    }

    /// Plays the step with the verified randomness.
    fn advance(&mut self, mut round: Round, output: [u8; 32]) {
        let mut rng = Rng::new(output);
        let gross = match round.bet {
            Bet::Dice(bet) => {
                let roll = dice_roll(&mut rng);
                round.roll = Some(roll);
                dice_gross(round.wager, &bet, roll)
            }
            Bet::Roulette(bet) => {
                let pocket = roulette_spin(&mut rng);
                round.pocket = Some(pocket);
                roulette_gross(round.wager, &bet, pocket)
            }
            Bet::Blackjack => match play_bj(&mut round, &mut rng) {
                Ok(Some(gross)) => gross,
                Ok(None) => {
                    round.status = Status::PlayerTurn;
                    round.updated_at = now();
                    self.rounds.insert(round.id, round);
                    return;
                }
                Err(e) => return self.fail_round(round, e.to_string()),
            },
        };
        self.settle(round, gross);
    }

    fn settle(&mut self, mut round: Round, gross: u128) {
        let payout = apply_rake(gross, round.wager, round.rake_bp);
        let mut dealer: Dealer = self.dealer(&round.dealer_id);
        if let Err(e) = dealer.pool.settle(round.wager, round.worst, payout) {
            return self.fail_round(round, e.to_string());
        }
        let now = now();
        dealer.record_bet(now, round.wager, payout);
        self.refresh_open(&mut dealer);
        self.dealers.insert(round.dealer_id.clone(), dealer);
        self.close_for_player(&round.player, payout);
        round.payout = Some(payout);
        round.status = Status::Settled;
        round.updated_at = now;
        self.rounds.insert(round.id, round);
    }

    /// Whole wager back to the player, reserve released, the bankroll does not move.
    fn refund(&mut self, mut round: Round) {
        let mut dealer = self.dealer(&round.dealer_id);
        dealer
            .pool
            .refund(round.wager, round.worst)
            .unwrap_or_else(|e| fail(&e.to_string()));
        self.refresh_open(&mut dealer);
        self.dealers.insert(round.dealer_id.clone(), dealer);
        self.close_for_player(&round.player, round.wager);
        round.status = Status::Refunded;
        round.updated_at = now();
        self.rounds.insert(round.id, round);
    }

    fn close_for_player(&mut self, account: &AccountId, amount: u128) {
        let mut player = self.player(account);
        player.balance = player.balance.saturating_add(amount);
        player.open_round = None;
        self.save_player(account, player);
    }

    fn fail_round(&mut self, mut round: Round, reason: String) {
        round.status = Status::Failed;
        round.error = Some(reason);
        round.updated_at = now();
        self.rounds.insert(round.id, round);
    }
}

/// Runs the pending blackjack step. `Some(gross)` once the hand is over, `None` while it is the
/// player's turn.
fn play_bj(round: &mut Round, rng: &mut Rng) -> Result<Option<u128>, BjError> {
    let mut state = round.bj.take().unwrap_or_default();
    let moved = match round.pending {
        Step::Bet => {
            state = core_rules::bj_deal(rng);
            Ok(())
        }
        Step::Hit => core_rules::bj_hit(&mut state, rng),
        Step::Double => core_rules::bj_double(&mut state, rng),
        Step::Stand => core_rules::bj_stand(&mut state, rng),
    };
    let gross = state.done.then(|| bj_gross(&state, round.stake));
    round.bj = Some(state);
    moved.map(|()| gross)
}

fn require_play_gas() {
    require!(
        env::prepaid_gas() >= PLAY_GAS,
        "attach at least 150 TGas (VRF request and callback)"
    );
}
