import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { KeyPair } from 'near-api-js'
import { describe, expect, it } from 'vitest'
import { checkProof } from './vrf'

const vrfKey = KeyPair.fromRandom('ed25519')
const pubkeyHex = bytesToHex(vrfKey.getPublicKey().data)
const RELAYER = 'relayer.tilthouse.testnet'
const signers = ['alice.testnet', RELAYER]

function proofFor(alpha: string, step = 0) {
  const signature = vrfKey.sign(new TextEncoder().encode(alpha)).signature
  return { step, alpha, signature_hex: bytesToHex(signature), output_hex: bytesToHex(sha256(signature)) }
}

// Real relayed round on testnet: get_round({round_id: 7}) on house.tilthouse.testnet, key from get_config.
const TESTNET_VRF_PUBKEY = 'c0c5aeae1688c2f7cc2350aae1ee3ce96eddc0de84d678db873de48268f8cfa8'
const ROUND_7 = {
  player: 'tilt-demo-mw11k0t51984ce.tilthouse.testnet',
  proof: {
    step: 0,
    alpha: 'vrf:6817:relayer.tilthouse.testnet:round-7-0',
    signature_hex:
      '0532e3708e0e587ccbde32328a456db6ce1540e95d3435bcb7ea1b1290f559c9a01e692c2ae8046657ec95bff04ee47c419c2bf328f9c99741b1a5706aa7d706',
    output_hex: '6b7219517e54356b7e129b0d7ae1eccdb0123cf69dbc05865d5300931e0e56b4',
  },
}

describe('checkProof', () => {
  it('accepts the real relayed testnet round 7', () => {
    expect(checkProof(ROUND_7.proof, TESTNET_VRF_PUBKEY, 7, [ROUND_7.player, RELAYER])).toEqual({
      signature: true,
      output: true,
      binding: true,
    })
  })

  it('rejects round 7 for another round, step or signer', () => {
    expect(checkProof(ROUND_7.proof, TESTNET_VRF_PUBKEY, 8, [ROUND_7.player, RELAYER]).binding).toBe(false)
    expect(checkProof({ ...ROUND_7.proof, step: 1 }, TESTNET_VRF_PUBKEY, 7, [ROUND_7.player, RELAYER]).binding).toBe(
      false,
    )
    expect(checkProof(ROUND_7.proof, TESTNET_VRF_PUBKEY, 7, [ROUND_7.player]).binding).toBe(false)
  })

  it('accepts a genuine proof signed by the player or the relayer', () => {
    expect(checkProof(proofFor('vrf:6802:alice.testnet:round-12-1', 1), pubkeyHex, 12, signers)).toEqual({
      signature: true,
      output: true,
      binding: true,
    })
    expect(checkProof(proofFor(`vrf:6802:${RELAYER}:round-12-0`), pubkeyHex, 12, signers).binding).toBe(true)
  })

  it('flags a proof made for another round, step or signer', () => {
    expect(checkProof(proofFor('vrf:6802:alice.testnet:round-11-0'), pubkeyHex, 12, signers).binding).toBe(false)
    expect(checkProof(proofFor('vrf:6802:alice.testnet:round-112-0'), pubkeyHex, 12, signers).binding).toBe(false)
    expect(checkProof(proofFor('vrf:6802:alice.testnet:round-12-10'), pubkeyHex, 12, signers).binding).toBe(false)
    expect(checkProof(proofFor('vrf:1:bob.testnet:round-12-0'), pubkeyHex, 12, signers).binding).toBe(false)
    expect(checkProof(proofFor('vrf:x:alice.testnet:round-12-0'), pubkeyHex, 12, signers).binding).toBe(false)
    expect(checkProof(proofFor('vrf:1:bob.testnet:alice.testnet:round-12-0'), pubkeyHex, 12, signers).binding).toBe(
      false,
    )
  })

  it('flags a forged signature or output', () => {
    const proof = proofFor('vrf:6802:alice.testnet:round-12-0')
    const otherKey = bytesToHex(KeyPair.fromRandom('ed25519').getPublicKey().data)
    expect(checkProof(proof, otherKey, 12, signers).signature).toBe(false)
    expect(checkProof({ ...proof, output_hex: '00'.repeat(32) }, pubkeyHex, 12, signers).output).toBe(false)
    expect(checkProof({ ...proof, signature_hex: 'zz' }, pubkeyHex, 12, signers)).toEqual({
      signature: false,
      output: false,
      binding: true,
    })
    const tampered = { ...ROUND_7.proof, alpha: `vrf:6818:${RELAYER}:round-7-0` }
    expect(checkProof(tampered, TESTNET_VRF_PUBKEY, 7, [RELAYER]).signature).toBe(false)
  })
})
