//! Stand-in for `outlayer.testnet` in sandbox tests. `request_execution` yields like the real
//! contract; the test reads the pending request, signs the alpha with its own test key off chain
//! and calls `resolve` with the output JSON (or `null`), which resumes the house's callback.
//! Like OutLayer, the alpha's sender is the transaction signer and a timeout answers `null`.
//! With `set_hang(true)` a timed-out request yields again instead, so the house's callback
//! never comes (OutLayer down) until the test resolves it.

use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::IterableMap;
use near_sdk::{env, near, AccountId, CryptoHash, Gas, GasWeight, PanicOnDefault, PromiseIndex};

/// Static gas of the yield callback; it also gets the unused gas (weight 1) to re-yield.
const RESUME_GAS: Gas = Gas::from_tgas(5);
const DATA_ID_REGISTER: u64 = 0;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Request {
    pub request_id: u64,
    pub sender_id: AccountId,
    pub seed: String,
    #[serde(skip)]
    data_id: CryptoHash,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOutlayer {
    next_id: u64,
    pending: IterableMap<u64, Request>,
    hang: bool,
}

#[near]
impl MockOutlayer {
    #[init]
    pub fn new() -> Self {
        Self {
            next_id: 1,
            pending: IterableMap::new(b"p"),
            hang: false,
        }
    }

    #[payable]
    pub fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Value,
        input_data: String,
        response_format: String,
    ) {
        assert!(source.is_object() && resource_limits.is_object() && response_format == "Json");
        let input: Value = serde_json::from_str(&input_data).expect("input_data is JSON");
        let seed = input["seed"].as_str().expect("seed").to_string();
        let request_id = self.next_id;
        self.next_id += 1;
        let (promise, data_id) = yield_for(request_id);
        let request = Request {
            request_id,
            sender_id: env::signer_account_id(),
            seed,
            data_id,
        };
        self.pending.insert(request_id, request);
        env::promise_return(promise);
    }

    pub fn set_hang(&mut self, hang: bool) {
        self.hang = hang;
    }

    /// Resumes the request with `output` as the worker's answer (any string, e.g. "null").
    pub fn resolve(&mut self, request_id: u64, output: String) {
        let request = self
            .pending
            .remove(&request_id)
            .expect("no such pending request");
        assert!(env::promise_yield_resume(
            &request.data_id,
            output.as_bytes()
        ));
    }

    /// Returns the resumed bytes verbatim, or `null` on a yield timeout (like OutLayer).
    #[private]
    pub fn on_resume(&mut self, request_id: u64) {
        match env::promise_result_checked(0, 64 * 1024) {
            Ok(bytes) => {
                self.pending.remove(&request_id);
                env::value_return(&bytes)
            }
            Err(_) if self.hang => {
                let (promise, data_id) = yield_for(request_id);
                if let Some(request) = self.pending.get_mut(&request_id) {
                    request.data_id = data_id;
                }
                env::promise_return(promise);
            }
            Err(_) => {
                self.pending.remove(&request_id);
                env::value_return(b"null")
            }
        }
    }

    pub fn get_pending(&self) -> Vec<Request> {
        self.pending.values().cloned().collect()
    }
}

fn yield_for(request_id: u64) -> (PromiseIndex, CryptoHash) {
    let args = json!({ "request_id": request_id }).to_string();
    let promise = env::promise_yield_create(
        "on_resume",
        args,
        RESUME_GAS,
        GasWeight(1),
        DATA_ID_REGISTER,
    );
    let data_id: CryptoHash = env::read_register(DATA_ID_REGISTER)
        .expect("data id")
        .try_into()
        .expect("32 bytes");
    (promise, data_id)
}
