//! The $TILT contract (crate doc in `lib.rs`).

use crate::rules::{self, Economics, Streak, TiltHourProgress, MAX_AMOUNT, MAX_PLAYERS};
use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::{I128, U128, U64};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};

/// Entries kept by the on-chain log (oldest overwritten first).
pub const LOG_CAPACITY: u64 = 256;
/// Most entries one `get_log` call returns.
pub const LOG_PAGE_MAX: u32 = 100;
const LOG_PAGE_DEFAULT: u32 = 50;
/// Gas for `floor.start_tilt_hour` and for our callback.
const START_TILT_HOUR_GAS: Gas = Gas::from_tgas(30);
const ON_TILT_HOUR_GAS: Gas = Gas::from_tgas(10);
/// NEAR the contract keeps free when it pays a winner's storage registration itself: below it,
/// the winner's share is skipped instead of bricking the contract's storage.
const REGISTRATION_RESERVE: NearToken = NearToken::from_millinear(500);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Token,
    Welcomed,
    Burners,
    Log,
}

/// What a log entry records.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogKind {
    Mint,
    Burn,
    Streak,
    TiltHour,
}

/// Why: mint `launch|daily|welcome`, burn `daily|tilt_hour|unregister`, streak `grow|reset`,
/// tilt hour `triggered|started|failed`.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Launch,
    Daily,
    Welcome,
    TiltHour,
    Unregister,
    Grow,
    Reset,
    Triggered,
    Started,
    Failed,
}

impl Reason {
    fn memo(self) -> &'static str {
        match self {
            Reason::Launch => "launch",
            Reason::Daily => "daily",
            Reason::Welcome => "welcome",
            Reason::TiltHour => "tilt_hour",
            Reason::Unregister => "unregister",
            Reason::Grow => "grow",
            Reason::Reset => "reset",
            Reason::Triggered => "triggered",
            Reason::Started => "started",
            Reason::Failed => "failed",
        }
    }
}

/// One line of the on-chain log. `amount`: TILT for mints and burns, the new streak for streak
/// entries, the TILT burned in the round for Tilt Hour entries.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogEntry {
    pub seq: u64,
    pub kind: LogKind,
    pub reason: Reason,
    pub account: Option<AccountId>,
    pub amount: U128,
    pub day: u32,
    pub timestamp_ns: U64,
}

/// NEP-297 events of the `tilt` standard (mints and burns also emit the NEP-141 `ft_mint` /
/// `ft_burn` events with the reason as memo).
#[near(event_json(standard = "tilt"))]
pub enum TiltEvent {
    #[event_version("1.0.0")]
    DayReported {
        day: u32,
        players_net: I128,
        players: u32,
        minted: U128,
        burned: U128,
        streak: u32,
        longest_streak: u32,
    },
    /// A winner's share was not minted: not registered and the contract could not pay storage.
    #[event_version("1.0.0")]
    MintSkipped {
        day: u32,
        account_id: AccountId,
        amount: U128,
    },
    #[event_version("1.0.0")]
    TiltHourTriggered {
        round: u64,
        burned: U128,
        burners: u32,
    },
    #[event_version("1.0.0")]
    TiltHourStarted { round: u64, started: bool },
}

/// `get_params`: the launch parameters (all fixed).
#[near(serializers = [json])]
pub struct ParamsView {
    pub floor: AccountId,
    pub welcome_operator: AccountId,
    pub house_receiver: AccountId,
    pub launch_day: u32,
    #[serde(flatten)]
    pub economics: Economics,
    pub max_players: u32,
    pub log_capacity: u64,
}

/// `get_state.tilt_hour`.
#[near(serializers = [json])]
pub struct TiltHourView {
    pub round: u64,
    pub burned: U128,
    pub burners: u32,
    /// "0" when no window is open.
    pub window_end_ns: U64,
    pub triggers: u64,
    pub last_started_ns: Option<U64>,
}

