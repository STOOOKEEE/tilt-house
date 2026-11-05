// The seat's overlays: small HUD panels in the corners, the round drawer, the cards shown before
// sitting and after leaving, and the bottom bar (chips, TILT, blackjack moves).
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { LoginPrompt } from '../../components/LoginPrompt'
import { formatBp, formatUsdc, parseUsdc } from '../../format'
import { roundWager, type BjAction, type BjSession, type CompactRound } from '../../near/session-client'
import type { SessionApi, StoredSession } from '../../near/useSession'
import type { DealerView, Game } from '../../near/views'
import { CHIP_VALUES, chipColor } from '../../scene/table/felt'
import { outcomeLabel } from './seat'

/** What a session locks by default: room for a few dozen minimum bets. */
const DEFAULT_LOCK_MIN_BETS = 50n
const DRAWER_ROUNDS = 30
/** A close that answers faster than this shows no spinner at all. */
const CLOSING_SPINNER_DELAY_MS = 300

/** Leaving closes the session: not in the middle of a blackjack hand or a round on its way. */
export function canLeave(session: SessionApi): boolean {
  return session.phase === 'playing' && !session.busy && session.hand === null
}

export function SessionHud({ dealer, session, demo }: { dealer: DealerView; session: SessionApi | null; demo: boolean }) {
  const s = session?.session ?? null
  return (
    <div className="hud hud-tl">
      <strong>
        {dealer.name} <span className="muted">· {dealer.game}</span>
      </strong>
      {s ? (
        <>
          <span>
            <span className="money">{formatUsdc(s.state.balance)}</span> <span className="muted">/ {formatUsdc(s.ticket.lock)} locked</span>
          </span>
          <span className="muted">
            round {s.state.nonce} · rake {formatBp(s.ticket.rake_bp)}
          </span>
          <span className={session?.broken ? 'loss' : 'win'}>
            {demo ? 'demo · local seed, nothing signed' : session?.broken ? 'signed state refused ✗' : 'signed state checked ✓'}
          </span>
          {session && (session.phase === 'playing' || session.phase === 'closing') ? (
            <button
              type="button"
              className="leave-button"
              disabled={!canLeave(session)}
              title="Esc"
              onClick={() => void session.close()}
            >
              Leave table <kbd>Esc</kbd>
            </button>
          ) : null}
        </>
      ) : (
        <span className="muted">edge {formatBp(dealer.total_edge_bp)} · no session yet</span>
      )}
    </div>
  )
}

interface WalletHudProps {
  wallet: bigint | null
  demo: boolean
  drawerOpen: boolean
  onRounds: () => void
}

export function WalletHud({ wallet, demo, drawerOpen, onRounds }: WalletHudProps) {
  return (
    <div className="hud hud-tr">
      <span className="muted">wallet</span>
      <span className="money">{demo ? 'demo' : wallet === null ? '—' : `${formatUsdc(wallet)} tUSDC`}</span>
      <button type="button" className="ghost" onClick={onRounds} aria-expanded={drawerOpen}>
        {drawerOpen ? 'close ✕' : 'rounds ☰'}
      </button>
    </div>
  )
}

function RoundList({ rounds }: { rounds: readonly CompactRound[] }) {
  if (rounds.length === 0) return <p className="muted">no rounds yet</p>
  return (
    <table className="grid">
      <tbody>
        {[...rounds]
          .reverse()
          .slice(0, DRAWER_ROUNDS)
          .map((round) => {
            const net = BigInt(round.payout) - roundWager(round)
            return (
              <tr key={round.nonce}>
                <td>#{round.nonce}</td>
                <td>{outcomeLabel(round)}</td>
                <td className={net > 0n ? 'win money' : net < 0n ? 'loss money' : 'money'}>
                  {net > 0n ? '+' : ''}
                  {formatUsdc(net)}
                </td>
              </tr>
            )
          })}
      </tbody>
    </table>
  )
}

