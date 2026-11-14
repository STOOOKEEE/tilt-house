import { useCallback, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ActionStatus, type ActionState } from '../components/ActionStatus'
import { LoginPrompt } from '../components/LoginPrompt'
import { YourMoney } from '../components/YourMoney'
import { formatAmount, formatBp, formatCountdown, formatUsdc, parseUsdc, tokenSymbol } from '../format'
import { freeBankroll } from '../house'
import { PREPAY_HOURS, getFloorState, type FloorState, type SeatView } from '../near/floor'
import { fullAccessCall } from '../near/session'
import { useNear } from '../near/useNear'
import { PAGE_POLL_MS, usePlayer, usePoll } from '../near/usePoll'
import type { DealerView, PlayerView } from '../near/views'
import { getFootfall, getLiveFloor, type Arrival, type FootfallReply, type GamblerSnapshot } from '../sim/gamblers'
import {
  BOOST_COOLDOWN_SECS,
  MAX_BOOST_SECS,
  RAKE_BOUNDS,
  SHARES_PER_UNIT,
  TEMPERAMENTS,
  TEMPERAMENT_COOLDOWN_SECS,
  bidProblem,
  cooldownLeft,
  hourMoney,
  maxBetCap,
  myTables,
  offerProblem,
  previewOffer,
  retireProblem,
  tableNameProblem,
  totalEdgeBp,
  trafficMultiple,
  type Temperament,
} from '../tycoon'
import { useNow } from '../useNow'
import { CapitalAtRisk, OwnerTiltHour, RentAndSeats, RivalCallouts, TestTable } from './mytable/Cockpit'
import type { Send } from './mytable/cockpit'
import { Door } from './mytable/Door'
import { sampleFeed } from './mytable/preview'
import './mytable/mytable.css'

interface TableProps {
  dealer: DealerView
  now: number
  busy: boolean
  send: Send
}

/** Base units → an amount the inputs parse back (no thousands separators). */
function amountText(value: bigint): string {
  return formatUsdc(value).replaceAll(',', '')
}

function usdcOrDash(value: bigint | null): string {
  return value === null ? '—' : formatUsdc(value)
}

