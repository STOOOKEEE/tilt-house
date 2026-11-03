import { describe, expect, it } from 'vitest'
import {
  applyRake,
  cardLabel,
  diceWinPayout,
  diceWins,
  freeBankroll,
  handTotal,
  pocketColor,
  reopenNeeds,
  rouletteBetLabel,
  rouletteWinMultiple,
} from './house'

describe('reopenNeeds', () => {
  it('is what the free bankroll lacks to cover a minimum bet worst case', () => {
    // Dice: 0.10 USDC at 1 % chance can cost 10 USDC.
    expect(reopenNeeds({ worst_case_multiple: '100', min_bet: '100000', bankroll: '4000000', reserved: '1000000' })).toBe(7_000_000n)
    expect(reopenNeeds({ worst_case_multiple: '4', min_bet: '100000', bankroll: '400000', reserved: '0' })).toBe(0n)
    expect(reopenNeeds({ worst_case_multiple: '36', min_bet: '100000', bankroll: '0', reserved: '5' })).toBe(3_600_000n)
  })

  it('never reports a negative free bankroll', () => {
    expect(freeBankroll({ bankroll: '1', reserved: '5' })).toBe(0n)
  })
})

describe('blackjack hands', () => {
  it('totals like core: faces 10, an ace 11 when it fits', () => {
    expect(handTotal([1, 13])).toEqual({ total: 21, soft: true })
    expect(handTotal([1, 9, 5])).toEqual({ total: 15, soft: false })
    expect(handTotal([12, 11, 2])).toEqual({ total: 22, soft: false })
    expect([1, 7, 11, 12, 13].map(cardLabel)).toEqual(['A', '7', 'J', 'Q', 'K'])
  })
})

describe('roulette', () => {
  it('colors pockets and labels bets', () => {
    expect([0, 1, 2].map(pocketColor)).toEqual(['green', 'red', 'black'])
    expect(rouletteBetLabel('red')).toBe('red')
    expect(rouletteBetLabel({ dozen: 2 })).toBe('dozen 2')
    expect(rouletteBetLabel({ straight: 17 })).toBe('number 17')
  })
})

describe('payouts', () => {
  it('rakes the gross, only out of the gain, rounding in the pool favour', () => {
    expect(applyRake(2_000_000n, 1_000_000n, 300)).toBe(1_940_000n)
    expect(applyRake(1_000_001n, 1_000_000n, 300)).toBe(1_000_000n)
    expect(applyRake(500n, 1_000n, 300)).toBe(500n)
    expect(applyRake(3n, 1n, 1)).toBe(2n)
  })

  it('pays dice at fair odds minus rake', () => {
    expect(diceWinPayout(1_000_000n, 5_000, 200)).toBe(1_960_000n)
    expect(diceWinPayout(1_000_000n, 100, 0)).toBe(100_000_000n)
  })

  it('knows dice wins and roulette multiples', () => {
    expect(diceWins(4_999, 5_000, false)).toBe(true)
    expect(diceWins(5_000, 5_000, false)).toBe(false)
    expect(diceWins(5_000, 5_000, true)).toBe(true)
    expect(diceWins(4_999, 5_000, true)).toBe(false)
    expect(rouletteWinMultiple('red')).toBe(2n)
    expect(rouletteWinMultiple({ dozen: 1 })).toBe(3n)
    expect(rouletteWinMultiple({ straight: 0 })).toBe(36n)
  })
})
