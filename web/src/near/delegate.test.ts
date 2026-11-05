import { describe, expect, it } from 'vitest'
import { buildDelegateAction, encodeDelegateAction, encodeSignedDelegate, KeyPair, KeyPairSigner } from 'near-api-js'
import { sha256 } from '@noble/hashes/sha256'
import {
  GAME_KEY_ALLOWANCE,
  GAME_METHODS,
  callAction,
  gameKeyAction,
  signedDelegateToBase64,
} from './delegate'

const HOUSE = 'house.tilthouse.testnet'
const PLAYER = 'a'.repeat(64)

describe('gameKeyAction', () => {
  it('adds a function-call key limited to the house, the game methods and 0.25 NEAR', () => {
    const gameKey = KeyPair.fromRandom('ed25519')
    const addKey = gameKeyAction(gameKey.getPublicKey(), HOUSE).addKey
    if (!addKey) throw new Error('expected an AddKey action')

    expect(addKey.publicKey.toString()).toBe(gameKey.getPublicKey().toString())
    const permission = addKey.accessKey.permission.functionCall
    if (!permission) throw new Error('expected a function-call permission, not full access')
    expect(addKey.accessKey.permission.fullAccess).toBeUndefined()
    expect(permission.receiverId).toBe(HOUSE)
    expect(permission.methodNames).toEqual(['open_session', 'close_session', 'force_close', 'claim_unrevealed'])
    expect(permission.allowance).toBe(250_000_000_000_000_000_000_000n)
    expect(GAME_KEY_ALLOWANCE).toBe(250_000_000_000_000_000_000_000n)
  })
})

describe('GAME_METHODS', () => {
  it('has no duplicates', () => {
    expect(new Set(GAME_METHODS).size).toBe(GAME_METHODS.length)
  })
})

describe('callAction', () => {
  it('carries the deposit and rejects a negative one', () => {
    expect(callAction('withdraw', { amount: '5' }, 1n).functionCall?.deposit).toBe(1n)
    expect(() => callAction('withdraw', {}, -1n)).toThrow()
  })
})

describe('signed delegate', () => {
  it('is signed by the given key over the NEP-461 delegate hash and base64-encoded for the relayer', async () => {
    const fullKey = KeyPair.fromRandom('ed25519')
    const gameKey = KeyPair.fromRandom('ed25519')
    const delegateAction = buildDelegateAction({
      senderId: PLAYER,
      receiverId: PLAYER,
      actions: [gameKeyAction(gameKey.getPublicKey(), HOUSE)],
      nonce: 7n,
      maxBlockHeight: 1_000n,
      publicKey: fullKey.getPublicKey(),
    })
    const { delegateHash, signedDelegate } = await new KeyPairSigner(fullKey).signDelegateAction(delegateAction)

    expect(delegateHash).toEqual(sha256(encodeDelegateAction(delegateAction)))
    expect(fullKey.verify(delegateHash, signedDelegate.signature.data)).toBe(true)
    expect(gameKey.verify(delegateHash, signedDelegate.signature.data)).toBe(false)

    const wire = Buffer.from(signedDelegateToBase64(signedDelegate), 'base64')
    expect(new Uint8Array(wire)).toEqual(encodeSignedDelegate(signedDelegate))
  })
})
