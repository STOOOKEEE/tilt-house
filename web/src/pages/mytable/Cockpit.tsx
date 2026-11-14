import { useCallback } from 'react'
import { Link } from 'react-router'
import { formatBp, formatCountdown, formatUsdc, tokenSymbol } from '../../format'
import type { FloorState } from '../../near/floor'
import { getTiltHourUntil } from '../../near/tilt'
import { useNear } from '../../near/useNear'
import { usePoll } from '../../near/usePoll'
import type { DealerView } from '../../near/views'
import { tablePath } from '../../paths'
import type { GamblerSnapshot } from '../../sim/gamblers'
import { trafficMultiple } from '../../tycoon'
import {
  capMaxBet,
  evictionIn,
  exposure,
  personaLabel,
  practicePath,
  seatLadder,
  seatedCustomers,
  undercutters,
  type Send,
  type SeatRef,
} from './cockpit'

interface BlockProps {
  dealer: DealerView
  now: number
  busy: boolean
  send: Send
}

const utcTime = (unix: number) => new Date(unix * 1000).toISOString().slice(11, 16)
const SECS_PER_DAY = 86_400

/** How long the pool keeps paying: days once it is long, else a clock. */
function runway(secs: number): string {
  return secs >= 2 * SECS_PER_DAY ? `${Math.floor(secs / SECS_PER_DAY)} days` : formatCountdown(secs) || 'no time'
}

// ---- capital at risk ----------------------------------------------------------------------

export function CapitalAtRisk({ dealer, feed, busy, send }: BlockProps & { feed: readonly GamblerSnapshot[] | null }) {
  const risk = exposure(dealer)
  const customers = feed ? seatedCustomers(feed, dealer) : []
  const cap = capMaxBet(dealer)
  const watch = customers.some((c) => c.flag !== null)

  return (
    <div className="cockpit-block">
      <h3>Capital at risk</h3>
      <p>
        Their win is your loss: open sessions reserve <span className="money">{formatUsdc(risk.reserved)}</span> of the
        table's <span className="money">{formatUsdc(risk.bankroll)}</span> {tokenSymbol()} bankroll (
        {formatBp(risk.reserved_bp)}); {formatUsdc(risk.free)} is free to back new sessions.
      </p>
      <div className="gauge" role="meter" aria-valuemin={0} aria-valuemax={10_000} aria-valuenow={risk.reserved_bp}>
        <div className="gauge-fill" style={{ width: `${risk.reserved_bp / 100}%` }} />
      </div>
      {feed === null ? null : customers.length === 0 ? (
        <p className="muted">Nobody is seated at your table right now.</p>
      ) : (
        <ul className="customers">
          {customers.map(({ gambler, net, flag }) => (
            <li key={gambler.id} className={flag ? 'watch' : undefined}>
              <strong>{gambler.name ?? gambler.id}</strong> <span className="muted">{personaLabel(gambler.persona)}</span>{' '}
              <span className={net > 0n ? 'loss' : net < 0n ? 'win' : 'muted'}>
                {net > 0n ? `up ${formatUsdc(net)}` : net < 0n ? `down ${formatUsdc(-net)}` : 'even'}
              </span>
              {flag === 'up_big' ? ' · up big: that is your money' : flag === 'whale' ? ' · whale: bets big' : ''}
            </li>
          ))}
        </ul>
      )}
      <p>
        {cap ? (
          <button type="button" className={watch ? undefined : 'ghost'} disabled={busy} onClick={() => send('cap the max bet', 'set_offer', cap)}>
            Cap max bet at {formatUsdc(cap.max_bet)}
          </button>
        ) : null}{' '}
        <span className="muted">
          or let it run: over many rounds the edge works for you. A lower cap applies to sessions opened afterwards and
          turns autopilot off.
        </span>
      </p>
    </div>
  )
}

// ---- rent and seats -----------------------------------------------------------------------

function seatName(ref: SeatRef): string {
  return `seat ${ref.seat.seat + 1} (${ref.dealer?.name ?? 'empty'}, ${trafficMultiple(ref.seat.traffic_bp)} traffic)`
}

