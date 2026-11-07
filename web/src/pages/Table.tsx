// A seat at one table, full screen: the player sits at the felt facing the dealer, places chips by
// clicking the felt, and plays with the TILT button. Everything else floats over the 3D view.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { formatUsdc } from '../format'
import { diceWinPayout } from '../house'
import { useDemoSession } from '../near/useDemoSession'
import { useNear } from '../near/useNear'
import { TABLE_POLL_MS, useLobby, usePlayer } from '../near/usePoll'
import { useSession, type SessionApi } from '../near/useSession'
import type { CompactRound } from '../near/session-client'
import type { DealerView, RoundView } from '../near/views'
import { dealerMood } from '../scene/mood'
import {
  addChip,
  CHIP_VALUES,
  diceTarget,
  flipDiceSide,
  rebet,
  removeChip,
  slipAmount,
  slipProblem,
  slipRound,
  slipTotal,
  stackChips,
  type DiceTarget,
  type SlipEntry,
} from '../scene/table/felt'
import { createTableScene } from '../scene/table/TableScene'
import type { FeltAction, TableSceneApi } from '../scene/types'
import { useNow } from '../useNow'
import { BetBar, canLeave, ClosedCard, ClosingCard, Drawer, SessionHud, SitCard, WalletHud } from './table/overlays'
import { boardInfo, feltSpot, ownRoundView, stackPoint } from './table/seat'
import { TableLegend } from './table/Legend'

const DEFAULT_DICE: DiceTarget = { chance_bp: 5_000, over: false }

export function Table() {
  const { dealer: dealerId = '' } = useParams()
  const [searchParams] = useSearchParams()
  // Dev `?demo=1`: a local session, no login, server or chain (useDemoSession).
  const demo = import.meta.env.DEV && searchParams.get('demo') === '1'
  const { config, provider, walletId, gameKey } = useNear()
  const lobby = useLobby(TABLE_POLL_MS)
  const player = usePlayer(TABLE_POLL_MS)
  const dealer = lobby.data?.find((d) => d.id === dealerId)
  const live = useSession(config, provider, walletId, gameKey.state === 'ready', dealer, player.data)
  const practice = useDemoSession(dealer)
  const session = demo ? practice : live
  const top = useTopbarBottom()

  if (lobby.error && !lobby.data) return <p className="loss">Could not load the table: {lobby.error}</p>
  if (!lobby.data) return <p className="muted">loading table…</p>
  if (!dealer) return <p>No dealer “{dealerId}”. <Link to="/">Back to the lobby</Link></p>

  // The chain is the truth: a session closed by us, by the server (idle) or force-closed no longer
  // holds the player, even if this browser still keeps it for verification.
  const openOnChain = player.data?.open_session ?? null
  const stored = session.session
  const elsewhere = !demo && stored && stored.ticket.dealer_id !== dealer.id && openOnChain === stored.session_id ? stored : null
  return (
    <div className="seat-view" style={{ top }}>
      <Seat
        key={dealer.id}
        dealer={dealer}
        session={session}
        walletId={demo ? 'demo.testnet' : walletId}
        wallet={demo ? null : player.data ? BigInt(player.data.balance) : null}
        demo={demo}
        offline={!demo && !config.sessionUrl}
        elsewhere={elsewhere?.ticket.dealer_id ?? null}
      />
    </div>
  )
}

/** The seat fills the window under the top bar; the page itself never scrolls. */
function useTopbarBottom(): number {
  const [top, setTop] = useState(0)
  useLayoutEffect(() => {
    const bar = document.querySelector('.topbar')
    const measure = () => setTop(bar ? bar.getBoundingClientRect().bottom : 0)
    measure()
    const observer = new ResizeObserver(measure)
    if (bar) observer.observe(bar)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      observer.disconnect()
      document.body.style.overflow = overflow
    }
  }, [])
  return top
}

interface SeatProps {
  dealer: DealerView
  session: SessionApi
  walletId: string
  /** House balance, null while unknown (or in the demo). */
  wallet: bigint | null
  demo: boolean
  offline: boolean
  /** The table where the player still has an open session, if not this one. */
  elsewhere: string | null
}

