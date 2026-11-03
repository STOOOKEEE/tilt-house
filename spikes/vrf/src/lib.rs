//! Spike: one OutLayer VRF round trip from a contract on NEAR testnet.
//!
//! `roll(round)` asks `outlayer.testnet` to run the published vrf-example wasm with the seed
//! `round-{round}`; `on_vrf` verifies the Ed25519 proof and logs the 32-byte output.

use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, log, near, AccountId, Gas, NearToken, Promise};

const OUTLAYER: &str = "outlayer.testnet";
/// OutLayer's testnet VRF key (`GET https://testnet-api.outlayer.ai/vrf/pubkey`).
const VRF_PUBKEY_HEX: &str = "c0c5aeae1688c2f7cc2350aae1ee3ce96eddc0de84d678db873de48268f8cfa8";
/// OutLayer project holding vrf-example @ 15b5024 (`cargo build --target wasm32-wasip2 --release`).
/// A bare `WasmUrl` source cannot run it: the module imports project storage.
const VRF_PROJECT_ID: &str = "tilthouse.testnet/tilt-vrf";
/// Pinning the version means a later `add_version` on the project cannot swap the code.
const VRF_WASM_SHA256: &str = "898b0449aec714bc97dd9725dc6faaee19b2c1a702a87c9d457cf0d279b23d7a";

