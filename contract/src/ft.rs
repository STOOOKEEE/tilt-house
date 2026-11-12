//! The money token (NEP-141): deposits through `ft_transfer_call`, withdrawals with rollback.

use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json;
use near_sdk::{
    assert_one_yocto, env, ext_contract, log, near, require, AccountId, Gas, NearToken,
    PromiseError, PromiseOrValue,
};

use crate::{fail, House, HouseExt};

const FT_TRANSFER_GAS: Gas = Gas::from_tgas(10);
const ON_WITHDRAW_GAS: Gas = Gas::from_tgas(10);

#[allow(dead_code)] // only used through the generated `ext_ft`
#[ext_contract(ext_ft)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

/// `ft_transfer_call` msg other than `""`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
enum TransferMsg {
    /// Buys LP shares of this dealer.
    Invest(String),
    /// The keeper pays an NPC gambler's salary into its floor balance.
    CreditNpc(AccountId),
}

#[near]
impl House {
    /// NEP-141 receiver. `msg = ""` credits the balance, `{"invest":"<dealer>"}` buys LP
    /// shares, `{"credit_npc":"<account>"}` (keeper only) credits an NPC gambler. Anything else
    /// panics, and the token refunds the whole transfer.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.token,
            "only the house token is accepted"
        );
        require!(amount.0 > 0, "amount must be positive");
        if msg.is_empty() {
            self.credit(&sender_id, amount.0);
            return PromiseOrValue::Value(U128(0));
        }
        let parsed: TransferMsg = serde_json::from_str(&msg).unwrap_or_else(|_| {
            fail("msg must be \"\", {\"invest\":\"<dealer_id>\"} or {\"credit_npc\":\"<account>\"}")
        });
        match parsed {
            TransferMsg::Invest(dealer_id) => {
                require!(
                    !self.is_npc(&sender_id),
                    "NPC gamblers can only play sessions"
                );
                self.invest_for(&sender_id, &dealer_id, amount.0);
            }
            TransferMsg::CreditNpc(npc) => self.credit_npc(&sender_id, &npc, amount.0),
        }
        PromiseOrValue::Value(U128(0))
    }

    /// Full-access key only (1 yocto). The balance is debited now and credited back if the
    /// token transfer fails.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) {
        assert_one_yocto();
        self.assert_not_npc();
        require!(amount.0 > 0, "amount must be positive");
        let account = env::predecessor_account_id();
        self.debit(&account, amount.0);
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(
                account.clone(),
                amount,
                Some("tilt house withdraw".to_string()),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_WITHDRAW_GAS)
                    .on_withdraw(account, amount),
            )
            .detach();
    }

    #[private]
    pub fn on_withdraw(&mut self, account: AccountId, amount: U128) {
        // Only a failed transfer is credited back; any returned value means it went through.
        if let Err(PromiseError::Failed) = env::promise_result_checked(0, 0) {
            log!(
                "withdraw of {} to {account} failed: credited back",
                amount.0
            );
            self.credit(&account, amount.0);
        }
    }
}
