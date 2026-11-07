import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch } from 'react'
import type { Config } from '../config'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Jackpot } from '../components/Jackpot'
import { TourOffer, TourPanel, useFootfalls, type TourFloor } from '../components/Tour'
import { formatBp, formatCountdown, formatPrice, formatPriceChange, formatUsdc } from '../format'
import { freeBankroll, reopenNeeds } from '../house'
import { devEvict, floorSeats, getFloorState, type FloorState, type SeatedTable } from '../near/floor'
import { useNear } from '../near/useNear'
import { PAGE_POLL_MS, usePoll } from '../near/usePoll'
import type { DealerView } from '../near/views'
import { createLobbyScene, type FloorFocus, type LobbySceneApi } from '../scene/lobby/LobbyScene'
import {
  diffGamblers,
  getLiveFloor,
  parseGamblerTimeline,
  toCues,
  type GamblerCue,
  type GamblerInfo,
  type GamblerSnapshot,
  type GamblerTimeline,
} from '../sim/gamblers'
import {
  currentStep,
  markTourSeen,
  pickChooser,
  pickGambler,
  pickTable,
  TOUR_HIDDEN,
  tourFocus,
  tourReducer,
  tourSeen,
  type TourAction,
  type TourState,
} from '../tour'
import { useNow } from '../useNow'

/** Dev demo `?evict=<id>`: wait this long after the floor appears, then play the seat change. */
const DEV_EVICT_DELAY_MS = 3_000
/** Live gamblers move every few seconds; their walk takes longer than a poll. */
const LIVE_GAMBLERS_POLL_MS = 2_000
/** Demo floor: one sim frame (10 simulated minutes) every this many ms, slow enough to walk. */
const DEMO_FRAME_MS = 6_000
/** The demo starts at the first frame with this many gamblers on the floor, so it is lively at once. */
const DEMO_START_CROWD = 4

export function Lobby() {
  const { config } = useNear()
  const load = useCallback(() => getFloorState(config), [config])
  const polled = usePoll(load, PAGE_POLL_MS)
  const state = useDevEviction(polled.data)
  const seats = useMemo(() => (state ? floorSeats(state) : null), [state])
  const seatedIds = useMemo(() => seats?.map((s) => s?.dealer.id ?? null) ?? null, [seats])
  const gamblers = useGamblerFloor(config, seatedIds)
  const [tour, dispatch] = useTour()
  const step = currentStep(tour)
  const gambler = useMemo(() => pickGambler(gamblers.gamblers), [gamblers.gamblers])
  const tableSeat = useMemo(() => (seats ? pickTable(seats) : null), [seats])
  const footfalls = useFootfalls(step && gamblers.live ? config.sessionUrl : '', seats)
  const chooser = useMemo(() => pickChooser(gambler, footfalls), [gambler, footfalls])
  const chooserSeat = chooser && seatedIds ? seatedIds.indexOf(chooser.dealer_id) : -1
  const focus = step ? tourFocus(step, { chooserSeat: chooserSeat >= 0 ? chooserSeat : null, tableSeat }) : null
  const tourFloor: TourFloor = {
    state,
    seats,
    gamblers: gamblers.gamblers,
    live: gamblers.live,
    sessionUrl: config.sessionUrl,
    houseContract: config.houseContract,
    gambler,
    chooser,
    footfalls,
    tableSeat,
  }
  return (
    <>
      <h1>Lobby</h1>
      <p className="muted">
        Six seats on the floor, rented by the hour. Every dealer is a liquidity pool: pick the table with the offer you
        like, back a dealer in Pools, or <Link to="/open">open your own table</Link>.
      </p>
      {polled.error ? <p className="loss">Could not load the floor: {polled.error}</p> : null}
      {state === null && !polled.error ? <p className="muted">loading tables…</p> : null}
      {state ? (
        <Jackpot amount={state.floor.jackpot} oddsUnit={state.floor.jackpot_odds_unit} mock={state.mock} pulse={step === 'jackpot'} />
      ) : null}
      <div className="floor-stage">
        <CasinoFloor seats={seats} rentFrom={state?.floor.outbid_min ?? null} cues={gamblers.cues} focus={focus} />
        {tour.kind === 'offered' ? <TourOffer dispatch={dispatch} /> : null}
        <TourPanel tour={tour} dispatch={dispatch} floor={tourFloor} />
      </div>
      <p className="muted floor-mode">{gamblers.label}</p>
      {state && seats ? <DealerList dealers={state.dealers} seats={seats} /> : null}
    </>
  )
}

/**
 * The guided tour: offered once on a first visit, started by `?tour=1` (the top bar's button).
 * Starting or dismissing it is remembered, so the offer never nags.
 */
