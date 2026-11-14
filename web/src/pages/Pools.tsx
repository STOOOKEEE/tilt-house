import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { ActionStatus, type ActionState } from '../components/ActionStatus'
import { YourMoney } from '../components/YourMoney'
import { PRICE_SCALE, formatPrice, formatPriceChange, formatUsdc, parseUsdc, tokenSymbol } from '../format'
import { freeBankroll, reopenNeeds } from '../house'
import { fullAccessCall } from '../near/session'
import { useNear } from '../near/useNear'
import { useLobby, usePlayer } from '../near/usePoll'
import type { DealerView, PlayerView } from '../near/views'

/** `core_rules::SHARES_PER_UNIT`: one LP token (as shown) = what 1 tUSDC bought at launch. */
const SHARES_PER_UNIT = 1_000_000n

export function Pools() {
  const lobby = useLobby()
  const player = usePlayer()
  const { walletId, nearAccount, config } = useNear()
  const [params, setParams] = useSearchParams()
  const [action, setAction] = useState<ActionState>({ state: 'idle' })
  const selected = lobby.data?.find((d) => d.id === params.get('dealer')) ?? lobby.data?.[0] ?? null

  const poolCall = async (label: string, method: string, args: object) => {
    if (!nearAccount) return
    setAction({ state: 'busy', label })
    try {
      const { txHash } = await fullAccessCall(nearAccount, config, config.houseContract, method, args, 0n)
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
      <h1>Back a table</h1>
      <YourMoney
        player={player.data}
        onChange={() => {
          player.refresh()
          lobby.refresh()
        }}
      />
      <h2>Invest in a table</h2>
      <p className="muted">
        Buying LP shares is investing in a table's bankroll, the money that pays its winners. It is not needed to play or
        to run a table. Shares gain when the table's players lose, and drop when they win.
      </p>
      {lobby.error ? <p className="loss">Could not load the tables: {lobby.error}</p> : null}
      <PoolTable dealers={lobby.data ?? []} player={player.data} onSelect={(id) => setParams({ dealer: id })} />
      {walletId && nearAccount && selected ? (
        <>
          <ActionStatus action={action} />
          <Liquidity
            key={selected.id}
            dealer={selected}
            dealers={lobby.data ?? []}
            player={player.data}
            busy={busy}
            onSelect={(id) => setParams({ dealer: id })}
            onInvest={(amount) => void poolCall(`invest in ${selected.name}`, 'invest', { dealer_id: selected.id, amount: String(amount) })}
            onDivest={(shares) => void poolCall(`divest from ${selected.name}`, 'divest', { dealer_id: selected.id, shares: String(shares) })}
          />
        </>
      ) : null}
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
              {player ? <td>{mine ? `${lpTokens(mine.shares)} · ${formatUsdc(mine.value)} ${tokenSymbol()}` : '—'}</td> : null}
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
        Back{' '}
        <select value={dealer.id} onChange={(event) => onSelect(event.target.value)}>
          {dealers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </h2>
      <p className="muted">
        You buy at {formatPrice(buyPrice)} and sell at {formatPrice(sellPrice)}. The gap stops anyone selling just before a
        known loss.
      </p>
      {!dealer.open ? (
        <p className="loss">
          Closed: {formatUsdc(reopenNeeds(dealer))} {tokenSymbol()} reopens it. Rescuers buy at the bottom price and own most of the
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
        <input placeholder={tokenSymbol()} inputMode="decimal" value={investText} onChange={(event) => setInvestText(event.target.value)} />
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
          {divestShares && divestValid ? `≈ ${formatUsdc((divestShares * sellPrice) / SHARES_PER_UNIT / PRICE_SCALE)} ${tokenSymbol()}` : ''}
        </span>
      </form>
    </section>
  )
}
