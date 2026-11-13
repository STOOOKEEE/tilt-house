import { describe, expect, it } from 'vitest'
import {
  CURRENCY_STORAGE_KEY,
  NETWORK_STORAGE_KEY,
  loadCurrencyChoice,
  loadNetworkChoice,
  readConfig,
  saveCurrencyChoice,
  saveNetworkChoice,
} from './config'

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

  it('keeps mainnet hidden until its contracts are configured, whatever was stored', () => {
    const config = readConfig(ENV, 'mainnet')
    expect(config).toMatchObject({ network: 'testnet', mainnetReady: false, houseContract: 'house.tilthouse.testnet' })
  })

  it('talks to mainnet through the /mainnet prefixes once configured', () => {
    expect(readConfig(MAINNET, 'testnet')).toMatchObject({ network: 'testnet', mainnetReady: true, relayerUrl: 'http://localhost:8787' })
    expect(readConfig(MAINNET, 'mainnet')).toEqual({
      network: 'mainnet',
      mainnetReady: true,
      currency: 'usd',
      tiltReady: false,
      tokenSymbol: 'tUSDC',
      usdFloor: 'floor.tilthouse.near',
      tiltToken: '',
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

const TILT = { ...ENV, VITE_TILT_FLOOR: 'floor-tilt.tilthouse.testnet' }

describe('currency', () => {
  it('plays in USD with the TILT switch hidden until VITE_TILT_FLOOR is set, whatever was stored', () => {
    expect(readConfig(ENV, 'testnet', 'tilt')).toMatchObject({
      currency: 'usd',
      tiltReady: false,
      tokenSymbol: 'tUSDC',
      houseContract: 'house.tilthouse.testnet',
      tiltToken: 'tilt.tilthouse.testnet',
    })
  })

  it('switches floor, token, relayer and session server to the TILT instance', () => {
    expect(readConfig({ ...TILT, VITE_SESSION_URL: '/session' }, 'testnet', 'usd')).toMatchObject({
      currency: 'usd',
      tiltReady: true,
      tokenSymbol: 'tUSDC',
      houseContract: 'house.tilthouse.testnet',
      tokenContract: 'tusdc.tilthouse.testnet',
      relayerUrl: 'http://localhost:8787',
      sessionUrl: '/session',
    })
    expect(readConfig(TILT, 'testnet', 'tilt')).toEqual({
      network: 'testnet',
      mainnetReady: false,
      currency: 'tilt',
      tiltReady: true,
      tokenSymbol: 'TILT',
      usdFloor: 'house.tilthouse.testnet',
      tiltToken: 'tilt.tilthouse.testnet',
      privyAppId: 'app',
      houseContract: 'floor-tilt.tilthouse.testnet',
      tokenContract: 'tilt.tilthouse.testnet',
      relayerUrl: '/tilt/relayer',
      relayerAccount: 'relayer.tilthouse.testnet',
      rpcUrl: 'https://test.rpc.fastnear.com',
      sessionUrl: '/tilt/session',
    })
  })

  it('takes overrides for the TILT token, relayer and session server', () => {
    const env = {
      ...TILT,
      VITE_TILT_TOKEN: 'tilt2.tilthouse.testnet',
      VITE_TILT_RELAYER_URL: 'http://localhost:8789/',
      VITE_TILT_SESSION_URL: 'http://localhost:8793',
      VITE_TILT_RELAYER_ACCOUNT: 'relayer-tilt.tilthouse.testnet',
    }
    expect(readConfig(env, 'testnet', 'tilt')).toMatchObject({
      tokenContract: 'tilt2.tilthouse.testnet',
      tiltToken: 'tilt2.tilthouse.testnet',
      relayerUrl: 'http://localhost:8789',
      sessionUrl: 'http://localhost:8793',
      relayerAccount: 'relayer-tilt.tilthouse.testnet',
    })
  })

  it('refuses the USD floor as the TILT floor, and has no TILT on mainnet', () => {
    expect(() => readConfig({ ...TILT, VITE_TILT_FLOOR: 'house.tilthouse.testnet' })).toThrow(/VITE_TILT_FLOOR/)
    expect(readConfig({ ...MAINNET, ...TILT }, 'mainnet', 'tilt')).toMatchObject({ network: 'mainnet', currency: 'usd', tiltReady: false })
  })

  it('round-trips through storage and defaults to USD', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    expect(loadCurrencyChoice(storage)).toBe('usd')
    saveCurrencyChoice(storage, 'tilt')
    expect(loadCurrencyChoice(storage)).toBe('tilt')
    store.set(CURRENCY_STORAGE_KEY, 'doge')
    expect(loadCurrencyChoice(storage)).toBe('usd')
    expect(loadCurrencyChoice({ getItem: () => { throw new Error('denied') } })).toBe('usd')
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
