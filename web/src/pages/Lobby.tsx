import { useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router'
import { formatBp, formatCountdown, formatPrice, formatPriceChange, formatUsdc } from '../format'
import { freeBankroll, reopenNeeds } from '../house'
import { useLobby } from '../near/usePoll'
import type { DealerView } from '../near/views'
import { createLobbyScene, type LobbySceneApi } from '../scene/lobby/LobbyScene'
import { useNow } from '../useNow'

export function Lobby() {
  const lobby = useLobby()
  return (
    <>
      <h1>Lobby</h1>
      <p className="muted">
        Every dealer is a liquidity pool. Pick the table with the offer you like, or back a dealer in Pools.
      </p>
      {lobby.error ? <p className="loss">Could not load the lobby: {lobby.error}</p> : null}
      {lobby.data === null && !lobby.error ? <p className="muted">loading tables…</p> : null}
      <CasinoFloor dealers={lobby.data} />
      {lobby.data ? <DealerList dealers={lobby.data} /> : null}
    </>
  )
}

/** The 3D floor; decorative for assistive tech, the list below carries the same information. */
function CasinoFloor({ dealers }: { dealers: DealerView[] | null }) {
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<LobbySceneApi | null>(null)
  const latest = useRef(dealers)
  latest.current = dealers
  const navigate = useNavigate()
  // Through a ref: `navigate` is not guaranteed stable, and the scene must not be rebuilt for it.
  const go = useRef(navigate)
  go.current = navigate

  useEffect(() => {
    if (!host.current) return
    const api = createLobbyScene(host.current, (id) => void go.current(`/table/${id}`))
    scene.current = api
    if (latest.current) api.setDealers(latest.current)
    return () => {
      scene.current = null
      api.dispose()
    }
  }, [])

  useEffect(() => {
    if (dealers) scene.current?.setDealers(dealers)
  }, [dealers])

  return <div className="casino-floor" ref={host} aria-hidden="true" />
}

function DealerList({ dealers }: { dealers: DealerView[] }) {
  return (
    <table className="grid dealer-list">
      <caption className="muted">Tables</caption>
      <thead>
        <tr>
          <th scope="col">dealer</th>
          <th scope="col">game</th>
          <th scope="col">edge</th>
          <th scope="col">max bet</th>
          <th scope="col">pool</th>
          <th scope="col">boost</th>
          <th scope="col">LP price</th>
          <th scope="col">table</th>
        </tr>
      </thead>
      <tbody>
        {dealers.map((dealer) => (
          <DealerRow key={dealer.id} dealer={dealer} />
        ))}
      </tbody>
    </table>
  )
}

function DealerRow({ dealer }: { dealer: DealerView }) {
  const now = useNow()
  const boostLeft = formatCountdown(dealer.boost_until - now)
  const price = dealer.share_price_buy
  return (
    <tr className={dealer.open ? undefined : 'closed'}>
      <th scope="row">
        {dealer.name} <span className="muted">· {dealer.temperament}</span>
      </th>
      <td>{dealer.game}</td>
      <td title={dealer.reason_text}>
        {formatBp(dealer.total_edge_bp)} <span className="reason">{dealer.reason_text}</span>
      </td>
      <td className="money">{formatUsdc(dealer.max_bet)}</td>
      <td className="money">{formatUsdc(freeBankroll(dealer))}</td>
      <td className={boostLeft ? 'win' : 'muted'}>{boostLeft ? `${boostLeft} left` : 'none'}</td>
      <td>
        {formatPrice(price)}{' '}
        <span className={BigInt(price) >= 1_000_000n ? 'win' : 'loss'}>{formatPriceChange(price)}</span>
      </td>
      <td>
        {dealer.open ? (
          <Link className="button" to={`/table/${dealer.id}`}>
            Play
          </Link>
        ) : (
          <Link className="button" to={`/pools?dealer=${dealer.id}`} title={`needs ${formatUsdc(reopenNeeds(dealer))} tUSDC`}>
            Rescue
          </Link>
        )}
      </td>
    </tr>
  )
}
