//! tUSDC, the Tilt House **testnet-only** test token. It has no value and must never be deployed
//! to mainnet.
//!
//! Circle's testnet USDC faucet is a captcha form with small amounts, so it cannot seed dealer
//! pools or serve AI judges (design call 7). This is a plain NEP-141 token (with NEP-145 storage
//! management and NEP-148 metadata) with 6 decimals like USDC. Only the minter (the relayer) can
//! mint, and each receiver gets at most 1,000 tUSDC per 24 h, except accounts the owner marks as
//! unlimited (used to seed dealer pools).

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};

/// 1 tUSDC in base units (6 decimals).
pub const ONE_TUSDC: u128 = 1_000_000;
/// Most a regular receiver can get from `mint_to` in one window.
pub const MINT_CAP: u128 = 1_000 * ONE_TUSDC;
/// Length of a mint window: 24 h in nanoseconds.
pub const MINT_WINDOW_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Token,
    Metadata,
    Minted,
    Unlimited,
}

/// Amount minted to a receiver in the window that started at `window_start_ns`.
#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
struct MintWindow {
    window_start_ns: u64,
    minted: u128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    owner_id: AccountId,
    minter_id: AccountId,
    minted: LookupMap<AccountId, MintWindow>,
    unlimited: LookupSet<AccountId>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, minter_id: AccountId) -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Tilt test USDC".to_string(),
            symbol: "tUSDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        };
        Self {
            token: FungibleToken::new(StorageKey::Token),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
            owner_id,
            minter_id,
            minted: LookupMap::new(StorageKey::Minted),
            unlimited: LookupSet::new(StorageKey::Unlimited),
        }
    }

    /// Mints `amount` to `account_id`. Minter only. Registers the receiver if needed, paid from
    /// the attached deposit; any unused deposit is refunded to the minter.
    #[payable]
    pub fn mint_to(&mut self, account_id: AccountId, amount: U128) {
        require!(
            env::predecessor_account_id() == self.minter_id,
            "Only the minter can mint"
        );
        let amount = amount.0;
        require!(amount > 0, "Amount must be positive");

        let mut deposit = env::attached_deposit();
        if !self.token.accounts.contains_key(&account_id) {
            let min = self.token.storage_balance_bounds().min;
            require!(
                deposit >= min,
                format!("Attach at least {min} to register the receiver")
            );
            self.token.internal_register_account(&account_id);
            deposit = deposit.saturating_sub(min);
        }

        if !self.unlimited.contains(&account_id) {
            self.charge_mint_cap(&account_id, amount);
        }

        self.token.internal_deposit(&account_id, amount);
        FtMint {
            owner_id: &account_id,
            amount: U128(amount),
            memo: Some("tUSDC test mint"),
        }
        .emit();

        if !deposit.is_zero() {
            Promise::new(env::predecessor_account_id())
                .transfer(deposit)
                .detach();
        }
    }

    /// Owner only: lets `account_id` receive mints without the daily cap (dealer pool seeding).
    pub fn set_unlimited(&mut self, account_id: AccountId, unlimited: bool) {
        self.assert_owner();
        if unlimited {
            self.unlimited.insert(account_id);
        } else {
            self.unlimited.remove(&account_id);
        }
    }

    /// Owner only: replaces the minter.
    pub fn set_minter(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.minter_id = account_id;
    }

    pub fn is_unlimited(&self, account_id: AccountId) -> bool {
        self.unlimited.contains(&account_id)
    }

    pub fn minter_id(&self) -> AccountId {
        self.minter_id.clone()
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the owner can do this"
        );
    }

    /// Fixed 24 h window per receiver, starting at its first mint after the previous one expired.
    fn charge_mint_cap(&mut self, account_id: &AccountId, amount: u128) {
        let now = env::block_timestamp();
        let window = match self.minted.get(account_id) {
            Some(w) if now.saturating_sub(w.window_start_ns) < MINT_WINDOW_NS => *w,
            _ => MintWindow {
                window_start_ns: now,
                minted: 0,
            },
        };
        let minted = window
            .minted
            .checked_add(amount)
            .filter(|m| *m <= MINT_CAP)
            .unwrap_or_else(|| env::panic_str("Mint cap reached: 1,000 tUSDC per 24 h"));
        self.minted.insert(
            account_id.clone(),
            MintWindow {
                window_start_ns: window.window_start_ns,
                minted,
            },
        );
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
        let (used_amount, _burned_amount) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used_amount.into()
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

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
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
        self.metadata.get().expect("metadata is set at init")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn owner() -> AccountId {
        "owner.testnet".parse().unwrap()
    }
    fn minter() -> AccountId {
        "minter.testnet".parse().unwrap()
    }
    fn alice() -> AccountId {
        "alice.testnet".parse().unwrap()
    }
    fn pool() -> AccountId {
        "pool.testnet".parse().unwrap()
    }

    fn call(predecessor: AccountId, deposit: NearToken, now_ns: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(predecessor)
            .attached_deposit(deposit)
            .block_timestamp(now_ns)
            .build());
    }

    fn setup() -> Contract {
        call(owner(), NearToken::from_yoctonear(0), 0);
        Contract::new(owner(), minter())
    }

    fn registration_deposit(c: &Contract) -> NearToken {
        c.storage_balance_bounds().min
    }

    fn mint(c: &mut Contract, to: AccountId, amount: u128, now_ns: u64) {
        let deposit = registration_deposit(c);
        call(minter(), deposit, now_ns);
        c.mint_to(to, U128(amount));
    }

    #[test]
    fn metadata_is_tusdc() {
        let c = setup();
        let m = c.ft_metadata();
        assert_eq!(m.name, "Tilt test USDC");
        assert_eq!(m.symbol, "tUSDC");
        assert_eq!(m.decimals, 6);
        assert_eq!(c.owner_id(), owner());
        assert_eq!(c.minter_id(), minter());
    }

    #[test]
    fn minter_mints_and_registers_receiver() {
        let mut c = setup();
        mint(&mut c, alice(), 10 * ONE_TUSDC, 0);
        assert_eq!(c.ft_balance_of(alice()).0, 10 * ONE_TUSDC);
        assert_eq!(c.ft_total_supply().0, 10 * ONE_TUSDC);
        assert!(c.storage_balance_of(alice()).is_some());
        // Already registered: a second mint needs no deposit.
        call(minter(), NearToken::from_yoctonear(0), 1);
        c.mint_to(alice(), U128(ONE_TUSDC));
        assert_eq!(c.ft_balance_of(alice()).0, 11 * ONE_TUSDC);
    }

    #[test]
    #[should_panic(expected = "Only the minter can mint")]
    fn non_minter_cannot_mint() {
        let mut c = setup();
        let deposit = registration_deposit(&c);
        call(alice(), deposit, 0);
        c.mint_to(alice(), U128(ONE_TUSDC));
    }

    #[test]
    #[should_panic(expected = "Only the minter can mint")]
    fn owner_cannot_mint() {
        let mut c = setup();
        let deposit = registration_deposit(&c);
        call(owner(), deposit, 0);
        c.mint_to(alice(), U128(ONE_TUSDC));
    }

    #[test]
    #[should_panic(expected = "to register the receiver")]
    fn unregistered_receiver_needs_storage_deposit() {
        let mut c = setup();
        call(minter(), NearToken::from_yoctonear(0), 0);
        c.mint_to(alice(), U128(ONE_TUSDC));
    }

    #[test]
    #[should_panic(expected = "Amount must be positive")]
    fn zero_mint_is_refused() {
        let mut c = setup();
        mint(&mut c, alice(), 0, 0);
    }

    #[test]
    fn cap_allows_exactly_1000_per_window() {
        let mut c = setup();
        mint(&mut c, alice(), 600 * ONE_TUSDC, 0);
        mint(&mut c, alice(), 400 * ONE_TUSDC, MINT_WINDOW_NS - 1);
        assert_eq!(c.ft_balance_of(alice()).0, MINT_CAP);
    }

    #[test]
    #[should_panic(expected = "Mint cap reached")]
    fn cap_refuses_over_1000_in_window() {
        let mut c = setup();
        mint(&mut c, alice(), 600 * ONE_TUSDC, 0);
        mint(&mut c, alice(), 400 * ONE_TUSDC + 1, MINT_WINDOW_NS - 1);
    }

    #[test]
    #[should_panic(expected = "Mint cap reached")]
    fn single_mint_over_cap_is_refused() {
        let mut c = setup();
        mint(&mut c, alice(), MINT_CAP + 1, 0);
    }

    #[test]
    #[should_panic(expected = "Mint cap reached")]
    fn huge_amount_does_not_overflow_cap() {
        let mut c = setup();
        mint(&mut c, alice(), ONE_TUSDC, 0);
        mint(&mut c, alice(), u128::MAX, 1);
    }

    #[test]
    fn cap_resets_after_24h() {
        let mut c = setup();
        mint(&mut c, alice(), MINT_CAP, 0);
        mint(&mut c, alice(), MINT_CAP, MINT_WINDOW_NS);
        assert_eq!(c.ft_balance_of(alice()).0, 2 * MINT_CAP);
    }

    #[test]
    fn unlimited_receiver_has_no_cap() {
        let mut c = setup();
        call(owner(), NearToken::from_yoctonear(0), 0);
        c.set_unlimited(pool(), true);
        assert!(c.is_unlimited(pool()));
        mint(&mut c, pool(), 2_000 * ONE_TUSDC, 0);
        mint(&mut c, pool(), 2_000 * ONE_TUSDC, 1);
        assert_eq!(c.ft_balance_of(pool()).0, 4_000 * ONE_TUSDC);
    }

    #[test]
    #[should_panic(expected = "Mint cap reached")]
    fn removing_unlimited_restores_cap() {
        let mut c = setup();
        call(owner(), NearToken::from_yoctonear(0), 0);
        c.set_unlimited(pool(), true);
        c.set_unlimited(pool(), false);
        assert!(!c.is_unlimited(pool()));
        mint(&mut c, pool(), MINT_CAP + 1, 0);
    }

    #[test]
    #[should_panic(expected = "Only the owner can do this")]
    fn only_owner_sets_unlimited() {
        let mut c = setup();
        call(minter(), NearToken::from_yoctonear(0), 0);
        c.set_unlimited(alice(), true);
    }

    #[test]
    fn owner_sets_minter() {
        let mut c = setup();
        call(owner(), NearToken::from_yoctonear(0), 0);
        c.set_minter(alice());
        assert_eq!(c.minter_id(), alice());
        let deposit = registration_deposit(&c);
        call(alice(), deposit, 0);
        c.mint_to(pool(), U128(ONE_TUSDC));
        assert_eq!(c.ft_balance_of(pool()).0, ONE_TUSDC);
    }

    #[test]
    #[should_panic(expected = "Only the minter can mint")]
    fn old_minter_loses_rights() {
        let mut c = setup();
        call(owner(), NearToken::from_yoctonear(0), 0);
        c.set_minter(alice());
        mint(&mut c, pool(), ONE_TUSDC, 0);
    }

    #[test]
    #[should_panic(expected = "Only the owner can do this")]
    fn only_owner_sets_minter() {
        let mut c = setup();
        call(minter(), NearToken::from_yoctonear(0), 0);
        c.set_minter(alice());
    }
}
