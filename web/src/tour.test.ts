import { describe, expect, it } from 'vitest'
import type { SeatedTable } from './near/floor'
import { verifySession } from './near/session-client'
import type { DealerView } from './near/views'
import type { FootfallReply, GamblerSnapshot } from './sim/gamblers'
import {
  comparedOffers,
  currentStep,
  markTourSeen,
  pickChooser,
  pickGambler,
  pickTable,
  playFairDemo,
  rentPerHour,
  tamperedRounds,
  TOUR_HIDDEN,
  TOUR_SEEN_KEY,
  TOUR_STEPS,
  tourFocus,
  tourReducer,
  tourSeen,
  type TourAction,
  type TourState,
} from './tour'

const LAST = TOUR_STEPS.length - 1

function run(actions: TourAction[], from: TourState = TOUR_HIDDEN): TourState {
  return actions.reduce(tourReducer, from)
}

describe('tourReducer', () => {
  it('offers only from hidden, and starts at the first step', () => {
    expect(run([{ type: 'offer' }])).toEqual({ kind: 'offered' })
    expect(run([{ type: 'offer' }, { type: 'start' }])).toEqual({ kind: 'step', index: 0 })
    expect(run([{ type: 'start' }, { type: 'offer' }])).toEqual({ kind: 'step', index: 0 })
  })

  it('walks forward and back, never before the first step', () => {
    expect(run([{ type: 'start' }, { type: 'next' }, { type: 'next' }, { type: 'back' }])).toEqual({ kind: 'step', index: 1 })
    expect(run([{ type: 'start' }, { type: 'back' }])).toEqual({ kind: 'step', index: 0 })
  })

  it('ends after the last step', () => {
    const atLast = run([{ type: 'go', index: LAST }])
    expect(currentStep(atLast)).toBe('your_move')
    expect(tourReducer(atLast, { type: 'next' })).toEqual(TOUR_HIDDEN)
    expect(run(Array.from({ length: TOUR_STEPS.length }, () => ({ type: 'next' as const })), { kind: 'step', index: 0 })).toEqual(TOUR_HIDDEN)
  })

  it('closes from anywhere, including the offer', () => {
    expect(run([{ type: 'offer' }, { type: 'close' }])).toEqual(TOUR_HIDDEN)
    expect(run([{ type: 'start' }, { type: 'next' }, { type: 'close' }])).toEqual(TOUR_HIDDEN)
  })

  it('ignores steps that do not exist and moves outside a tour', () => {
    const step = { kind: 'step', index: 2 } as const
    expect(tourReducer(step, { type: 'go', index: TOUR_STEPS.length })).toBe(step)
    expect(tourReducer(step, { type: 'go', index: -1 })).toBe(step)
    expect(tourReducer(step, { type: 'go', index: 1.5 })).toBe(step)
    expect(tourReducer({ kind: 'offered' }, { type: 'next' })).toEqual({ kind: 'offered' })
    expect(tourReducer(TOUR_HIDDEN, { type: 'back' })).toEqual(TOUR_HIDDEN)
  })

  it('has seven steps', () => {
    expect(TOUR_STEPS).toHaveLength(7)
  })
})

describe('tour seen flag', () => {
  it('round-trips through storage', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    expect(tourSeen(storage)).toBe(false)
    markTourSeen(storage)
    expect(data.get(TOUR_SEEN_KEY)).toBe('1')
    expect(tourSeen(storage)).toBe(true)
  })

  it('treats broken or missing storage as not seen, without throwing', () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error('blocked')
      },
      setItem: (): void => {
        throw new Error('blocked')
      },
    }
    expect(tourSeen(broken)).toBe(false)
    expect(() => markTourSeen(broken)).not.toThrow()
    expect(tourSeen(null)).toBe(false)
  })
})

function gambler(id: string, state: GamblerSnapshot['state'], dealer_id: string | null, reason: string | null): GamblerSnapshot {
  return { id, name: id, persona: 'regular', state, dealer_id, seat: dealer_id ? 0 : null, reason_code: null, reason, balance: '1000000', session_net: '0' }
}

function table(id: string, bankroll: string, playerOwned = false, open = true): SeatedTable {
  const dealer = { id, name: id.toUpperCase(), game: 'dice', open, bankroll, reserved: '0', total_edge_bp: 200, max_bet: '5000000', boost_until: 0 }
  return { dealer: dealer as DealerView, rent: '1500000', playerOwned, look: null }
}