/// `get_state`: the live state.
#[near(serializers = [json])]
pub struct StateView {
    pub total_supply: U128,
    pub treasury: U128,
    /// Supply outside the treasury.
    pub circulating: U128,
    pub welcome_remaining: U128,
    pub welcome_claims: u64,
    pub welcome_claims_today: u32,
    pub minted_total: U128,
    pub burned_total: U128,
    pub today: u32,
    pub last_reported_day: Option<u32>,
    pub streak: u32,
    pub longest_streak: u32,
    pub longest_streak_day: Option<u32>,
    pub tilt_hour: TiltHourView,
    pub log_next_seq: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    floor: AccountId,
    welcome_operator: AccountId,
    house_receiver: AccountId,
    launch_day: u32,
    economics: Economics,
    streak: Streak,
    welcome_remaining: u128,
    welcome_claims: u64,
    welcome_day: u32,
    welcome_claims_today: u32,
    welcomed: LookupSet<AccountId>,
    minted_total: u128,
    burned_total: u128,
    tilt_hour: TiltHourProgress,
    /// (round, account): who already burned in a round.
    burners: LookupSet<(u64, AccountId)>,
    tilt_hour_triggers: u64,
    last_started_ns: Option<u64>,
    log: LookupMap<u64, LogEntry>,
    log_next_seq: u64,
}

#[near]
impl Contract {
    /// Launch: fixes every parameter for good, mints the treasury to this contract and the house
    /// allocation to `house_receiver`. Needs ~0.01 NEAR of free balance for the two registrations.
    #[init]
    pub fn new(
        floor: AccountId,
        welcome_operator: AccountId,
        house_receiver: AccountId,
        economics: Economics,
    ) -> Self {
        if let Err(error) = economics.validate() {
            env::panic_str(&format!("Invalid economics: {error}"));
        }
        let me = env::current_account_id();
        require!(
            floor != me && welcome_operator != me && house_receiver != me,
            "floor, welcome operator and house receiver must be other accounts"
        );
        let mut contract = Self {
            token: FungibleToken::new(StorageKey::Token),
            floor,
            welcome_operator,
            house_receiver: house_receiver.clone(),
            launch_day: rules::utc_day(env::block_timestamp()),
            welcome_remaining: economics.welcome_pool.0,
            economics,
            streak: Streak::default(),
            welcome_claims: 0,
            welcome_day: 0,
            welcome_claims_today: 0,
            welcomed: LookupSet::new(StorageKey::Welcomed),
            minted_total: 0,
            burned_total: 0,
            tilt_hour: TiltHourProgress::default(),
            burners: LookupSet::new(StorageKey::Burners),
            tilt_hour_triggers: 0,
            last_started_ns: None,
            log: LookupMap::new(StorageKey::Log),
            log_next_seq: 0,
        };
        contract.token.internal_register_account(&me);
        contract.token.internal_register_account(&house_receiver);
        let today = contract.launch_day;
        contract.mint(
            &me,
            contract.economics.treasury_initial.0,
            Reason::Launch,
            today,
        );
        contract.mint(
            &house_receiver,
            contract.economics.house_allocation.0,
            Reason::Launch,
            today,
        );
        contract
    }

