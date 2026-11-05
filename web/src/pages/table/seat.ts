// Pure helpers of the table seat: session rounds as the scene's RoundView, the dealer's board,
// and what the felt means for the game on it.
import { formatBp, formatCountdown, formatUsdc } from '../../format'
import { cardLabel, diceWins, handTotal, pocketColor } from '../../house'
import { roundWager, type BjSession, type CompactRound } from '../../near/session-client'
import type { StoredSession } from '../../near/useSession'
import type { Bet, DealerView, RoundView } from '../../near/views'
import type { BoardInfo, BoardResult } from '../../scene/table/board'
import { rollLabel } from '../../scene/table/dice'
import {
  BLACKJACK_BET_SPOT,
  betCell,
  betKey,
  blackjackHitAt,
  DICE_BAR,
  DICE_BET_SPOT,
  DICE_SIDES,
  diceHitAt,
  rouletteBetAt,
  type Cell,
  type DiceTarget,
} from '../../scene/table/felt'

// ---- the round on the felt ----------------------------------------------------------------

/** Round ids for the scene: unique per session and nonce, so a new session never "continues" an old round. */
function sceneId(s: StoredSession, nonce: number): number {
  return (Number.parseInt(s.ticket.server_seed_hash.slice(0, 6), 16) % 10_000) * 100_000 + nonce
}

function baseView(s: StoredSession, player: string, nonce: number, bet: Bet, stake: string): RoundView {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: sceneId(s, nonce),
    player,
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
    error: null,
  }
}

function roundView(s: StoredSession, round: CompactRound, player: string, ordinal: number): RoundView {
  const view = baseView(s, player, round.nonce, round.bet, round.stake)
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

function handView(s: StoredSession, hand: BjSession, player: string): RoundView {
  return {
    ...baseView(s, player, hand.nonce, 'blackjack', hand.stake),
    status: 'player_turn',
    step: hand.actions.length,
    wager: (hand.state.doubled ? BigInt(hand.stake) * 2n : BigInt(hand.stake)).toString(),
    bj: hand.state,
  }
}

/** The player's round on the felt: the live blackjack hand, else the last finished round. */
export function ownRoundView(
  s: StoredSession | null,
  hand: BjSession | null,
  last: { round: CompactRound; ordinal: number } | null,
  player: string,
): RoundView | null {
  if (!s) return null
  if (hand) return handView(s, hand, player)
  if (last) return roundView(s, last.round, player, last.ordinal)
  return null
}

// ---- the dealer's board -------------------------------------------------------------------

const WIN = '#2f8a4f'
const LOSS = '#9a2c2c'
const PUSH = '#5a5a62'
const POCKET: Record<string, string> = { red: '#b3202f', black: '#17161a', green: '#178a4a' }

export function resultChip(round: CompactRound): BoardResult {
  const o = round.outcome
  const net = BigInt(round.payout) - roundWager(round)
  const tone = net > 0n ? WIN : net < 0n ? LOSS : PUSH
  if ('roulette' in o) return { text: String(o.roulette.pocket), color: POCKET[pocketColor(o.roulette.pocket)] }
  if ('dice' in o) {
    const bet = round.bet !== 'blackjack' && 'dice' in round.bet ? round.bet.dice : null
    const won = bet ? diceWins(o.dice.roll, bet.chance_bp, bet.over) : net > 0n
    return { text: rollLabel(o.dice.roll).slice(0, 2), color: won ? WIN : LOSS }
  }
  return { text: String(handTotal(o.blackjack.player).total), color: tone }
}

export function boardInfo(dealer: DealerView, rounds: readonly CompactRound[], now: number): BoardInfo {
  const boost = formatCountdown(dealer.boost_until - now)
  return {
    title: `${dealer.name.toUpperCase()} · ${dealer.game.toUpperCase()}`,
    lines: [
      { label: 'house edge', value: formatBp(dealer.total_edge_bp), color: '#f0c26a' },
      { label: 'bets', value: `${formatUsdc(dealer.min_bet)} – ${formatUsdc(dealer.max_bet)}` },
      { label: 'boost', value: boost ? `${boost} left` : 'none', color: boost ? '#7ccf8f' : undefined },
      { label: 'table', value: dealer.open ? 'open' : 'closed', color: dealer.open ? undefined : '#f0715f' },
    ],
    strategy: dealer.reason_text,
    results: rounds.map(resultChip),
  }
}

// ---- the felt for this game ---------------------------------------------------------------

/** What a felt point means: the bet a chip there goes on, and the cell to light up. */
export type FeltSpot =
  | { kind: 'bet'; bet: Bet; cell: Cell }
  | { kind: 'target'; position_bp: number; cell: Cell }
  | { kind: 'side'; over: boolean; cell: Cell }

const SPOT_CELL = { w: 0.12, h: 0.2 }

function around(spot: { u: number; v: number }, size: { w: number; h: number }): Cell {
  return { u: spot.u - size.w / 2, v: spot.v - size.h / 2, w: size.w, h: size.h }
}

export function feltSpot(game: DealerView['game'], u: number, v: number, dice: DiceTarget): FeltSpot | null {
  if (game === 'roulette') {
    const bet = rouletteBetAt(u, v)
    return bet === null ? null : { kind: 'bet', bet: { roulette: bet }, cell: betCell(bet) }
  }
  if (game === 'blackjack') return blackjackHitAt(u, v) ? { kind: 'bet', bet: 'blackjack', cell: around(BLACKJACK_BET_SPOT, SPOT_CELL) } : null
  const hit = diceHitAt(u, v)
  if (hit === null) return null
  if (hit.kind === 'stake') return { kind: 'bet', bet: { dice: dice }, cell: around(DICE_BET_SPOT, SPOT_CELL) }
  if (hit.kind === 'target') {
    const bar = { u: DICE_BAR.u0, v: DICE_BAR.v - DICE_BAR.halfH, w: DICE_BAR.u1 - DICE_BAR.u0, h: DICE_BAR.halfH * 2 }
    return { kind: 'target', position_bp: hit.position_bp, cell: bar }
  }
  const side = hit.over ? DICE_SIDES.over : DICE_SIDES.under
  return { kind: 'side', over: hit.over, cell: around(side, { w: DICE_SIDES.halfW * 2, h: DICE_SIDES.halfH * 2 }) }
}

/** Felt point where a bet's chips stack. */
export function stackPoint(bet: Bet): { u: number; v: number } {
  if (bet === 'blackjack') return BLACKJACK_BET_SPOT
  if ('dice' in bet) return DICE_BET_SPOT
  const cell = betCell(bet.roulette)
  return { u: cell.u + cell.w / 2, v: cell.v + cell.h / 2 }
}

export function betLabel(bet: Bet): string {
  if (bet === 'blackjack') return 'blackjack'
  if ('dice' in bet) {
    const { chance_bp: chance, over } = bet.dice
    return `roll ${over ? '≥' : '<'} ${rollLabel(over ? 10_000 - chance : chance)}`
  }
  return betKey(bet).replace(':', ' ').replace('straight', 'number')
}

export function outcomeLabel(round: CompactRound): string {
  const o = round.outcome
  if ('dice' in o) return `roll ${rollLabel(o.dice.roll)}`
  if ('roulette' in o) return `pocket ${o.roulette.pocket}`
  const cards = (c: number[]) => `${c.map(cardLabel).join(' ')} (${handTotal(c).total})`
  return `you ${cards(o.blackjack.player)} · dealer ${cards(o.blackjack.dealer)}`
}
