import { describe, expect, it } from 'vitest'
import type { Bet, RouletteBet } from '../../near/views'
import {
  addChip,
  betCell,
  betKey,
  blackjackHitAt,
  CHIP_VALUES,
  DICE_BAR,
  DICE_BET_SPOT,
  DICE_SIDES,
  diceHitAt,
  diceTarget,
  flipDiceSide,
  MAX_STACK_CHIPS,
  OUTSIDE,
  removeChip,
  rouletteBetAt,
  slipProblem,
  slipTotal,
  stackChips,
} from './felt'

const ALL_ROULETTE_BETS: RouletteBet[] = [
  ...Array.from({ length: 37 }, (_, n) => ({ straight: n })),
  ...[1, 2, 3].map((dozen) => ({ dozen })),
  ...[1, 2, 3].map((column) => ({ column })),
  ...OUTSIDE,
]

describe('rouletteBetAt', () => {
  it.each(ALL_ROULETTE_BETS.map((bet) => [betKey({ roulette: bet }), bet] as const))('a click inside %s is that bet', (_, bet) => {
    const cell = betCell(bet)
    for (const [fu, fv] of [[0.5, 0.5], [0.05, 0.05], [0.95, 0.95]]) {
      expect(rouletteBetAt(cell.u + cell.w * fu, cell.v + cell.h * fv)).toEqual(bet)
    }
  })

  it('reads the printed layout: 3 on the top row, 34 bottom right, red under the dozens', () => {
    const top = betCell({ straight: 3 })
    expect(top.v).toBeLessThan(betCell({ straight: 1 }).v)
    expect(rouletteBetAt(betCell({ straight: 34 }).u + 0.001, betCell({ straight: 34 }).v + 0.001)).toEqual({ straight: 34 })
    expect(betCell('red').v).toBeGreaterThan(betCell({ dozen: 1 }).v)
  })

  it('is null off the layout and in the dead corners under 0 and 2:1', () => {
    expect(rouletteBetAt(0.2, 0.5)).toBeNull() // the wheel
    expect(rouletteBetAt(0.99, 0.5)).toBeNull()
    expect(rouletteBetAt(0.6, 0.1)).toBeNull()
    expect(rouletteBetAt(0.6, 0.85)).toBeNull()
    const zero = betCell({ straight: 0 })
    expect(rouletteBetAt(zero.u + zero.w / 2, betCell('low').v + 0.01)).toBeNull()
  })
})

describe('dice felt', () => {
  it('finds the stake spot, the bar and the side buttons', () => {
    expect(diceHitAt(DICE_BET_SPOT.u, DICE_BET_SPOT.v)).toEqual({ kind: 'stake' })
    expect(diceHitAt(DICE_BAR.u0, DICE_BAR.v)).toEqual({ kind: 'target', position_bp: 0 })
    expect(diceHitAt((DICE_BAR.u0 + DICE_BAR.u1) / 2, DICE_BAR.v)).toEqual({ kind: 'target', position_bp: 5_000 })
    expect(diceHitAt(DICE_SIDES.over.u, DICE_SIDES.over.v)).toEqual({ kind: 'side', over: true })
    expect(diceHitAt(DICE_SIDES.under.u, DICE_SIDES.under.v)).toEqual({ kind: 'side', over: false })
    expect(diceHitAt(0.02, 0.02)).toBeNull()
  })

  it('turns a bar position into a valid bet, snapped and clamped', () => {
    expect(diceTarget(4_210, false)).toEqual({ chance_bp: 4_200, over: false })
    expect(diceTarget(4_210, true)).toEqual({ chance_bp: 5_800, over: true })
    expect(diceTarget(0, false)).toEqual({ chance_bp: 100, over: false })
    expect(diceTarget(10_000, false)).toEqual({ chance_bp: 9_800, over: false })
  })

  it('keeps the split point when the side flips', () => {
    expect(flipDiceSide({ chance_bp: 3_000, over: false }, true)).toEqual({ chance_bp: 7_000, over: true })
    expect(flipDiceSide({ chance_bp: 3_000, over: true }, true)).toEqual({ chance_bp: 3_000, over: true })
  })
})

describe('blackjack felt', () => {
  it('takes chips on the bet circle only', () => {
    expect(blackjackHitAt(0.5, 0.84)).toBe(true)
    expect(blackjackHitAt(0.5, 0.5)).toBe(false)
  })
})

describe('chips', () => {
  const [tenth, half, one, five] = CHIP_VALUES
  const red: Bet = { roulette: 'red' }
  const seven: Bet = { roulette: { straight: 7 } }

  it('stacks on the same spot, new spots go last, removal takes the last chip', () => {
    let slip = addChip([], red, one)
    slip = addChip(slip, seven, tenth)
    slip = addChip(slip, red, half)
    expect(slip.map((e) => e.key)).toEqual(['red', 'straight:7'])
    expect(slip[0].chips).toEqual([one, half])
    expect(slipTotal(slip)).toBe(1_600_000n)
    slip = removeChip(slip, red)
    expect(slip[0].chips).toEqual([one])
    slip = removeChip(slip, seven)
    expect(slip.map((e) => e.key)).toEqual(['red'])
    expect(removeChip(slip, seven)).toEqual(slip)
  })

  it('colours an amount up with the biggest chips first, capped', () => {
    expect(stackChips(6_700_000n)).toEqual([five, one, half, tenth, tenth])
    expect(stackChips(0n)).toEqual([])
    expect(stackChips(1_000_000_000n)).toHaveLength(MAX_STACK_CHIPS)
  })

  it('checks every spot against the table limits and the total against the session', () => {
    const limits = { minBet: 100_000n, maxBet: 2_000_000n, balance: 3_000_000n }
    expect(slipProblem([], limits)).toMatch(/place chips/)
    expect(slipProblem(addChip([], red, five), limits)).toMatch(/maximum/)
    const two = addChip(addChip(addChip([], red, one), seven, one), { roulette: 'odd' }, one)
    expect(slipProblem(two, limits)).toBeNull()
    expect(slipProblem(addChip(two, { roulette: 'even' }, one), limits)).toMatch(/session balance/)
    expect(slipProblem(addChip([], red, tenth), { ...limits, minBet: 200_000n })).toMatch(/minimum/)
  })
})
