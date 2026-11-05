export interface Config {
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

function required(env: Env, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing ${name}: copy web/.env.example to web/.env and fill it in`)
  return value
}

// Fails closed: the app refuses to start rather than sign for an unknown contract or relayer.
export function readConfig(env: Env): Config {
  return {
    privyAppId: env.VITE_PRIVY_APP_ID?.trim() ?? '',
    houseContract: required(env, 'VITE_HOUSE_CONTRACT'),
    tokenContract: required(env, 'VITE_TOKEN_CONTRACT'),
    relayerUrl: required(env, 'VITE_RELAYER_URL').replace(/\/+$/, ''),
    relayerAccount: required(env, 'VITE_RELAYER_ACCOUNT'),
    rpcUrl: required(env, 'VITE_NEAR_RPC_URL'),
    sessionUrl: env.VITE_SESSION_URL?.trim().replace(/\/+$/, '') ?? '',
  }
}