function Seat({ dealer, session, walletId, wallet, demo, offline, elsewhere }: SeatProps) {
  const s = session.session
  const here = s !== null && s.ticket.dealer_id === dealer.id
  const playing = here && (session.phase === 'playing' || session.phase === 'closing')
  const closedHere = here && session.phase === 'closed'
  const [slip, setSlip] = useState<SlipEntry[]>([])
  const [chip, setChip] = useState<bigint>(CHIP_VALUES[0])
  const [dice, setDice] = useState<DiceTarget>(DEFAULT_DICE)
  const [drawer, setDrawer] = useState(false)
  const [tilting, setTilting] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const navigate = useNavigate()
  // A new close shows its card again.
  useEffect(() => {
    if (!closedHere) setDismissed(false)
  }, [closedHere])

  const ownRound = useMemo(
    () => (here ? ownRoundView(s, session.hand, session.last, walletId) : null),
    [here, s, session.hand, session.last, walletId],
  )
  const balance = s ? BigInt(s.state.balance) : 0n
  const maxBet = s ? BigInt(s.ticket.max_bet) : BigInt(dealer.max_bet)
  const problem = slipProblem(slip, { minBet: BigInt(dealer.min_bet), maxBet, balance })
  const handLive = session.hand !== null && !session.hand.state.done
  const canBet = playing && !session.busy && !tilting && session.broken === '' && session.phase === 'playing' && !handLive
  const round = slipRound(slip)
  const canTilt = canBet && problem === null && round !== null

  // The whole slip is one round: one spin settles every roulette spot, the slip stays for the next TILT.
  const tilt = useCallback(async () => {
    if (!canTilt || round === null) return
    setTilting(true)
    try {
      await session.bet(round.bet, round.stake)
    } finally {
      setTilting(false)
    }
  }, [canTilt, round, session])

  const onFelt = (u: number, v: number, action: FeltAction, scene: TableSceneApi) => {
    const spot = action === 'leave' ? null : feltSpot(dealer.game, u, v, dice)
    scene.highlight(canBet && spot ? spot.cell : null)
    if (!spot || !canBet || action === 'move' || action === 'leave') return
    if (spot.kind === 'target') {
      const next = diceTarget(spot.position_bp, dice.over)
      setDice(next)
      setSlip((current) => rebet(current, { dice: next }))
    } else if (spot.kind === 'side') {
      const next = flipDiceSide(dice, spot.over)
      setDice(next)
      setSlip((current) => rebet(current, { dice: next }))
    } else if (action === 'add') setSlip((current) => addChip(current, spot.bet, chip))
    else setSlip((current) => removeChip(current, spot.bet))
  }

  // Space skips the animation of the round on screen, else plays the next one.
  const scene = useRef<TableSceneApi | null>(null)
  useKeys({
    ' ': () => (scene.current?.animating() ? scene.current.skip() : void tilt()),
    h: () => handLive && void session.act('hit'),
    s: () => handLive && void session.act('stand'),
    d: () => handLive && void session.act('double'),
    // Esc leaves the table, and once it is closed, the room.
    escape: () => (closedHere ? void navigate('/') : canLeave(session) && void session.close()),
  })

  const center = elsewhere ? (
    <div className="center-card">
      <p>
        You are seated at <Link to={`/table/${elsewhere}`}>{elsewhere}</Link>: leave that table first.
      </p>
    </div>
  ) : offline ? (
    <div className="center-card">
      <p className="muted">Play is offline: no session server configured.</p>
    </div>
  ) : closedHere && s ? (
    dismissed ? null : <ClosedCard session={session} s={s} onDismiss={() => setDismissed(true)} />
  ) : here && session.phase === 'closing' ? (
    <ClosingCard />
  ) : !playing ? (
    <SitCard dealer={dealer} session={session} balance={wallet} loggedIn={walletId !== ''} demo={demo} />
  ) : null

  return (
    <>
      <TableStage
        dealer={dealer}
        ownRound={ownRound}
        drawing={session.busy && session.phase === 'playing'}
        failed={session.error !== ''}
        slip={playing ? slip : []}
        dice={dealer.game === 'dice' ? dice : null}
        rounds={here && s ? s.rounds : []}
        onFelt={onFelt}
        onScene={(created) => (scene.current = created)}
      />
      <SessionHud dealer={dealer} session={here ? session : null} demo={demo} />
      <WalletHud wallet={wallet} demo={demo} onRounds={() => setDrawer((open) => !open)} drawerOpen={drawer} />
      {drawer && here && s ? <Drawer session={session} s={s} /> : null}
      <TableLegend game={dealer.game} />
      {center}
      {session.error ? <p className="seat-toast loss">{session.error}</p> : null}
      {session.broken ? <p className="seat-toast loss">Stopped: {session.broken}</p> : null}
      {playing && session.phase === 'playing' ? (
        <BetBar
          game={dealer.game}
          chip={chip}
          onChip={setChip}
          total={slipTotal(slip)}
          problem={canBet ? problem : null}
          hint={dealer.game === 'dice' && s ? diceHint(dice, slip, s.ticket.rake_bp) : null}
          canTilt={canTilt}
          busy={session.busy || tilting}
          onTilt={() => void tilt()}
          onClear={() => setSlip([])}
          hand={handLive ? session.hand : null}
          canAct={!session.busy && session.broken === ''}
          canDouble={handLive && session.hand !== null && session.hand.state.player.length === 2 && balance >= BigInt(session.hand.stake)}
          onAct={(action) => void session.act(action)}
        />
      ) : null}
    </>
  )
}

