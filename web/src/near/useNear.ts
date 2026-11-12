import { createContext, useContext } from 'react'
import type { Account, JsonRpcProvider } from 'near-api-js'
import type { Config } from '../config'

/** Game-key setup after login: `ready` means moves can be signed without a popup. */
export type GameKeyStatus = { state: 'none' } | { state: 'pending' } | { state: 'ready' } | { state: 'error'; message: string }

/** Login controls; `available: false` = read-only mode (no Privy app, or Privy failed to start). */
export type Auth =
  | { available: true; ready: boolean; authenticated: boolean; login: () => void; logout: () => void }
  | { available: false; reason: string }

export interface NearContextValue {
  auth: Auth
  config: Config
  provider: JsonRpcProvider
  nearAccount: Account | null
  walletId: string
  gameKey: GameKeyStatus
  /** The Privy access token the relayer asks for (activation, mainnet faucet); null when logged out. */
  getAccessToken: () => Promise<string | null>
}

export const NearContext = createContext<NearContextValue | undefined>(undefined)

export function useNear(): NearContextValue {
  const context = useContext(NearContext)
  if (!context) throw new Error('useNear must be used within <NearPrivyProvider> or <ReadOnlyNearProvider>')
  return context
}
