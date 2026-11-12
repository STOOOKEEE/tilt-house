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
const { activate } = await import('./relay')

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
const token = async () => 'privy-token'

function fakeAccount(): Account {
  const signing = { createSignedMetaTransaction: async () => ({ signedDelegate: { nonce: 1 } }) }
  return { accountId: 'a'.repeat(64), ...signing } as unknown as Account
}

describe('ensureGameKey', () => {
  it('signs one AddKey when the provider asks twice at once', async () => {
    const [first, second] = await Promise.all([ensureGameKey(fakeAccount(), config, token), ensureGameKey(fakeAccount(), config, token)])
    expect(relayed).toHaveLength(1)
    expect(second.toString()).toBe(first.toString())
  })

  it('reuses the stored key afterwards', async () => {
    const key = await ensureGameKey(fakeAccount(), config, token)
    expect((await ensureGameKey(fakeAccount(), config, token)).toString()).toBe(key.toString())
    expect(relayed).toHaveLength(1)
  })

  it('sends the Privy access token with the activation', async () => {
    await ensureGameKey(fakeAccount(), config, token)
    expect(vi.mocked(activate)).toHaveBeenLastCalledWith('/relayer', 'a'.repeat(64), 'privy-token')
  })

  it('stops before activating when the login is gone', async () => {
    vi.mocked(activate).mockClear()
    await expect(ensureGameKey(fakeAccount(), config, async () => null)).rejects.toThrow(/log in again/)
    expect(vi.mocked(activate)).not.toHaveBeenCalled()
    expect(relayed).toHaveLength(0)
  })
})
