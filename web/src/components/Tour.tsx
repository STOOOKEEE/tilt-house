// "How the house works": the tour's card over the 3D floor. Each step shows live numbers from the
// floor and the gamblers (the sim.json demo floor when the gambler runner is offline).
import { useEffect, useMemo, useState, type Dispatch, type ReactNode } from 'react'
import { Link } from 'react-router'
import { formatBp, formatUsdc, shortHex } from '../format'
import { freeBankroll } from '../house'
import { SEAT_TRAFFIC_BP, type FloorState, type SeatedTable } from '../near/floor'
import { verifySession } from '../near/session-client'
import { getFootfall, type FootfallReply, type GamblerSnapshot } from '../sim/gamblers'
import {
  comparedOffers,
  GAMBLER_MAX_BALANCE,
  GAMBLER_SALARY_PER_HOUR,
  playFairDemo,
  rentPerHour,
  tamperedRounds,
  TOUR_STEPS,
  type Chooser,
  type TourAction,
  type TourState,
} from '../tour'
import { useNow } from '../useNow'

const EXPLORER_ACCOUNT = 'https://testnet.nearblocks.io/address/'
/** The traffic bar grows one em per this much traffic (1.5× → 6 em). */
const TRAFFIC_BP_PER_EM = 2_500
/** A dice roll is 0..9999: shown as 0.00..99.99, under 50 wins in the demo. */
const DEMO_WIN_BELOW = 5_000

export interface TourFloor {
  state: FloorState | null
  seats: readonly (SeatedTable | null)[] | null
  gamblers: readonly GamblerSnapshot[]
  /** Gamblers come from the live runner (real wallets), not the sim.json demo. */
  live: boolean
  sessionUrl: string
  houseContract: string
  gambler: GamblerSnapshot | null
  chooser: Chooser | null
  footfalls: ReadonlyMap<string, FootfallReply>
  tableSeat: number | null
}

export function TourOffer({ dispatch }: { dispatch: Dispatch<TourAction> }) {
  return (
    <div className="tour-card tour-offer" role="dialog" aria-label="Tour offer">
      <strong>New in the house?</strong>
      <span>One minute, seven stops: how gamblers, tables, rent and the jackpot fit together.</span>
      <div className="tour-actions">
        <button type="button" onClick={() => dispatch({ type: 'start' })}>
          Show me
        </button>
        <button type="button" className="ghost" onClick={() => dispatch({ type: 'close' })}>
          Not now
        </button>
      </div>
    </div>
  )
}

export function TourPanel({ tour, dispatch, floor }: { tour: TourState; dispatch: Dispatch<TourAction>; floor: TourFloor }) {
  useTourKeys(tour.kind === 'step', dispatch)
  if (tour.kind !== 'step') return null
  const index = tour.index
  const last = index === TOUR_STEPS.length - 1
  const step = STEP_VIEWS[TOUR_STEPS[index]]
  return (
    <div className="tour-card tour-panel" role="dialog" aria-label={`Tour step ${index + 1}: ${step.title}`}>
      <div className="tour-head">
        <span className="tour-count">
          {index + 1} / {TOUR_STEPS.length}
        </span>
        <button type="button" className="ghost tour-close" aria-label="Close the tour" onClick={() => dispatch({ type: 'close' })}>
          ✕
        </button>
      </div>
      <h2>{step.title}</h2>
      <p className="tour-caption">{step.caption}</p>
      <step.Body floor={floor} dispatch={dispatch} />
      <div className="tour-nav">
        <div className="tour-dots">
          {TOUR_STEPS.map((id, i) => (
            <button
              key={id}
              type="button"
              className={i === index ? 'tour-dot on' : 'tour-dot'}
              aria-label={`Go to step ${i + 1}`}
              onClick={() => dispatch({ type: 'go', index: i })}
            />
          ))}
        </div>
        <button type="button" className="ghost" disabled={index === 0} onClick={() => dispatch({ type: 'back' })}>
          ← Back
        </button>
        <button type="button" onClick={() => dispatch({ type: 'next' })}>
          {last ? 'Done' : 'Next →'}
        </button>
      </div>
    </div>
  )
}

