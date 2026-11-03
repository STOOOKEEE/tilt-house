import { createContext, useContext } from 'react'
import type { Account, JsonRpcProvider } from 'near-api-js'
import type { Config } from '../config'

/** Game-key setup after login: `ready` means moves can be signed without a popup. */
export type GameKeyStatus = { state: 'none' } | { state: 'pending' } | { state: 'ready' } | { state: 'error'; message: string }

export interface NearContextValue {
  config: Config
  provider: JsonRpcProvider
  nearAccount: Account | null
  walletId: string
  gameKey: GameKeyStatus
}

export const NearContext = createContext<NearContextValue | undefined>(undefined)

export function useNear(): NearContextValue {
  const context = useContext(NearContext)
  if (!context) throw new Error('useNear must be used within <NearPrivyProvider>')
  return context
}
