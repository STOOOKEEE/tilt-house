//! The server's ed25519 key: signs tickets and states (the contract checks them against
//! `SESSION_SERVER_PUBKEY`) and, in chain mode, the server's NEAR transactions.

use anyhow::{anyhow, bail, Context};
use ed25519_dalek::{Signer as _, SigningKey};

const KEY_PREFIX: &str = "ed25519:";

pub struct Signer {
    key: SigningKey,
}

impl Signer {
    /// Parses a NEAR secret key, `ed25519:<base58>` of 64 bytes (seed || public key) or of the
    /// 32-byte seed alone.
    pub fn from_near_secret(text: &str) -> anyhow::Result<Self> {
        let encoded = text
            .strip_prefix(KEY_PREFIX)
            .ok_or_else(|| anyhow!("key must start with {KEY_PREFIX}"))?;
        let bytes = bs58::decode(encoded)
            .into_vec()
            .context("key is not base58")?;
        let seed: [u8; 32] = match bytes.len() {
            32 | 64 => bytes[..32].try_into()?,
            n => bail!("key has {n} bytes, expected 32 or 64"),
        };
        let key = SigningKey::from_bytes(&seed);
        if bytes.len() == 64 && bytes[32..] != key.verifying_key().to_bytes() {
            bail!("key's public half does not match its seed");
        }
        Ok(Self { key })
    }

    /// A throwaway key for `--no-chain` runs; nothing it signs can be used on chain.
    pub fn random() -> anyhow::Result<Self> {
        Ok(Self {
            key: SigningKey::from_bytes(&random_bytes::<32>()?),
        })
    }

    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.key.sign(message).to_bytes()
    }

    /// `ed25519:<base58>`, the format of `SESSION_SERVER_PUBKEY` in the contract config.
    pub fn public_key(&self) -> String {
        format!(
            "{KEY_PREFIX}{}",
            bs58::encode(self.key.verifying_key().to_bytes()).into_string()
        )
    }

    pub fn verifying_key(&self) -> ed25519_dalek::VerifyingKey {
        self.key.verifying_key()
    }
}

/// OS randomness; seeds and tokens never come from anything weaker.
pub fn random_bytes<const N: usize>() -> anyhow::Result<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes).map_err(|err| anyhow!("OS randomness unavailable: {err}"))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier};

    #[test]
    fn parses_near_keys_and_signs() {
        let signer = Signer::random().unwrap();
        let mut full = signer.key.to_bytes().to_vec();
        full.extend(signer.verifying_key().to_bytes());
        let text = format!("ed25519:{}", bs58::encode(&full).into_string());
        let parsed = Signer::from_near_secret(&text).unwrap();
        assert_eq!(parsed.public_key(), signer.public_key());
        let sig = parsed.sign(b"hello");
        assert!(signer
            .verifying_key()
            .verify(b"hello", &Signature::from_bytes(&sig))
            .is_ok());
    }

    #[test]
    fn rejects_bad_keys() {
        assert!(Signer::from_near_secret("secp256k1:abc").is_err());
        assert!(Signer::from_near_secret("ed25519:0OIl").is_err());
        assert!(Signer::from_near_secret("ed25519:abc").is_err());
        let mut wrong = vec![1u8; 32];
        wrong.extend([2u8; 32]);
        let text = format!("ed25519:{}", bs58::encode(&wrong).into_string());
        assert!(Signer::from_near_secret(&text).is_err());
    }
}