export function MyTable() {
  const { config, walletId, nearAccount } = useNear()
  const loadFloor = useCallback(() => getFloorState(config), [config])
  const floor = usePoll(loadFloor, PAGE_POLL_MS)
  const loadFeed = useCallback(() => getLiveFloor(config.sessionUrl), [config.sessionUrl])
  const feed = usePoll(config.sessionUrl ? loadFeed : null, PAGE_POLL_MS)
  const player = usePlayer()
  const now = useNow()
  const [action, setAction] = useState<ActionState>({ state: 'idle' })
  // Dev only: `?as=<dealer_id>` shows that table's cockpit read-only, `&sample=1` adds made-up gamblers.
  const [params] = useSearchParams()
  const previewId = import.meta.env.DEV ? params.get('as') : null
  const [sampleAnchor] = useState(now)
  const state = floor.data
  const sample = previewId !== null && params.get('sample') === '1'
  const gamblers = useMemo(
    () => (sample && state && previewId ? [...sampleFeed(state, previewId, sampleAnchor, now), ...(feed.data ?? [])] : feed.data),
    [sample, state, previewId, sampleAnchor, now, feed.data],
  )

  if (previewId === null && (!walletId || !nearAccount)) {
    return (
      <>
        <h1>My table</h1>
        <LoginPrompt action="run your table" />
      </>
    )
  }

  const send: Send = (label, method, args) => {
    if (previewId !== null || !nearAccount) {
      setAction({ state: 'error', message: `read-only preview: ${label} (${method}) was not sent` })
      return
    }
    setAction({ state: 'busy', label })
    void fullAccessCall(nearAccount, config, config.houseContract, method, args, 0n)
      .then(({ txHash }) => setAction({ state: 'done', label, txHash }))
      .catch((error: unknown) => setAction({ state: 'error', message: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        floor.refresh()
        player.refresh()
        feed.refresh()
      })
  }
  const tables = !state ? [] : previewId !== null ? state.dealers.filter((d) => d.id === previewId) : myTables(state.dealers, player.data, walletId)

  return (
    <>
      <h1>My table</h1>
      <p className="muted">
        You earn your table's edge on every gambler who sits, minus the rent of your seat. Set the offer yourself or put
        the dealer on autopilot; offers apply to sessions opened after the change.
      </p>
      {previewId !== null ? <p className="loss">Dev preview of {previewId}, read-only: nothing is sent.</p> : null}
      <OwnerTiltHour now={now} />
      {state?.mock ? (
        <p className="loss">
          This contract ({config.houseContract}) has no floor yet: the controls below will fail until the new contract
          is deployed.
        </p>
      ) : null}
      {floor.error ? <p className="loss">Could not load the floor: {floor.error}</p> : null}
      <ActionStatus action={action} />
      {state && tables.length === 0 ? (
        <p>
          You do not run a table yet. <Link to="/open">Open your table</Link>
        </p>
      ) : null}
      {state
        ? tables.map((dealer) => (
            <TableDashboard
              key={dealer.id}
              dealer={dealer}
              state={state}
              player={player.data}
              feed={gamblers}
              feedError={feed.error}
              now={now}
              busy={action.state === 'busy'}
              send={send}
            />
          ))
        : null}
      {previewId === null ? (
        <YourMoney
          player={player.data}
          onChange={() => {
            player.refresh()
            floor.refresh()
          }}
        />
      ) : null}
    </>
  )
}

interface DashboardProps extends TableProps {
  state: FloorState
  player: PlayerView | null
  /** The live gambler feed; null while it is unreachable. */
  feed: GamblerSnapshot[] | null
  feedError: string
}

function TableDashboard({ dealer, state, player, feed, feedError, now, busy, send }: DashboardProps) {
  const { config } = useNear()
  const loadFootfall = useCallback(() => getFootfall(config.sessionUrl, dealer.id), [config.sessionUrl, dealer.id])
  const footfall = usePoll(config.sessionUrl ? loadFootfall : null, PAGE_POLL_MS)
  const seat = state.floor.seats.find((s) => s.dealer_id === dealer.id) ?? null
  const money = hourMoney(dealer)
  const props = { dealer, now, busy, send }

  return (
    <section className="panel dashboard">
      <h2>
        {dealer.name} <span className="muted">{dealer.game}</span> · <Link to={`/table/${dealer.id}`}>table</Link>
      </h2>
      <p>
        {seat
          ? `seat ${seat.seat + 1} · ${trafficMultiple(seat.traffic_bp)} traffic`
          : 'off the floor: no gambler sees the table until it takes a seat'}
      </p>
      <TestTable dealer={dealer} />
      <Door dealer={dealer} dealers={state.dealers} feed={feed} feedError={feedError} now={now} busy={busy} send={send} />
      <RivalCallouts dealer={dealer} state={state} />
      <CapitalAtRisk {...props} feed={feed} />
      <RentAndSeats {...props} state={state} />
      <Footfall reply={footfall.data} error={footfall.error} gamblers={dealer.gamblers_1h} />
      <p>
        last hour: revenue <span className="money">{usdcOrDash(money.revenue)}</span> · rent{' '}
        <span className="money">{usdcOrDash(money.rentPerHour)}</span>/h (paid {usdcOrDash(money.rentPaid)}) · P&amp;L{' '}
        <span className={money.pnl === null ? 'money' : money.pnl >= 0n ? 'win' : 'loss'}>{usdcOrDash(money.pnl)}</span>{' '}
        {tokenSymbol()}/h
      </p>
      <OfferForm {...props} arrivals={footfall.data?.arrivals_1h ?? null} />
      <AutopilotForm {...props} />
      <PoolForms {...props} player={player} />
      {seat ? <SeatSale {...props} seat={seat} /> : <SeatBid {...props} outbidMin={BigInt(state.floor.outbid_min)} />}
      <RenameForm {...props} />
      <RetireTable {...props} player={player} seated={seat !== null} />
    </section>
  )
}

/** Live footfall from the session server, else the contract's gambler count, else nothing. */
function Footfall({ reply, error, gamblers }: { reply: FootfallReply | null; error: string; gamblers: number | null }) {
  const feedError = error ? <span className="loss"> (live feed: {error})</span> : null
  if (reply) {
    return (
      <p>
        last hour: <strong>{reply.passed_1h}</strong> gamblers stopped and walked on, <strong>{reply.sat_1h}</strong> sat
        down
      </p>
    )
  }
  if (gamblers !== null) {
    return (
      <p>
        last hour: <strong>{gamblers}</strong> gamblers sat down{feedError}
      </p>
    )
  }
  return <p className="muted">no live data on gamblers{feedError}</p>
}

const BOOST_MINUTES = /^\d{1,2}$/

function OfferForm({ dealer, now, busy, send, arrivals }: TableProps & { arrivals: Arrival[] | null }) {
  const [low, high] = RAKE_BOUNDS[dealer.game]
  const [rake, setRake] = useState(dealer.offer_rake_bp ?? dealer.rake_bp)
  const [maxBetText, setMaxBetText] = useState(amountText(BigInt(dealer.max_bet)))
  const [boostMinutes, setBoostMinutes] = useState('0')
  const maxBet = parseUsdc(maxBetText)
  // -1 makes an unreadable entry fail `offerProblem` like any out-of-range boost.
  const boostSecs = BOOST_MINUTES.test(boostMinutes) ? Number(boostMinutes) * 60 : -1
  const problem = offerProblem(dealer, { rakeBp: rake, maxBet, boostSecs }, now)
  const edge = totalEdgeBp(dealer, rake)
  const boostWait = cooldownLeft(dealer.last_boost_at, BOOST_COOLDOWN_SECS, now)
  const preview = arrivals ? previewOffer(arrivals, dealer.total_edge_bp, edge) : null

  return (
    <form
      className="game-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (problem !== null || maxBet === null) return
        send('set the offer', 'set_offer', { dealer_id: dealer.id, rake_bp: rake, max_bet: String(maxBet), boost_secs: boostSecs })
      }}
    >
      <h3>Offer</h3>
      {dealer.autopilot ? <p className="muted">On autopilot ({dealer.temperament}): setting an offer turns it off.</p> : null}
      <label>
        rake
        <input type="range" min={low} max={high} step={1} value={rake} onChange={(e) => setRake(Number(e.target.value))} />
        {formatBp(rake)} → total edge <strong>{formatBp(edge)}</strong>
        <span className="muted">now {formatBp(dealer.total_edge_bp)}</span>
      </label>
      <label>
        max bet
        <input inputMode="decimal" value={maxBetText} onChange={(e) => setMaxBetText(e.target.value)} /> {tokenSymbol()}
        <span className="muted">the pool covers up to {formatUsdc(maxBetCap(dealer))}</span>
      </label>
      <label>
        boost
        <input className="number" inputMode="numeric" value={boostMinutes} onChange={(e) => setBoostMinutes(e.target.value)} />
        minutes
        <span className="muted">
          {boostWait > 0
            ? `next boost in ${formatCountdown(boostWait)}`
            : `up to ${MAX_BOOST_SECS / 60}, once an hour: the rake drops to the game's minimum`}
        </span>
      </label>
      <p className="muted">
        {preview
          ? `based on last hour's ${preview.arrivals} arrivals: ${preview.sat} sat here; at ${formatBp(edge)} about ${preview.predicted} would have`
          : 'the preview needs the live gambler feed'}
      </p>
      {problem ? <p className="muted">{problem}</p> : null}
      <button type="submit" disabled={busy || problem !== null}>
        Set offer
      </button>
    </form>
  )
}

