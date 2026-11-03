import { describe, expect, it } from 'vitest'
import { dealerMood } from './mood'

const LAUNCH = '2000000000'
const dealer = (bankroll: string, reason = 'steady', open = true) => ({ bankroll, reason, open })

describe('dealerMood', () => {
  it('is broke when the table is closed, whatever the pool', () => {
    expect(dealerMood(dealer('5000000000', 'hot_table', false))).toBe('broke')
  })

  it('is neutral around the launch pool with a calm reason', () => {
    expect(dealerMood(dealer(LAUNCH))).toBe('neutral')
    expect(dealerMood(dealer('1800000000'))).toBe('neutral') // exactly 90%
    expect(dealerMood(dealer('2100000000'))).toBe('neutral') // exactly 105%
  })

  it('is nervous below 90% of the launch pool or on a bad reason', () => {
    expect(dealerMood(dealer('1799999999'))).toBe('nervous')
    expect(dealerMood(dealer(LAUNCH, 'losing_streak'))).toBe('nervous')
    expect(dealerMood(dealer(LAUNCH, 'low_bankroll'))).toBe('nervous')
  })

  it('is happy above 105% of the launch pool or on a good reason', () => {
    expect(dealerMood(dealer('2100000001'))).toBe('happy')
    expect(dealerMood(dealer(LAUNCH, 'winning_streak'))).toBe('happy')
    expect(dealerMood(dealer(LAUNCH, 'hot_table'))).toBe('happy')
  })

  it('lets nervousness win over a good reason when the pool is low', () => {
    expect(dealerMood(dealer('1000000000', 'hot_table'))).toBe('nervous')
  })
})
