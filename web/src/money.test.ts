import { describe, expect, it } from 'vitest'
import { missingSeedHint } from './money'

const SEED = 200_000_000n
const base = { house: 0n, wallet: 0n, minSeed: SEED, loggedIn: true, symbol: 'tUSDC' }

describe('missingSeedHint', () => {
  it('asks a logged-out player to log in first', () => {
    expect(missingSeedHint({ ...base, loggedIn: false })).toMatch(/^Log in first/)
  })

  it('is null once the house can seed a table', () => {
    expect(missingSeedHint({ ...base, house: SEED })).toBeNull()
  })

  it('says to deposit the missing amount when the wallet holds it', () => {
    expect(missingSeedHint({ ...base, house: 50_000_000n, wallet: 300_000_000n })).toBe(
      'Deposit 150.00 tUSDC below: it moves chips from your wallet into the house.',
    )
  })

  it('says to get chips first when the wallet is short', () => {
    expect(missingSeedHint({ ...base, wallet: 10_000_000n })).toBe('Get chips with the button below, then deposit 200.00 tUSDC.')
  })

  it('counts the whole seed as missing while the house balance loads', () => {
    expect(missingSeedHint({ ...base, house: null, wallet: null })).toMatch(/deposit 200\.00 tUSDC/)
  })
})
