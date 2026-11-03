import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { PublicKey } from 'near-api-js'
import type { VrfProof } from './near/views'

export interface ProofCheck {
  /** Ed25519 signature over the alpha string, under OutLayer's VRF key. */
  signature: boolean
  /** The output the round used is sha256(signature). */
  output: boolean
  /** The alpha names this round, step and player, so it cannot be reused for another bet. */
  binding: boolean
}

/**
 * Re-does in the browser the checks the contract did on chain (contract-api.md, "VRF checks"),
 * so anyone can see a draw was not picked by the house.
 */
export function checkProof(proof: VrfProof, vrfPubkeyHex: string, roundId: number, player: string): ProofCheck {
  const expectedSuffix = `:${player}:round-${roundId}-${proof.step}`
  const binding = /^vrf:\d+:/.test(proof.alpha) && proof.alpha.endsWith(expectedSuffix)
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
