import { describe, expect, it } from 'vitest'
import { tablePath } from './paths'

describe('tablePath', () => {
  it('sends poker tables to the poker room, not the casino table page', () => {
    expect(tablePath({ id: 'faye', game: 'poker' })).toBe('/poker/faye')
  })

  it('sends dice, roulette and blackjack tables to the casino table page', () => {
    expect(tablePath({ id: 'ada', game: 'dice' })).toBe('/table/ada')
    expect(tablePath({ id: 'chloe', game: 'roulette' })).toBe('/table/chloe')
    expect(tablePath({ id: 'eve', game: 'blackjack' })).toBe('/table/eve')
  })

  it('encodes the table id', () => {
    expect(tablePath({ id: 'zob zob', game: 'dice' })).toBe('/table/zob%20zob')
  })
})
