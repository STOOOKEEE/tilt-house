import { describe, expect, it } from 'vitest'
import { rouletteBetIsValid, rouletteWins } from '../../near/session-client'
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
  slipRound,
  slipTotal,
  stackChips,
} from './felt'

const ALL_ROULETTE_BETS: RouletteBet[] = [
  ...Array.from({ length: 37 }, (_, n) => ({ straight: n })),
  ...[1, 2, 3].map((dozen) => ({ dozen })),
  ...[1, 2, 3].map((column) => ({ column })),
  ...OUTSIDE,
]

/** Every valid split, street, corner and six line, found by brute force like the Rust test. */
const INSIDE_BETS: RouletteBet[] = Array.from({ length: 37 }, (_, a) =>
  Array.from({ length: 37 }, (_, b): RouletteBet[] => [{ split: [a, b] }, { street: a }, { corner: a }, { six_line: a }]).flat(),
)
  .flat()
  .filter((bet, i, all) => rouletteBetIsValid(bet) && all.findIndex((other) => betKey({ roulette: other }) === betKey({ roulette: bet })) === i)

const covered = (bet: RouletteBet): number[] => Array.from({ length: 37 }, (_, p) => p).filter((p) => rouletteWins(bet, p))

describe('rouletteBetAt', () => {
  // Away from the lines: near them a chip goes on the line (a split, a corner…).
  it.each(ALL_ROULETTE_BETS.map((bet) => [betKey({ roulette: bet }), bet] as const))('a click inside %s is that bet', (_, bet) => {
    const cell = betCell(bet)
    for (const [fu, fv] of [[0.5, 0.5], [0.3, 0.3], [0.7, 0.7]]) {
      expect(rouletteBetAt(cell.u + cell.w * fu, cell.v + cell.h * fv)).toEqual(bet)
    }
  })

  it('finds every inside bet on its line or crossing, chips centred there', () => {
    expect(INSIDE_BETS).toHaveLength(60 + 12 + 22 + 11)
    for (const bet of INSIDE_BETS) {
      const cell = betCell(bet)
      for (const [fu, fv] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.8]]) {
        expect(rouletteBetAt(cell.u + cell.w * fu, cell.v + cell.h * fv)).toEqual(bet)
      }
    }
  })

  it('puts a chip on the line between two numbers, at a crossing or on a row end', () => {
    const between = (a: RouletteBet, b: RouletteBet) => {
      const [x, y] = [betCell(a), betCell(b)]
      return rouletteBetAt((x.u + x.w / 2 + y.u + y.w / 2) / 2, (x.v + x.h / 2 + y.v + y.h / 2) / 2)
    }
    expect(between({ straight: 7 }, { straight: 10 })).toEqual({ split: [7, 10] })
    expect(between({ straight: 8 }, { straight: 9 })).toEqual({ split: [8, 9] })
    expect(between({ straight: 8 }, { straight: 12 })).toEqual({ corner: 8 })
    const seven = betCell({ straight: 7 })
    // The bottom edge of the 7-8-9 row, next to the dozens.
    expect(rouletteBetAt(seven.u + seven.w / 2, seven.v + seven.h)).toEqual({ street: 7 })
    expect(rouletteBetAt(seven.u + seven.w, seven.v + seven.h)).toEqual({ six_line: 7 })
    const zero = betCell({ straight: 0 })
    expect(rouletteBetAt(zero.u + zero.w, betCell({ straight: 2 }).v + seven.h / 2)).toEqual({ split: [0, 2] })
  })

  it('covers exactly the numbers a chip there touches', () => {
    expect(covered({ split: [7, 10] })).toEqual([7, 10])
    expect(covered({ split: [0, 3] })).toEqual([0, 3])
    expect(covered({ street: 13 })).toEqual([13, 14, 15])
    expect(covered({ corner: 8 })).toEqual([8, 9, 11, 12])
    expect(covered({ six_line: 31 })).toEqual([31, 32, 33, 34, 35, 36])
    // Each pair of adjacent cells is one split, each 2×2 block one corner.
    for (const bet of INSIDE_BETS) {
      const numbers = covered(bet)
      const cells = numbers.filter((n) => n > 0).map((n) => betCell({ straight: n }))
      const spanU = Math.max(...cells.map((c) => c.u)) - Math.min(...cells.map((c) => c.u))
      const spanV = Math.max(...cells.map((c) => c.v)) - Math.min(...cells.map((c) => c.v))
      // Adjacent: at most one column apart, and one row apart unless the bet takes whole rows of three.
      const rows = typeof bet === 'object' && ('street' in bet || 'six_line' in bet) ? 2 : 1
      expect(spanU).toBeLessThanOrEqual(cells[0].w * 1.01)
      expect(spanV).toBeLessThanOrEqual(cells[0].h * rows * 1.01)
    }
  })

  it('reads the printed layout: 3 on the top row, 34 bottom right, red under the dozens', () => {
    const top = betCell({ straight: 3 })
    expect(top.v).toBeLessThan(betCell({ straight: 1 }).v)
    const last = betCell({ straight: 34 })
    expect(rouletteBetAt(last.u + last.w / 2, last.v + last.h / 2)).toEqual({ straight: 34 })
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

  it('checks every spot against the minimum and the one-spin total against the maximum and the session', () => {
    const limits = { minBet: 100_000n, maxBet: 2_000_000n, balance: 3_000_000n }
    expect(slipProblem([], limits)).toMatch(/place chips/)
    expect(slipProblem(addChip([], red, five), limits)).toMatch(/maximum/)
    const two = addChip(addChip([], red, one), seven, one)
    expect(slipProblem(two, limits)).toBeNull()
    expect(slipProblem(addChip(two, { roulette: 'odd' }, one), limits)).toMatch(/add up to more than the maximum/)
    expect(slipProblem(two, { ...limits, balance: 1_500_000n })).toMatch(/session balance/)
    expect(slipProblem(addChip([], red, tenth), { ...limits, minBet: 200_000n })).toMatch(/minimum/)
    const many = Array.from({ length: 21 }, (_, n) => n).reduce((slip, n) => addChip(slip, { roulette: { straight: n } }, tenth), addChip([], red, tenth))
    expect(slipProblem(many, { ...limits, maxBet: 10_000_000n })).toMatch(/at most 20/)
  })

  it('plays the whole slip as one round: one bet alone, several roulette spots on one spin', () => {
    expect(slipRound([])).toBeNull()
    expect(slipRound(addChip([], red, one))).toEqual({ bet: red, stake: one })
    const split: Bet = { roulette: { split: [7, 10] } }
    const slip = addChip(addChip(addChip([], red, one), split, half), red, tenth)
    expect(slipRound(slip)).toEqual({
      bet: {
        roulette_spots: [
          { bet: 'red', stake: '1100000' },
          { bet: { split: [7, 10] }, stake: '500000' },
        ],
      },
      stake: 1_600_000n,
    })
  })
})
