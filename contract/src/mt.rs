//! NEP-245 subset. LP shares: token id = dealer id; mint on invest, burn on divest, plain
//! transfers between accounts. Seat leases: token id `seat-<n>`, supply 1 while seated, held by
//! the seated dealer's controller, moved only by `buy_seat`. Events follow NEP-297.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::{assert_one_yocto, env, near, require, AccountId};

use crate::floor::seat_index;
use crate::{fail, House, HouseExt};

fn emit(event: &str, data: Value) {
    let log = json!({
        "standard": "nep245",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

pub fn emit_mint(owner: &AccountId, token_id: &str, amount: u128) {
    emit(
        "mt_mint",
        json!({ "owner_id": owner, "token_ids": [token_id], "amounts": [amount.to_string()] }),
    );
}

pub fn emit_burn(owner: &AccountId, token_id: &str, amount: u128) {
    emit(
        "mt_burn",
        json!({ "owner_id": owner, "token_ids": [token_id], "amounts": [amount.to_string()] }),
    );
}

pub fn emit_transfer(
    from: &AccountId,
    to: &AccountId,
    token_id: &str,
    amount: u128,
    memo: Option<String>,
) {
    let mut data = json!({
        "old_owner_id": from,
        "new_owner_id": to,
        "token_ids": [token_id],
        "amounts": [amount.to_string()],
    });
    if let Some(memo) = memo {
        data["memo"] = Value::String(memo);
    }
    emit("mt_transfer", data);
}

#[near]
impl House {
    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.token_balance(&token_id, &account_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids
            .iter()
            .map(|id| U128(self.token_balance(id, &account_id)))
            .collect()
    }

    /// Null for an unknown token.
    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        if let Some(index) = seat_index(&token_id) {
            return Some(U128(u128::from(self.floor.seats[index].is_some())));
        }
        self.dealers.get(&token_id).map(|d| U128(d.pool.shares))
    }

    /// 1 yocto (full-access key). Approvals are not supported.
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        self.assert_not_npc();
        require!(approval.is_none(), "approvals are not supported");
        require!(
            seat_index(&token_id).is_none(),
            "seat leases move only with buy_seat"
        );
        require!(self.dealers.contains_key(&token_id), "unknown token id");
        require!(amount.0 > 0, "amount must be positive");
        let sender = env::predecessor_account_id();
        require!(sender != receiver_id, "sender and receiver are the same");
        let held = self.shares_of(&token_id, &sender);
        if held < amount.0 {
            fail("not enough shares");
        }
        let received = self.shares_of(&token_id, &receiver_id);
        self.set_shares(&token_id, &sender, held - amount.0);
        self.set_shares(&token_id, &receiver_id, received + amount.0);
        emit_transfer(&sender, &receiver_id, &token_id, amount.0, memo);
    }
}

impl House {
    fn token_balance(&self, token_id: &str, account: &AccountId) -> u128 {
        match seat_index(token_id) {
            Some(index) => u128::from(self.seat_holder(index).as_ref() == Some(account)),
            None => self.shares_of(token_id, account),
        }
    }
}
