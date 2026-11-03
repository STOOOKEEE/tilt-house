import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { LoginPrompt } from '../components/LoginPrompt'
import { DiceForm, RouletteForm } from '../components/GameForms'
import { RoundResult } from '../components/RoundResult'
import { formatBp, formatCountdown, formatUsdc, parseUsdc } from '../format'
import { reopenNeeds } from '../house'
import type { GameMethod } from '../near/delegate'
import { playMove } from '../near/session'
import { useNear } from '../near/useNear'
import { TABLE_POLL_MS, useLobby, usePlayer, usePoll } from '../near/usePoll'
import { getConfig, getRound, type DealerView, type PlayerView, type RoundView } from '../near/views'
import { useNow } from '../useNow'

// The VRF key and refund delay only change with an owner call; a slow poll is plenty.
const CONFIG_POLL_MS = 60_000
const DEFAULT_REFUND_AFTER_SECS = 120

export function Table() {
  const { dealer: dealerId = '' } = useParams()
  const { config, provider, walletId, gameKey } = useNear()
  const lobby = useLobby(TABLE_POLL_MS)
  const player = usePlayer(TABLE_POLL_MS)
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
  const round = usePoll(roundId === null ? null : loadRound, TABLE_POLL_MS)
  const shownRound = round.data?.id === roundId ? round.data : null

  const send = async (method: GameMethod, args: Record<string, unknown>, newRound: boolean) => {
    setSending(true)
    setMoveError('')
    try {
      if (newRound) setStaleRound(lastRound)
      const { txHash } = await playMove(walletId, provider, config, method, args)
      setTxHashes((hashes) => (newRound ? [txHash] : [...hashes, txHash]))
    } catch (error) {
      if (newRound) setStaleRound(undefined)
      setMoveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
      player.refresh()
      round.refresh()
    }
  }

  if (lobby.error && !lobby.data) return <p className="loss">Could not load the table: {lobby.error}</p>
  if (!lobby.data) return <p className="muted">loading table…</p>
  if (!dealer) return <p>No dealer “{dealerId}”. <Link to="/">Back to the lobby</Link></p>

  return (
    <>
      <DealerHeader dealer={dealer} />
      {!walletId ? <LoginPrompt action="play" /> : null}
      <PlayArea
        dealer={dealer}
        player={player.data}
        round={shownRound}
        loggedIn={walletId !== ''}
        ready={gameKey.state === 'ready'}
        sending={sending}
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
          refundAfterSecs={houseConfig.data?.refund_after_secs ?? DEFAULT_REFUND_AFTER_SECS}
          onRefund={
            walletId && !sending ? () => void send('refund_stuck_round', { round_id: shownRound.id }, false) : null
          }
        />
      ) : null}
    </>
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