    /// Floor only, once per ended UTC day, days in increasing order. `players_net`: the humans'
    /// net result against the house in tUSDC base units (> 0: they won). `wagers`: at most 50
    /// (account, tUSDC wagered), each > 0, no duplicates.
    pub fn report_day(&mut self, day: u32, players_net: I128, wagers: Vec<(AccountId, U128)>) {
        require!(
            env::predecessor_account_id() == self.floor,
            "Only the floor can report a day"
        );
        require!(
            day < rules::utc_day(env::block_timestamp()),
            "The day has not ended"
        );
        require!(
            self.streak.last_day.is_none_or(|last| day > last),
            "Day already reported (or older than the last report)"
        );
        require!(wagers.len() <= MAX_PLAYERS, "At most 50 players per day");
        for (i, (account, wagered)) in wagers.iter().enumerate() {
            require!(
                wagered.0 > 0 && wagered.0 <= MAX_AMOUNT,
                "Each wager must be positive and below 2^64"
            );
            require!(
                wagers[..i].iter().all(|(other, _)| other != account),
                "Duplicate player"
            );
        }

        let players_won = players_net.0 > 0;
        self.streak.record(day, players_won);
        let streak_reason = if players_won {
            Reason::Grow
        } else {
            Reason::Reset
        };
        self.push_log(
            LogKind::Streak,
            streak_reason,
            None,
            u128::from(self.streak.current),
            day,
        );

        let mut minted = 0;
        let mut burned = 0;
        if players_won {
            let pool = rules::day_pool(players_net.0, self.streak.current, &self.economics);
            let amounts: Vec<u128> = wagers.iter().map(|(_, w)| w.0).collect();
            let shares = rules::split(pool, &amounts, self.economics.player_day_cap.0);
            for ((account, _), share) in wagers.iter().zip(shares) {
                if share == 0 {
                    continue;
                }
                if !self.pay_registration(account) {
                    TiltEvent::MintSkipped {
                        day,
                        account_id: account.clone(),
                        amount: U128(share),
                    }
                    .emit();
                    continue;
                }
                self.mint(account, share, Reason::Daily, day);
                minted += share;
            }
        } else {
            let me = env::current_account_id();
            burned = rules::treasury_burn(self.treasury(), self.economics.burn_bp);
            if burned > 0 {
                self.burn(&me, burned, Reason::Daily, day);
            }
        }
        TiltEvent::DayReported {
            day,
            players_net,
            players: wagers.len() as u32,
            minted: U128(minted),
            burned: U128(burned),
            streak: self.streak.current,
            longest_streak: self.streak.longest,
        }
        .emit();
    }