function useTour(): [TourState, Dispatch<TourAction>] {
  const [tour, rawDispatch] = useReducer(tourReducer, TOUR_HIDDEN)
  const dispatch = useCallback((action: TourAction) => {
    if (action.type === 'start' || action.type === 'close') markTourSeen(window.localStorage)
    rawDispatch(action)
  }, [])
  const [params, setParams] = useSearchParams()
  const asked = params.get('tour') === '1'

  useEffect(() => {
    if (!tourSeen(window.localStorage)) dispatch({ type: 'offer' })
  }, [dispatch])

  useEffect(() => {
    if (!asked) return
    dispatch({ type: 'start' })
    // Drop the query so the top bar's button starts the tour again on the next click.
    setParams(
      (current) => {
        current.delete('tour')
        return current
      },
      { replace: true },
    )
  }, [asked, setParams, dispatch])

  // The tour plays over the jackpot and the floor: bring both into view when it starts.
  useEffect(() => {
    if (tour.kind === 'step') document.querySelector('.jackpot')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [tour.kind])
  return [tour, dispatch]
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
interface CasinoFloorProps {
  seats: (SeatedTable | null)[] | null
  rentFrom: string | null
  cues: GamblerCues
  /** The tour's camera shot; null = the idle drift. */
  focus: FloorFocus | null
}

function CasinoFloor({ seats, rentFrom, cues, focus }: CasinoFloorProps) {
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

  // Gamblers walk to tables: they wait until the floor has its tables.
  useEffect(() => {
    if (seats) scene.current?.cueGamblers(cues.list)
  }, [cues, seats])

  // Only sets the camera's target: the same shot again changes nothing.
  useEffect(() => {
    scene.current?.focus(focus)
  }, [focus])

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

// ---- NPC gamblers ---------------------------------------------------------------------------

/** A fresh object per batch, so the same cues are never replayed by a re-render. */
interface GamblerCues {
  list: readonly GamblerCue[]
}

interface GamblerFloor {
  cues: GamblerCues
  label: string
  /** On the floor now, names and personas filled in (the sim keeps them apart from its frames). */
  gamblers: GamblerSnapshot[]
  live: boolean
}

const NO_CUES: GamblerCues = { list: [] }

/**
 * The gamblers on the floor: live from the session server's gambler runner when it answers, else
 * the simulated week of sim.json replayed as a demo floor. Emits the steps between snapshots.
 */
function useGamblerFloor(config: Config, seatedIds: readonly (string | null)[] | null): GamblerFloor {
  const [snapshot, setSnapshot] = useState<{ gamblers: GamblerSnapshot[]; info: ReadonlyMap<string, GamblerInfo> } | null>(null)
  const [mode, setMode] = useState<'live' | 'demo' | 'none'>(config.sessionUrl ? 'live' : 'demo')
  const [label, setLabel] = useState('')

  useEffect(() => {
    if (mode !== 'live') return
    let stopped = false
    const poll = async (): Promise<void> => {
      try {
        const gamblers = await getLiveFloor(config.sessionUrl)
        if (!stopped) setSnapshot({ gamblers, info: new Map() })
        if (!stopped) setLabel(`live floor · ${gamblers.length} gamblers`)
      } catch {
        // The runner is down or not deployed yet: the floor stays watchable with the sim.
        if (!stopped) setMode('demo')
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), LIVE_GAMBLERS_POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [mode, config.sessionUrl])

  useEffect(() => {
    if (mode !== 'demo') return
    let timer = 0
    let stopped = false
    void loadTimeline().then(
      (timeline) => {
        if (stopped) return
        if (!timeline) {
          setMode('none')
          return
        }
        const info = new Map(timeline.gamblers.map((g) => [g.id, g]))
        let index = Math.max(0, timeline.frames.findIndex((f) => f.gamblers.length >= DEMO_START_CROWD))
        const show = (): void => {
          const frame = timeline.frames[index]
          setSnapshot({ gamblers: frame.gamblers, info })
          setLabel(`demo floor · simulated gamblers, day ${Math.floor(frame.t / 86_400) + 1} ${clock(frame.t)}`)
          index = (index + 1) % timeline.frames.length
        }
        show()
        timer = window.setInterval(show, DEMO_FRAME_MS)
      },
      () => {
        if (!stopped) setMode('none')
      },
    )
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [mode])

  useEffect(() => {
    if (mode === 'none') setLabel('no gamblers on the floor: the gambler runner is offline and sim.json has none')
  }, [mode])

  // Through a ref: a floor poll alone must not replay the moves of the last snapshot.
  const seated = useRef(seatedIds)
  seated.current = seatedIds
  const previous = useRef<GamblerSnapshot[]>([])
  const [cues, setCues] = useState<GamblerCues>(NO_CUES)
  useEffect(() => {
    const ids = seated.current
    // Before the tables are known, nobody can walk to one: the next snapshot starts the crowd.
    if (!snapshot || !ids) return
    const moves = diffGamblers(previous.current, snapshot.gamblers)
    previous.current = snapshot.gamblers
    setCues({ list: toCues(moves, snapshot.gamblers, snapshot.info, ids) })
  }, [snapshot])
  const gamblers = useMemo(
    () =>
      snapshot?.gamblers.map((g) => {
        const known = snapshot.info.get(g.id)
        return { ...g, name: g.name ?? known?.name ?? null, persona: g.persona ?? known?.persona ?? null }
      }) ?? [],
    [snapshot],
  )
  return { cues, label, gamblers, live: mode === 'live' && snapshot !== null }
}

async function loadTimeline(): Promise<GamblerTimeline | null> {
  const response = await fetch('/sim.json')
  if (!response.ok) throw new Error(`sim.json: HTTP ${response.status}`)
  return parseGamblerTimeline(await response.json())
}

function clock(t: number): string {
  const minutes = Math.floor((t % 86_400) / 60)
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}
