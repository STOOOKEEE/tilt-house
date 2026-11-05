import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { LoginPrompt } from '../components/LoginPrompt'
import { DiceForm, RouletteForm } from '../components/GameForms'
import { formatBp, formatCountdown, formatUsdc, parseUsdc } from '../format'
import { cardLabel, handTotal, reopenNeeds } from '../house'
import { roundWager, type BjSession, type CompactRound } from '../near/session-client'
import { useNear } from '../near/useNear'
import { TABLE_POLL_MS, useLobby, usePlayer } from '../near/usePoll'
import { useSession, type SessionApi, type StoredSession } from '../near/useSession'
import type { Bet, DealerView, RoundView } from '../near/views'
import { dealerMood } from '../scene/mood'
import { demoRound } from '../scene/table/demo'
import { createTableScene } from '../scene/table/TableScene'
import type { TableSceneApi } from '../scene/types'
import { useNow } from '../useNow'

/** Dev `?demo=1`: one scripted snapshot every this many ms. */
const DEMO_STEP_MS = 2_500
/** What a session locks by default: room for a few dozen minimum bets. */
const DEFAULT_LOCK_MIN_BETS = 50n

export function Table() {
  const { dealer: dealerId = '' } = useParams()
  const { config, nearAccount, walletId } = useNear()
  const lobby = useLobby(TABLE_POLL_MS)
  const player = usePlayer(TABLE_POLL_MS)
  const dealer = lobby.data?.find((d) => d.id === dealerId)
  const session = useSession(config, nearAccount, walletId, dealer)
  const { session: stored, hand, last } = session
  // Memoized: the scene replays its animation for every new round object.
  const ownRound = useMemo(() => ownRoundView(stored, hand, last, walletId), [stored, hand, last, walletId])

  if (lobby.error && !lobby.data) return <p className="loss">Could not load the table: {lobby.error}</p>
  if (!lobby.data) return <p className="muted">loading table…</p>
  if (!dealer) return <p>No dealer “{dealerId}”. <Link to="/">Back to the lobby</Link></p>

  const elsewhere = session.session && session.session.ticket.dealer_id !== dealer.id ? session.session : null
  return (
    <>
      <TableStage dealer={dealer} ownRound={ownRound} drawing={session.busy && session.phase === 'playing'} failed={session.error !== ''} />
      <DealerHeader dealer={dealer} />
      {!walletId ? <LoginPrompt action="play" /> : null}
      {elsewhere ? (
        <p>
          You are seated at <Link to={`/table/${elsewhere.ticket.dealer_id}`}>{elsewhere.ticket.dealer_id}</Link>: close
          that session first.
        </p>
      ) : (
        <SessionPanel dealer={dealer} session={session} balance={player.data ? BigInt(player.data.balance) : null} loggedIn={walletId !== ''} />
      )}
      {session.error ? <p className="loss">{session.error}</p> : null}
    </>
  )
}

/** The player's round on the felt: the live blackjack hand, else the last finished round. */
function ownRoundView(s: StoredSession | null, hand: BjSession | null, last: SessionApi['last'], walletId: string): RoundView | null {
  if (!s) return null
  if (hand) return handView(s, hand, walletId)
  if (last) return roundView(s, last.round, walletId, last.ordinal)
  return null
}

/** Round ids for the scene: unique per session and nonce, so a new session never "continues" an old round. */
function sceneId(s: StoredSession, nonce: number): number {
  return (Number.parseInt(s.ticket.server_seed_hash.slice(0, 6), 16) % 10_000) * 100_000 + nonce
}

function baseView(s: StoredSession, walletId: string, nonce: number, bet: Bet, stake: string): RoundView {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: sceneId(s, nonce),
    player: walletId,
    dealer_id: s.ticket.dealer_id,
    game: s.ticket.game,
    bet,
    stake,
    wager: stake,
    rake_bp: s.ticket.rake_bp,
    status: 'settled',
    step: 0,
    created_at: now,
    updated_at: now,
    roll: null,
    pocket: null,
    bj: null,
    payout: null,
    proofs: [],
    error: null,
  }
}