    /// Burns `amount` of the caller's TILT toward the next Tilt Hour (attach exactly 1 yoctoNEAR,
    /// and 100 Tgas: a burn that completes the round calls the floor). Returns whether this burn
    /// started a Tilt Hour on the floor.
    #[payable]
    pub fn burn_for_tilt_hour(&mut self, amount: U128) -> PromiseOrValue<bool> {
        near_sdk::assert_one_yocto();
        require!(
            amount.0 >= self.economics.tilt_hour_min_burn.0,
            "Burn at least tilt_hour_min_burn"
        );
        let burner = env::predecessor_account_id();
        self.tilt_hour
            .roll(env::block_timestamp(), self.economics.tilt_hour_window_secs);
        self.burn(&burner, amount.0, Reason::TiltHour, self.today());
        let round = self.tilt_hour.round;
        let new_burner = self.burners.insert((round, burner));
        let Some((burned, burners)) = self.tilt_hour.add(amount.0, new_burner, &self.economics)
        else {
            return PromiseOrValue::Value(false);
        };
        self.tilt_hour_triggers += 1;
        self.push_log(
            LogKind::TiltHour,
            Reason::Triggered,
            None,
            burned,
            self.today(),
        );
        TiltEvent::TiltHourTriggered {
            round,
            burned: U128(burned),
            burners,
        }
        .emit();
        Promise::new(self.floor.clone())
            .function_call(
                "start_tilt_hour".to_string(),
                b"{}".to_vec(),
                NearToken::from_yoctonear(0),
                START_TILT_HOUR_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_TILT_HOUR_GAS)
                    .on_tilt_hour_started(round, U128(burned)),
            )
            .into()
    }

    /// Callback of `floor.start_tilt_hour`: logs the outcome. Nothing is refunded on failure (the
    /// burn was the ritual; docs/tilt.md).
    #[private]
    pub fn on_tilt_hour_started(&mut self, round: u64, burned: U128) -> bool {
        let started = near_sdk::is_promise_success();
        if started {
            self.last_started_ns = Some(env::block_timestamp());
        }
        let reason = if started {
            Reason::Started
        } else {
            Reason::Failed
        };
        self.push_log(LogKind::TiltHour, reason, None, burned.0, self.today());
        TiltEvent::TiltHourStarted { round, started }.emit();
        started
    }

    /// Welcome operator only: mints the welcome amount to `account_id`, once per account, within
    /// the daily claim cap. Registers the account if needed from the attached deposit (at least
    /// `storage_balance_bounds().min`); any unused deposit goes back to the operator.
    #[payable]
    pub fn claim_welcome_for(&mut self, account_id: AccountId) -> U128 {
        require!(
            env::predecessor_account_id() == self.welcome_operator,
            "Only the welcome operator can claim"
        );
        require!(
            !self.welcomed.contains(&account_id),
            "Welcome already claimed"
        );
        let today = self.today();
        if self.welcome_day != today {
            self.welcome_day = today;
            self.welcome_claims_today = 0;
        }
        require!(
            self.welcome_claims_today < self.economics.welcome_daily_claims,
            "Daily welcome cap reached"
        );
        let amount = self.economics.welcome_amount.0.min(self.welcome_remaining);
        require!(amount > 0, "Welcome pool is empty");

        let mut deposit = env::attached_deposit();
        if !self.token.accounts.contains_key(&account_id) {
            let min = self.token.storage_balance_bounds().min;
            require!(
                deposit >= min,
                format!("Attach at least {min} to register the account")
            );
            self.token.internal_register_account(&account_id);
            deposit = deposit.saturating_sub(min);
        }
        self.welcomed.insert(account_id.clone());
        self.welcome_claims += 1;
        self.welcome_claims_today += 1;
        self.welcome_remaining -= amount;
        self.mint(&account_id, amount, Reason::Welcome, today);
        if !deposit.is_zero() {
            Promise::new(env::predecessor_account_id())
                .transfer(deposit)
                .detach();
        }
        U128(amount)
    }

    pub fn has_claimed_welcome(&self, account_id: AccountId) -> bool {
        self.welcomed.contains(&account_id)
    }

    pub fn get_params(&self) -> ParamsView {
        ParamsView {
            floor: self.floor.clone(),
            welcome_operator: self.welcome_operator.clone(),
            house_receiver: self.house_receiver.clone(),
            launch_day: self.launch_day,
            economics: self.economics.clone(),
            max_players: MAX_PLAYERS as u32,
            log_capacity: LOG_CAPACITY,
        }
    }

    pub fn get_state(&self) -> StateView {
        let now = env::block_timestamp();
        let today = rules::utc_day(now);
        let supply = self.token.total_supply;
        let treasury = self.treasury();
        let progress = self.tilt_hour.at(now);
        StateView {
            total_supply: U128(supply),
            treasury: U128(treasury),
            circulating: U128(supply - treasury),
            welcome_remaining: U128(self.welcome_remaining),
            welcome_claims: self.welcome_claims,
            welcome_claims_today: if self.welcome_day == today {
                self.welcome_claims_today
            } else {
                0
            },
            minted_total: U128(self.minted_total),
            burned_total: U128(self.burned_total),
            today,
            last_reported_day: self.streak.last_day,
            streak: self.streak.current,
            longest_streak: self.streak.longest,
            longest_streak_day: self.streak.longest_day,
            tilt_hour: TiltHourView {
                round: progress.round,
                burned: progress.burned,
                burners: progress.burners,
                window_end_ns: progress.window_end_ns,
                triggers: self.tilt_hour_triggers,
                last_started_ns: self.last_started_ns.map(U64),
            },
            log_next_seq: self.log_next_seq,
        }
    }

    /// Log entries from `from` (sequence number; default: the oldest kept), ascending, at most
    /// `limit` (default 50, max 100). Only the last 256 entries are kept.
    pub fn get_log(&self, from: Option<u64>, limit: Option<u32>) -> Vec<LogEntry> {
        let oldest = self.log_next_seq.saturating_sub(LOG_CAPACITY);
        let start = from.unwrap_or(oldest).max(oldest);
        let limit = u64::from(limit.unwrap_or(LOG_PAGE_DEFAULT).min(LOG_PAGE_MAX));
        let end = start.saturating_add(limit).min(self.log_next_seq);
        (start..end)
            .filter_map(|seq| self.log.get(&(seq % LOG_CAPACITY)).cloned())
            .collect()
    }
}

impl Contract {
    fn today(&self) -> u32 {
        rules::utc_day(env::block_timestamp())
    }

    /// The treasury is this contract's own TILT balance (TILT sent to the contract joins it).
    fn treasury(&self) -> u128 {
        self.token
            .accounts
            .get(&env::current_account_id())
            .unwrap_or(0)
    }

