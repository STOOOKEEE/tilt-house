import { useCallback, useState } from 'react'
import { useSearchParams } from 'react-router'
import { ActionStatus, type ActionState } from '../components/ActionStatus'
import { LoginPrompt } from '../components/LoginPrompt'
import { PRICE_SCALE, formatPrice, formatPriceChange, formatUsdc, parseUsdc } from '../format'
import { freeBankroll, reopenNeeds } from '../house'
import { claimFaucet } from '../near/relay'
import { fullAccessCall } from '../near/session'
import { useNear } from '../near/useNear'
import { useLobby, usePlayer, usePoll } from '../near/usePoll'
import { getTokenBalance, type DealerView, type PlayerView } from '../near/views'

/** `core_rules::SHARES_PER_UNIT`: one LP token (as shown) = what 1 tUSDC bought at launch. */
const SHARES_PER_UNIT = 1_000_000n

/** Money moves need the Privy (full-access) signature; NEAR wants 1 yocto on deposit and withdraw. */
const ONE_YOCTO = 1n

export function Pools() {
  const lobby = useLobby()
  const player = usePlayer()
  const { walletId, nearAccount, config } = useNear()
  const [params, setParams] = useSearchParams()
  const [action, setAction] = useState<ActionState>({ state: 'idle' })
  const selected = lobby.data?.find((d) => d.id === params.get('dealer')) ?? lobby.data?.[0] ?? null

  const run = async (label: string, receiver: string, method: string, args: object, deposit: bigint) => {
    if (!nearAccount) return
    setAction({ state: 'busy', label })
    try {
      const { txHash } = await fullAccessCall(nearAccount, config, receiver, method, args, deposit)
      setAction({ state: 'done', label, txHash })
    } catch (error) {
      setAction({ state: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      player.refresh()
      lobby.refresh()
    }
  }
  const busy = action.state === 'busy'

  return (
    <>
      <h1>Pools</h1>
      <p className="muted">
        Each dealer is a liquidity pool. Your tUSDC becomes the bankroll: the pool earns the edge on losing bets and pays
        the winning ones, so your LP tokens rise or fall in value.
      </p>
      {lobby.error ? <p className="loss">Could not load the pools: {lobby.error}</p> : null}
      <PoolTable dealers={lobby.data ?? []} player={player.data} onSelect={(id) => setParams({ dealer: id })} />

      {!walletId || !nearAccount ? (
        <LoginPrompt action="deposit and provide liquidity" />
      ) : (
        <>
          <ActionStatus action={action} />
          <Wallet
            player={player.data}
            busy={busy}
            onDeposit={(amount) =>
              void run('deposit', config.tokenContract, 'ft_transfer_call', { receiver_id: config.houseContract, amount: String(amount), msg: '' }, ONE_YOCTO)
            }
            onWithdraw={(amount) => void run('withdraw', config.houseContract, 'withdraw', { amount: String(amount) }, ONE_YOCTO)}
          />
          {selected ? (
            <Liquidity
              key={selected.id}
              dealer={selected}
              dealers={lobby.data ?? []}
              player={player.data}
              busy={busy}
              onSelect={(id) => setParams({ dealer: id })}
              onInvest={(amount) =>
                void run(`invest in ${selected.name}`, config.houseContract, 'invest', { dealer_id: selected.id, amount: String(amount) }, 0n)
              }
              onDivest={(shares) =>
                void run(`divest from ${selected.name}`, config.houseContract, 'divest', { dealer_id: selected.id, shares: String(shares) }, 0n)
              }
            />
          ) : null}
        </>
      )}
    </>
  )
}

function lpTokens(shares: string | bigint): string {
  return formatUsdc(BigInt(shares) / SHARES_PER_UNIT)
}

function PoolTable({ dealers, player, onSelect }: { dealers: DealerView[]; player: PlayerView | null; onSelect: (id: string) => void }) {
  const positions = new Map(player?.lp.map((p) => [p.dealer_id, p]))
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>dealer</th>
          <th>pool (free)</th>
          <th>LP buy / sell</th>
          <th>vs launch</th>
          <th>status</th>
          {player ? <th>my LP · value</th> : null}
          <th />
        </tr>
      </thead>
      <tbody>
        {dealers.map((dealer) => {
          const mine = positions.get(dealer.id)
          return (
            <tr key={dealer.id}>
              <td>
                {dealer.name} <span className="muted">{dealer.game}</span>
              </td>
              <td className="money">{formatUsdc(freeBankroll(dealer))}</td>
              <td>
                {formatPrice(dealer.share_price_buy)} / {formatPrice(dealer.share_price_sell)}
              </td>
              <td className={BigInt(dealer.share_price_sell) >= PRICE_SCALE ? 'win' : 'loss'}>
                {formatPriceChange(dealer.share_price_sell)}
              </td>
              <td className={dealer.open ? 'win' : 'loss'}>
                {dealer.open ? 'open' : `closed · needs ${formatUsdc(reopenNeeds(dealer))}`}
              </td>
              {player ? <td>{mine ? `${lpTokens(mine.shares)} · ${formatUsdc(mine.value)} tUSDC` : '—'}</td> : null}
              <td>
                <button type="button" className="ghost" onClick={() => onSelect(dealer.id)}>
                  {dealer.open ? 'Invest' : 'Rescue'}
                </button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

interface WalletProps {
  player: PlayerView | null
  busy: boolean
  onDeposit: (amount: bigint) => void
  onWithdraw: (amount: bigint) => void
}

function Wallet({ player, busy, onDeposit, onWithdraw }: WalletProps) {
  const { config, walletId } = useNear()
  const wallet = usePoll(
    useCallback(() => getTokenBalance(config.rpcUrl, config.tokenContract, walletId), [config, walletId]),
    5_000,
  )
  const [faucet, setFaucet] = useState('')
  const claim = async () => {
    setFaucet('claiming…')
    try {
      setFaucet(`+${formatUsdc(await claimFaucet(config.relayerUrl, walletId))} tUSDC in your wallet`)
      wallet.refresh()
    } catch (error) {
      setFaucet(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <section className="panel">
      <h2>Your money</h2>
      <p>
        in the house: <span className="money">{player ? formatUsdc(player.balance) : '—'} tUSDC</span> · in your wallet:{' '}
        <span className="money">{wallet.data ? formatUsdc(wallet.data) : '—'} tUSDC</span>{' '}
        <button type="button" className="ghost" onClick={() => void claim()}>
          Get test tUSDC
        </button>{' '}
        <span className="muted">{faucet}</span>
      </p>
      <AmountForm label="Deposit" max={wallet.data ? BigInt(wallet.data) : null} busy={busy} onSubmit={onDeposit} />
      <AmountForm label="Withdraw" max={player ? BigInt(player.balance) : null} busy={busy} onSubmit={onWithdraw} />
    </section>
  )
}

function AmountForm({ label, max, busy, onSubmit }: { label: string; max: bigint | null; busy: boolean; onSubmit: (amount: bigint) => void }) {
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
      <input placeholder="tUSDC" inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)} />
      <button type="button" className="ghost" disabled={max === null} onClick={() => max !== null && setText(formatUsdc(max, 0))}>
        max
      </button>
      <button type="submit" disabled={!valid || busy}>
        {label}
      </button>
    </form>
  )
}

interface LiquidityProps {
  dealer: DealerView
  dealers: DealerView[]
  player: PlayerView | null
  busy: boolean
  onSelect: (id: string) => void
  onInvest: (amount: bigint) => void
  onDivest: (shares: bigint) => void
}

function Liquidity({ dealer, dealers, player, busy, onSelect, onInvest, onDivest }: LiquidityProps) {
  const [investText, setInvestText] = useState('')
  const [divestText, setDivestText] = useState('')
  const owned = BigInt(player?.lp.find((p) => p.dealer_id === dealer.id)?.shares ?? '0')
  const balance = player ? BigInt(player.balance) : 0n
  const buyPrice = BigInt(dealer.share_price_buy)
  const sellPrice = BigInt(dealer.share_price_sell)

  const invest = parseUsdc(investText)
  const investValid = invest !== null && invest > 0n && invest <= balance
  // LP tokens are typed like tUSDC (6 decimals); "all" sends the exact share count, dust included.
  const divestTokens = divestText === 'all' ? owned : parseUsdc(divestText)
  const divestShares = divestText === 'all' ? owned : divestTokens === null ? null : divestTokens * SHARES_PER_UNIT
  const divestValid = divestShares !== null && divestShares > 0n && divestShares <= owned

  return (
    <section className="panel">
      <h2>
        Liquidity ·{' '}
        <select value={dealer.id} onChange={(event) => onSelect(event.target.value)}>
          {dealers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </h2>
      <p className="muted">
        Spread: you buy at {formatPrice(buyPrice)} (as if every open bet loses) and sell at {formatPrice(sellPrice)} (as if
        every open bet wins), so nobody can sell just before a known loss.
      </p>
      {!dealer.open ? (
        <p className="loss">
          Closed: {formatUsdc(reopenNeeds(dealer))} tUSDC reopens it. Rescuers buy at the bottom price and own most of the
          pool.
        </p>
      ) : null}
      <p>
        you hold <span className="money">{lpTokens(owned)}</span> LP tokens of {dealer.name}
      </p>
      <form
        className="amount-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (investValid) onInvest(invest)
        }}
      >
        <input placeholder="tUSDC" inputMode="decimal" value={investText} onChange={(event) => setInvestText(event.target.value)} />
        <button type="submit" disabled={!investValid || busy}>
          {dealer.open ? 'Invest' : 'Rescue'}
        </button>
        <span className="muted">
          {invest && buyPrice > 0n ? `≈ ${formatUsdc((invest * PRICE_SCALE) / buyPrice)} LP tokens` : 'from your house balance'}
        </span>
      </form>
      <form
        className="amount-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (divestValid) onDivest(divestShares)
        }}
      >
        <input placeholder="LP tokens" inputMode="decimal" value={divestText} onChange={(event) => setDivestText(event.target.value)} />
        <button type="button" className="ghost" disabled={owned === 0n} onClick={() => setDivestText('all')}>
          all
        </button>
        <button type="submit" disabled={!divestValid || busy}>
          Divest
        </button>
        <span className="muted">
          {divestShares && divestValid ? `≈ ${formatUsdc((divestShares * sellPrice) / SHARES_PER_UNIT / PRICE_SCALE)} tUSDC` : ''}
        </span>
      </form>
    </section>
  )
}
