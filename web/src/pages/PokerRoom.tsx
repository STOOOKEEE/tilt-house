// A poker table, full screen: the 3D felt and players, with the player's controls floating over
// it: the seat card (buy-in), the action bar (fold, check/call, bet/raise with a slider and pot
// presets, all in) with the turn timer, and the proof of the last hand, replayed in the browser.
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { LoginPrompt } from '../components/LoginPrompt'
import { formatBp, formatUsdc, parseUsdc } from '../format'
import { actionProblem, raiseAction, raisePresets, type TableState } from '../near/poker-client'
import type { Legal, PokerAction } from '../near/poker-rules'
import type { PokerTableApi } from '../near/usePokerTable'
import { createPokerScene, type PokerSceneApi } from '../scene/poker/PokerScene'
import { pokerScene, potTotal } from '../scene/poker/view'
import { useNow } from '../useNow'
import { useTopbarBottom } from './Table'
import './Poker.css'

/** The buy-in offered first: 50 big blinds, within the table's range. */
const DEFAULT_BUY_IN_BB = 50n
const TABLE_ACCENT = '#f0c26a'

interface RoomProps {
  api: PokerTableApi
  /** Practice table: no login, local bots. */
  demo: boolean
  loggedIn: boolean
  /** Contract balance, null while unknown or in practice. */
  wallet: bigint | null
}

export function PokerRoom({ api, demo, loggedIn, wallet }: RoomProps) {
  const top = useTopbarBottom()
  const table = api.table
  if (!table) {
    return (
      <div className="seat-view" style={{ top }}>
        <div className="center-card">
          <p className="muted">{api.error ? `Could not load the table: ${api.error}` : 'loading table…'}</p>
        </div>
      </div>
    )
  }
  const you = table.you
  const seat = you?.seat == null ? null : table.seats[you.seat]
  return (
    <div className="seat-view poker-view" style={{ top }}>
      <PokerStage table={table} />
      <TableHud table={table} demo={demo} />
      {you && seat ? (
        <div className="hud hud-tr">
          <span>
            your stack <span className="money">{formatUsdc(seat.stack)}</span>
          </span>
          {seat.waiting ? <span className="muted">dealt in from the next hand</span> : null}
          {seat.leaving ? <span className="muted">leaving when this hand ends</span> : null}
          <button type="button" className="leave-button" disabled={api.busy || seat.leaving} onClick={() => void api.leave()}>
            Leave table
          </button>
        </div>
      ) : you ? (
        <div className="hud hud-tr">
          <span className="muted">queued: a house bot gives you its seat when this hand ends</span>
          <button type="button" className="leave-button" disabled={api.busy} onClick={() => void api.leave()}>
            Leave the queue
          </button>
        </div>
      ) : null}
      {you ? null : <SeatCard table={table} api={api} demo={demo} loggedIn={loggedIn} wallet={wallet} />}
      <ProofBadge api={api} table={table} />
      {api.error ? <p className="seat-toast loss">{api.error}</p> : null}
      {you?.legal && table.hand ? <ActionBar key={`${table.hand.number}-${table.hand.phase}`} table={table} legal={you.legal} api={api} /> : null}
    </div>
  )
}

