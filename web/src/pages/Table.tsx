import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { LoginPrompt } from '../components/LoginPrompt'
import { DiceForm, RouletteForm } from '../components/GameForms'
import { RoundResult } from '../components/RoundResult'
import { formatBp, formatCountdown, formatUsdc, parseUsdc } from '../format'
import { reopenNeeds } from '../house'
import type { GameMethod } from '../near/delegate'
import { playMove } from '../near/session'
import { useNear } from '../near/useNear'
import { PENDING_POLL_MS, TABLE_POLL_MS, useLobby, usePlayer, usePoll } from '../near/usePoll'
import { getConfig, getRound, type DealerView, type PlayerView, type RoundView } from '../near/views'
import { dealerMood } from '../scene/mood'
import { demoRound, LATENCY_DRAW_MS, LATENCY_INCLUDED_MS } from '../scene/table/demo'
import { watchTable } from '../scene/table/spectator'
import { createTableScene } from '../scene/table/TableScene'
import type { TableSceneApi } from '../scene/types'
import { useNow } from '../useNow'

// The VRF key and refund delay only change with an owner call; a slow poll is plenty.
const CONFIG_POLL_MS = 60_000
const DEFAULT_REFUND_AFTER_SECS = 120
/** Dev `?demo=1`: one scripted snapshot every this many ms. */
const DEMO_STEP_MS = 2_500
/** The relayer answers a move at inclusion: if its round never changes, the move failed on chain. */
const MOVE_VISIBLE_TIMEOUT_MS = 30_000

/** Changes with every new state of a round: tells the round after a move from the one before. */
function roundKey(round: RoundView | null): string {
  return round === null ? '' : `${round.id}:${round.step}:${round.status}:${round.updated_at}`
}

