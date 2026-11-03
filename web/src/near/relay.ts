import type { SignedDelegate } from 'near-api-js'
import { signedDelegateToBase64 } from './delegate'

export class RelayError extends Error {}

/** Relayer reply on 200. `pending` means its RPC wait timed out: the tx may still land. */
export interface RelayResult {
  txHash: string
  status: 'success' | 'pending'
}

/** Posts a SignedDelegate to `${relayerUrl}/relay`. Refusals and on-chain failures throw. */
export async function relay(relayerUrl: string, signedDelegate: SignedDelegate): Promise<RelayResult> {
  const body = await postJson(`${relayerUrl}/relay`, { signedDelegate: signedDelegateToBase64(signedDelegate) })
  if (!isRecord(body) || typeof body.txHash !== 'string') throw new RelayError('relayer sent an unexpected reply')
  if (body.status === 'failure') {
    const reason = typeof body.failure === 'string' ? body.failure : 'unknown'
    throw new RelayError(`transaction ${body.txHash} failed: ${reason}`)
  }
  if (body.status !== 'success' && body.status !== 'pending') throw new RelayError('relayer sent an unknown status')
  return { txHash: body.txHash, status: body.status }
}

/** Asks the relayer to fund a new implicit account and register it on the token. Idempotent. */
export async function activate(relayerUrl: string, accountId: string): Promise<void> {
  await postJson(`${relayerUrl}/activate`, { accountId })
}

async function postJson(url: string, payload: object): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const code = isRecord(body) && typeof body.error === 'string' ? body.error : 'no error code'
    throw new RelayError(`relayer refused (${response.status}): ${code}`)
  }
  return body
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
