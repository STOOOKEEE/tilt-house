// What the felt means where the player clicks, and how chips stack on it. Pure (no three.js):
// felt coordinates are u (0 left → 1 right) and v (0 dealer side → 1 player side).
import { DICE_MAX_CHANCE_BP, DICE_MIN_CHANCE_BP } from '../../house'
import type { Bet, RouletteBet } from '../../near/views'

export interface Cell {
  u: number
  v: number
  w: number
  h: number
}

// ---- roulette layout ----------------------------------------------------------------------

/** 14 columns (0, twelve number columns, 2:1) × 5 rows (three number rows, dozens, outside bets). */
const LAYOUT = { u0: 0.45, u1: 0.97, v0: 0.2, v1: 0.8 }
const COLS = 14
const ROWS = 5
const CW = (LAYOUT.u1 - LAYOUT.u0) / COLS
const RH = (LAYOUT.v1 - LAYOUT.v0) / ROWS
export const OUTSIDE = ['low', 'even', 'red', 'black', 'odd', 'high'] as const

/** 1..36 in 12 columns of 3 (3, 6, 9… on the top row), 0 down the left side. */
export function numberCell(n: number): Cell {
  if (n === 0) return { u: LAYOUT.u0, v: LAYOUT.v0, w: CW, h: RH * 3 }
  const col = Math.floor((n - 1) / 3)
  const row = 2 - ((n - 1) % 3)
  return { u: LAYOUT.u0 + CW * (1 + col), v: LAYOUT.v0 + RH * row, w: CW, h: RH }
}

/** Where chips go for a bet. */
export function betCell(bet: RouletteBet): Cell {
  if (typeof bet === 'string') {
    return { u: LAYOUT.u0 + CW * (1 + 2 * OUTSIDE.indexOf(bet)), v: LAYOUT.v0 + RH * 4, w: CW * 2, h: RH }
  }
  if ('straight' in bet) return numberCell(bet.straight)
  if ('dozen' in bet) return { u: LAYOUT.u0 + CW * (1 + 4 * (bet.dozen - 1)), v: LAYOUT.v0 + RH * 3, w: CW * 4, h: RH }
  return { u: LAYOUT.u0 + CW * 13, v: LAYOUT.v0 + RH * (3 - bet.column), w: CW, h: RH }
}

/** The roulette bet printed under a felt point: the exact inverse of `betCell`. */
export function rouletteBetAt(u: number, v: number): RouletteBet | null {
  const col = Math.floor((u - LAYOUT.u0) / CW)
  const row = Math.floor((v - LAYOUT.v0) / RH)
  if (u < LAYOUT.u0 || v < LAYOUT.v0 || col >= COLS || row >= ROWS) return null
  if (row <= 2) {
    if (col === 0) return { straight: 0 }
    if (col === 13) return { column: 3 - row }
    return { straight: (col - 1) * 3 + (3 - row) }
  }
  if (col === 0 || col === 13) return null
  if (row === 3) return { dozen: Math.floor((col - 1) / 4) + 1 }
  return OUTSIDE[Math.floor((col - 1) / 2)]
}

// ---- dice and blackjack spots -------------------------------------------------------------

/** Where the dice stake sits, and the 0-100 bar the player sets the target on. */
export const DICE_BET_SPOT = { u: 0.5, v: 0.66 }
export const DICE_BAR = { u0: 0.14, u1: 0.86, v: 0.8, halfH: 0.07 }
/** Printed buttons either side of the stake circle (clear of the bottom overlays): which side of the target wins. */
export const DICE_SIDES = { under: { u: 0.27, v: 0.66 }, over: { u: 0.73, v: 0.66 }, halfW: 0.09, halfH: 0.045 } as const
export const BLACKJACK_BET_SPOT = { u: 0.5, v: 0.84 }
/** Bet circles are easy targets: a little wider than what is printed. */
const SPOT_RADIUS = { u: 0.06, v: 0.1 }
const CHANCE_SNAP_BP = 50

function inSpot(u: number, v: number, spot: { u: number; v: number }): boolean {
  return ((u - spot.u) / SPOT_RADIUS.u) ** 2 + ((v - spot.v) / SPOT_RADIUS.v) ** 2 <= 1
}

export type DiceTarget = { chance_bp: number; over: boolean }

/** What a click on the dice felt does. */
export type DiceHit = { kind: 'stake' } | { kind: 'target'; position_bp: number } | { kind: 'side'; over: boolean }

export function diceHitAt(u: number, v: number): DiceHit | null {
  if (inSpot(u, v, DICE_BET_SPOT)) return { kind: 'stake' }
  if (Math.abs(v - DICE_BAR.v) <= DICE_BAR.halfH && u >= DICE_BAR.u0 && u <= DICE_BAR.u1) {
    return { kind: 'target', position_bp: Math.round(((u - DICE_BAR.u0) / (DICE_BAR.u1 - DICE_BAR.u0)) * 10_000) }
  }
  for (const over of [false, true]) {
    const b = over ? DICE_SIDES.over : DICE_SIDES.under
    if (Math.abs(u - b.u) <= DICE_SIDES.halfW && Math.abs(v - b.v) <= DICE_SIDES.halfH) return { kind: 'side', over }
  }
  return null
}