function VerifyResult({ session }: { session: SessionApi }) {
  const result = session.verified
  if (!result) return null
  return result.ok ? (
    <p className="win">
      ✓ {result.summary.rounds} rounds replayed from the seed: wagered {formatUsdc(result.summary.wagered)}, paid{' '}
      {formatUsdc(result.summary.paid)}; final balance and hash chain match.
    </p>
  ) : (
    <p className="loss">✗ verification failed: {result.error}</p>
  )
}

export function Drawer({ session, s }: { session: SessionApi; s: StoredSession }) {
  const open = session.phase === 'playing' || session.phase === 'closing'
  return (
    <aside className="seat-drawer">
      <strong>Session {s.session_id}</strong>
      <p className="muted">each round below was checked against the server's signed state as it arrived</p>
      <RoundList rounds={s.rounds} />
      {open ? (
        <button type="button" disabled={session.busy || session.hand !== null} onClick={() => void session.close()}>
          {session.phase === 'closing' ? 'closing…' : 'Leave the table (close and reveal)'}
        </button>
      ) : (
        <button type="button" disabled={!s.server_seed} onClick={session.verify}>
          Verify every round
        </button>
      )}
      {session.broken ? (
        <button type="button" className="ghost" disabled={session.busy} onClick={() => void session.forceClose()}>
          Force close with my last signed state
        </button>
      ) : null}
      <VerifyResult session={session} />
    </aside>
  )
}

/** Shown while the server closes the session, only if that takes long enough to notice. */
export function ClosingCard() {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), CLOSING_SPINNER_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [])
  if (!shown) return null
  return (
    <div className="center-card">
      <p className="closing">
        <span className="spinner" aria-hidden="true" /> leaving the table: the server reveals its seed…
      </p>
    </div>
  )
}

export function ClosedCard({ session, s, onDismiss }: { session: SessionApi; s: StoredSession; onDismiss: () => void }) {
  const wagered = s.rounds.reduce((sum, round) => sum + roundWager(round), 0n)
  const net = BigInt(s.state.balance) - BigInt(s.ticket.lock)
  const verified = session.verified !== null
  return (
    <div className="center-card">
      <button type="button" className="ghost card-close" aria-label="dismiss" onClick={onDismiss}>
        ✕
      </button>
      <h2>You left the table</h2>
      <dl className="closed-summary">
        <dt>rounds</dt>
        <dd>{s.state.nonce}</dd>
        <dt>wagered</dt>
        <dd className="money">{formatUsdc(wagered)}</dd>
        <dt>net</dt>
        <dd className={net > 0n ? 'win' : net < 0n ? 'loss' : undefined}>
          {net > 0n ? '+' : ''}
          {formatUsdc(net)}
        </dd>
        <dt>back to your balance</dt>
        <dd className="money">{formatUsdc(s.state.balance)} tUSDC</dd>
      </dl>
      <VerifyResult session={session} />
      {s.server_seed ? (
        <details className="muted seed">
          <summary>seeds</summary>
          revealed seed <code>{s.server_seed}</code>
          <br />
          committed hash <code>{s.ticket.server_seed_hash}</code>
          <br />
          your client seed <code>{s.ticket.client_seed}</code>
        </details>
      ) : (
        <p className="muted">waiting for the server to reveal its seed…</p>
      )}
      <p className="choices">
        {/* Verify first, then the way out becomes the main button. */}
        <button type="button" className={verified ? 'ghost' : undefined} disabled={!s.server_seed} onClick={session.verify}>
          Verify every round
        </button>
        <Link className={verified ? 'button' : 'button ghost'} to="/">
          Back to the lobby <kbd>Esc</kbd>
        </Link>
        <button type="button" className="ghost" onClick={session.forget}>
          Sit down again
        </button>
      </p>
    </div>
  )
}

interface SitCardProps {
  dealer: DealerView
  session: SessionApi
  /** House balance, null while unknown. */
  balance: bigint | null
  loggedIn: boolean
  demo: boolean
}

