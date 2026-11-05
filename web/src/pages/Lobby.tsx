import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Jackpot } from '../components/Jackpot'
import { formatBp, formatCountdown, formatPrice, formatPriceChange, formatUsdc } from '../format'
import { freeBankroll, reopenNeeds } from '../house'
import { devEvict, floorSeats, getFloorState, type FloorState, type SeatedTable } from '../near/floor'
import { useNear } from '../near/useNear'
import { PAGE_POLL_MS, usePoll } from '../near/usePoll'
import type { DealerView } from '../near/views'
import { createLobbyScene, type LobbySceneApi } from '../scene/lobby/LobbyScene'
import { useNow } from '../useNow'

/** Dev demo `?evict=<id>`: wait this long after the floor appears, then play the seat change. */
const DEV_EVICT_DELAY_MS = 3_000

export function Lobby() {
  const { config } = useNear()
  const load = useCallback(() => getFloorState(config), [config])
  const polled = usePoll(load, PAGE_POLL_MS)
  const state = useDevEviction(polled.data)
  const seats = useMemo(() => (state ? floorSeats(state) : null), [state])
  return (
    <>
      <h1>Lobby</h1>
      <p className="muted">
        Six seats on the floor, rented by the hour. Every dealer is a liquidity pool: pick the table with the offer you
        like, back a dealer in Pools, or <Link to="/open">open your own table</Link>.
      </p>
      {polled.error ? <p className="loss">Could not load the floor: {polled.error}</p> : null}
      {state === null && !polled.error ? <p className="muted">loading tables…</p> : null}
      {state ? <Jackpot amount={state.floor.jackpot} oddsUnit={state.floor.jackpot_odds_unit} mock={state.mock} /> : null}
      <CasinoFloor seats={seats} rentFrom={state?.floor.outbid_min ?? null} />
      {state && seats ? <DealerList dealers={state.dealers} seats={seats} /> : null}
    </>
  )
}

/** Dev builds only, on mock data only (see `devEvict`); production ignores the query. */
function useDevEviction(state: FloorState | null): FloorState | null {
  const [params] = useSearchParams()
  const evictId = import.meta.env.DEV ? params.get('evict') : null
  const [armed, setArmed] = useState(false)
  const loaded = state !== null
  useEffect(() => {
    if (!evictId || !loaded) return
    const timer = window.setTimeout(() => setArmed(true), DEV_EVICT_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [evictId, loaded])
  return useMemo(() => (state && evictId && armed ? devEvict(state, evictId) : state), [state, evictId, armed])
}

/** The 3D floor; decorative for assistive tech, the list below carries the same information. */
function CasinoFloor({ seats, rentFrom }: { seats: (SeatedTable | null)[] | null; rentFrom: string | null }) {
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<LobbySceneApi | null>(null)
  const latest = useRef({ seats, rentFrom })
  latest.current = { seats, rentFrom }
  const navigate = useNavigate()
  // Through a ref: `navigate` is not guaranteed stable, and the scene must not be rebuilt for it.
  const go = useRef(navigate)
  go.current = navigate

  useEffect(() => {
    if (!host.current) return
    const api = createLobbyScene(host.current, {
      onTable: (id) => void go.current(`/table/${id}`),
      onEmptySeat: () => void go.current('/open'),
    })
    scene.current = api
    const first = latest.current
    if (first.seats && first.rentFrom !== null) api.setFloor(first.seats, first.rentFrom)
    return () => {
      scene.current = null
      api.dispose()
    }
  }, [])

  useEffect(() => {
    if (seats && rentFrom !== null) scene.current?.setFloor(seats, rentFrom)
  }, [seats, rentFrom])

  return <div className="casino-floor" ref={host} aria-hidden="true" />
}

interface SeatInfo {
  seat: number
  rent: string
  playerOwned: boolean
}

function DealerList({ dealers, seats }: { dealers: DealerView[]; seats: (SeatedTable | null)[] }) {
  const seatOf = new Map<string, SeatInfo>()
  seats.forEach((s, i) => {
    if (s) seatOf.set(s.dealer.id, { seat: i + 1, rent: s.rent, playerOwned: s.playerOwned })
  })
  return (
    <table className="grid dealer-list">
      <caption className="muted">Tables</caption>
      <thead>
        <tr>
          <th scope="col">dealer</th>
          <th scope="col">game</th>
          <th scope="col">seat · rent</th>
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
          <DealerRow key={dealer.id} dealer={dealer} seat={seatOf.get(dealer.id) ?? null} />
        ))}
      </tbody>
    </table>
  )
}

function DealerRow({ dealer, seat }: { dealer: DealerView; seat: SeatInfo | null }) {
  const now = useNow()
  const boostLeft = formatCountdown(dealer.boost_until - now)
  const price = dealer.share_price_buy
  return (
    <tr className={dealer.open && seat ? undefined : 'closed'}>
      <th scope="row">
        {dealer.name} <span className="muted">· {dealer.temperament}</span>
        {seat?.playerOwned ? <span className="badge">player-owned</span> : null}
      </th>
      <td>{dealer.game}</td>
      <td>{seat ? `seat ${seat.seat} · ${formatUsdc(seat.rent)}/h` : <span className="muted">off the floor</span>}</td>
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
        {dealer.open && seat ? (
          <Link className="button" to={`/table/${dealer.id}`}>
            Play
          </Link>
        ) : dealer.open ? (
          <span className="muted">no seat: no bets</span>
        ) : (
          <Link className="button" to={`/pools?dealer=${dealer.id}`} title={`needs ${formatUsdc(reopenNeeds(dealer))} tUSDC`}>
            Rescue
          </Link>
        )}
      </td>
    </tr>
  )
}
