export type NetworkId = 'testnet' | 'mainnet'
/** What the tables play in: tUSDC on the USD floor, $TILT on its twin floor (same contract code). */
export type Currency = 'usd' | 'tilt'

export const TOKEN_SYMBOLS: Record<Currency, string> = { usd: 'tUSDC', tilt: 'TILT' }

export interface Config {
  /** The network this page talks to; switching reloads the page (see `saveNetworkChoice`). */
  network: NetworkId
  /** False until the mainnet contracts are configured: the network switch stays hidden. */
  mainnetReady: boolean
  /** The currency this page plays in; switching reloads the page (see `saveCurrencyChoice`). */
  currency: Currency
  /** False until VITE_TILT_FLOOR is set (testnet only): the currency switch stays hidden. */
  tiltReady: boolean
  /** Shown after every amount of the active currency. */
  tokenSymbol: string
  /** The USD floor, whatever the currency: it reports the daily result and runs Tilt Hour. */
  usdFloor: string
  /** The $TILT token contract (testnet), whatever the currency. Empty on mainnet. */
  tiltToken: string
  /** Empty: no login, the app runs read-only (lobby, tables, dealers, sim still work). */
  privyAppId: string
  houseContract: string
  tokenContract: string
  relayerUrl: string
  /** Account that signs relayed transactions, hence the signer named in the VRF alpha of relayed rounds. */
  relayerAccount: string
  rpcUrl: string
  /** Session server (sessions and live gamblers). Empty: no session play, the floor shows the sim demo. */
  sessionUrl: string
}

type Env = Record<string, string | undefined>
type NetworkConfig = Pick<Config, 'houseContract' | 'tokenContract' | 'relayerUrl' | 'relayerAccount' | 'rpcUrl' | 'sessionUrl'>

/** Same-origin prefixes the site proxies to each network's relayer and session server (web/vercel.json). */
const MAINNET_RELAYER_URL = '/mainnet/relayer'
const MAINNET_SESSION_URL = '/mainnet/session'
const MAINNET_RPC_URL = 'https://rpc.mainnet.fastnear.com'
const MAINNET_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)+near$/
export const NETWORK_STORAGE_KEY = 'tilt-house:network'
export const CURRENCY_STORAGE_KEY = 'tilt-house:currency'
/** Same-origin prefixes of the TILT floor's relayer and session server (web/vercel.json). */
const TILT_RELAYER_URL = '/tilt/relayer'
const TILT_SESSION_URL = '/tilt/session'
const TILT_TOKEN = 'tilt.tilthouse.testnet'

function value(env: Env, name: string): string {
  return env[name]?.trim() ?? ''
}

function required(env: Env, name: string): string {
  const found = value(env, name)
  if (!found) throw new Error(`Missing ${name}: copy web/.env.example to web/.env and fill it in`)
  return found
}

const withoutSlash = (url: string) => url.replace(/\/+$/, '')

function testnet(env: Env): NetworkConfig {
  return {
    houseContract: required(env, 'VITE_HOUSE_CONTRACT'),
    tokenContract: required(env, 'VITE_TOKEN_CONTRACT'),
    relayerUrl: withoutSlash(required(env, 'VITE_RELAYER_URL')),
    relayerAccount: required(env, 'VITE_RELAYER_ACCOUNT'),
    rpcUrl: required(env, 'VITE_NEAR_RPC_URL'),
    sessionUrl: withoutSlash(value(env, 'VITE_SESSION_URL')),
  }
}

/** A mainnet account, so a testnet id pasted into the mainnet slot cannot slip through. */
function mainnetAccount(env: Env, name: string): string {
  const id = required(env, name)
  if (!MAINNET_ACCOUNT.test(id)) throw new Error(`${name} must be a .near account`)
  return id
}