export function SitCard({ dealer, session, balance, loggedIn, demo }: SitCardProps) {
  const [lockText, setLockText] = useState(() => formatUsdc(BigInt(dealer.min_bet) * DEFAULT_LOCK_MIN_BETS, 0))
  const lock = parseUsdc(lockText)
  const problem =
    lock === null || lock < BigInt(dealer.min_bet)
      ? `lock at least ${formatUsdc(dealer.min_bet)} tUSDC`
      : balance !== null && lock > balance
        ? 'not enough balance: deposit in Pools'
        : ''
  const working = session.phase === 'starting' || session.phase === 'opening'
  const signedIn = loggedIn || demo
  return (
    <div className="center-card">
      <h2>
        Take a seat at {dealer.name}'s {dealer.game} table
      </h2>
      <p className="muted">
        The amount you sit down with is locked on chain for the session. Every round is then instant and signed by the
        server; when you leave, it reveals its seed and you can replay every round.
      </p>
      {signedIn ? null : <LoginPrompt action="play" />}
      <label className="stake">
        sit down with (tUSDC)
        <input value={lockText} inputMode="decimal" onChange={(event) => setLockText(event.target.value)} />
        {balance !== null ? <span className="muted">balance {formatUsdc(balance)}</span> : null}
      </label>
      {signedIn && problem ? <p className="loss">{problem}</p> : null}
      <button
        type="button"
        className="tilt-button"
        disabled={!signedIn || working || session.busy || problem !== '' || !dealer.open || lock === null}
        onClick={() => lock !== null && void session.start(lock)}
      >
        {session.phase === 'starting' ? 'asking the server…' : session.phase === 'opening' ? 'opening on chain…' : 'Sit down'}
      </button>
      {dealer.open ? null : <p className="loss">This table is closed: its pool cannot cover a bet.</p>}
    </div>
  )
}

interface BetBarProps {
  game: Game
  chip: bigint
  onChip: (value: bigint) => void
  /** On the felt, not yet played. */
  total: bigint
  problem: string | null
  hint: string | null
  canTilt: boolean
  busy: boolean
  onTilt: () => void
  onClear: () => void
  /** A blackjack hand waiting for the player's move. */
  hand: BjSession | null
  canAct: boolean
  canDouble: boolean
  onAct: (action: BjAction) => void
}

export function BetBar(props: BetBarProps) {
  const { game, chip, onChip, total, problem, hint, canTilt, busy, onTilt, onClear, hand, canAct, canDouble, onAct } = props
  return (
    <div className="bet-bar">
      {hand ? (
        <div className="bj-actions">
          <button type="button" disabled={!canAct} onClick={() => onAct('hit')}>
            Hit <kbd>H</kbd>
          </button>
          <button type="button" disabled={!canAct} onClick={() => onAct('stand')}>
            Stand <kbd>S</kbd>
          </button>
          <button type="button" disabled={!canAct || !canDouble} onClick={() => onAct('double')}>
            Double <kbd>D</kbd>
          </button>
        </div>
      ) : null}
      <p className="bet-hint">
        {hint ? <span>{hint}</span> : null}
        {problem && !hand ? <span className="muted">{problem}</span> : null}
        {!problem && !hint ? <span className="muted">{hand ? 'your move: hit, stand or double' : feltHelp(game)}</span> : null}
      </p>
      <div className="bet-row">
        <div className="chips" role="radiogroup" aria-label="chip value">
          {CHIP_VALUES.map((value) => (
            <button
              key={value.toString()}
              type="button"
              role="radio"
              aria-checked={value === chip}
              className={value === chip ? 'chip selected' : 'chip'}
              style={{ background: chipColor(value) }}
              onClick={() => onChip(value)}
            >
              {formatUsdc(value, 0)}
            </button>
          ))}
        </div>
        <button type="button" className="tilt-button" disabled={!canTilt} onClick={onTilt} title="Space">
          {busy ? '…' : 'TILT'}
        </button>
        <div className="on-felt">
          <span className="muted">on the felt</span>
          <span className="money">{formatUsdc(total)}</span>
          <button type="button" className="ghost" disabled={total === 0n || busy} onClick={onClear}>
            clear
          </button>
        </div>
      </div>
    </div>
  )
}

function feltHelp(game: Game): string {
  if (game === 'roulette') return 'click the felt to place chips · right-click or long-press takes one off'
  if (game === 'dice') return 'click the bar to set your target, then the bet circle for chips'
  return 'click the bet circle to place chips, then TILT to deal'
}