/** ← → step through, Esc closes; ignored while typing. */
function useTourKeys(active: boolean, dispatch: Dispatch<TourAction>): void {
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey) return
      const action: TourAction | null =
        event.key === 'ArrowRight' ? { type: 'next' } : event.key === 'ArrowLeft' ? { type: 'back' } : event.key === 'Escape' ? { type: 'close' } : null
      if (!action) return
      event.preventDefault()
      dispatch(action)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, dispatch])
}

interface BodyProps {
  floor: TourFloor
  dispatch: Dispatch<TourAction>
}

const STEP_VIEWS: Record<(typeof TOUR_STEPS)[number], { title: string; caption: ReactNode; Body: (props: BodyProps) => ReactNode }> = {
  walk_in: {
    title: 'Gamblers walk in',
    caption: (
      <>
        The customers are NPC gamblers, each with its own NEAR wallet. The house pays them a salary of{' '}
        {formatUsdc(GAMBLER_SALARY_PER_HOUR, 0)} tUSDC an hour (up to {formatUsdc(GAMBLER_MAX_BALANCE, 0)}): the only
        money that enters the economy.
      </>
    ),
    Body: WalkInBody,
  },
  compare: {
    title: 'They shop for the best table',
    caption: 'Every gambler scores every table on the floor: edge, max bet, boosts, the walk from the door. Then it picks one.',
    Body: CompareBody,
  },
  pools: {
    title: 'Every table is a liquidity pool',
    caption: 'The pool banks every bet and earns the edge. Players or NPC dealers own the tables; anyone can back one and share the profit.',
    Body: PoolBody,
  },
  seats: {
    title: 'Location, location',
    caption: `Seat 1 is by the door and sees ${SEAT_TRAFFIC_BP[0] / 10_000}× the passers-by, so it rents for more. Floor full? Outbid the cheapest seat by 10 % and it is yours.`,
    Body: SeatsBody,
  },
  jackpot: {
    title: 'Rent fills the jackpot',
    caption: 'Every tUSDC of rent goes into one pot, and every settled bet has a shot at all of it. Money comes back to the players.',
    Body: JackpotBody,
  },
  fair: {
    title: 'Provably fair, every round',
    caption: 'Sit down and the server commits to a secret seed (its hash goes on chain). Play. Leave, the seed is revealed, and your browser replays every round.',
    Body: FairBody,
  },
  your_move: {
    title: 'Your move',
    caption: 'Run a table, back a dealer, or try your luck. Testnet tUSDC, real rules.',
    Body: YourMoveBody,
  },
}

function WalkInBody({ floor }: BodyProps) {
  const g = floor.gambler
  const parent = floor.houseContract.split('.').slice(1).join('.')
  const account = g && floor.live && parent ? `${g.id}.${parent}` : null
  return (
    <div className="tour-data">
      <span className="muted">
        {floor.gamblers.length} on the floor now · {floor.live ? 'live' : 'demo week from sim.json'}
      </span>
      {g ? (
        <div className="tour-gambler">
          <span>
            <strong>{g.name ?? g.id}</strong> <span className="muted">· {(g.persona ?? 'tourist').replace('_', ' ')}</span>
          </span>
          <span>
            wallet{' '}
            {account ? (
              <a href={`${EXPLORER_ACCOUNT}${account}`} target="_blank" rel="noreferrer">
                {account}
              </a>
            ) : (
              <span className="muted">simulated</span>
            )}
          </span>
          <span>
            balance <span className="money">{formatUsdc(g.balance)} tUSDC</span>
          </span>
        </div>
      ) : (
        <span className="muted">The floor is quiet right now: the next gambler is on its way.</span>
      )}
    </div>
  )
}

