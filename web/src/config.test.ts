import { describe, expect, it } from 'vitest'
import { NETWORK_STORAGE_KEY, loadNetworkChoice, readConfig, saveNetworkChoice } from './config'

const ENV = {
  VITE_PRIVY_APP_ID: 'app',
  VITE_HOUSE_CONTRACT: 'house.tilthouse.testnet',
  VITE_TOKEN_CONTRACT: 'tusdc.tilthouse.testnet',
  VITE_RELAYER_URL: 'http://localhost:8787/',
  VITE_RELAYER_ACCOUNT: 'relayer.tilthouse.testnet',
  VITE_NEAR_RPC_URL: 'https://test.rpc.fastnear.com',
}

const MAINNET = {
  ...ENV,
  VITE_MAINNET_HOUSE_CONTRACT: 'floor.tilthouse.near',
  VITE_MAINNET_TOKEN_CONTRACT: 'tusdc.tilthouse.near',
  VITE_MAINNET_RELAYER_ACCOUNT: 'relayer.tilthouse.near',
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

  it('keeps mainnet "coming soon" until its contracts are configured, whatever was stored', () => {
    const config = readConfig(ENV, 'mainnet')
    expect(config).toMatchObject({ network: 'testnet', mainnetReady: false, houseContract: 'house.tilthouse.testnet' })
  })

  it('talks to mainnet through the /mainnet prefixes once configured', () => {
    expect(readConfig(MAINNET, 'testnet')).toMatchObject({ network: 'testnet', mainnetReady: true, relayerUrl: 'http://localhost:8787' })
    expect(readConfig(MAINNET, 'mainnet')).toEqual({
      network: 'mainnet',
      mainnetReady: true,
      privyAppId: 'app',
      houseContract: 'floor.tilthouse.near',
      tokenContract: 'tusdc.tilthouse.near',
      relayerUrl: '/mainnet/relayer',
      relayerAccount: 'relayer.tilthouse.near',
      rpcUrl: 'https://rpc.mainnet.fastnear.com',
      sessionUrl: '/mainnet/session',
    })
  })

  it('refuses a half-configured mainnet or a testnet id in a mainnet slot', () => {
    expect(() => readConfig({ ...MAINNET, VITE_MAINNET_TOKEN_CONTRACT: '' })).toThrow(/VITE_MAINNET_TOKEN_CONTRACT/)
    expect(() => readConfig({ ...MAINNET, VITE_MAINNET_HOUSE_CONTRACT: 'floor.tilthouse.testnet' })).toThrow(/\.near/)
  })
})

describe('network choice', () => {
  it('round-trips through storage and defaults to testnet', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    expect(loadNetworkChoice(storage)).toBe('testnet')
    saveNetworkChoice(storage, 'mainnet')
    expect(loadNetworkChoice(storage)).toBe('mainnet')
    store.set(NETWORK_STORAGE_KEY, 'betanet')
    expect(loadNetworkChoice(storage)).toBe('testnet')
  })

  it('falls back to testnet when storage is unavailable', () => {
    expect(loadNetworkChoice({ getItem: () => { throw new Error('denied') } })).toBe('testnet')
  })
})
