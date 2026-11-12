export type NetworkId = 'testnet' | 'mainnet'

export interface Config {
  /** The network this page talks to; switching reloads the page (see `saveNetworkChoice`). */
  network: NetworkId
  /** False until the mainnet contracts are configured: the switch shows "coming soon". */
  mainnetReady: boolean
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

// Fails closed: the app refuses to start rather than sign for an unknown contract or relayer.
export function readConfig(env: Env, choice: NetworkId = 'testnet'): Config {
  const main = mainnet(env)
  const base = { privyAppId: value(env, 'VITE_PRIVY_APP_ID'), mainnetReady: main !== null }
  // Mainnet stays unreachable, whatever was stored, until it is configured.
  if (choice === 'mainnet' && main) return { ...base, network: 'mainnet', ...main }
  return { ...base, network: 'testnet', ...testnet(env) }
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