export function RentAndSeats({ dealer, state, now, busy, send }: BlockProps & { state: FloorState }) {
  const ladder = seatLadder(state, dealer.id, now)
  const { mine } = ladder
  const evicted = mine ? evictionIn(mine, dealer, now) : null
  const prepaid = mine ? mine.paid_until - now : 0

  return (
    <div className="cockpit-block">
      <h3>Rent and seat</h3>
      {mine ? (
        <>
          <p>
            Seat {mine.seat + 1} · {trafficMultiple(mine.traffic_bp)} traffic · rent{' '}
            <span className="money">{formatUsdc(mine.rent_per_hour)}</span> {tokenSymbol()}/h ·{' '}
            {prepaid > 0 ? (
              <>
                prepaid for <span className="countdown">{formatCountdown(prepaid)}</span> (until {utcTime(mine.paid_until)} UTC)
              </>
            ) : (
              <>prepaid time used up: owed {formatUsdc(mine.rent_owed)}, drawn from the free bankroll every minute</>
            )}
          </p>
          <p className="muted">
            {evicted === null ? '' : `At this rent the free bankroll pays about ${runway(evicted)} more. `}
            Unpaid rent means eviction at the keeper's next pass (every minute): the seat goes to the next bidder and
            your table sees no gambler until it takes a seat again.
          </p>
        </>
      ) : (
        <p>Off the floor: no gambler sees your table until it takes a seat.</p>
      )}
      <ul className="ladder">
        {mine && ladder.above ? (
          <li>
            Next seat up: {seatName(ladder.above)} rents for {formatUsdc(ladder.above.seat.rent_per_hour)}/h. Seats change
            hands by sale or eviction; buying one means leaving yours first (<Link to="/seats">Seats</Link>).
          </li>
        ) : null}
        {mine === null && ladder.target ? (
          <li>
            A bid of <span className="money">{formatUsdc(ladder.outbid)}</span>/h takes {seatName(ladder.target)}
            {ladder.target.dealer ? ' (lowest rent + 10 %)' : ''}: bid below, with 2 h prepaid from the pool.
          </li>
        ) : null}
        {ladder.defend !== null ? (
          <li>
            You are the cheapest seat: any bid of {formatUsdc(ladder.outbid)}/h evicts you.{' '}
            <button
              type="button"
              disabled={busy}
              onClick={() => send('raise the rent', 'bid_for_seat', { dealer_id: dealer.id, rent_per_hour: String(ladder.defend) })}
            >
              Raise my rent to {formatUsdc(ladder.defend)}/h
            </button>{' '}
            <span className="muted">leaves the bottom; a raise shortens the prepaid time at once</span>
          </li>
        ) : null}
        {ladder.for_sale.map((ref) => (
          <li key={ref.seat.seat}>
            For sale: {seatName(ref)} at <span className="money">{formatUsdc(ref.seat.ask ?? '0')}</span> {tokenSymbol()} ·{' '}
            <Link to="/seats">Seats</Link>
          </li>
        ))}
        {ladder.freeing.map((ref) => (
          <li key={ref.seat.seat}>
            {ref.dealer?.name ?? 'A rival'}'s rent runs out in {formatCountdown(ref.in_secs) || 'under a minute'}: an
            eviction frees {seatName(ref)}.
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---- rivals -------------------------------------------------------------------------------

export function RivalCallouts({ dealer, state }: { dealer: DealerView; state: FloorState }) {
  const rivals = undercutters(state, dealer)
  if (rivals.length === 0) return null
  return (
    <div className="cockpit-block rivals">
      {rivals.map((rival) => (
        <p key={rival.id} className="rival-callout">
          <strong>{rival.name} is coming for you</strong>: cut to {formatBp(rival.total_edge_bp)}, under your{' '}
          {formatBp(dealer.total_edge_bp)}, after your table took {rival.name}'s players. Answer in the Offer below, or hold
          your edge and win on max bet, seat and boost.
        </p>
      ))}
    </div>
  )
}

// ---- Tilt Hour ----------------------------------------------------------------------------

/** Same slow poll as the lobby banner: a Tilt Hour starts at most once per burn window. */
const TILT_HOUR_POLL_MS = 15_000

export function OwnerTiltHour({ now }: { now: number }) {
  const { config } = useNear()
  const load = useCallback(() => getTiltHourUntil(config.rpcUrl, config.houseContract), [config])
  const until = usePoll(load, TILT_HOUR_POLL_MS).data ?? 0
  if (until <= now) return null
  return (
    <p className="tilt-hour-banner">
      Tilt Hour for {formatCountdown(until - now)} more (until {utcTime(until)} UTC): every table, yours included, plays
      at its minimum edge for the hour. Customers then choose on max bet, seat and boost.{' '}
      <Link to="/tilt">What is this?</Link>
    </p>
  )
}

// ---- test my table ------------------------------------------------------------------------

export function TestTable({ dealer }: { dealer: DealerView }) {
  return (
    <p className="cockpit-test">
      <Link className="button ghost" to={practicePath(dealer)}>
        Test my table
      </Link>{' '}
      <span className="muted">practice: same rules, local seed, nothing on chain ·</span>{' '}
      <Link to={tablePath(dealer)}>sit live as a customer</Link>
    </p>
  )
}