    /// `day`: the UTC day the entry belongs to (the reported day for daily mints and burns).
    fn mint(&mut self, account: &AccountId, amount: u128, reason: Reason, day: u32) {
        self.token.internal_deposit(account, amount);
        self.minted_total += amount;
        FtMint {
            owner_id: account,
            amount: U128(amount),
            memo: Some(reason.memo()),
        }
        .emit();
        self.push_log(LogKind::Mint, reason, Some(account.clone()), amount, day);
    }

    fn burn(&mut self, account: &AccountId, amount: u128, reason: Reason, day: u32) {
        self.token.internal_withdraw(account, amount);
        self.record_burn(account, amount, reason, day);
    }

    /// Accounts for TILT already removed from the supply (by `burn` or by the standard library).
    fn record_burn(&mut self, account: &AccountId, amount: u128, reason: Reason, day: u32) {
        self.burned_total += amount;
        FtBurn {
            owner_id: account,
            amount: U128(amount),
            memo: Some(reason.memo()),
        }
        .emit();
        self.push_log(LogKind::Burn, reason, Some(account.clone()), amount, day);
    }

    /// Makes sure `account` can hold TILT, registering it at the contract's expense while the
    /// contract keeps `REGISTRATION_RESERVE` free. False if it cannot.
    fn pay_registration(&mut self, account: &AccountId) -> bool {
        if self.token.accounts.contains_key(account) {
            return true;
        }
        let locked = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
        let needed = locked
            .saturating_add(self.token.storage_balance_bounds().min)
            .saturating_add(REGISTRATION_RESERVE);
        if env::account_balance() < needed {
            return false;
        }
        self.token.internal_register_account(account);
        true
    }

