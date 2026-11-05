import { describe, expect, it } from 'vitest'
// The vitest node-polyfill plugin stubs node:fs, so the fixture comes through Vite's ?raw import.
import simJson from '../../public/sim.json?raw'
import { advance, dealerSeries, eventsUpTo, parseSim, RUN_SECONDS_AT_1X, type SimEventKind } from './sim'

function frame(t: number, events: unknown[] = []) {
  return {
    t,
    dealers: [
      { id: 'ada', bankroll: String(t), share_price: '1000000', rake_bp: 300, max_bet: '1', boost: false, open: true, reason: 'steady' },
    ],
    events,
  }
}

const TINY = {
  seed: 1,
  days: 1,
  min_bet: '100000',
  dealers: [{ id: 'ada', name: 'Ada', game: 'dice', temperament: 'greedy', traits: {} }],
  frames: [
    frame(600),
    frame(1200, [{ t: 1200, dealer: 'ada', kind: 'bust', text: 'broke' }]),
    frame(1800, [
      { t: 1800, dealer: 'ada', kind: 'reprice', text: 'r' },
      { t: 1800, dealer: 'ada', kind: 'reopen', text: 'back' },
    ]),
  ],
}

describe('parseSim', () => {
  it('reads the checked-in week of simulation', () => {
    const sim = parseSim(JSON.parse(simJson))
    expect(sim.frames).toHaveLength(1008)
    // The five launch dealers first, then the tables simulated owners open during the week.
    expect(sim.dealers.slice(0, 5).map((d) => d.id)).toEqual(['ada', 'bruno', 'chloe', 'dmitri', 'eve'])
    expect(sim.dealers.length).toBeGreaterThan(5)
    const kinds = new Set(sim.frames.flatMap((f) => f.events.map((e) => e.kind)))
    const tycoon: SimEventKind[] = ['opened', 'evicted', 'jackpot']
    expect(tycoon.every((k) => kinds.has(k))).toBe(true)
  })

  it('rejects malformed data', () => {
    expect(() => parseSim({ ...TINY, frames: [] })).toThrow(/no frames/)
    expect(() => parseSim({ ...TINY, frames: [frame(600, [{ dealer: 'ada', kind: 'explode', text: '' }])] })).toThrow(
      /kind/,
    )
    expect(() =>
      parseSim({ ...TINY, frames: [{ ...frame(600), dealers: [{ ...frame(600).dealers[0], bankroll: 5 }] }] }),
    ).toThrow(/bankroll/)
  })
})

describe('advance', () => {
  it('plays the whole run in RUN_SECONDS_AT_1X at 1x', () => {
    const half = advance(0, (RUN_SECONDS_AT_1X * 1000) / 2, 1, 1008)
    expect(half.position).toBeCloseTo(504)
    expect(half.ended).toBe(false)
    expect(advance(0, RUN_SECONDS_AT_1X * 1000, 1, 1008)).toEqual({ position: 1007, ended: true })
  })

  it('scales with speed and stops on the last frame', () => {
    expect(advance(10, 1000, 4, 1008).position).toBeCloseTo(10 + (1008 / 60) * 4)
    expect(advance(1000, 10_000, 8, 1008)).toEqual({ position: 1007, ended: true })
  })
})

describe('series and events', () => {
  const sim = parseSim(TINY)

  it('builds one series per dealer', () => {
    expect(dealerSeries(sim, (d) => Number(d.bankroll)).get('ada')).toEqual([600, 1200, 1800])
  })

  it('lists notable events seen so far, newest first', () => {
    expect(eventsUpTo(sim, 0, ['bust', 'reopen'])).toEqual([])
    expect(eventsUpTo(sim, 2, ['bust', 'reopen']).map((e) => e.kind)).toEqual(['reopen', 'bust'])
  })
})