function roundView(s: StoredSession, round: CompactRound, walletId: string, ordinal: number): RoundView {
  const view = baseView(s, walletId, round.nonce, round.bet, round.stake)
  const outcome = round.outcome
  return {
    ...view,
    wager: roundWager(round).toString(),
    step: round.actions.length,
    updated_at: view.updated_at + ordinal,
    roll: 'dice' in outcome ? outcome.dice.roll : null,
    pocket: 'roulette' in outcome ? outcome.roulette.pocket : null,
    bj: 'blackjack' in outcome ? outcome.blackjack : null,
    payout: round.payout,
  }
}

function handView(s: StoredSession, hand: BjSession, walletId: string): RoundView {
  return {
    ...baseView(s, walletId, hand.nonce, 'blackjack', hand.stake),
    status: 'player_turn',
    step: hand.actions.length,
    wager: (hand.state.doubled ? BigInt(hand.stake) * 2n : BigInt(hand.stake)).toString(),
    bj: hand.state,
  }
}

interface StageProps {
  dealer: DealerView
  /** The player's round at this table, null before the first one. */
  ownRound: RoundView | null
  /** A move is on its way to the session server (about 100 ms): the dealer starts the draw. */
  drawing: boolean
  failed: boolean
}

/** The 3D table: the player's session rounds, or a scripted demo (`?demo=1`, dev only). */
function TableStage({ dealer, ownRound, drawing, failed }: StageProps) {
  const [searchParams] = useSearchParams()
  const demo = import.meta.env.DEV && searchParams.get('demo') === '1'
  const host = useRef<HTMLDivElement>(null)
  const [scene, setScene] = useState<TableSceneApi | null>(null)

  useEffect(() => {
    if (!host.current) return
    const created = createTableScene(host.current, {
      dealerId: dealer.id,
      dealerName: dealer.name,
      game: dealer.game,
      onRound: () => undefined,
    })
    setScene(created)
    return () => {
      created.dispose()
      setScene(null)
    }
    // Rebuilt only for another dealer: live fields are pushed by the effects below.
  }, [dealer.id])

  const mood = dealerMood(dealer)
  useEffect(() => {
    scene?.setGame(dealer.game)
    scene?.setMood(mood)
    scene?.say(dealer.reason_text)
    scene?.setOpen(dealer.open)
  }, [scene, dealer.game, mood, dealer.reason_text, dealer.open])

  const shown = useRef<RoundView | null>(null)
  useEffect(() => {
    if (!scene || !ownRound || demo) return
    scene.showRound(shown.current, ownRound)
    shown.current = ownRound
  }, [scene, ownRound, demo])

  useEffect(() => {
    if (scene && drawing) scene.startDrawing(dealer.game)
  }, [scene, drawing, dealer.game])
  // On success the director ends the loop with the answer; only a failed move stops it here.
  useEffect(() => {
    if (scene && failed) scene.stopDrawing()
  }, [scene, failed])

  useEffect(() => {
    if (!scene || !demo) return
    let id = 1
    let snapshots = demoRound(dealer.game, dealer.id, id)
    let previous: RoundView | null = null
    const timer = window.setInterval(() => {
      const next = snapshots.shift()
      if (!next) {
        id += 1
        snapshots = demoRound(dealer.game, dealer.id, id)
        previous = null
        return
      }
      scene.showRound(previous, next)
      previous = next
    }, DEMO_STEP_MS)
    return () => window.clearInterval(timer)
  }, [scene, demo, dealer.game, dealer.id])

  return (
    <div style={{ position: 'relative', height: 'min(58vh, 540px)', marginBottom: '1rem' }}>
      <div ref={host} style={{ position: 'absolute', inset: 0, borderRadius: 6, overflow: 'hidden' }} />
      {demo ? (
        <p className="muted" style={{ position: 'absolute', left: 12, top: 4, margin: 0 }}>
          demo round (scripted)
        </p>
      ) : null}
    </div>
  )
}

function DealerHeader({ dealer }: { dealer: DealerView }) {
  const now = useNow()
  const boostLeft = formatCountdown(dealer.boost_until - now)
  return (
    <header className="table-header">
      <h1>
        {dealer.name} <span className="muted">· {dealer.temperament} · {dealer.game}</span>
      </h1>
      <p>
        edge {formatBp(dealer.total_edge_bp)} · bets {formatUsdc(dealer.min_bet)}–{formatUsdc(dealer.max_bet)} tUSDC
        {boostLeft ? <span className="win"> · boost {boostLeft}</span> : null}
      </p>
      <p className="muted">“{dealer.reason_text}”</p>
      {dealer.open ? null : (
        <p className="loss">
          Table closed · needs {formatUsdc(reopenNeeds(dealer))} tUSDC to reopen.{' '}
          <Link to={`/pools?dealer=${dealer.id}`}>Rescue it</Link>
        </p>
      )}
    </header>
  )
}