/**
 * The bet a target set on the bar means: the split point stays where the player put it, so
 * "under" wins below it (chance = position) and "over" wins at or above it (chance = 100 − position),
 * snapped to 0.5 % and clamped to what core accepts.
 */
export function diceTarget(positionBp: number, over: boolean): DiceTarget {
  const raw = over ? 10_000 - positionBp : positionBp
  const snapped = Math.round(raw / CHANCE_SNAP_BP) * CHANCE_SNAP_BP
  return { chance_bp: Math.min(DICE_MAX_CHANCE_BP, Math.max(DICE_MIN_CHANCE_BP, snapped)), over }
}

/** Switching side keeps the split point on the bar (so the zone flips, not the marker). */
export function flipDiceSide(target: DiceTarget, over: boolean): DiceTarget {
  if (target.over === over) return target
  return diceTarget(target.over ? 10_000 - target.chance_bp : target.chance_bp, over)
}

export function blackjackHitAt(u: number, v: number): boolean {
  return inSpot(u, v, BLACKJACK_BET_SPOT)
}

// ---- chips --------------------------------------------------------------------------------

/** Chip values in base units: 0.1, 0.5, 1 and 5 tUSDC. */
export const CHIP_VALUES = [100_000n, 500_000n, 1_000_000n, 5_000_000n] as const
/** One colour per chip value (felt stacks and the on-screen chip picker). */
const CHIP_COLOR: Record<string, string> = {
  '100000': '#f4f1ea',
  '500000': '#ec6fae',
  '1000000': '#f0c26a',
  '5000000': '#7ccf8f',
}

export const chipColor = (value: bigint): string => CHIP_COLOR[value.toString()] ?? '#4a7bd6'

/** Tallest stack drawn per cell; the label still shows the full amount. */
export const MAX_STACK_CHIPS = 20

/** One betting spot with its chips, in the order they were placed. */
export interface SlipEntry {
  key: string
  bet: Bet
  chips: bigint[]
}

export function betKey(bet: Bet): string {
  if (bet === 'blackjack') return 'blackjack'
  if ('dice' in bet) return 'dice'
  const r = bet.roulette
  if (typeof r === 'string') return r
  if ('straight' in r) return `straight:${r.straight}`
  return 'dozen' in r ? `dozen:${r.dozen}` : `column:${r.column}`
}

export const slipAmount = (entry: SlipEntry): bigint => entry.chips.reduce((sum, c) => sum + c, 0n)

export function slipTotal(slip: readonly SlipEntry[]): bigint {
  return slip.reduce((sum, e) => sum + slipAmount(e), 0n)
}

/** Adds a chip on `bet`'s spot (a new spot goes last, so rounds play in the order bets were made). */
export function addChip(slip: readonly SlipEntry[], bet: Bet, chip: bigint): SlipEntry[] {
  const key = betKey(bet)
  if (!slip.some((e) => e.key === key)) return [...slip, { key, bet, chips: [chip] }]
  // The dice bet keeps its stack when the target moves: the latest bet replaces the old one.
  return slip.map((e) => (e.key === key ? { ...e, bet, chips: [...e.chips, chip] } : e))
}

/** Takes the last chip placed on `bet`'s spot off; an empty spot disappears. */
export function removeChip(slip: readonly SlipEntry[], bet: Bet): SlipEntry[] {
  const key = betKey(bet)
  return slip.flatMap((e) => (e.key !== key ? [e] : e.chips.length > 1 ? [{ ...e, chips: e.chips.slice(0, -1) }] : []))
}

/** Same chips, another bet (the dice target moved). */
export function rebet(slip: readonly SlipEntry[], bet: Bet): SlipEntry[] {
  const key = betKey(bet)
  return slip.map((e) => (e.key === key ? { ...e, bet } : e))
}

/**
 * The chips drawn for an amount: biggest values first (bottom of the stack), as a dealer would
 * colour it up, capped at `MAX_STACK_CHIPS`.
 */
export function stackChips(amount: bigint): bigint[] {
  const chips: bigint[] = []
  let left = amount
  for (const value of [...CHIP_VALUES].reverse()) {
    while (left >= value && chips.length < MAX_STACK_CHIPS) {
      chips.push(value)
      left -= value
    }
  }
  return chips
}

export interface SlipLimits {
  minBet: bigint
  maxBet: bigint
  /** What the session can still put at risk. */
  balance: bigint
}

/**
 * Why the slip cannot be played, or null. Each spot is one round: it must fit the table's limits;
 * together they must fit the session balance (they all play, one after the other).
 */
export function slipProblem(slip: readonly SlipEntry[], limits: SlipLimits): string | null {
  if (slip.length === 0) return 'place chips on the felt'
  for (const entry of slip) {
    const amount = slipAmount(entry)
    if (amount < limits.minBet) return 'a spot is under the minimum bet'
    if (amount > limits.maxBet) return 'a spot is over the maximum bet'
  }
  if (slipTotal(slip) > limits.balance) return 'more than your session balance'
  return null
}
