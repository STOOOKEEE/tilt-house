//! NPC gamblers: a capped list of accounts run by the agents. Their keys can only call the
//! session methods, and the floor refuses every other way out for their money (withdraw, LP,
//! seats, tables, share transfers), so a leaked NPC key can at worst play at a table. The
//! keeper pays their salary straight into their floor balance (`ft_on_transfer` `credit_npc`).

use core_rules::gambler_rules::{GAMBLER_MAX_BALANCE, MAX_NPC_GAMBLERS};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::{emit, House, HouseExt};

#[near]
impl House {
    /// Owner only: adds NPC gamblers (already registered ones are skipped), at most
    /// `MAX_NPC_GAMBLERS` in total. There is no removal: an NPC stays session-only for good.
    pub fn register_npcs(&mut self, accounts: Vec<AccountId>) {
        self.assert_owner();
        let mut added = Vec::new();
        for account in accounts {
            if !self.npcs.contains(&account) {
                self.npcs.push(account.clone());
                added.push(account);
            }
        }
        require!(self.npcs.len() <= MAX_NPC_GAMBLERS, "too many NPC gamblers");
        if !added.is_empty() {
            emit("npcs_registered", json!({ "account_ids": added }));
        }
    }

    pub fn get_npcs(&self) -> Vec<AccountId> {
        self.npcs.clone()
    }
}

impl House {
    pub(crate) fn is_npc(&self, account: &AccountId) -> bool {
        self.npcs.contains(account)
    }

    /// Every money move other than a session refuses NPC callers.
    pub(crate) fn assert_not_npc(&self) {
        require!(
            !self.is_npc(&env::predecessor_account_id()),
            "NPC gamblers can only play sessions"
        );
    }

    /// The keeper's salary transfer, credited to `npc`'s floor balance (never above
    /// `GAMBLER_MAX_BALANCE`).
    pub(crate) fn credit_npc(&mut self, sender: &AccountId, npc: &AccountId, amount: u128) {
        require!(
            *sender == self.keeper,
            "only the keeper can pay NPC gamblers"
        );
        require!(self.is_npc(npc), "not a registered NPC gambler");
        let balance = self.player(npc).balance;
        require!(
            balance.saturating_add(amount) <= GAMBLER_MAX_BALANCE,
            "the salary would take the NPC above its balance cap"
        );
        self.credit(npc, amount);
        emit(
            "npc_credited",
            json!({ "account_id": npc, "amount": amount.to_string() }),
        );
    }
}
