import type { DealerView, RouletteBet } from './near/views'

/**
 * UI-side copies of a few `core_rules` constants, only to label and pre-check forms. The
 * contract re-checks everything, so a drift here can only refuse a move, never pay wrongly.
 */

/** `core_rules::dice::{MIN_CHANCE_BP, MAX_CHANCE_BP}`. */
export const DICE_MIN_CHANCE_BP = 100
export const DICE_MAX_CHANCE_BP = 9_800

export const EXPLORER_TX = 'https://testnet.nearblocks.io/txns/'

const BP = 10_000n

/** `core_rules::apply_rake`: the rake is `rake_bp` of the gross, taken only out of a gain, rounded up. */
export function applyRake(gross: bigint, wager: bigint, rakeBp: number): bigint {
  if (gross <= wager) return gross
  const cut = (gross * BigInt(rakeBp) + BP - 1n) / BP
  const gain = gross - wager
  return gross - (cut < gain ? cut : gain)
}

/** What a winning dice bet pays back (stake included, after rake): fair odds `stake × 10000 / chance`. */
export function diceWinPayout(stake: bigint, chanceBp: number, rakeBp: number): bigint {
  return applyRake((stake * BP) / BigInt(chanceBp), stake, rakeBp)
}

/**
 * Roulette payout multiple (stake included): 36× a number, 18× a split, 12× a street, 9× a corner,
 * 6× a six line, 3× a dozen or column, 2× even-money bets.
 */
export function rouletteWinMultiple(bet: RouletteBet): bigint {
  if (typeof bet === 'string') return 2n
  if ('straight' in bet) return 36n
  if ('split' in bet) return 18n
  if ('street' in bet) return 12n
  if ('corner' in bet) return 9n
  if ('six_line' in bet) return 6n
  return 3n
}

/** `DiceBet::wins`: under wins below `chance`, over wins at or above `10000 − chance`. */
export function diceWins(roll: number, chanceBp: number, over: boolean): boolean {
  return over ? roll >= 10_000 - chanceBp : roll < chanceBp
}

/**
 * What investors must bring to reopen a closed table: the pool opens again once its free
 * bankroll covers the worst case of a minimum bet (`Pool::is_open`).
 */
export function reopenNeeds(
  dealer: Pick<DealerView, 'min_bet' | 'worst_case_multiple' | 'bankroll' | 'reserved'>,
): bigint {
  const needed = BigInt(dealer.min_bet) * BigInt(dealer.worst_case_multiple) - freeBankroll(dealer)
  return needed > 0n ? needed : 0n
}

/** Pool size as players see it: bankroll not backing open bets. */
export function freeBankroll(dealer: Pick<DealerView, 'bankroll' | 'reserved'>): bigint {
  const free = BigInt(dealer.bankroll) - BigInt(dealer.reserved)
  return free > 0n ? free : 0n
}

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36])

export function pocketColor(pocket: number): 'red' | 'black' | 'green' {
  if (pocket === 0) return 'green'
  return RED.has(pocket) ? 'red' : 'black'
}

export function rouletteBetLabel(bet: RouletteBet): string {
  if (typeof bet === 'string') return bet
  if ('dozen' in bet) return `dozen ${bet.dozen}`
  if ('column' in bet) return `column ${bet.column}`
  if ('split' in bet) return `split ${bet.split[0]}/${bet.split[1]}`
  if ('street' in bet) return `street ${bet.street}-${bet.street + 2}`
  if ('corner' in bet) return `corner ${[0, 1, 3, 4].map((d) => bet.corner + d).join('/')}`
  if ('six_line' in bet) return `six line ${bet.six_line}-${bet.six_line + 5}`
  return `number ${bet.straight}`
}

const RANK_LABEL: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }

/** `core_rules::bj_total`: cards are ranks 1..=13 (ace 1, faces 10); an ace counts 11 when it fits. */
export function handTotal(cards: readonly number[]): { total: number; soft: boolean } {
  const hard = cards.reduce((sum, rank) => sum + Math.min(rank, 10), 0)
  const soft = cards.includes(1) && hard + 10 <= 21
  return { total: soft ? hard + 10 : hard, soft }
}

export function cardLabel(rank: number): string {
  return RANK_LABEL[rank] ?? String(rank)
}
