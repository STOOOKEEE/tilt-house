import { createHash, createPublicKey, verify } from "node:crypto";

/** One entry of `get_round().proofs`. */
export interface VrfProof {
  alpha: string;
  signature_hex: string;
  output_hex: string;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

const HEX = /^[0-9a-f]*$/;

function hexBytes(value: string, length: number, name: string): Buffer {
  if (value.length !== length * 2 || !HEX.test(value)) throw new Error(`${name} is not ${length} hex bytes`);
  return Buffer.from(value, "hex");
}

function ed25519Key(pubkeyHex: string) {
  const x = hexBytes(pubkeyHex, 32, "VRF public key").toString("base64url");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
}

/**
 * Re-checks an OutLayer VRF proof off-chain, the same way the contract does: alpha is exactly
 * `vrf:{digits}:{signer}:{seed}`, the signature is Ed25519 over alpha with OutLayer's key, and
 * the output is sha256(signature).
 */
export function verifyVrfProof(proof: VrfProof, pubkeyHex: string, signer: string, seed: string): Verdict {
  const parts = proof.alpha.split(":");
  const [tag, requestId, sender, userSeed] = parts;
  const alphaOk =
    parts.length === 4 && tag === "vrf" && /^\d+$/.test(requestId ?? "") && sender === signer && userSeed === seed;
  if (!alphaOk) return { ok: false, reason: `alpha is not vrf:<n>:${signer}:${seed}` };
  let signature: Buffer;
  let output: Buffer;
  try {
    signature = hexBytes(proof.signature_hex, 64, "signature");
    output = hexBytes(proof.output_hex, 32, "output");
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!verify(null, Buffer.from(proof.alpha, "utf8"), ed25519Key(pubkeyHex), signature)) {
    return { ok: false, reason: "bad Ed25519 signature" };
  }
  if (!createHash("sha256").update(signature).digest().equals(output)) {
    return { ok: false, reason: "output is not sha256(signature)" };
  }
  return { ok: true };
}