function AutopilotForm({ dealer, now, busy, send }: TableProps) {
  // Player tables start on autopilot (docs/floor.md rule 4); the v1 contract does not say.
  const current = dealer.autopilot ?? true
  const [on, setOn] = useState(current)
  const [temperament, setTemperament] = useState<Temperament>(
    TEMPERAMENTS.find((t) => t === dealer.temperament) ?? 'promoter',
  )
  const wait = cooldownLeft(dealer.temperament_changed_at, TEMPERAMENT_COOLDOWN_SECS, now)
  const changesTemperament = on && temperament !== dealer.temperament
  const blocked = changesTemperament && wait > 0
  const unchanged = on === current && (!on || temperament === dealer.temperament)

  return (
    <form
      className="amount-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (blocked || unchanged) return
        send(on ? `autopilot: ${temperament}` : 'autopilot off', 'set_autopilot', {
          dealer_id: dealer.id,
          temperament: on ? temperament : null,
        })
      }}
    >
      <label>
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> autopilot
      </label>
      <select value={temperament} disabled={!on} onChange={(e) => setTemperament(TEMPERAMENTS.find((t) => t === e.target.value) ?? temperament)}>
        {TEMPERAMENTS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <button type="submit" disabled={busy || blocked || unchanged}>
        Apply
      </button>
      <span className="muted">
        {blocked ? `temperament can change again in ${formatCountdown(wait)}` : 'the temperament can change once an hour'}
      </span>
    </form>
  )
}

