import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { PublicKey } from 'near-api-js'
import type { VrfProof } from './near/views'

export interface ProofCheck {
  /** Ed25519 signature over the alpha string, under OutLayer's VRF key. */
  signature: boolean
  /** The output the round used is sha256(signature). */
  output: boolean
  /** The alpha names this round and step, signed by an expected account, so it cannot be reused for another bet. */
  binding: boolean
}

/**
 * Re-does in the browser the checks the contract did on chain (contract-api.md, "VRF checks"),
 * so anyone can see a draw was not picked by the house.
 *
 * The alpha's signer is whoever signed the transaction that requested the step: the player when they call
 * directly, the relayer for a meta-transaction. `get_round` does not expose the signer the contract stored, so
 * the caller passes the accounts that may legitimately have signed (the player and the configured relayer).
 */
export function checkProof(
  proof: VrfProof,
  vrfPubkeyHex: string,
  roundId: number,
  allowedSigners: readonly string[],
): ProofCheck {
  const signer = alphaSigner(proof.alpha, `round-${roundId}-${proof.step}`)
  const binding = signer !== null && allowedSigners.includes(signer)
  try {
    const signature = hexToBytes(proof.signature_hex)
    const key = new PublicKey({ keyType: 0, data: hexToBytes(vrfPubkeyHex) })
    return {
      signature: key.verify(new TextEncoder().encode(proof.alpha), signature),
      output: bytesToHex(sha256(signature)) === proof.output_hex.toLowerCase(),
      binding,
    }
  } catch {
    // Malformed hex is a failed check, not a crash of the result panel.
    return { signature: false, output: false, binding }
  }
}

/** The signer named by an alpha `vrf:{digits}:{signer}:{seed}` for exactly this seed, or null. */
function alphaSigner(alpha: string, seed: string): string | null {
  const parts = alpha.split(':')
  if (parts.length !== 4) return null
  const [prefix, requestId, signer, alphaSeed] = parts
  return prefix === 'vrf' && /^\d+$/.test(requestId) && signer !== '' && alphaSeed === seed ? signer : null
}
