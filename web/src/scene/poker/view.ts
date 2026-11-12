// What the poker scene shows for a table snapshot: the hand in play, else the last hand's result
// (cards shown at showdown, the pot pushed to its winners). Pure, so it is tested without WebGL.
import { formatUsdc } from '../../format'
import type { SeatView, TableState } from '../../near/poker-client'
import { categoryOf, type PokerAction } from '../../near/poker-rules'
import type { PokerSceneState, PokerSeatScene } from './PokerScene'

/** "raise to 1.20", "ALL IN", "call": what a player says over its head. */
export function actionLabel(action: PokerAction): string {
  if (typeof action === 'object') return `raise to ${formatUsdc(action.raise_to)}`
  return action === 'all_in' ? 'ALL IN' : action
}

/** Every chip of the hand: the pots (which already count this street's bets). */
export function potTotal(table: TableState): bigint {
  return (table.hand?.pots ?? []).reduce((sum, p) => sum + BigInt(p.amount), 0n)
}

function seatScene(s: SeatView, table: TableState, cards: readonly (string | null)[], said: string | null): PokerSeatScene {
  return {
    seat: s.seat,
    player: s.player,
    name: s.name,
    npc: s.npc,
    you: table.you?.seat === s.seat,
    stack: s.stack,
    bet: s.bet,
    folded: s.folded,
    allIn: s.all_in,
    cards,
    said,
  }
}

export function pokerScene(table: TableState): PokerSceneState {
  const hand = table.hand
  const you = table.you
  const actionMs = table.config.action_ms
  if (hand && hand.phase !== 'seeding') {
    const seats = table.seats.map((s) => {
      if (!s) return null
      const own = you?.seat === s.seat ? (you.hole ?? []) : null
      const cards = own ?? s.cards ?? (s.in_hand && !s.folded ? [null, null] : [])
      return seatScene(s, table, s.folded && !own ? [] : cards, s.last_action ? actionLabel(s.last_action) : null)
    })
    const bets = table.seats.reduce((sum, s) => sum + BigInt(s?.bet ?? '0'), 0n)
    const total = potTotal(table)
    // Chips in front of the players are drawn there; the middle holds the rest.
    const pots = bets === 0n ? hand.pots.map((p) => p.amount).filter((a) => a !== '0') : total > bets ? [(total - bets).toString()] : []
    return { seats, hand: hand.number, button: hand.button, board: hand.board, pots, toAct: hand.to_act, deadline: hand.deadline, actionMs, winners: [] }
  }
  const last = table.last_hand
  if (last) {
    const seats = table.seats.map((s) => {
      if (!s) return null
      const line = last.result.seats.find((r) => r.seat === s.seat)
      const own = you?.seat === s.seat ? last.players.find((p) => p.seat === s.seat)?.hole : undefined
      const cards = line?.shown ?? own ?? []
      return { ...seatScene(s, table, cards, null), bet: '0', folded: false, allIn: false }
    })
    const winners = last.result.seats
      .filter((r) => r.won !== '0')
      .map((r) => ({ seat: r.seat, amount: r.won, label: r.value === null ? '' : categoryOf(r.value) }))
    return {
      seats,
      hand: last.number,
      button: last.history.start.button,
      board: last.result.board,
      pots: last.result.pots.map((p) => p.amount),
      toAct: null,
      deadline: null,
      actionMs,
      winners,
    }
  }
  return {
    seats: table.seats.map((s) => (s ? seatScene(s, table, [], null) : null)),
    hand: null,
    button: null,
    board: [],
    pots: [],
    toAct: null,
    deadline: null,
    actionMs,
    winners: [],
  }
}