function PoolForms({ dealer, busy, send, player }: TableProps & { player: PlayerView | null }) {
  const [investText, setInvestText] = useState('')
  const [divestText, setDivestText] = useState('')
  const balance = player ? BigInt(player.balance) : 0n
  const owned = BigInt(player?.lp.find((p) => p.dealer_id === dealer.id)?.shares ?? '0')
  const invest = parseUsdc(investText)
  const investValid = invest !== null && invest > 0n && invest <= balance
  // LP tokens are typed like tUSDC (6 decimals); "all" sends the exact share count, dust included.
  const divestTokens = parseUsdc(divestText)
  const divestShares = divestText === 'all' ? owned : divestTokens === null ? null : divestTokens * SHARES_PER_UNIT
  const divestValid = divestShares !== null && divestShares > 0n && divestShares <= owned

  return (
    <>
      <h3 id={`pool-${dealer.id}`}>Pool</h3>
      <p>
        pool <span className="money">{formatUsdc(freeBankroll(dealer))}</span> {tokenSymbol()} free (not backing open bets) ·
        you hold <span className="money">{formatUsdc(owned / SHARES_PER_UNIT)}</span> LP tokens · in the house{' '}
        {formatUsdc(balance)} {tokenSymbol()} (<a href="#your-money">deposit</a>)
      </p>
      <form
        className="amount-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (investValid) send(`invest in ${dealer.name}`, 'invest', { dealer_id: dealer.id, amount: String(invest) })
        }}
      >
        <input placeholder={tokenSymbol()} inputMode="decimal" value={investText} onChange={(e) => setInvestText(e.target.value)} />
        <button type="submit" disabled={!investValid || busy}>
          Invest
        </button>
      </form>
      <form
        className="amount-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (divestValid) send(`divest from ${dealer.name}`, 'divest', { dealer_id: dealer.id, shares: String(divestShares) })
        }}
      >
        <input placeholder="LP tokens" inputMode="decimal" value={divestText} onChange={(e) => setDivestText(e.target.value)} />
        <button type="button" className="ghost" disabled={owned === 0n} onClick={() => setDivestText('all')}>
          all
        </button>
        <button type="submit" disabled={!divestValid || busy}>
          Divest
        </button>
        <span className="muted">only free pool money can leave: money backing open sessions stays</span>
      </form>
    </>
  )
}

