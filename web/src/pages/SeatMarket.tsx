import { useCallback, useState } from 'react'
import { Link } from 'react-router'
import { ActionStatus, type ActionState } from '../components/ActionStatus'
import { LoginPrompt } from '../components/LoginPrompt'
import { formatUsdc, tokenSymbol } from '../format'
import { getFloorState } from '../near/floor'
import { fullAccessCall } from '../near/session'
import { useNear } from '../near/useNear'
import { PAGE_POLL_MS, usePlayer, usePoll } from '../near/usePoll'
import type { DealerView } from '../near/views'
import { isSeated, myTables, seatMarket, trafficMultiple } from '../tycoon'

export function SeatMarket() {
  const { config, walletId, nearAccount } = useNear()
  const loadFloor = useCallback(() => getFloorState(config), [config])
  const floor = usePoll(loadFloor, PAGE_POLL_MS)
  const player = usePlayer()
  const [buyer, setBuyer] = useState('')
  const [action, setAction] = useState<ActionState>({ state: 'idle' })

  const state = floor.data
  const rows = state ? seatMarket(state) : []
  // Only a table off the floor can take a bought seat (`buy_seat`).
  const offFloor = state && walletId ? myTables(state.dealers, player.data, walletId).filter((d) => !isSeated(state, d.id)) : []
  const buyWith = offFloor.find((d) => d.id === buyer) ?? offFloor[0] ?? null
  const balance = player.data ? BigInt(player.data.balance) : null

  /** `buy_seat` takes the 1-based seat; `max_price` = the ask shown, so a raised ask is refused. */
  const buy = (index: number, ask: string, dealer: DealerView) => {
    if (!nearAccount) return
    const label = `buy seat ${index + 1} for ${dealer.name}`
    setAction({ state: 'busy', label })
    const args = { seat: index + 1, dealer_id: dealer.id, max_price: ask }
    void fullAccessCall(nearAccount, config, config.houseContract, 'buy_seat', args, 0n)
      .then(({ txHash }) => setAction({ state: 'done', label, txHash }))
      .catch((error: unknown) => setAction({ state: 'error', message: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        floor.refresh()
        player.refresh()
      })
  }

  return (
    <>
      <h1>Seats</h1>
      <p className="muted">
        Six seats, seat 1 by the entrance: the closer to the door, the more gamblers walk past and the higher the
        minimum rent. A seated table's owner can sell its seat; the buyer's table takes it with its rent and prepaid time.
      </p>
      {state?.mock ? (
        <p className="loss">
          This contract ({config.houseContract}) has no seat market yet: the floor below is a preview built from the
          lobby.
        </p>
      ) : null}
      {floor.error ? <p className="loss">Could not load the floor: {floor.error}</p> : null}
      {!walletId || !nearAccount ? <LoginPrompt action="buy a seat" /> : null}
      {walletId && nearAccount && state ? (
        <BuyerPicker tables={offFloor} selected={buyWith} onSelect={setBuyer} />
      ) : null}
      <ActionStatus action={action} />
      <table className="grid">
        <thead>
          <tr>
            <th>seat</th>
            <th>traffic</th>
            <th>table</th>
            <th>rent / h</th>
            <th>for sale</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { ask } = row
            const showBuy = ask !== null && buyWith !== null && row.controller !== walletId
            const affordable = ask !== null && balance !== null && BigInt(ask) <= balance
            return (
              <tr key={row.index}>
                <td>{row.index + 1}</td>
                <td>{trafficMultiple(row.traffic_bp)}</td>
                <td>{row.dealer ? <Link to={`/table/${row.dealer.id}`}>{row.dealer.name}</Link> : <span className="muted">empty</span>}</td>
                <td className="money">{row.rent === null ? `from ${formatUsdc(row.min_rent)}` : formatUsdc(row.rent)}</td>
                <td>{row.ask === null ? <span className="muted">—</span> : <span className="money">{formatUsdc(row.ask)} {tokenSymbol()}</span>}</td>
                <td>
                  {showBuy ? (
                    <button
                      type="button"
                      title={affordable ? undefined : 'deposit more in Pools first'}
                      disabled={!affordable || action.state === 'busy'}
                      onClick={() => buy(row.index, ask, buyWith)}
                    >
                      Buy
                    </button>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

/** Which of my off-floor tables a bought seat goes to. */
function BuyerPicker({ tables, selected, onSelect }: { tables: DealerView[]; selected: DealerView | null; onSelect: (id: string) => void }) {
  if (tables.length === 0) {
    return (
      <p className="muted">
        To buy a seat you need a table off the floor: <Link to="/open">open one</Link> or manage yours in{' '}
        <Link to="/my-table">My table</Link>.
      </p>
    )
  }
  return (
    <p>
      buy for{' '}
      <select value={selected?.id ?? ''} onChange={(e) => onSelect(e.target.value)}>
        {tables.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>{' '}
      <span className="muted">the price comes from your house balance</span>
    </p>
  )
}