describe('live picks', () => {
  it('follows a gambler weighing a table over one walking or leaving', () => {
    const picked = pickGambler([
      gambler('walker', 'walking', null, null),
      gambler('sitter', 'seated', 'ada', 'loyal'),
      gambler('chooser', 'deciding', 'ada', "Ada's 1.0 % beats Bruno's 2.4 %"),
    ])
    expect(picked?.id).toBe('chooser')
    expect(pickGambler([gambler('walker', 'walking', null, null)])?.id).toBe('walker')
    expect(pickGambler([])).toBeNull()
  })

  it('features a player table first, else the deepest open pool', () => {
    expect(pickTable([table('ada', '900'), null, table('zob', '100', true)])).toBe(2)
    expect(pickTable([table('ada', '100'), table('bruno', '900'), table('chloe', '5000', false, false)])).toBe(1)
    expect(pickTable([null, null])).toBeNull()
  })

  it('lists the open offers with the gambler’s scores from its latest arrival', () => {
    const reason = "Ada's 1.0 % beats Bruno's 2.4 %"
    const g = { name: 'mia', persona: 'regular' as const, reason, dealer_id: 'ada' }
    const footfall = (dealer_id: string, score: number): FootfallReply => ({
      dealer_id,
      passed_1h: 0,
      sat_1h: 0,
      arrivals_1h: [
        { persona: 'regular', score: -1, chose: false, reason },
        { persona: 'whale', score: 999, chose: false, reason },
        { persona: 'regular', score, chose: dealer_id === 'ada', reason },
      ],
    })
    const offers = comparedOffers(
      [table('ada', '1'), table('bruno', '1'), null, table('shut', '1', false, false)],
      g,
      new Map([['ada', footfall('ada', 80)], ['bruno', footfall('bruno', 55)]]),
      0,
    )
    expect(offers.map((o) => [o.dealerId, o.score, o.chosen])).toEqual([
      ['ada', 80, true],
      ['bruno', 55, false],
    ])
    expect(comparedOffers([table('ada', '1')], g, new Map(), 0)[0].score).toBeNull()
  })

  it('explains the followed gambler’s choice, else the latest pick of the hour', () => {
    const footfall = (dealer_id: string, chose: boolean[]): FootfallReply => ({
      dealer_id,
      passed_1h: 0,
      sat_1h: 0,
      arrivals_1h: chose.map((c, i) => ({ persona: 'whale', score: i, chose: c, reason: `arrival ${i}` })),
    })
    // Arrival 2 sat at bruno, arrival 3 (newest) walked out: bruno's pick is the latest.
    const footfalls = new Map([
      ['ada', footfall('ada', [true, false, false, false])],
      ['bruno', footfall('bruno', [false, false, true, false])],
    ])
    expect(pickChooser(null, footfalls)).toEqual({ name: null, persona: 'whale', reason: 'arrival 2', dealer_id: 'bruno' })
    expect(pickChooser(gambler('mia', 'deciding', 'ada', 'cheap'), footfalls)).toMatchObject({ name: 'mia', dealer_id: 'ada' })
    expect(pickChooser(gambler('mia', 'walking', null, null), new Map())).toBeNull()
  })

  it('sums the rent of seated tables', () => {
    expect(rentPerHour([table('ada', '1'), null, table('bruno', '1')])).toBe(3_000_000n)
  })

  it('points the camera at the step’s subject, or the whole floor without one', () => {
    const picks = { chooserSeat: 3, tableSeat: 5 }
    expect(tourFocus('walk_in', picks)).toEqual({ kind: 'entrance' })
    expect(tourFocus('compare', picks)).toEqual({ kind: 'seat', seat: 3 })
    expect(tourFocus('pools', picks)).toEqual({ kind: 'seat', seat: 5 })
    expect(tourFocus('seats', picks)).toEqual({ kind: 'traffic' })
    expect(tourFocus('jackpot', picks)).toEqual({ kind: 'jackpot' })
    expect(tourFocus('pools', { chooserSeat: null, tableSeat: null })).toEqual({ kind: 'overview' })
  })
})

describe('fairness demo', () => {
  const seed = new Uint8Array(32).fill(7)

  it('verifies once revealed, and catches a changed roll', () => {
    const demo = playFairDemo(seed, 'tour')
    expect(demo.rounds).toHaveLength(3)
    expect(verifySession(demo.serverSeed, demo.ticket, demo.rounds, demo.state)).toMatchObject({ ok: true })
    expect(verifySession(demo.serverSeed, demo.ticket, tamperedRounds(demo.rounds), demo.state)).toMatchObject({ ok: false, nonce: 1 })
  })

  it('refuses a seed that does not match the commitment', () => {
    const demo = playFairDemo(seed, 'tour')
    const other = playFairDemo(new Uint8Array(32).fill(8), 'tour')
    expect(verifySession(other.serverSeed, demo.ticket, demo.rounds, demo.state)).toMatchObject({ ok: false })
  })
})