export function Table() {
  const { dealer: dealerId = '' } = useParams()
  const { config, provider, walletId, gameKey } = useNear()
  // From the click until the round shows the draw's answer: the scene loops its draw gesture and
  // the page polls fast. `from` is the round's state at the click.
  const [pending, setPending] = useState<{ from: string } | null>(null)
  const [ownWaiting, setOwnWaiting] = useState(false)
  const pollMs = pending !== null || ownWaiting ? PENDING_POLL_MS : TABLE_POLL_MS
  const lobby = useLobby(TABLE_POLL_MS)
  const player = usePlayer(pollMs)
  const houseConfig = usePoll(useCallback(() => getConfig(config), [config]), CONFIG_POLL_MS)
  const dealer = lobby.data?.find((d) => d.id === dealerId)

  // The round on screen: the player's latest. After a bet we wait for `last_round` to move off
  // `staleRound`, so the previous result is not shown as the new one.
  const [staleRound, setStaleRound] = useState<number | null | undefined>(undefined)
  const [txHashes, setTxHashes] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [moveError, setMoveError] = useState('')
  const lastRound = player.data?.last_round ?? null
  const roundId = staleRound !== undefined && lastRound === staleRound ? null : lastRound
  useEffect(() => {
    if (staleRound !== undefined && lastRound !== staleRound) setStaleRound(undefined)
  }, [lastRound, staleRound])

  const loadRound = useCallback(() => getRound(config, roundId ?? 0), [config, roundId])
  const round = usePoll(roundId === null ? null : loadRound, pollMs)
  const shownRound = round.data?.id === roundId ? round.data : null
  const waiting = shownRound?.status === 'waiting_vrf' && shownRound.player === walletId
  useEffect(() => setOwnWaiting(waiting), [waiting])

  const moved = pending !== null && shownRound !== null && roundKey(shownRound) !== pending.from
  useEffect(() => {
    if (moved && !waiting) setPending(null)
  }, [moved, waiting])
  useEffect(() => {
    if (pending === null || moved) return
    const timer = window.setTimeout(() => {
      setPending(null)
      setStaleRound(undefined)
      setMoveError('your move did not show up on chain: check your balance and try again')
    }, MOVE_VISIBLE_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [pending, moved])

  // A failed draw blocks new bets until refunded (contract-api.md): refund it once, unprompted.
  const refundedFailed = useRef<number | null>(null)
  const failedId = shownRound?.status === 'failed' && shownRound.player === walletId ? shownRound.id : null

  const send = async (method: GameMethod, args: Record<string, unknown>, newRound: boolean) => {
    setSending(true)
    setMoveError('')
    if (method !== 'refund_stuck_round') setPending({ from: roundKey(shownRound) })
    try {
      if (newRound) setStaleRound(lastRound)
      const { txHash } = await playMove(walletId, provider, config, method, args)
      setTxHashes((hashes) => (newRound ? [txHash] : [...hashes, txHash]))
    } catch (error) {
      if (newRound) setStaleRound(undefined)
      setPending(null)
      setMoveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
      player.refresh()
      round.refresh()
    }
  }

  useEffect(() => {
    if (failedId === null || sending || refundedFailed.current === failedId) return
    refundedFailed.current = failedId
    void send('refund_stuck_round', { round_id: failedId }, false)
  })

  if (lobby.error && !lobby.data) return <p className="loss">Could not load the table: {lobby.error}</p>
  if (!lobby.data) return <p className="muted">loading table…</p>
  if (!dealer) return <p>No dealer “{dealerId}”. <Link to="/">Back to the lobby</Link></p>

  return (
    <>
      <TableStage
        dealer={dealer}
        ownRound={shownRound?.dealer_id === dealer.id ? shownRound : null}
        walletId={walletId}
        drawing={pending !== null}
        moveFailed={moveError !== ''}
      />
      <DealerHeader dealer={dealer} />
      {!walletId ? <LoginPrompt action="play" /> : null}
      <PlayArea
        dealer={dealer}
        player={player.data}
        round={shownRound}
        loggedIn={walletId !== ''}
        ready={gameKey.state === 'ready'}
        sending={sending || pending !== null}
        onMove={(method, args, newRound) => void send(method, args, newRound)}
      />
      {moveError ? <p className="loss">{moveError}</p> : null}
      {roundId !== null && !shownRound ? <p className="muted">loading round #{roundId}…</p> : null}
      {staleRound !== undefined ? <p className="muted">placing your bet…</p> : null}
      {shownRound ? (
        <RoundResult
          round={shownRound}
          txHashes={txHashes}
          vrfPubkeyHex={houseConfig.data?.vrf_pubkey_hex ?? null}
          relayerAccount={config.relayerAccount}
          refundAfterSecs={houseConfig.data?.refund_after_secs ?? DEFAULT_REFUND_AFTER_SECS}
          onRefund={
            walletId && !sending ? () => void send('refund_stuck_round', { round_id: shownRound.id }, false) : null
          }
        />
      ) : null}
    </>
  )
}

interface StageProps {
  dealer: DealerView
  /** The player's round at this table; null shows other players' rounds instead. */
  ownRound: RoundView | null
  walletId: string
  /** The player just moved: the dealer draws until the round shows the answer. */
  drawing: boolean
  moveFailed: boolean
}

/** The 3D table: the player's own round when there is one, else live rounds of others at this dealer. */
function TableStage({ dealer, ownRound, walletId, drawing, moveFailed }: StageProps) {
  const { config } = useNear()
  const [searchParams] = useSearchParams()
  const demo = import.meta.env.DEV && searchParams.get('demo') === '1'
  // Dev `?latency=1`: a mock move with the real stack's timings, to check the click-to-result flow.
  const latency = import.meta.env.DEV && searchParams.get('latency') === '1'
  const scripted = demo || latency
  const host = useRef<HTMLDivElement>(null)
  const [scene, setScene] = useState<TableSceneApi | null>(null)
  const [onFelt, setOnFelt] = useState<string | null>(null)
  const [spectatorError, setSpectatorError] = useState('')

  useEffect(() => {
    if (!host.current) return
    const created = createTableScene(host.current, {
      dealerId: dealer.id,
      dealerName: dealer.name,
      game: dealer.game,
      onRound: (round) => setOnFelt(round.player),
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
    if (!scene || !ownRound || scripted) return
    scene.showRound(shown.current, ownRound)
    shown.current = ownRound
  }, [scene, ownRound, scripted])

  useEffect(() => {
    if (scene && drawing) scene.startDrawing(dealer.game)
  }, [scene, drawing, dealer.game])
  // On success the director ends the loop with the answer; only a failed move stops it here.
  useEffect(() => {
    if (scene && moveFailed) scene.stopDrawing()
  }, [scene, moveFailed])

  const spectating = ownRound === null && !scripted && !drawing
  useEffect(() => {
    if (!scene || !spectating) return
    return watchTable({
      target: config,
      dealerId: dealer.id,
      intervalMs: TABLE_POLL_MS,
      onRound: (previous, next) => scene.showRound(previous, next),
      onError: setSpectatorError,
    })
  }, [scene, spectating, config, dealer.id])

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

  const [mockTimes, setMockTimes] = useState('')
  const mockMove = () => {
    if (!scene) return
    const clicked = performance.now()
    const [placed, answered] = demoRound(dealer.game, dealer.id, Math.floor(clicked))
    scene.startDrawing(dealer.game)
    requestAnimationFrame(() => setMockTimes(`motion after ${Math.round(performance.now() - clicked)} ms`))
    window.setTimeout(() => scene.showRound(null, placed), LATENCY_INCLUDED_MS)
    window.setTimeout(() => {
      scene.showRound(placed, answered)
      setMockTimes((times) => `${times} · round settled at ${Math.round(performance.now() - clicked)} ms`)
    }, LATENCY_DRAW_MS)
  }

  const watching = onFelt !== null && onFelt !== walletId ? onFelt : null
  return (
    <div style={{ position: 'relative', height: 'min(58vh, 540px)', marginBottom: '1rem' }}>
      <div ref={host} style={{ position: 'absolute', inset: 0, borderRadius: 6, overflow: 'hidden' }} />
      <p className="muted" style={{ position: 'absolute', left: 12, top: 4, margin: 0 }}>
        {scripted ? `${demo ? 'demo round' : 'mock move'} (scripted)` : watching ? `watching ${watching}` : spectating ? 'waiting for players…' : null}
      </p>
      {latency ? (
        <p style={{ position: 'absolute', right: 12, top: 4, margin: 0 }}>
          <button type="button" onClick={mockMove}>
            mock move
          </button>{' '}
          <span className="muted" data-testid="latency-times">
            {mockTimes}
          </span>
        </p>
      ) : null}
      {spectatorError ? (
        <p className="loss" style={{ position: 'absolute', left: 12, bottom: 4, margin: 0 }}>
          live rounds: {spectatorError}
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

interface PlayAreaProps {
  dealer: DealerView
  player: PlayerView | null
  round: RoundView | null
  /** Logged out, the table still shows its games (disabled) so visitors see what they would play. */
  loggedIn: boolean
  ready: boolean
  sending: boolean
  onMove: (method: GameMethod, args: Record<string, unknown>, newRound: boolean) => void
}

function PlayArea({ dealer, player, round, loggedIn, ready, sending, onMove }: PlayAreaProps) {
  const [stakeText, setStakeText] = useState(() => formatUsdc(dealer.min_bet, 0))
  const stake = parseUsdc(stakeText)
  const balance = player ? BigInt(player.balance) : 0n
  const stakeProblem = checkStake(stake, dealer, balance)
  const openRound = player?.open_round ?? null
  const canBet = ready && !sending && dealer.open && openRound === null && stakeProblem === '' && player !== null
  const bet = (method: GameMethod, args: Record<string, unknown>) =>
    onMove(method, { dealer_id: dealer.id, stake: String(stake), ...args }, true)

  return (
    <section className="play">
      <label className="stake">
        stake (tUSDC)
        <input value={stakeText} inputMode="decimal" onChange={(event) => setStakeText(event.target.value)} />
        {loggedIn ? <span className="muted">balance {formatUsdc(balance)}</span> : null}
      </label>
      {loggedIn && stakeProblem ? <p className="loss">{stakeProblem}</p> : null}
      {loggedIn && !ready ? <p className="muted">setting up your game key…</p> : null}
      {openRound !== null && round?.status !== 'player_turn' ? (
        <p className="muted">round #{openRound} in progress: the next one starts once it settles.</p>
      ) : null}
      {dealer.game === 'dice' ? (
        <DiceForm stake={stake} rakeBp={dealer.rake_bp} disabled={!canBet} onBet={(args) => bet('bet_dice', args)} />
      ) : null}
      {dealer.game === 'roulette' ? (
        <RouletteForm
          stake={stake}
          rakeBp={dealer.rake_bp}
          disabled={!canBet}
          onBet={(args) => bet('bet_roulette', args)}
        />
      ) : null}
      {dealer.game === 'blackjack' ? (
        <BlackjackControls
          round={round}
          balance={balance}
          canDeal={canBet}
          canMove={ready && !sending}
          onDeal={() => bet('bj_deal', {})}
          onMove={(method) => round && onMove(method, { round_id: round.id }, false)}
        />
      ) : null}
    </section>
  )
}

/** Mirrors the contract's bet checks so the button explains itself; the contract still decides. */
function checkStake(stake: bigint | null, dealer: DealerView, balance: bigint): string {
  if (stake === null) return 'Enter a stake like 0.5'
  if (stake < BigInt(dealer.min_bet)) return `Minimum bet is ${formatUsdc(dealer.min_bet)}`
  if (stake > BigInt(dealer.max_bet)) return `This dealer takes at most ${formatUsdc(dealer.max_bet)} right now`
  if (stake > balance) return 'Not enough balance: deposit in Pools'
  return ''
}

interface BlackjackProps {
  round: RoundView | null
  balance: bigint
  canDeal: boolean
  canMove: boolean
  onDeal: () => void
  onMove: (method: 'bj_hit' | 'bj_stand' | 'bj_double') => void
}

function BlackjackControls({ round, balance, canDeal, canMove, onDeal, onMove }: BlackjackProps) {
  const myTurn = canMove && round?.game === 'blackjack' && round.status === 'player_turn'
  // Doubling takes another stake from the balance, on the first two cards only.
  const canDouble = myTurn && round.bj?.player.length === 2 && balance >= BigInt(round.stake)
  return (
    <div className="choices">
      <button type="button" disabled={!canDeal} onClick={onDeal}>
        Deal
      </button>
      <button type="button" disabled={!myTurn} onClick={() => onMove('bj_hit')}>
        Hit
      </button>
      <button type="button" disabled={!myTurn} onClick={() => onMove('bj_stand')}>
        Stand
      </button>
      <button type="button" disabled={!canDouble} onClick={() => onMove('bj_double')}>
        Double
      </button>
    </div>
  )
}
