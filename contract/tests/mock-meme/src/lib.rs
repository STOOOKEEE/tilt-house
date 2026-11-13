//! Minimal stand-in for the $TILT contract in the floor sandbox tests: records `report_day`
//! calls (or refuses them on demand) and starts a Tilt Hour on a floor.

use near_sdk::json_types::{I128, U128};
use near_sdk::{ext_contract, near, require, AccountId, Gas, Promise};

#[allow(dead_code)] // only used through the generated `ext_floor`
#[ext_contract(ext_floor)]
trait Floor {
    fn start_tilt_hour(&mut self);
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Report {
    pub day: u64,
    pub players_net: I128,
    pub wagers: Vec<(AccountId, U128)>,
}

#[near(contract_state)]
#[derive(Default)]
pub struct MockMeme {
    reports: Vec<Report>,
    refuse: bool,
}

#[near]
impl MockMeme {
    pub fn report_day(&mut self, day: u64, players_net: I128, wagers: Vec<(AccountId, U128)>) {
        require!(!self.refuse, "report refused");
        self.reports.push(Report {
            day,
            players_net,
            wagers,
        });
    }

    pub fn set_refuse(&mut self, refuse: bool) {
        self.refuse = refuse;
    }

    pub fn get_reports(&self) -> Vec<Report> {
        self.reports.clone()
    }

    pub fn start_tilt_hour(&mut self, floor: AccountId) -> Promise {
        ext_floor::ext(floor)
            .with_static_gas(Gas::from_tgas(30))
            .start_tilt_hour()
    }
}