interface SessionPanelProps {
  dealer: DealerView
  session: SessionApi
  /** House balance, null while unknown. */
  balance: bigint | null
  loggedIn: boolean
}

function SessionPanel({ dealer, session, balance, loggedIn }: SessionPanelProps) {
  const { config } = useNear()
  if (!config.sessionUrl) return <p className="muted">Play is offline: no session server configured.</p>
  const s = session.session
  switch (session.phase) {
    case 'idle':
    case 'starting':
    case 'opening':
      return <OpenSession dealer={dealer} session={session} balance={balance} loggedIn={loggedIn} />
    case 'playing':
    case 'closing':
      return s ? <PlayArea dealer={dealer} session={session} s={s} /> : null
    case 'closed':
      return s ? <ClosedSession session={session} s={s} /> : null
  }
}

function OpenSession({ dealer, session, balance, loggedIn }: SessionPanelProps) {
  const [lockText, setLockText] = useState(() => formatUsdc(BigInt(dealer.min_bet) * DEFAULT_LOCK_MIN_BETS, 0))
  const lock = parseUsdc(lockText)
  const problem =
    lock === null || lock < BigInt(dealer.min_bet)
      ? `lock at least ${formatUsdc(dealer.min_bet)} tUSDC`
      : balance !== null && lock > balance
        ? 'not enough balance: deposit in Pools'
        : ''
  const working = session.phase !== 'idle'
  return (
    <section className="play">
      <p className="muted">
        Sit down with an amount: it is locked on chain for the session, then every round is instant and signed by the
        server. When you leave, the server reveals its seed and you can replay every round.
      </p>
      <label className="stake">
        lock (tUSDC)
        <input value={lockText} inputMode="decimal" onChange={(event) => setLockText(event.target.value)} />
        {balance !== null ? <span className="muted">balance {formatUsdc(balance)}</span> : null}
      </label>
      {loggedIn && problem ? <p className="loss">{problem}</p> : null}
      <button
        type="button"
        disabled={!loggedIn || working || session.busy || problem !== '' || !dealer.open || lock === null}
        onClick={() => lock !== null && void session.start(lock)}
      >
        {session.phase === 'starting' ? 'asking the server…' : session.phase === 'opening' ? 'opening on chain…' : 'Sit down'}
      </button>
    </section>
  )
}

function PlayArea({ dealer, session, s }: { dealer: DealerView; session: SessionApi; s: StoredSession }) {
  const ticket = s.ticket
  const [stakeText, setStakeText] = useState(() => formatUsdc(dealer.min_bet, 0))
  const stake = parseUsdc(stakeText)
  const balance = BigInt(s.state.balance)
  const stakeProblem =
    stake === null
      ? 'Enter a stake like 0.5'
      : stake < BigInt(dealer.min_bet)
        ? `Minimum bet is ${formatUsdc(dealer.min_bet)}`
        : stake > BigInt(ticket.max_bet)
          ? `This session takes at most ${formatUsdc(ticket.max_bet)}`
          : stake > balance
            ? 'Not enough left in the session'
            : ''
  const idle = !session.busy && session.phase === 'playing' && session.broken === ''
  const canBet = idle && stakeProblem === '' && session.hand === null
  const bet = (b: Bet) => stake !== null && void session.bet(b, stake)

  return (
    <section className="play">
      <p>
        session <code>{s.session_id}</code> · balance <strong className="money">{formatUsdc(balance)}</strong> of{' '}
        {formatUsdc(ticket.lock)} locked · rake {formatBp(ticket.rake_bp)} · round {s.state.nonce}
      </p>
      {session.broken ? <Broken session={session} /> : null}
      <label className="stake">
        stake (tUSDC)
        <input value={stakeText} inputMode="decimal" onChange={(event) => setStakeText(event.target.value)} />
      </label>
      {stakeProblem && session.hand === null ? <p className="loss">{stakeProblem}</p> : null}
      {ticket.game === 'dice' ? <DiceForm stake={stake} rakeBp={ticket.rake_bp} disabled={!canBet} onBet={bet} /> : null}
      {ticket.game === 'roulette' ? <RouletteForm stake={stake} rakeBp={ticket.rake_bp} disabled={!canBet} onBet={bet} /> : null}
      {ticket.game === 'blackjack' ? (
        <BlackjackControls hand={session.hand} canDeal={canBet} canMove={idle} balance={balance} onDeal={() => bet('blackjack')} session={session} />
      ) : null}
      <RoundList rounds={s.rounds} />
      <button type="button" className="ghost" disabled={session.busy || session.hand !== null} onClick={() => void session.close()}>
        {session.phase === 'closing' ? 'closing…' : 'Leave the table (close and reveal)'}
      </button>
    </section>
  )
}

