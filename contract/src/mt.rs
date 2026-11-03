//! LP shares as a NEP-245 subset: token id = dealer id. Mint on invest, burn on divest, plain
//! transfers between accounts. Events follow NEP-297 (`EVENT_JSON:` logs).

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::{assert_one_yocto, env, near, require, AccountId};

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

fn emit_transfer(
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
        U128(self.shares_of(&token_id, &account_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids
            .iter()
            .map(|id| U128(self.shares_of(id, &account_id)))
            .collect()
    }

    /// Null for an unknown dealer.
    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
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
        require!(approval.is_none(), "approvals are not supported");
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