function CompareBody({ floor }: BodyProps) {
  const chooser = floor.chooser
  const now = useNow()
  const offers = useMemo(
    () => (chooser && floor.seats ? comparedOffers(floor.seats, chooser, floor.footfalls, now) : []),
    [chooser, floor.seats, floor.footfalls, now],
  )
  if (!chooser) return <p className="muted">Nobody is choosing right now: watch the bubbles on the floor.</p>
  const scored = offers.some((o) => o.score !== null)
  const who = chooser.name ?? `a ${(chooser.persona ?? 'gambler').replace('_', ' ')}, this hour`
  return (
    <div className="tour-data">
      <blockquote className="tour-bubble">
        “{chooser.reason}” <span className="muted">— {who}</span>
      </blockquote>
      <table className="grid tour-offers">
        <thead>
          <tr>
            <th scope="col">table</th>
            <th scope="col">edge</th>
            <th scope="col">max bet</th>
            {scored ? <th scope="col">score</th> : null}
          </tr>
        </thead>
        <tbody>
          {offers.map((o) => (
            <tr key={o.dealerId} className={o.chosen ? 'tour-chosen' : undefined}>
              <th scope="row">
                {o.chosen ? '▶ ' : ''}
                {o.name} <span className="muted">· {o.game}</span>
                {o.boosted ? <span className="badge">boost</span> : null}
              </th>
              <td>{formatBp(o.edgeBp)}</td>
              <td className="money">{formatUsdc(o.maxBet)}</td>
              {scored ? <td>{o.score === null ? '—' : Math.round(o.score)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The last hour at each seated table, for the scores live gamblers gave them; empty without a session URL. */
export function useFootfalls(sessionUrl: string, seats: readonly (SeatedTable | null)[] | null): ReadonlyMap<string, FootfallReply> {
  const [footfalls, setFootfalls] = useState<ReadonlyMap<string, FootfallReply>>(new Map())
  const ids = useMemo(() => (seats ?? []).flatMap((s) => (s ? [s.dealer.id] : [])).join(','), [seats])
  useEffect(() => {
    if (!sessionUrl || !ids) return
    let stopped = false
    // Scores only add detail: a table whose footfall fails just shows "—".
    void Promise.allSettled(ids.split(',').map((id) => getFootfall(sessionUrl, id))).then((results) => {
      if (stopped) return
      setFootfalls(new Map(results.flatMap((r) => (r.status === 'fulfilled' ? [[r.value.dealer_id, r.value] as const] : []))))
    })
    return () => {
      stopped = true
    }
  }, [sessionUrl, ids])
  return footfalls
}

function PoolBody({ floor }: BodyProps) {
  const seat = floor.tableSeat
  const table = seat === null ? null : floor.seats?.[seat]
  if (!table || seat === null) return <p className="muted">No open table on the floor right now.</p>
  const d = table.dealer
  const owner = floor.state?.floor.seats[seat]?.controller ?? d.controller
  return (
    <div className="tour-data tour-facts">
      <span>
        <strong>{d.name}</strong> <span className="muted">· {d.game} · seat {seat + 1}</span>
        {table.playerOwned ? <span className="badge">player-owned</span> : null}
      </span>
      <span>
        pool <span className="money">{formatUsdc(freeBankroll(d))} tUSDC</span>
      </span>
      <span>edge {formatBp(d.total_edge_bp)}</span>
      <span>
        owner {owner ?? <span className="muted">unknown</span>} <span className="muted">({table.playerOwned ? 'a player' : 'NPC dealer'})</span>
      </span>
      <Link to={`/pools?dealer=${d.id}`}>Back {d.name} in Pools →</Link>
    </div>
  )
}

function SeatsBody({ floor }: BodyProps) {
  const seats = floor.state?.floor.seats ?? []
  if (seats.length === 0) return <p className="muted">loading seats…</p>
  return (
    <table className="grid tour-offers">
      <thead>
        <tr>
          <th scope="col">seat</th>
          <th scope="col">traffic</th>
          <th scope="col">rent / h</th>
          <th scope="col">table</th>
        </tr>
      </thead>
      <tbody>
        {seats.map((s) => (
          <tr key={s.seat}>
            <th scope="row">{s.seat === 0 ? '1 · door' : s.seat + 1}</th>
            <td className="traffic">
              <span className="traffic-bar" style={{ width: `${s.traffic_bp / TRAFFIC_BP_PER_EM}em` }} />×{(s.traffic_bp / 10_000).toFixed(1)}
            </td>
            <td className="money">{formatUsdc(s.dealer_id ? s.rent_per_hour : s.min_rent)}</td>
            <td>{s.dealer_id ?? <span className="muted">for rent</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function JackpotBody({ floor }: BodyProps) {
  const jackpot = floor.state?.floor
  if (!jackpot || !floor.seats) return <p className="muted">loading the jackpot…</p>
  return (
    <div className="tour-data tour-facts">
      <span>
        in the pot <span className="money">{formatUsdc(jackpot.jackpot)} tUSDC</span>
      </span>
      <span>
        rent flowing in <span className="money">+{formatUsdc(rentPerHour(floor.seats))} tUSDC/h</span>
      </span>
      <span className="muted">a 1 tUSDC bet: 1 chance in {formatUsdc(jackpot.jackpot_odds_unit, 0)} to win it all</span>
    </div>
  )
}

function FairBody() {
  const [seed] = useState(() => crypto.getRandomValues(new Uint8Array(32)))
  const demo = useMemo(() => playFairDemo(seed, 'your-lucky-seed'), [seed])
  const [revealed, setRevealed] = useState(false)
  const [cheat, setCheat] = useState(false)
  const result = useMemo(
    () => (revealed ? verifySession(demo.serverSeed, demo.ticket, cheat ? tamperedRounds(demo.rounds) : demo.rounds, demo.state) : null),
    [revealed, cheat, demo],
  )
  return (
    <ol className="tour-data tour-fair">
      <li>
        commit <code>{shortHex(demo.ticket.server_seed_hash)}</code>
      </li>
      <li>
        play{' '}
        {(cheat ? tamperedRounds(demo.rounds) : demo.rounds).map((r) => {
          const roll = 'dice' in r.outcome ? r.outcome.dice.roll : 0
          return (
            <span key={r.nonce} className={roll < DEMO_WIN_BELOW ? 'win' : 'loss'}>
              {(roll / 100).toFixed(2)}{' '}
            </span>
          )
        })}
        <span className="muted">(under 50 wins)</span>
      </li>
      <li>
        {revealed ? (
          <>
            reveal <code>{shortHex(demo.serverSeed)}</code>
          </>
        ) : (
          <button type="button" onClick={() => setRevealed(true)}>
            Leave the table and reveal
          </button>
        )}
      </li>
      {result ? (
        <li>
          {result.ok ? (
            <span className="win">✓ verified: {result.summary.rounds} rounds replay bit for bit</span>
          ) : (
            <span className="loss">✗ caught: {result.error}</span>
          )}{' '}
          <button type="button" className="ghost" onClick={() => setCheat((c) => !c)}>
            {cheat ? 'Undo the cheat' : 'Try to cheat a roll'}
          </button>
        </li>
      ) : null}
    </ol>
  )
}

function YourMoveBody({ floor, dispatch }: BodyProps) {
  const seat = floor.tableSeat
  const table = seat === null ? null : floor.seats?.[seat]
  const close = () => dispatch({ type: 'close' })
  return (
    <div className="tour-actions">
      <Link className="button" to="/open" onClick={close}>
        Open a table
      </Link>
      <Link className="button" to="/pools" onClick={close}>
        Back a dealer
      </Link>
      <Link className="button" to={table ? `/table/${table.dealer.id}` : '/'} onClick={close}>
        Play{table ? ` at ${table.dealer.name}` : ''}
      </Link>
    </div>
  )
}
