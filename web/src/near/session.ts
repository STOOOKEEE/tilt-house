import { Account, KeyPair, KeyPairSigner, type JsonRpcProvider, type KeyPairString } from 'near-api-js'
import type { Config } from '../config'
import { callAction, gameKeyAction, type GameMethod } from './delegate'
import { activate, relay, type RelayResult } from './relay'

type SessionConfig = Pick<Config, 'houseContract' | 'relayerUrl'>
/** Privy's `getAccessToken`: null when the login session is gone. */
export type GetAccessToken = () => Promise<string | null>

// The relayer refuses delegates valid for more than 600 blocks; ~2 minutes is plenty.
const DELEGATE_TTL_BLOCKS = 120
// Activation answers once its transfer executed, but signing reads the key at `final`, a block or
// two later: a fresh account's key can be missing for a few seconds.
const KEY_VISIBLE_TRIES = 10
const KEY_VISIBLE_WAIT_MS = 1_500

/** Runs `sign`, retrying while the signing key of a just-activated account is not final yet. */
async function whenKeyVisible<T>(sign: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sign()
    } catch (error) {
      const missingKey = error instanceof Error && /access key .* does not exist/i.test(error.message)
      if (!missingKey || attempt >= KEY_VISIBLE_TRIES) throw error
      // ES2022 lib has no Promise.withResolvers.
      await new Promise((resolve) => setTimeout(resolve, KEY_VISIBLE_WAIT_MS))
    }
  }
}

function storageKey(accountId: string, houseContract: string): string {
  return `tilt-house:game-key:${accountId}:${houseContract}`
}

function loadGameKey(accountId: string, houseContract: string): KeyPair | null {
  const stored = localStorage.getItem(storageKey(accountId, houseContract))
  return stored ? KeyPair.fromString(stored as KeyPairString) : null
}

/**
 * Makes sure this browser holds a function-call key for the house on `account`.
 * First time: the relayer activates the account (Privy wallets are implicit accounts that do not
 * exist until funded), then one Privy signature for the AddKey delegate, relayed gas-free.
 * The key is stored only after the relayer accepted it, so a failed relay retries next login.
 */
// The provider effect reruns whenever Privy hands a new Account object for the same wallet; two
// concurrent setups sign AddKey delegates with the same nonce and the second one fails on chain.
const pendingSetups = new Map<string, Promise<KeyPair>>()

export function ensureGameKey(account: Account, config: SessionConfig, getAccessToken: GetAccessToken): Promise<KeyPair> {
  const existing = loadGameKey(account.accountId, config.houseContract)
  if (existing) return Promise.resolve(existing)
  const id = storageKey(account.accountId, config.houseContract)
  const pending = pendingSetups.get(id)
  if (pending) return pending
  const setup = setUpGameKey(account, config, getAccessToken).finally(() => pendingSetups.delete(id))
  pendingSetups.set(id, setup)
  return setup
}

async function setUpGameKey(account: Account, config: SessionConfig, getAccessToken: GetAccessToken): Promise<KeyPair> {
  const accessToken = await getAccessToken()
  if (!accessToken) throw new Error('Login expired: log in again')
  await activate(config.relayerUrl, account.accountId, accessToken)
  const gameKey = KeyPair.fromRandom('ed25519')
  // AddKey acts on the delegate's receiver, so it targets the player's own account.
  const { signedDelegate } = await whenKeyVisible(() =>
    account.createSignedMetaTransaction({
      receiverId: account.accountId,
      actions: [gameKeyAction(gameKey.getPublicKey(), config.houseContract)],
      blockHeightTtl: DELEGATE_TTL_BLOCKS,
    }),
  )
  await relay(config.relayerUrl, signedDelegate)
  localStorage.setItem(storageKey(account.accountId, config.houseContract), gameKey.toString())
  return gameKey
}

/**
 * A session call (docs/sessions.md) signed by the browser game key and relayed: no popup, no gas
 * for the player. Safe with a function-call key: the money only moves inside the floor contract
 * (balance to session escrow and back), and the key cannot attach deposits.
 */
export async function gameKeyCall(
  accountId: string,
  provider: JsonRpcProvider,
  config: SessionConfig,
  method: GameMethod,
  args: object,
): Promise<RelayResult> {
  const gameKey = loadGameKey(accountId, config.houseContract)
  if (!gameKey) throw new Error('No game key in this browser: log in again')
  const account = new Account(accountId, provider, new KeyPairSigner(gameKey))
  // The game key was just added by a relayed AddKey: it can take a block to become final.
  const { signedDelegate } = await whenKeyVisible(() =>
    account.createSignedMetaTransaction({
      receiverId: config.houseContract,
      actions: [callAction(method, args, 0n)],
      blockHeightTtl: DELEGATE_TTL_BLOCKS,
    }),
  )
  return relay(config.relayerUrl, signedDelegate)
}

/** Money moves (deposit, withdraw, invest) signed by the Privy full-access key and relayed. */
export async function fullAccessCall(
  account: Account,
  config: SessionConfig,
  receiverId: string,
  method: string,
  args: object,
  deposit: bigint,
): Promise<RelayResult> {
  const { signedDelegate } = await account.createSignedMetaTransaction({
    receiverId,
    actions: [callAction(method, args, deposit)],
    blockHeightTtl: DELEGATE_TTL_BLOCKS,
  })
  return relay(config.relayerUrl, signedDelegate)
}