/** Null until VITE_MAINNET_HOUSE_CONTRACT is set; once it is, the rest must be complete. */
function mainnet(env: Env): NetworkConfig | null {
  if (!value(env, 'VITE_MAINNET_HOUSE_CONTRACT')) return null
  return {
    houseContract: mainnetAccount(env, 'VITE_MAINNET_HOUSE_CONTRACT'),
    tokenContract: mainnetAccount(env, 'VITE_MAINNET_TOKEN_CONTRACT'),
    relayerUrl: withoutSlash(value(env, 'VITE_MAINNET_RELAYER_URL') || MAINNET_RELAYER_URL),
    relayerAccount: mainnetAccount(env, 'VITE_MAINNET_RELAYER_ACCOUNT'),
    rpcUrl: value(env, 'VITE_MAINNET_NEAR_RPC_URL') || MAINNET_RPC_URL,
    sessionUrl: withoutSlash(value(env, 'VITE_MAINNET_SESSION_URL') || MAINNET_SESSION_URL),
  }
}

const tiltToken = (env: Env) => value(env, 'VITE_TILT_TOKEN') || TILT_TOKEN

/**
 * The TILT floor: a second instance of the floor contract with token = TILT, its own relayer and
 * session server; same RPC and relayer account as testnet. Null until VITE_TILT_FLOOR is set.
 */
function tilt(env: Env, usd: NetworkConfig): NetworkConfig | null {
  const floor = value(env, 'VITE_TILT_FLOOR')
  if (!floor) return null
  if (floor === usd.houseContract) throw new Error('VITE_TILT_FLOOR must not be the USD floor (VITE_HOUSE_CONTRACT)')
  return {
    houseContract: floor,
    tokenContract: tiltToken(env),
    relayerUrl: withoutSlash(value(env, 'VITE_TILT_RELAYER_URL') || TILT_RELAYER_URL),
    relayerAccount: value(env, 'VITE_TILT_RELAYER_ACCOUNT') || usd.relayerAccount,
    rpcUrl: usd.rpcUrl,
    sessionUrl: withoutSlash(value(env, 'VITE_TILT_SESSION_URL') || TILT_SESSION_URL),
  }
}

// Fails closed: the app refuses to start rather than sign for an unknown contract or relayer.
export function readConfig(env: Env, choice: NetworkId = 'testnet', currency: Currency = 'usd'): Config {
  const main = mainnet(env)
  const privyAppId = value(env, 'VITE_PRIVY_APP_ID')
  // Mainnet stays unreachable, whatever was stored, until it is configured. It has no TILT.
  if (choice === 'mainnet' && main) {
    return {
      privyAppId,
      mainnetReady: true,
      network: 'mainnet',
      currency: 'usd',
      tiltReady: false,
      tokenSymbol: TOKEN_SYMBOLS.usd,
      usdFloor: main.houseContract,
      tiltToken: '',
      ...main,
    }
  }
  const usd = testnet(env)
  const tiltFloor = tilt(env, usd)
  // Same for TILT: a stored "tilt" means USD until the TILT floor is configured.
  const picked = currency === 'tilt' ? tiltFloor : null
  const active: Currency = picked ? 'tilt' : 'usd'
  return {
    privyAppId,
    mainnetReady: main !== null,
    network: 'testnet',
    currency: active,
    tiltReady: tiltFloor !== null,
    tokenSymbol: TOKEN_SYMBOLS[active],
    usdFloor: usd.houseContract,
    tiltToken: tiltToken(env),
    ...(picked ?? usd),
  }
}

/** The network picked in this browser; anything unreadable means testnet. */
export function loadNetworkChoice(storage: Pick<Storage, 'getItem'>): NetworkId {
  try {
    return storage.getItem(NETWORK_STORAGE_KEY) === 'mainnet' ? 'mainnet' : 'testnet'
  } catch {
    return 'testnet'
  }
}

export function saveNetworkChoice(storage: Pick<Storage, 'setItem'>, network: NetworkId): void {
  storage.setItem(NETWORK_STORAGE_KEY, network)
}

/** The currency picked in this browser; anything unreadable means USD. */
export function loadCurrencyChoice(storage: Pick<Storage, 'getItem'>): Currency {
  try {
    return storage.getItem(CURRENCY_STORAGE_KEY) === 'tilt' ? 'tilt' : 'usd'
  } catch {
    return 'usd'
  }
}

export function saveCurrencyChoice(storage: Pick<Storage, 'setItem'>, currency: Currency): void {
  storage.setItem(CURRENCY_STORAGE_KEY, currency)
}
