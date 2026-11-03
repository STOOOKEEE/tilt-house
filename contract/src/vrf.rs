//! OutLayer VRF: one request per round step, verified on chain (docs/vrf-notes.md).

use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, AccountId, Gas, NearToken, Promise};

use crate::rounds::Proof;
use crate::House;

/// Worst-case fee for the limits below is ≈ 0.0041 NEAR (`estimate_execution_cost`); the
/// unused part comes back to this contract, the payer. Players hold no NEAR.
const REQUEST_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// `request_execution` reserves 50 TGas for its own yield callback out of this.
const REQUEST_GAS: Gas = Gas::from_tgas(100);
/// `on_vrf`: parse ~1 KB, verify, play the step and settle (blackjack dealer play included).
const CALLBACK_GAS: Gas = Gas::from_tgas(30);
/// What a play call must carry: the request, the callback and its own work.
pub const PLAY_GAS: Gas = Gas::from_tgas(150);
const MAX_INSTRUCTIONS: u64 = 1_000_000_000;
const MAX_MEMORY_MB: u32 = 128;
const MAX_EXECUTION_SECONDS: u64 = 30;
/// vrf-example answers ~1 KB; anything far larger is not its output, so don't pay to read it.
pub const MAX_OUTPUT_LEN: usize = 8 * 1024;

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct VrfResponse {
    results: Vec<VrfEntry>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct VrfEntry {
    /// Without `max` in the input: the 32-byte output as hex (SHA-256 of the signature).
    value: String,
    signature_hex: String,
    /// `vrf:{request_id}:{signer_id}:{user_seed}`, signed as-is.
    alpha: String,
}

/// The user seed of one round step. No `:` (OutLayer forbids it in seeds), so the alpha's
/// 4-way split stays unambiguous.
pub fn seed(round_id: u64, step: u32) -> String {
    format!("round-{round_id}-{step}")
}

impl House {
    /// Asks OutLayer for the step's randomness; `on_vrf` gets the answer, whatever it is.
    pub(crate) fn request_vrf(&self, round_id: u64, step: u32) {
        let source: Value = serde_json::from_str(&self.vrf_source).unwrap_or(Value::Null);
        let args = json!({
            "source": source,
            "resource_limits": {
                "max_instructions": MAX_INSTRUCTIONS,
                "max_memory_mb": MAX_MEMORY_MB,
                "max_execution_seconds": MAX_EXECUTION_SECONDS,
            },
            "input_data": json!({ "seed": seed(round_id, step) }).to_string(),
            "response_format": "Json",
        });
        // Not returned: the play call answers with the round id.
        Promise::new(self.outlayer.clone())
            .function_call(
                "request_execution".to_string(),
                args.to_string().into_bytes(),
                REQUEST_DEPOSIT,
                REQUEST_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_vrf(round_id, step),
            )
            .detach();
    }
}

/// Parses OutLayer's callback value. Returns the 32-byte VRF output and its proof only if the
/// signature verifies against `pubkey` and the alpha names exactly this seed and this signer.
pub fn verified_output(
    raw: &[u8],
    seed: &str,
    signer: &AccountId,
    pubkey: &[u8; 32],
) -> Result<([u8; 32], Proof), String> {
    // OutLayer answers `null` when the run failed or the yield timed out.
    let response: Option<VrfResponse> =
        serde_json::from_slice(raw).map_err(|e| format!("unparseable output: {e}"))?;
    let response = response.ok_or("execution failed (null output)")?;
    let [entry] = response.results.as_slice() else {
        return Err(format!("expected 1 result, got {}", response.results.len()));
    };
    check_alpha(&entry.alpha, seed, signer)?;
    let signature: [u8; 64] = decode_hex(&entry.signature_hex)?;
    if !env::ed25519_verify(&signature, entry.alpha.as_bytes(), pubkey) {
        return Err("bad VRF signature".to_string());
    }
    // The output is defined as SHA-256(signature); recompute it rather than trust `value`.
    let output: [u8; 32] = env::sha256_array(signature);
    if decode_hex::<32>(&entry.value)? != output {
        return Err("value is not sha256(signature)".to_string());
    }
    let proof = Proof {
        step: 0,
        alpha: entry.alpha.clone(),
        signature_hex: entry.signature_hex.to_lowercase(),
        output_hex: hex::encode(output),
    };
    Ok((output, proof))
}

/// Alpha is `vrf:{request_id}:{signer}:{seed}`. Account ids and our seeds never contain `:`,
/// so an exact 4-way split is unambiguous; the exact seed match rejects `round-41-0` for
/// `round-4-0` and every other round's or step's proof.
fn check_alpha(alpha: &str, seed: &str, signer: &AccountId) -> Result<(), String> {
    let parts: Vec<&str> = alpha.split(':').collect();
    let ok = matches!(
        parts.as_slice(),
        ["vrf", request_id, sender, user_seed]
            if !request_id.is_empty()
                && request_id.bytes().all(|b| b.is_ascii_digit())
                && *sender == signer.as_str()
                && *user_seed == seed
    );
    if ok {
        Ok(())
    } else {
        Err(format!(
            "alpha {alpha} is not for {seed} signed by {signer}"
        ))
    }
}

pub fn decode_hex<const N: usize>(s: &str) -> Result<[u8; N], String> {
    let bytes = hex::decode(s).map_err(|e| format!("bad hex: {e}"))?;
    bytes.try_into().map_err(|_| format!("expected {N} bytes"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real round 4 from the testnet spike (tx BheWBR5zSFQreWoJW7HHVXc7oAMMvpMvcjThogKM28Jh).
    const ALPHA: &str = "vrf:6798:vrfspike.tilthouse.testnet:round-4";
    const SIG: &str = "b164aa6e2614d11ea822e8d24e852bed3714333b94d0b85b21bcc4c7d3ada1e93de3acb178655936609901b3cc5bf12065168e905efd612f2e3d99ee23cc7e03";
    const VALUE: &str = "a42bd982409759251def6c2a3b82b9e8662a37f403d996e525c9e6a55993ae8b";
    const PUBKEY: &str = "c0c5aeae1688c2f7cc2350aae1ee3ce96eddc0de84d678db873de48268f8cfa8";

    fn raw(alpha: &str, sig: &str, value: &str) -> Vec<u8> {
        json!({ "results": [{ "alpha": alpha, "signature_hex": sig, "value": value }] })
            .to_string()
            .into_bytes()
    }

    fn spike() -> AccountId {
        "vrfspike.tilthouse.testnet".parse().unwrap()
    }

    fn key() -> [u8; 32] {
        decode_hex(PUBKEY).unwrap()
    }

    #[test]
    fn real_testnet_output_verifies() {
        let (output, proof) =
            verified_output(&raw(ALPHA, SIG, VALUE), "round-4", &spike(), &key()).unwrap();
        assert_eq!(hex::encode(output), VALUE);
        assert_eq!(proof.alpha, ALPHA);
    }

    #[test]
    fn tampered_signature_or_value_is_rejected() {
        let bad_sig = format!("00{}", &SIG[2..]);
        assert!(
            verified_output(&raw(ALPHA, &bad_sig, VALUE), "round-4", &spike(), &key()).is_err()
        );
        let bad_value = format!("00{}", &VALUE[2..]);
        assert!(
            verified_output(&raw(ALPHA, SIG, &bad_value), "round-4", &spike(), &key()).is_err()
        );
        let mut other_key = key();
        other_key[0] ^= 1;
        assert!(verified_output(&raw(ALPHA, SIG, VALUE), "round-4", &spike(), &other_key).is_err());
    }

    #[test]
    fn null_or_garbage_is_rejected() {
        assert_eq!(
            verified_output(b"null", "round-1-0", &spike(), &key()).unwrap_err(),
            "execution failed (null output)"
        );
        assert!(verified_output(b"{", "round-1-0", &spike(), &key()).is_err());
        assert!(verified_output(br#"{"results":[]}"#, "round-1-0", &spike(), &key()).is_err());
    }

    #[test]
    fn foreign_seed_or_signer_is_rejected() {
        assert!(verified_output(&raw(ALPHA, SIG, VALUE), "round-5", &spike(), &key()).is_err());
        let other: AccountId = "mallory.testnet".parse().unwrap();
        assert!(verified_output(&raw(ALPHA, SIG, VALUE), "round-4", &other, &key()).is_err());
        let s = spike();
        assert!(check_alpha(
            "vrf:1:vrfspike.tilthouse.testnet:round-41-0",
            "round-4-0",
            &s
        )
        .is_err());
        assert!(check_alpha(
            "vrf:1:vrfspike.tilthouse.testnet:round-4-01",
            "round-4-0",
            &s
        )
        .is_err());
        assert!(check_alpha("vrf::vrfspike.tilthouse.testnet:round-4-0", "round-4-0", &s).is_err());
        assert!(check_alpha(
            "vrf:1:vrfspike.tilthouse.testnet:round-4-0",
            "round-4-0",
            &s
        )
        .is_ok());
    }

    #[test]
    fn seeds_name_round_and_step() {
        assert_eq!(seed(12, 3), "round-12-3");
    }
}
