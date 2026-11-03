import { describe, expect, it } from 'vitest'
import { readConfig } from './config'

const ENV = {
  VITE_PRIVY_APP_ID: 'app',
  VITE_HOUSE_CONTRACT: 'house.tilthouse.testnet',
  VITE_TOKEN_CONTRACT: 'tusdc.tilthouse.testnet',
  VITE_RELAYER_URL: 'http://localhost:8787/',
  VITE_RELAYER_ACCOUNT: 'relayer.tilthouse.testnet',
  VITE_NEAR_RPC_URL: 'https://test.rpc.fastnear.com',
}

describe('readConfig', () => {
  it('runs read-only without a Privy app id', () => {
    expect(readConfig({ ...ENV, VITE_PRIVY_APP_ID: undefined }).privyAppId).toBe('')
    expect(readConfig({ ...ENV, VITE_PRIVY_APP_ID: '  ' }).privyAppId).toBe('')
    expect(readConfig(ENV).relayerUrl).toBe('http://localhost:8787')
  })

  it('still refuses to start without the contracts, relayer or RPC', () => {
    expect(() => readConfig({ ...ENV, VITE_HOUSE_CONTRACT: '' })).toThrow(/VITE_HOUSE_CONTRACT/)
  })
})
