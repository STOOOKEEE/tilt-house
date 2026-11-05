import { EXPLORER_TX } from '../house'

/** A relayed money call: waiting for the Privy signature, landed (with its tx), or refused. */
export type ActionState =
  | { state: 'idle' }
  | { state: 'busy'; label: string }
  | { state: 'done'; label: string; txHash: string }
  | { state: 'error'; message: string }

export function ActionStatus({ action }: { action: ActionState }) {
  switch (action.state) {
    case 'idle':
      return null
    case 'busy':
      return <p className="muted">{action.label}: confirm in the Privy window…</p>
    case 'done':
      return (
        <p className="win">
          {action.label} done ·{' '}
          <a href={`${EXPLORER_TX}${action.txHash}`} target="_blank" rel="noreferrer">
            view tx
          </a>
        </p>
      )
    case 'error':
      return <p className="loss">{action.message}</p>
  }
}