function SeatSale({ dealer, now, busy, send, seat }: TableProps & { seat: SeatView }) {
  const [priceText, setPriceText] = useState('')
  const price = parseUsdc(priceText)
  const valid = price !== null && price > 0n
  const ask = seat.ask ?? dealer.ask
  const prepaid = seat.paid_until - now

  return (
    <>
      <h3>Seat {seat.seat + 1}</h3>
      <p>
        rent {formatUsdc(seat.rent_per_hour)} {tokenSymbol()}/h · {prepaid > 0 ? `prepaid for ${formatCountdown(prepaid)}` : 'paid as it accrues'}
        {' · '}owed {formatUsdc(seat.rent_owed)} · {ask === null ? 'not for sale' : `listed for ${formatUsdc(ask)} ${tokenSymbol()}`}
      </p>
      <form
        className="amount-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) send('list the seat', 'list_seat', { dealer_id: dealer.id, price: String(price) })
        }}
      >
        <input placeholder={`price, ${tokenSymbol()}`} inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
        <button type="submit" disabled={!valid || busy}>
          {ask === null ? 'List for sale' : 'Change price'}
        </button>
        {ask !== null ? (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => send('unlist the seat', 'list_seat', { dealer_id: dealer.id, price: null })}
          >
            Unlist
          </button>
        ) : null}
        <span className="muted">a buyer pays you the price and your table leaves the floor</span>
      </form>
    </>
  )
}

function SeatBid({ dealer, now, busy, send, outbidMin }: TableProps & { outbidMin: bigint }) {
  const [rentText, setRentText] = useState('')
  // Until the owner types a rent, offer the price of a seat right now.
  const rent = rentText === '' ? outbidMin : parseUsdc(rentText)
  const problem = bidProblem(dealer, rent, outbidMin, now)

  return (
    <>
      <h3>Take a seat</h3>
      <p className="muted">
        A seat costs {formatUsdc(outbidMin)} {tokenSymbol()}/h now; {String(PREPAY_HOURS)} hours are prepaid from the pool into the
        jackpot. Or buy a listed seat in <Link to="/seats">Seats</Link>.
      </p>
      <form
        className="amount-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (problem === null && rent !== null) {
            send('bid for a seat', 'bid_for_seat', { dealer_id: dealer.id, rent_per_hour: String(rent) })
          }
        }}
      >
        <input
          placeholder={amountText(outbidMin)}
          inputMode="decimal"
          value={rentText}
          onChange={(e) => setRentText(e.target.value)}
        />
        {tokenSymbol()}/h
        <button type="submit" disabled={busy || problem !== null}>
          Bid for a seat
        </button>
        {problem ? <span className="muted">{problem}</span> : null}
      </form>
    </>
  )
}

function RenameForm({ dealer, busy, send }: TableProps) {
  const [name, setName] = useState(dealer.name)
  const problem = tableNameProblem(name)
  return (
    <form
      className="game-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (problem === null && name !== dealer.name) send('rename the table', 'set_table_name', { dealer_id: dealer.id, name })
      }}
    >
      <h3>Name</h3>
      <label>
        name <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {problem ? <p className="loss">{problem}</p> : null}
      <button type="submit" disabled={busy || problem !== null || name === dealer.name}>
        Rename table
      </button>
    </form>
  )
}

/** Shown as a button only when `retire_table` would pass; otherwise says what blocks it. */
function RetireTable({ dealer, busy, send, player, seated }: TableProps & { player: PlayerView | null; seated: boolean }) {
  const problem = retireProblem(dealer, player, seated)
  const retire = () => {
    const ok = window.confirm(
      `Retire ${dealer.name} for good?\n\n` +
        `Its whole bankroll (${formatAmount(dealer.bankroll)}) goes back to your house balance, since you hold every LP share. ` +
        'The table leaves the lobby and refuses every later call; this cannot be undone.',
    )
    if (ok) send('retire the table', 'retire_table', { dealer_id: dealer.id })
  }
  return (
    <div className="game-form">
      <h3>Retire</h3>
      {problem ? (
        <p className="muted">Retiring pays you the bankroll and closes the table for good: not now, {problem}.</p>
      ) : (
        <button type="button" className="ghost" disabled={busy} onClick={retire}>
          Retire table
        </button>
      )}
    </div>
  )
}
