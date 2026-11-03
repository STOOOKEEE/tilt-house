import { usePrivy } from '@privy-io/react-auth'
import { useCreateWallet, useSignRawHash } from '@privy-io/react-auth/extended-chains'
import { Account, JsonRpcProvider } from 'near-api-js'
import { useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react'
import type { Config } from '../config'
import { ensureGameKey } from './session'
import { PrivySigner } from './signer'
import { NearContext, type GameKeyStatus } from './useNear'

// Follows near-examples/hello-privy (src/context/provider.tsx), plus the game-key setup.
export function NearPrivyProvider({ config, children }: PropsWithChildren<{ config: Config }>) {
  const provider = useMemo(() => new JsonRpcProvider({ url: config.rpcUrl }), [config.rpcUrl])
  const { authenticated, user } = usePrivy()
  const { signRawHash } = useSignRawHash()
  const { createWallet } = useCreateWallet()
  const creatingWallet = useRef(false)
  const [walletId, setWalletId] = useState('')
  const [nearAccount, setNearAccount] = useState<Account | null>(null)
  const [gameKey, setGameKey] = useState<GameKeyStatus>({ state: 'none' })

  useEffect(() => {
    if (!authenticated || !user) {
      setWalletId('')
      setNearAccount(null)
      return
    }
    // A user may also hold Ethereum/Solana wallets: pick the NEAR one explicitly.
    const nearWallet = user.linkedAccounts.find((account) => account.type === 'wallet' && account.chainType === 'near')
    if (nearWallet?.type !== 'wallet') {
      if (!creatingWallet.current) {
        creatingWallet.current = true
        createWallet({ chainType: 'near' })
          .catch((error: unknown) => console.error('Could not create NEAR wallet', error))
          .finally(() => {
            creatingWallet.current = false
          })
      }
      return
    }
    const signer = new PrivySigner(signRawHash, nearWallet.address, provider)
    setNearAccount(new Account(nearWallet.address, provider, signer))
    setWalletId(nearWallet.address)
  }, [authenticated, user, createWallet, signRawHash, provider])

  useEffect(() => {
    if (!nearAccount) {
      setGameKey({ state: 'none' })
      return
    }
    let cancelled = false
    setGameKey({ state: 'pending' })
    ensureGameKey(nearAccount, config)
      .then(() => !cancelled && setGameKey({ state: 'ready' }))
      .catch((error: unknown) => {
        if (cancelled) return
        setGameKey({ state: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      cancelled = true
    }
  }, [nearAccount, config])

  const value = useMemo(
    () => ({ config, provider, nearAccount, walletId, gameKey }),
    [config, provider, nearAccount, walletId, gameKey],
  )
  return <NearContext.Provider value={value}>{children}</NearContext.Provider>
}
