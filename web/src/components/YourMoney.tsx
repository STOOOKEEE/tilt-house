import { useCallback, useState } from 'react'
import { formatAmount, formatUsdc, parseUsdc, tokenSymbol } from '../format'
import { MONEY_EXPLAINER } from '../money'
import { claimFaucet, claimWelcome } from '../near/relay'
import { fullAccessCall } from '../near/session'
import { useNear } from '../near/useNear'
import { usePoll } from '../near/usePoll'
import { getTokenBalance, type PlayerView } from '../near/views'
import { ActionStatus, type ActionState } from './ActionStatus'
import { LoginPrompt } from './LoginPrompt'

/** Money moves need the Privy (full-access) signature; NEAR wants 1 yocto on deposit and withdraw. */
const ONE_YOCTO = 1n

interface YourMoneyProps {
  /** The caller's player poll: its house balance is shown here. */
  player: PlayerView | null
  /** Called after every money move so the caller's own balances follow. */
  onChange: () => void
}

/** Wallet and house balances, the chips faucet, deposit and withdraw: the same block on every page money matters. */
export function YourMoney({ player, onChange }: YourMoneyProps) {
  const { config, walletId, nearAccount, getAccessToken } = useNear()
  const loadWallet = useCallback(() => getTokenBalance(config.rpcUrl, config.tokenContract, walletId), [config, walletId])
  const wallet = usePoll(walletId ? loadWallet : null, 5_000)
  const [action, setAction] = useState<ActionState>({ state: 'idle' })
  const [faucet, setFaucet] = useState('')

  if (!walletId || !nearAccount) {
    return (
      <section className="panel" id="your-money">
        <h2>Your money</h2>
        <p className="muted">{MONEY_EXPLAINER}</p>
        <LoginPrompt action="get chips and deposit them" />
      </section>
    )
  }

  const refresh = () => {
    wallet.refresh()
    onChange()
  }
  const move = async (label: string, receiver: string, method: string, args: object) => {
    setAction({ state: 'busy', label })
    try {
      const { txHash } = await fullAccessCall(nearAccount, config, receiver, method, args, ONE_YOCTO)
      setAction({ state: 'done', label, txHash })
    } catch (error) {
      setAction({ state: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      refresh()
    }
  }
  const claim = async () => {
    setFaucet('claiming…')
    try {
      const claimFor = config.currency === 'tilt' ? claimWelcome : claimFaucet
      setFaucet(`+${formatAmount(await claimFor(config.relayerUrl, walletId, await getAccessToken()))} in your wallet`)
      refresh()
    } catch (error) {
      setFaucet(error instanceof Error ? error.message : String(error))
    }
  }
  const busy = action.state === 'busy'

  return (
    <section className="panel" id="your-money">
      <h2>Your money</h2>
      <p className="muted">{MONEY_EXPLAINER}</p>
      <p>
        in the house: <span className="money">{player ? formatUsdc(player.balance) : '—'} {tokenSymbol()}</span> · in your wallet:{' '}
        <span className="money">{wallet.data ? formatUsdc(wallet.data) : '—'} {tokenSymbol()}</span>{' '}
        <button type="button" className="ghost" onClick={() => void claim()}>
          {config.currency === 'tilt' ? 'Claim welcome TILT (once)' : `Get test ${tokenSymbol()}`}
        </button>{' '}
        <span className="muted">{faucet}</span>
      </p>
      <ActionStatus action={action} />
      <AmountForm
        label="Deposit"
        hint="wallet → house"
        max={wallet.data ? BigInt(wallet.data) : null}
        busy={busy}
        onSubmit={(amount) =>
          void move('deposit', config.tokenContract, 'ft_transfer_call', { receiver_id: config.houseContract, amount: String(amount), msg: '' })
        }
      />
      <AmountForm
        label="Withdraw"
        hint="house → wallet"
        max={player ? BigInt(player.balance) : null}
        busy={busy}
        onSubmit={(amount) => void move('withdraw', config.houseContract, 'withdraw', { amount: String(amount) })}
      />
    </section>
  )
}

interface AmountFormProps {
  label: string
  hint: string
  max: bigint | null
  busy: boolean
  onSubmit: (amount: bigint) => void
}

function AmountForm({ label, hint, max, busy, onSubmit }: AmountFormProps) {
  const [text, setText] = useState('')
  const amount = parseUsdc(text)
  const valid = amount !== null && amount > 0n && max !== null && amount <= max
  return (
    <form
      className="amount-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid) onSubmit(amount)
      }}
    >
      <input placeholder={tokenSymbol()} inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)} />
      <button type="button" className="ghost" disabled={max === null} onClick={() => max !== null && setText(formatUsdc(max, 0))}>
        max
      </button>
      <button type="submit" disabled={!valid || busy}>
        {label}
      </button>
      <span className="muted">{hint}</span>
    </form>
  )
}
