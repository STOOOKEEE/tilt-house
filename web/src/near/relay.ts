import type { SignedDelegate } from 'near-api-js'
import { signedDelegateToBase64 } from './delegate'

/** A non-2xx reply; `code` is the relayer's error code (e.g. `rpc_timeout`: the tx may still land). */
export class RelayError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

export interface RelayResult {
  txHash: string
}

/** Posts a SignedDelegate to `${relayerUrl}/relay`. Refusals and reported on-chain failures throw. */
export async function relay(relayerUrl: string, signedDelegate: SignedDelegate): Promise<RelayResult> {
  const body = await postJson(`${relayerUrl}/relay`, { signedDelegate: signedDelegateToBase64(signedDelegate) })
  if (!isRecord(body) || typeof body.txHash !== 'string') {
    throw new RelayError('relayer sent an unexpected reply', 'bad_reply')
  }
  if (body.status === 'failure') {
    const reason = typeof body.failure === 'string' ? body.failure : 'unknown'
    throw new RelayError(`transaction ${body.txHash} failed: ${reason}`, 'tx_failure')
  }
  // `pending`: a game move in a block, still running; its result shows up in the round.
  if (body.status !== 'success' && body.status !== 'pending') {
    throw new RelayError('relayer sent an unknown status', 'bad_reply')
  }
  return { txHash: body.txHash }
}

/**
 * Asks the relayer to fund a new implicit account and register it on the token. The relayer pays
 * only for a logged-in Privy user (one account each), so the site sends the Privy access token;
 * null is for the testnet CLI demo, which the testnet relayer activates anonymously.
 */
export async function activate(relayerUrl: string, accountId: string, accessToken: string | null): Promise<void> {
  try {
    await postJson(`${relayerUrl}/activate`, { accountId }, accessToken)
  } catch (error) {
    // Activation is one-time per account: a repeat (e.g. new browser) is fine.
    if (error instanceof RelayError && error.code === 'already_activated') return
    throw error
  }
}

/**
 * Claims free tUSDC (once per hour per account; on mainnet once per hour per Privy user, who must
 * send their access token); returns the minted base units.
 */
export async function claimFaucet(relayerUrl: string, accountId: string, accessToken: string | null): Promise<string> {
  const body = await postJson(`${relayerUrl}/faucet`, { accountId }, accessToken)
  if (!isRecord(body) || typeof body.minted !== 'string') throw new RelayError('relayer sent an unexpected reply', 'bad_reply')
  return body.minted
}

/**
 * Claims the one-time $TILT welcome from the TILT floor's relayer (welcome mode; Privy token
 * required, once per user forever: 409 `already_claimed`); returns the TILT base units received.
 */
export async function claimWelcome(relayerUrl: string, accountId: string, accessToken: string | null): Promise<string> {
  const body = await postJson(`${relayerUrl}/faucet`, { accountId }, accessToken)
  if (!isRecord(body) || typeof body.welcomed !== 'string') throw new RelayError('relayer sent an unexpected reply', 'bad_reply')
  return body.welcomed
}

async function postJson(url: string, payload: object, accessToken: string | null = null): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (accessToken) headers.authorization = `Bearer ${accessToken}`
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const code = isRecord(body) && typeof body.error === 'string' ? body.error : 'no_error_code'
    throw new RelayError(`relayer refused (${response.status}): ${code}`, code)
  }
  return body
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
