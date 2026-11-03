import { describe, expect, it } from "vitest";
import { verifyVrfProof } from "../src/vrf.ts";

// Real round 4 of the VRF spike on testnet (tx BheWBR5zSFQreWoJW7HHVXc7oAMMvpMvcjThogKM28Jh), see spikes/vrf.
const PUBKEY = "c0c5aeae1688c2f7cc2350aae1ee3ce96eddc0de84d678db873de48268f8cfa8";
const SIGNER = "vrfspike.tilthouse.testnet";
const SEED = "round-4";
const PROOF = {
  alpha: "vrf:6798:vrfspike.tilthouse.testnet:round-4",
  signature_hex:
    "b164aa6e2614d11ea822e8d24e852bed3714333b94d0b85b21bcc4c7d3ada1e93de3acb178655936609901b3cc5bf12065168e905efd612f2e3d99ee23cc7e03",
  output_hex: "a42bd982409759251def6c2a3b82b9e8662a37f403d996e525c9e6a55993ae8b",
};

describe("verifyVrfProof", () => {
  it("accepts the real testnet round 4 proof", () => {
    expect(verifyVrfProof(PROOF, PUBKEY, SIGNER, SEED)).toEqual({ ok: true });
  });

  it("rejects a tampered signature", () => {
    const proof = { ...PROOF, signature_hex: `00${PROOF.signature_hex.slice(2)}` };
    expect(verifyVrfProof(proof, PUBKEY, SIGNER, SEED)).toEqual({ ok: false, reason: "bad Ed25519 signature" });
  });

  it("rejects an output that is not sha256(signature)", () => {
    const proof = { ...PROOF, output_hex: `00${PROOF.output_hex.slice(2)}` };
    expect(verifyVrfProof(proof, PUBKEY, SIGNER, SEED)).toEqual({
      ok: false,
      reason: "output is not sha256(signature)",
    });
  });

  it("rejects another key", () => {
    const other = `00${PUBKEY.slice(2)}`;
    expect(verifyVrfProof(PROOF, other, SIGNER, SEED).ok).toBe(false);
  });

  it("rejects a proof replayed for another round or signer", () => {
    expect(verifyVrfProof(PROOF, PUBKEY, SIGNER, "round-5").ok).toBe(false);
    expect(verifyVrfProof(PROOF, PUBKEY, "mallory.testnet", SEED).ok).toBe(false);
    const prefix = { ...PROOF, alpha: "vrf:1:vrfspike.tilthouse.testnet:round-41" };
    expect(verifyVrfProof(prefix, PUBKEY, SIGNER, SEED).ok).toBe(false);
    const noRequestId = { ...PROOF, alpha: "vrf::vrfspike.tilthouse.testnet:round-4" };
    expect(verifyVrfProof(noRequestId, PUBKEY, SIGNER, SEED).ok).toBe(false);
  });

  it("rejects malformed hex", () => {
    const proof = { ...PROOF, signature_hex: "zz" };
    expect(verifyVrfProof(proof, PUBKEY, SIGNER, SEED)).toEqual({ ok: false, reason: "signature is not 64 hex bytes" });
  });
});