/// Small limits keep the worst-case fee low: `estimate_execution_cost` for them is
/// base 0.001 + 1000 Minstr * 1e14 + 30_000 ms * 1e17 ≈ 0.0041 NEAR. The unused part
/// comes back to this contract (the payer) at settlement.
const MAX_INSTRUCTIONS: u64 = 1_000_000_000;
const MAX_MEMORY_MB: u32 = 128;
const MAX_EXECUTION_SECONDS: u64 = 30;
const REQUEST_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// `request_execution` reserves 50 TGas for its own yield callback out of this.
const REQUEST_GAS: Gas = Gas::from_tgas(100);
const CALLBACK_GAS: Gas = Gas::from_tgas(15);
/// vrf-example answers ~1 KB; anything far larger is not its output, so don't pay to read it.
const MAX_OUTPUT_LEN: usize = 8 * 1024;

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct VrfResponse {
    results: Vec<VrfEntry>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct VrfEntry {
    /// Without `max` in the input this is the 32-byte output as hex (SHA-256 of the signature).
    value: String,
    signature_hex: String,
    /// `vrf:{request_id}:{signer_id}:{user_seed}`, signed as-is.
    alpha: String,
}

#[near(contract_state)]
#[derive(Default)]
pub struct VrfSpike {}

#[near]
impl VrfSpike {
    /// Only the contract account itself may roll: every call spends the contract's NEAR.
    #[private]
    pub fn roll(&mut self, round: u64) -> Promise {
        let source = json!({
            "Project": {
                "project_id": VRF_PROJECT_ID,
                "version_key": VRF_WASM_SHA256,
            }
        });
        let args = json!({
            "source": source,
            "resource_limits": {
                "max_instructions": MAX_INSTRUCTIONS,
                "max_memory_mb": MAX_MEMORY_MB,
                "max_execution_seconds": MAX_EXECUTION_SECONDS,
            },
            "input_data": json!({ "seed": seed(round) }).to_string(),
            "response_format": "Json",
        });
        let outlayer: AccountId = OUTLAYER.parse().expect("valid account id");
        Promise::new(outlayer)
            .function_call(
                "request_execution".to_string(),
                args.to_string().into_bytes(),
                REQUEST_DEPOSIT,
                REQUEST_GAS,
            )
            .then(
                // OutLayer puts the transaction signer (not this contract) in the alpha.
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_vrf(round, env::signer_account_id(), env::block_height(), env::block_timestamp_ms()),
            )
    }

    /// Never panics: the house contract must be able to refund a round whatever comes back.
    #[private]
    pub fn on_vrf(
        &mut self,
        round: u64,
        signer: AccountId,
        requested_at_block: u64,
        requested_at_ms: u64,
    ) -> Option<String> {
        log!(
            "round {round}: callback after {} blocks, {} ms",
            env::block_height() - requested_at_block,
            env::block_timestamp_ms() - requested_at_ms
        );
        let raw = match env::promise_result_checked(0, MAX_OUTPUT_LEN) {
            Ok(bytes) => bytes,
            Err(e) => {
                log!("round {round}: request_execution failed ({e:?})");
                return None;
            }
        };
        match verified_output(&raw, round, &signer) {
            Ok(output) => {
                let output_hex = hex::encode(output);
                log!("round {round}: verified VRF output {output_hex}");
                Some(output_hex)
            }
            Err(reason) => {
                log!("round {round}: rejected ({reason}); raw = {}", String::from_utf8_lossy(&raw));
                None
            }
        }
    }
}

fn seed(round: u64) -> String {
    format!("round-{round}")
}

/// Parses OutLayer's callback value and returns the 32-byte VRF output only if the proof
/// verifies against the pinned key and the alpha names this round and this signer.
fn verified_output(raw: &[u8], round: u64, signer: &AccountId) -> Result<[u8; 32], String> {
    // OutLayer returns `null` when the run failed or the yield timed out.
    let response: Option<VrfResponse> =
        serde_json::from_slice(raw).map_err(|e| format!("unparseable output: {e}"))?;
    let response = response.ok_or("execution failed (null output)")?;
    let [entry] = response.results.as_slice() else {
        return Err(format!("expected 1 result, got {}", response.results.len()));
    };
    verify_entry(entry, round, signer)
}

fn verify_entry(entry: &VrfEntry, round: u64, signer: &AccountId) -> Result<[u8; 32], String> {
    check_alpha(&entry.alpha, round, signer)?;
    let signature: [u8; 64] = decode_hex(&entry.signature_hex)?;
    let pubkey: [u8; 32] = decode_hex(VRF_PUBKEY_HEX)?;
    if !env::ed25519_verify(&signature, entry.alpha.as_bytes(), &pubkey) {
        return Err("bad VRF signature".to_string());
    }
    // The output is defined as SHA-256(signature); recompute it rather than trust `value`.
    let output: [u8; 32] = env::sha256_array(signature);
    if decode_hex::<32>(&entry.value)? != output {
        return Err("value is not sha256(signature)".to_string());
    }
    Ok(output)
}

/// Alpha is `vrf:{request_id}:{signer}:{seed}`. Account ids and our seed never contain `:`,
/// so an exact 4-way split is unambiguous.
fn check_alpha(alpha: &str, round: u64, signer: &AccountId) -> Result<(), String> {
    let parts: Vec<&str> = alpha.split(':').collect();
    let ok = matches!(
        parts.as_slice(),
        ["vrf", request_id, sender, user_seed]
            if !request_id.is_empty()
                && request_id.bytes().all(|b| b.is_ascii_digit())
                && *sender == signer.as_str()
                && *user_seed == seed(round)
    );
    if ok {
        Ok(())
    } else {
        Err(format!("alpha {alpha} is not for round {round} signed by {signer}"))
    }
}

fn decode_hex<const N: usize>(s: &str) -> Result<[u8; N], String> {
    let bytes = hex::decode(s).map_err(|e| format!("bad hex: {e}"))?;
    bytes.try_into().map_err(|_| format!("expected {N} bytes"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real round 4 from testnet (tx BheWBR5zSFQreWoJW7HHVXc7oAMMvpMvcjThogKM28Jh).
    const ALPHA: &str = "vrf:6798:vrfspike.tilthouse.testnet:round-4";
    const SIG: &str = "b164aa6e2614d11ea822e8d24e852bed3714333b94d0b85b21bcc4c7d3ada1e93de3acb178655936609901b3cc5bf12065168e905efd612f2e3d99ee23cc7e03";
    const VALUE: &str = "a42bd982409759251def6c2a3b82b9e8662a37f403d996e525c9e6a55993ae8b";

    fn raw(alpha: &str, sig: &str, value: &str) -> Vec<u8> {
        json!({ "results": [{ "alpha": alpha, "signature_hex": sig, "value": value }] })
            .to_string()
            .into_bytes()
    }

    fn spike() -> AccountId {
        "vrfspike.tilthouse.testnet".parse().unwrap()
    }

    #[test]
    fn real_testnet_output_verifies() {
        let output = verified_output(&raw(ALPHA, SIG, VALUE), 4, &spike()).unwrap();
        assert_eq!(hex::encode(output), VALUE);
    }

    #[test]
    fn tampered_signature_or_value_is_rejected() {
        let bad_sig = format!("00{}", &SIG[2..]);
        assert!(verified_output(&raw(ALPHA, &bad_sig, VALUE), 4, &spike()).is_err());
        let bad_value = format!("00{}", &VALUE[2..]);
        assert!(verified_output(&raw(ALPHA, SIG, &bad_value), 4, &spike()).is_err());
    }

    #[test]
    fn null_output_is_rejected() {
        assert_eq!(
            verified_output(b"null", 1, &spike()),
            Err("execution failed (null output)".to_string())
        );
    }

    #[test]
    fn foreign_round_or_signer_is_rejected() {
        // A valid proof, but for round 4: replaying it for another round fails.
        assert!(verified_output(&raw(ALPHA, SIG, VALUE), 5, &spike()).unwrap_err().contains("not for round 5"));
        let other: AccountId = "mallory.testnet".parse().unwrap();
        assert!(verified_output(&raw(ALPHA, SIG, VALUE), 4, &other).is_err());
        // `round-41` must not pass for round 4.
        let alpha = "vrf:1:vrfspike.tilthouse.testnet:round-41";
        assert!(check_alpha(alpha, 4, &spike()).is_err());
        assert!(check_alpha("vrf::vrfspike.tilthouse.testnet:round-4", 4, &spike()).is_err());
    }
}
