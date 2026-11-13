//! Stand-in for the floor in the $TILT sandbox tests: `close_day` forwards a day report to TILT
//! (so `report_day` comes from the floor account, as on testnet), and `start_tilt_hour` accepts
//! only TILT and counts Tilt Hours, or fails on demand.

use near_sdk::json_types::{I128, U128};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockFloor {
    tilt: AccountId,
    tilt_hours: u32,
    fail_tilt_hour: bool,
}

#[near]
impl MockFloor {
    #[init]
    pub fn new(tilt: AccountId) -> Self {
        Self {
            tilt,
            tilt_hours: 0,
            fail_tilt_hour: false,
        }
    }

    /// Returns TILT's promise, so a refused report fails this transaction too.
    pub fn close_day(
        &mut self,
        day: u32,
        players_net: I128,
        wagers: Vec<(AccountId, U128)>,
    ) -> Promise {
        Promise::new(self.tilt.clone()).function_call(
            "report_day".to_string(),
            json!({ "day": day, "players_net": players_net, "wagers": wagers })
                .to_string()
                .into_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(150),
        )
    }

    pub fn start_tilt_hour(&mut self) {
        require!(
            env::predecessor_account_id() == self.tilt,
            "Only TILT can start a Tilt Hour"
        );
        require!(!self.fail_tilt_hour, "Tilt Hour refused");
        self.tilt_hours += 1;
    }

    pub fn set_fail_tilt_hour(&mut self, fail: bool) {
        self.fail_tilt_hour = fail;
    }

    pub fn tilt_hours(&self) -> u32 {
        self.tilt_hours
    }
}