function diceHint(dice: DiceTarget, slip: readonly SlipEntry[], rakeBp: number): string {
  const edge = dice.over ? 10_000 - dice.chance_bp : dice.chance_bp
  const stake = slip.length > 0 ? slipAmount(slip[0]) : 0n
  const wins = `roll ${dice.over ? '≥' : '<'} ${(edge / 100).toFixed(2)} wins (${(dice.chance_bp / 100).toFixed(2)} %)`
  return stake > 0n ? `${wins} · pays ${formatUsdc(diceWinPayout(stake, dice.chance_bp, rakeBp))}` : wins
}

/** Single-key shortcuts, ignored while typing in a field. */
function useKeys(bindings: Record<string, () => void>): void {
  const latest = useRef(bindings)
  latest.current = bindings
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || event.metaKey || event.ctrlKey) return
      const run = latest.current[event.key.toLowerCase()]
      if (!run) return
      event.preventDefault()
      run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

interface StageProps {
  dealer: DealerView
  ownRound: RoundView | null
  /** A move is on its way to the session server (about 100 ms): the dealer starts the draw. */
  drawing: boolean
  failed: boolean
  slip: readonly SlipEntry[]
  dice: DiceTarget | null
  rounds: readonly CompactRound[]
  onFelt: (u: number, v: number, action: FeltAction, scene: TableSceneApi) => void
  onScene: (scene: TableSceneApi | null) => void
}

/** The 3D seat: the player's session rounds, the chips on the felt, the dealer's board. */
function TableStage({ dealer, ownRound, drawing, failed, slip, dice, rounds, onFelt, onScene }: StageProps) {
  const host = useRef<HTMLDivElement>(null)
  const [scene, setScene] = useState<TableSceneApi | null>(null)
  // Through a ref: the scene is built once per dealer, the handler changes with every render.
  const felt = useRef(onFelt)
  felt.current = onFelt
  const sceneRef = useRef(onScene)
  sceneRef.current = onScene

  useEffect(() => {
    if (!host.current) return
    let created: TableSceneApi | null = null
    created = createTableScene(host.current, {
      dealerId: dealer.id,
      dealerName: dealer.name,
      game: dealer.game,
      onFelt: (u, v, action) => created && felt.current(u, v, action, created),
    })
    setScene(created)
    sceneRef.current(created)
    return () => {
      created?.dispose()
      setScene(null)
      sceneRef.current(null)
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

  const now = useNow()
  useEffect(() => {
    scene?.setBoard(boardInfo(dealer, rounds, now))
  }, [scene, dealer, rounds, now])

  const shown = useRef<RoundView | null>(null)
  useEffect(() => {
    if (!scene || !ownRound) return
    scene.showRound(shown.current, ownRound)
    shown.current = ownRound
  }, [scene, ownRound])

  useEffect(() => {
    scene?.setSlip(slip.map((entry) => ({ ...stackPoint(entry.bet), chips: stackChips(slipAmount(entry)) })))
  }, [scene, slip])

  useEffect(() => {
    scene?.previewDiceBet(dice)
  }, [scene, dice])

  useEffect(() => {
    if (scene && drawing) scene.startDrawing(dealer.game)
  }, [scene, drawing, dealer.game])
  // On success the director ends the loop with the answer; only a failed move stops it here.
  useEffect(() => {
    if (scene && failed) scene.stopDrawing()
  }, [scene, failed])

  return <div ref={host} className="seat-stage" />
}
