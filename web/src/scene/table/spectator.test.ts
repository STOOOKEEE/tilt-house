import { describe, expect, it } from 'vitest'
import type { RoundView } from '../../near/views'
import { idsToScan, roundsToShow } from './spectator'

describe('idsToScan', () => {
  it('looks back `firstLook` ids on the first poll', () => {
    expect(idsToScan(null, 101, 3, 20)).toEqual([98, 99, 100])
  })

  it('then only fetches the ids created since the last poll', () => {
    expect(idsToScan(98, 101, 3, 20)).toEqual([99, 100])
    expect(idsToScan(100, 101, 3, 20)).toEqual([])
  })

  it('caps a burst to the newest `max` ids', () => {
    expect(idsToScan(10, 101, 3, 4)).toEqual([97, 98, 99, 100])
  })

  it('never asks for ids before round 1', () => {
    expect(idsToScan(null, 3, 30, 20)).toEqual([1, 2])
    expect(idsToScan(null, 1, 30, 20)).toEqual([])
  })
})

describe('roundsToShow', () => {
  const at = (id: number, dealer_id: string) => ({ id, dealer_id }) as RoundView

  it("keeps this dealer's rounds, oldest first", () => {
    const shown = roundsToShow([at(5, 'ada'), null, at(3, 'ada'), at(4, 'eve')], 'ada', false)
    expect(shown.map((r) => r.id)).toEqual([3, 5])
  })

  it('shows only the latest round on the first poll', () => {
    expect(roundsToShow([at(3, 'ada'), at(5, 'ada')], 'ada', true).map((r) => r.id)).toEqual([5])
    expect(roundsToShow([at(4, 'eve')], 'ada', true)).toEqual([])
  })
})