function Broken({ session }: { session: SessionApi }) {
  return (
    <div className="loss">
      <p>Stopped: {session.broken}. Your last valid signed state is kept in this browser.</p>
      <button type="button" disabled={session.busy} onClick={() => void session.forceClose()}>
        Force close with my last signed state
      </button>{' '}
      <span className="muted">(allowed by the contract 10 minutes after the last settle)</span>
    </div>
  )
}

interface BlackjackProps {
  hand: BjSession | null
  canDeal: boolean
  canMove: boolean
  balance: bigint
  onDeal: () => void
  session: SessionApi
}

function BlackjackControls({ hand, canDeal, canMove, balance, onDeal, session }: BlackjackProps) {
  const myTurn = canMove && hand !== null && !hand.state.done
  // Doubling takes another stake from the session, on the first two cards only.
  const canDouble = myTurn && hand.state.player.length === 2 && balance >= BigInt(hand.stake) * 2n
  return (
    <div className="choices">
      <button type="button" disabled={!canDeal} onClick={onDeal}>
        Deal
      </button>
      <button type="button" disabled={!myTurn} onClick={() => void session.act('hit')}>
        Hit
      </button>
      <button type="button" disabled={!myTurn} onClick={() => void session.act('stand')}>
        Stand
      </button>
      <button type="button" disabled={!canDouble} onClick={() => void session.act('double')}>
        Double
      </button>
    </div>
  )
}

function outcomeLabel(round: CompactRound): string {
  const o = round.outcome
  if ('dice' in o) return `roll ${(o.dice.roll / 100).toFixed(2)}`
  if ('roulette' in o) return `pocket ${o.roulette.pocket}`
  const cards = (c: number[]) => `${c.map(cardLabel).join(' ')} (${handTotal(c).total})`
  return `you ${cards(o.blackjack.player)} · dealer ${cards(o.blackjack.dealer)}`
}

/** The session's rounds, newest first: each one was checked against the server's signed state. */
function RoundList({ rounds }: { rounds: readonly CompactRound[] }) {
  if (rounds.length === 0) return null
  return (
    <table className="grid">
      <caption className="muted">rounds (signed state checked ✓)</caption>
      <tbody>
        {[...rounds].reverse().slice(0, 12).map((round) => {
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

function ClosedSession({ session, s }: { session: SessionApi; s: StoredSession }) {
  const result = session.verified
  return (
    <section className="play">
      <p>
        Session <code>{s.session_id}</code> closed after {s.state.nonce} rounds: {formatUsdc(s.state.balance)} tUSDC back to
        your balance.
      </p>
      {s.server_seed ? (
        <p className="muted">
          revealed seed <code>{s.server_seed}</code>
          <br />
          committed hash <code>{s.ticket.server_seed_hash}</code> · your client seed <code>{s.ticket.client_seed}</code>
        </p>
      ) : null}
      {session.broken ? <p className="loss">{session.broken}</p> : null}
      <button type="button" disabled={!s.server_seed} onClick={session.verify}>
        Verify every round
      </button>{' '}
      <button type="button" className="ghost" onClick={session.forget}>
        New session
      </button>
      {result?.ok ? (
        <p className="win">
          ✓ {result.summary.rounds} rounds replayed from the seed: wagered {formatUsdc(result.summary.wagered)}, paid{' '}
          {formatUsdc(result.summary.paid)}, final balance and hash chain match.
        </p>
      ) : null}
      {result && !result.ok ? <p className="loss">✗ verification failed: {result.error}</p> : null}
      <RoundList rounds={s.rounds} />
    </section>
  )
}