function PokerStage({ table }: { table: TableState }) {
  const host = useRef<HTMLDivElement>(null)
  const [scene, setScene] = useState<PokerSceneApi | null>(null)
  useEffect(() => {
    if (!host.current) return
    const created = createPokerScene(host.current, { title: table.name, accent: TABLE_ACCENT })
    setScene(created)
    return () => {
      created.dispose()
      setScene(null)
    }
    // Built once per table; snapshots are pushed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table.table_id])
  useEffect(() => {
    scene?.show(pokerScene(table))
  }, [scene, table])
  return <div ref={host} className="seat-stage" />
}

function TableHud({ table, demo }: { table: TableState; demo: boolean }) {
  const { config, hand } = table
  const bots = table.seats.some((s) => s?.npc)
  return (
    <div className="hud hud-tl">
      <strong>
        {table.name} <span className="muted">· no-limit hold'em</span>
      </strong>
      <span className="muted">
        blinds {formatUsdc(config.small_blind)}/{formatUsdc(config.big_blind)} · rake {formatBp(config.rake_bp)} (cap{' '}
        {formatUsdc(config.rake_cap)}, no flop no drop)
      </span>
      {hand ? (
        <span>
          hand #{hand.number} · {hand.phase} · pot <span className="money">{formatUsdc(potTotal(table))}</span>
        </span>
      ) : (
        <span className="muted">{table.last_hand ? `hand #${table.last_hand.number} is over · next hand soon` : 'waiting for players…'}</span>
      )}
      {hand ? (
        <span className="muted" title={hand.commitment}>
          seed committed {hand.commitment.slice(0, 12)}… before the deal
        </span>
      ) : null}
      {bots ? <span className="poker-bot-note">BOT = house bot, it only fills empty seats</span> : null}
      {demo ? <span className="win">practice · local bots, nothing on chain</span> : null}
    </div>
  )
}

interface SeatCardProps {
  table: TableState
  api: PokerTableApi
  demo: boolean
  loggedIn: boolean
  wallet: bigint | null
}

function SeatCard({ table, api, demo, loggedIn, wallet }: SeatCardProps) {
  const { config } = table
  const min = BigInt(config.min_buy_in)
  const max = BigInt(config.max_buy_in)
  const preferred = BigInt(config.big_blind) * DEFAULT_BUY_IN_BB
  const [text, setText] = useState(() => formatUsdc(preferred < min ? min : preferred > max ? max : preferred, 0))
  const buyIn = parseUsdc(text)
  const humans = table.seats.filter((s) => s && !s.npc).length
  const full = humans >= table.seats.length
  const problem =
    buyIn === null || buyIn < min || buyIn > max
      ? `buy in between ${formatUsdc(min)} and ${formatUsdc(max)}`
      : wallet !== null && buyIn > wallet
        ? 'not enough balance: deposit first'
        : full
          ? 'every seat has a human player'
          : ''
  const canSit = (loggedIn || demo) && problem === '' && !api.busy && api.progress === ''
  return (
    <div className="center-card poker-seat-card">
      <h2>Sit down at {table.name}</h2>
      <p className="muted">Your buy-in is locked on chain as a session; each hand is one signed round of it.</p>
      {loggedIn || demo ? null : <LoginPrompt action="play poker" />}
      <label className="stake">
        buy-in ({demo ? 'practice chips' : 'tUSDC'})
        <input value={text} inputMode="decimal" onChange={(event) => setText(event.target.value)} />
        {wallet !== null ? <span className="muted">balance {formatUsdc(wallet)}</span> : null}
      </label>
      {(loggedIn || demo) && problem ? <p className="loss">{problem}</p> : null}
      <button type="button" className="tilt-button" disabled={!canSit} onClick={() => buyIn !== null && void api.sit(buyIn)}>
        {api.progress || 'Sit down'}
      </button>
      {demo ? null : (
        <p className="muted">
          Just looking? <Link to="/poker?demo=1">Practice against bots</Link>, no login.
        </p>
      )}
    </div>
  )
}

/** Fold, check or call, bet or raise (slider + presets), all in; F, C, R, A on the keyboard. */
function ActionBar({ table, legal, api }: { table: TableState; legal: Legal; api: PokerTableApi }) {
  const hand = table.hand
  // useNow ticks in seconds: enough for a countdown of whole seconds.
  const now = useNow() * 1000
  const range = legal.raise
  const presets = hand ? raisePresets(legal, potTotal(table), BigInt(hand.current_bet)) : []
  const [to, setTo] = useState<bigint>(() => range?.min_to ?? 0n)
  const [problem, setProblem] = useState('')
  const opening = hand?.current_bet === '0'

  const send = (action: PokerAction) => {
    const why = actionProblem(legal, action)
    setProblem(why ?? '')
    if (why === null) void api.act(action)
  }
  const raise = () => range && send(raiseAction(legal, to))

  const keys = useRef<Record<string, () => void>>({})
  keys.current = {
    f: () => send('fold'),
    c: () => send(legal.can_check ? 'check' : 'call'),
    r: raise,
    a: () => send('all_in'),
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey) return
      const run = keys.current[event.key.toLowerCase()]
      if (!run) return
      event.preventDefault()
      run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const left = hand?.deadline ? Math.max(0, hand.deadline - now) : null
  const fraction = left === null ? 1 : left / Math.max(1, table.config.action_ms)
  const allInOnly = range !== null && range.min_to === range.max_to
  return (
    <div className="bet-bar poker-actions">
      {left !== null ? (
        <div className="poker-timer" title="when it runs out you check if you can, else fold">
          <div className={fraction < 0.25 ? 'poker-timer-fill late' : 'poker-timer-fill'} style={{ width: `${fraction * 100}%` }} />
          <span>{Math.ceil(left / 1000)} s</span>
        </div>
      ) : null}
      {range && !allInOnly ? (
        <div className="poker-raise">
          {presets.map((p) => (
            <button key={p.label} type="button" className={p.to === to ? 'selected' : ''} onClick={() => setTo(p.to)}>
              {p.label}
            </button>
          ))}
          <input
            type="range"
            aria-label="bet size"
            min={Number(range.min_to)}
            max={Number(range.max_to)}
            step={Number(BigInt(table.config.small_blind))}
            value={Number(to)}
            onChange={(event) => setTo(BigInt(event.target.value))}
          />
          <input
            className="poker-amount"
            inputMode="decimal"
            aria-label="bet to"
            value={formatUsdc(to)}
            onChange={(event) => {
              const typed = parseUsdc(event.target.value)
              if (typed !== null) setTo(typed)
            }}
          />
        </div>
      ) : null}
      {problem ? <p className="bet-hint loss">{problem}</p> : null}
      <div className="bj-actions">
        <button type="button" disabled={api.busy} onClick={() => send('fold')}>
          Fold<kbd>F</kbd>
        </button>
        <button type="button" disabled={api.busy} onClick={() => send(legal.can_check ? 'check' : 'call')}>
          {legal.can_check ? 'Check' : `Call ${formatUsdc(legal.call)}`}
          <kbd>C</kbd>
        </button>
        {range && !allInOnly ? (
          <button type="button" disabled={api.busy} onClick={raise}>
            {to >= range.max_to ? `All in ${formatUsdc(range.max_to)}` : `${opening ? 'Bet' : 'Raise to'} ${formatUsdc(to)}`}
            <kbd>R</kbd>
          </button>
        ) : null}
        {range || legal.call === legal.stack ? (
          <button type="button" className="poker-all-in" disabled={api.busy} onClick={() => send('all_in')}>
            All in {formatUsdc(range ? range.max_to : legal.stack)}
            <kbd>A</kbd>
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** "hand #12 · seed revealed ✓ deck verified": the last hand replayed here, details on click. */
function ProofBadge({ api, table }: { api: PokerTableApi; table: TableState }) {
  const [open, setOpen] = useState(false)
  const proof = api.proof
  const last = table.last_hand
  if (!proof || !last || last.number !== proof.hand) return null
  const ok = proof.check.ok
  return (
    <div className="hud poker-proof">
      <button type="button" className={ok ? 'win' : 'loss'} onClick={() => setOpen((v) => !v)}>
        hand #{proof.hand} · {ok ? 'seed revealed ✓ deck verified' : `✗ ${proof.check.ok ? '' : proof.check.error}`}
      </button>
      {open ? (
        <div className="poker-proof-detail">
          {proof.check.ok ? (
            <ul>
              {proof.check.checks.map((c) => (
                <li key={c}>✓ {c}</li>
              ))}
            </ul>
          ) : null}
          <dl>
            <dt>commitment</dt>
            <dd>
              <code>{last.commitment}</code>
            </dd>
            <dt>hand seed</dt>
            <dd>
              <code>{last.history.hand_seed}</code>
            </dd>
            <dt>client seeds</dt>
            <dd>
              {last.history.start.seats.map((s) => (
                <code key={s.seat}>
                  seat {s.seat + 1}: {s.client_seed}{' '}
                </code>
              ))}
            </dd>
            <dt>deck</dt>
            <dd>
              <code>{last.deck.join(' ')}</code>
            </dd>
          </dl>
          <p className="muted">Replayed in your browser with web/src/near/poker-rules.ts, checked against core/src/poker.rs vectors.</p>
        </div>
      ) : null}
    </div>
  )
}