    fn push_log(
        &mut self,
        kind: LogKind,
        reason: Reason,
        account: Option<AccountId>,
        amount: u128,
        day: u32,
    ) {
        let seq = self.log_next_seq;
        self.log.insert(
            seq % LOG_CAPACITY,
            LogEntry {
                seq,
                kind,
                reason,
                account,
                amount: U128(amount),
                day,
                timestamp_ns: U64(env::block_timestamp()),
            },
        );
        self.log_next_seq += 1;
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id.clone(), amount);
        if burned > 0 {
            // The sender unregistered meanwhile: the standard burned the refund (and emitted
            // `ft_burn`); only our totals and log are left to update.
            self.burned_total += burned;
            self.push_log(
                LogKind::Burn,
                Reason::Unregister,
                Some(receiver_id),
                burned,
                self.today(),
            );
        }
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    /// With `force`, the account's TILT burns (logged as an `unregister` burn).
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        match self.token.internal_storage_unregister(force) {
            Some((account, balance)) => {
                if balance > 0 {
                    self.record_burn(&account, balance, Reason::Unregister, self.today());
                }
                true
            }
            None => false,
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Tilt".to_string(),
            symbol: "TILT".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::{LAUNCH, ONE_TILT};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const SECOND_NS: u64 = 1_000_000_000;
    const DAY_10_NS: u64 = 10 * rules::DAY_NS;

    fn id(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn context(predecessor: &str, deposit: NearToken, now_ns: u64, balance: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(id("tilt.testnet"))
            .predecessor_account_id(id(predecessor))
            .attached_deposit(deposit)
            .block_timestamp(now_ns)
            .account_balance(balance)
            .build());
    }

    fn launch(economics: Economics) -> Contract {
        context(
            "deployer.testnet",
            NearToken::from_yoctonear(0),
            DAY_10_NS,
            NearToken::from_near(10),
        );
        Contract::new(
            id("floor.testnet"),
            id("relayer.testnet"),
            id("house.testnet"),
            economics,
        )
    }

    fn welcome(c: &mut Contract, who: &str, now_ns: u64) {
        context(
            "relayer.testnet",
            NearToken::from_millinear(2),
            now_ns,
            NearToken::from_near(10),
        );
        c.claim_welcome_for(id(who));
    }

    #[test]
    fn a_winner_the_contract_cannot_register_is_skipped() {
        let mut c = launch(LAUNCH);
        // Almost no free NEAR left: the unregistered winner's share is not minted, the
        // registered one (the house receiver here) still gets its share.
        context(
            "floor.testnet",
            NearToken::from_yoctonear(0),
            DAY_10_NS + rules::DAY_NS,
            NearToken::from_millinear(100),
        );
        let before = c.get_state().minted_total.0;
        c.report_day(
            10,
            I128(10 * 1_000_000),
            vec![(id("new.testnet"), U128(1)), (id("house.testnet"), U128(1))],
        );
        assert_eq!(c.ft_balance_of(id("new.testnet")).0, 0);
        assert_eq!(c.get_state().minted_total.0 - before, 50 * ONE_TILT);
        assert_eq!(c.get_state().streak, 1);
    }

    #[test]
    #[should_panic(expected = "The day has not ended")]
    fn today_cannot_be_reported() {
        let mut c = launch(LAUNCH);
        context(
            "floor.testnet",
            NearToken::from_yoctonear(0),
            DAY_10_NS,
            NearToken::from_near(10),
        );
        c.report_day(10, I128(1), vec![]);
    }

    #[test]
    #[should_panic(expected = "Only the floor can report a day")]
    fn only_the_floor_reports() {
        let mut c = launch(LAUNCH);
        context(
            "house.testnet",
            NearToken::from_yoctonear(0),
            DAY_10_NS + rules::DAY_NS,
            NearToken::from_near(10),
        );
        c.report_day(10, I128(1), vec![]);
    }

    #[test]
    #[should_panic(expected = "Invalid economics")]
    fn launch_refuses_invalid_economics() {
        launch(Economics {
            burn_bp: 0,
            ..LAUNCH
        });
    }

    #[test]
    fn an_ended_window_does_not_count_toward_the_next() {
        let mut c = launch(Economics {
            tilt_hour_amount: U128(100 * ONE_TILT),
            tilt_hour_min_burners: 2,
            ..LAUNCH
        });
        welcome(&mut c, "a.testnet", DAY_10_NS);
        welcome(&mut c, "b.testnet", DAY_10_NS);
        let window_ns = u64::from(LAUNCH.tilt_hour_window_secs) * SECOND_NS;
        context(
            "a.testnet",
            NearToken::from_yoctonear(1),
            DAY_10_NS,
            NearToken::from_near(10),
        );
        assert!(matches!(
            c.burn_for_tilt_hour(U128(60 * ONE_TILT)),
            PromiseOrValue::Value(false)
        ));
        // b burns after a's window ended: a new round with b alone.
        context(
            "b.testnet",
            NearToken::from_yoctonear(1),
            DAY_10_NS + window_ns,
            NearToken::from_near(10),
        );
        assert!(matches!(
            c.burn_for_tilt_hour(U128(60 * ONE_TILT)),
            PromiseOrValue::Value(false)
        ));
        let th = c.get_state().tilt_hour;
        assert_eq!(
            (th.round, th.burned.0, th.burners, th.triggers),
            (1, 60 * ONE_TILT, 1, 0)
        );
        // a again, within b's window: the goal is reached.
        context(
            "a.testnet",
            NearToken::from_yoctonear(1),
            DAY_10_NS + window_ns + SECOND_NS,
            NearToken::from_near(10),
        );
        assert!(matches!(
            c.burn_for_tilt_hour(U128(40 * ONE_TILT)),
            PromiseOrValue::Promise(_)
        ));
        assert_eq!(c.get_state().tilt_hour.triggers, 1);
        assert_eq!(c.get_state().burned_total.0, 160 * ONE_TILT);
    }

    #[test]
    fn the_log_keeps_the_last_256_entries() {
        let mut c = launch(LAUNCH);
        for i in 0..298 {
            c.push_log(LogKind::Streak, Reason::Grow, None, i, 10);
        }
        // 2 launch mints + 298 = 300 entries, the first 44 overwritten.
        assert_eq!(c.get_state().log_next_seq, 300);
        let seqs = |entries: Vec<LogEntry>| entries.iter().map(|e| e.seq).collect::<Vec<_>>();
        assert_eq!(seqs(c.get_log(None, Some(3))), [44, 45, 46]);
        assert_eq!(seqs(c.get_log(Some(0), Some(2))), [44, 45]);
        assert_eq!(seqs(c.get_log(Some(298), None)), [298, 299]);
        assert_eq!(c.get_log(None, Some(1_000)).len(), 100);
        assert!(c.get_log(Some(300), None).is_empty());
    }
}
