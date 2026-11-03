import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { KeyPair } from 'near-api-js'
import { describe, expect, it } from 'vitest'
import { checkProof } from './vrf'

const vrfKey = KeyPair.fromRandom('ed25519')
const pubkeyHex = bytesToHex(vrfKey.getPublicKey().data)

function proofFor(alpha: string, step = 0) {
  const signature = vrfKey.sign(new TextEncoder().encode(alpha)).signature
  return { step, alpha, signature_hex: bytesToHex(signature), output_hex: bytesToHex(sha256(signature)) }
}

describe('checkProof', () => {
  it('accepts a genuine proof for this round, step and player', () => {
    const proof = proofFor('vrf:6802:alice.testnet:round-12-1', 1)
    expect(checkProof(proof, pubkeyHex, 12, 'alice.testnet')).toEqual({ signature: true, output: true, binding: true })
  })

  it('flags a proof made for another round or player', () => {
    const proof = proofFor('vrf:6802:alice.testnet:round-11-0')
    expect(checkProof(proof, pubkeyHex, 12, 'alice.testnet').binding).toBe(false)
    expect(checkProof(proofFor('vrf:1:bob.testnet:round-12-0'), pubkeyHex, 12, 'alice.testnet').binding).toBe(false)
  })

  it('flags a forged signature or output', () => {
    const proof = proofFor('vrf:6802:alice.testnet:round-12-0')
    const otherKey = bytesToHex(KeyPair.fromRandom('ed25519').getPublicKey().data)
    expect(checkProof(proof, otherKey, 12, 'alice.testnet').signature).toBe(false)
    expect(checkProof({ ...proof, output_hex: '00'.repeat(32) }, pubkeyHex, 12, 'alice.testnet').output).toBe(false)
    expect(checkProof({ ...proof, signature_hex: 'zz' }, pubkeyHex, 12, 'alice.testnet')).toEqual({
      signature: false,
      output: false,
      binding: true,
    })
  })
})
