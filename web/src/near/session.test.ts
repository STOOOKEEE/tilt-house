import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from 'near-api-js'

const relayed: unknown[] = []
vi.mock('./relay', () => ({
  activate: vi.fn(async () => undefined),
  relay: vi.fn(async (_url: string, delegate: unknown) => {
    relayed.push(delegate)
    return { txHash: 'tx', status: 'success' }
  }),
}))

const { ensureGameKey } = await import('./session')

const store: Record<string, string> = {}
beforeEach(() => {
  relayed.length = 0
  for (const key of Object.keys(store)) delete store[key]
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => void (store[key] = value),
  })
})

const config = { houseContract: 'floor.tilthouse.testnet', relayerUrl: '/relayer' }

function fakeAccount(): Account {
  const signing = { createSignedMetaTransaction: async () => ({ signedDelegate: { nonce: 1 } }) }
  return { accountId: 'a'.repeat(64), ...signing } as unknown as Account
}

describe('ensureGameKey', () => {
  it('signs one AddKey when the provider asks twice at once', async () => {
    const [first, second] = await Promise.all([ensureGameKey(fakeAccount(), config), ensureGameKey(fakeAccount(), config)])
    expect(relayed).toHaveLength(1)
    expect(second.toString()).toBe(first.toString())
  })

  it('reuses the stored key afterwards', async () => {
    const key = await ensureGameKey(fakeAccount(), config)
    expect((await ensureGameKey(fakeAccount(), config)).toString()).toBe(key.toString())
    expect(relayed).toHaveLength(1)
  })
})
