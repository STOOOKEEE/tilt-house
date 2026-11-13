import { describe, expect, it } from 'vitest'
import { mockFloor } from './near/floor'
import { parseDealer, parsePlayer } from './near/views'
import type { Arrival } from './sim/gamblers'
import {
  BOOST_COOLDOWN_SECS,
  RAKE_BOUNDS,
  bidProblem,
  cooldownLeft,
  hourMoney,
  isSeated,
  maxBetCap,
  myTables,
  offerProblem,
  previewOffer,
  retireProblem,
  seatMarket,
  tableNameProblem,
  totalEdgeBp,
  trafficMultiple,
} from './tycoon'

const NOW = 1_762_190_000

function dealer(id: string, extra: object = {}) {
  return parseDealer({
    id,
    name: id.toUpperCase(),
    game: 'dice',
    temperament: 'greedy',
    rake_bp: 300,
    total_edge_bp: 300,
    min_bet: '100000',
    max_bet: '1000000',
    worst_case_multiple: '100',
    boost_until: 0,
    reason: 'steady',
    reason_text: 'steady',
    open: true,
    bankroll: '2000000000',
    reserved: '100000000',
    open_stakes: '0',
    shares: '2000000000000000',
    share_price_buy: '1000000',
    share_price_sell: '1000000',
    ...extra,
  })
}

describe('edges and caps', () => {
  it('total edge = base edge + rake, from the contract when it says so', () => {
    expect(totalEdgeBp(dealer('d'), 300)).toBe(300)
    expect(totalEdgeBp(dealer('r', { game: 'roulette' }), RAKE_BOUNDS.roulette[1])).toBe(500)
    expect(totalEdgeBp(dealer('b', { game: 'blackjack' }), 0)).toBe(117)
    expect(totalEdgeBp(dealer('x', { game: 'roulette', base_edge_bp: 50 }), 10)).toBe(60)
  })

  it('max bet is capped by the free bankroll over the worst-case multiple', () => {
    expect(maxBetCap(dealer('d'))).toBe(19_000_000n)
    expect(maxBetCap(dealer('d', { worst_case_multiple: '0' }))).toBe(0n)
    expect(maxBetCap(dealer('d', { reserved: '3000000000' }))).toBe(0n)
  })

  it('formats seat traffic as a multiple', () => {
    expect(trafficMultiple(15_000)).toBe('1.5×')
    expect(trafficMultiple(6_000)).toBe('0.6×')
  })
})

describe('cooldownLeft', () => {
  it('is 0 when never done or an hour has passed, else the seconds left', () => {
    expect(cooldownLeft(0, BOOST_COOLDOWN_SECS, NOW)).toBe(0)
    expect(cooldownLeft(null, BOOST_COOLDOWN_SECS, NOW)).toBe(0)
    expect(cooldownLeft(NOW - 100, BOOST_COOLDOWN_SECS, NOW)).toBe(3_500)
    expect(cooldownLeft(NOW - BOOST_COOLDOWN_SECS, BOOST_COOLDOWN_SECS, NOW)).toBe(0)
  })
})

describe('offerProblem', () => {
  const ok = { rakeBp: 200, maxBet: 5_000_000n, boostSecs: 600 }

  it('accepts an offer within every bound', () => {
    expect(offerProblem(dealer('d'), ok, NOW)).toBeNull()
  })

  it('refuses a rake out of the game bounds, a bad max bet or boost', () => {
    expect(offerProblem(dealer('d'), { ...ok, rakeBp: 99 }, NOW)).toMatch(/rake: 100–495/)
    expect(offerProblem(dealer('d', { game: 'roulette' }), { ...ok, rakeBp: 231 }, NOW)).toMatch(/rake: 0–230/)
    expect(offerProblem(dealer('d'), { ...ok, maxBet: null }, NOW)).toMatch(/at least 0.10/)
    expect(offerProblem(dealer('d'), { ...ok, maxBet: 99_999n }, NOW)).toMatch(/at least/)
    expect(offerProblem(dealer('d'), { ...ok, maxBet: 19_000_001n }, NOW)).toMatch(/covers at most 19.00/)
    expect(offerProblem(dealer('d'), { ...ok, boostSecs: 901 }, NOW)).toMatch(/0 to 15 minutes/)
  })

  it('allows one boost per hour, and offers without a boost any time', () => {
    const boosted = dealer('d', { last_boost_at: NOW - 600 })
    expect(offerProblem(boosted, ok, NOW)).toMatch(/next in 50:00/)
    expect(offerProblem(boosted, { ...ok, boostSecs: 0 }, NOW)).toBeNull()
  })
})

describe('hourMoney', () => {
  it('reads revenue, rent and signed P&L; null on the v1 contract', () => {
    const v2 = dealer('d', { earnings_1h: '1200000', rent_per_hour: '1500000', rent_1h: '1500000', pnl_1h: '-300000' })
    expect(hourMoney(v2)).toEqual({ revenue: 1_200_000n, rentPerHour: 1_500_000n, rentPaid: 1_500_000n, pnl: -300_000n })
    expect(hourMoney(dealer('d'))).toEqual({ revenue: null, rentPerHour: null, rentPaid: null, pnl: null })
  })
})

describe('previewOffer', () => {
  // Bargain hunter: edge weight 300, threshold 150. At 3 % its edge points are 150; at 1 %, 300.
  const arrivals: Arrival[] = [
    { persona: 'bargain_hunter', score: 160, chose: true, reason: 'sat here' },
    { persona: 'bargain_hunter', score: 100, chose: false, reason: 'nothing worth it' },
    { persona: 'bargain_hunter', score: 200, chose: false, reason: "Bruno's 1.0 % beats Ada's 3.0 %" },
    // Tourist: weight 40, threshold 130: 1 % instead of 3 % adds 20 points only.
    { persona: 'tourist', score: 100, chose: false, reason: 'nothing worth it' },
  ]

  it('keeps the last hour as it was at the same edge', () => {
    expect(previewOffer(arrivals, 300, 300)).toEqual({ arrivals: 4, sat: 1, predicted: 1 })
  })

  it('wins gamblers who left the floor when a lower edge lifts them over their threshold, never rivals', () => {
    expect(previewOffer(arrivals, 300, 100).predicted).toBe(2)
  })

  it('loses gamblers who sat here when a higher edge drops them under their threshold', () => {
    expect(previewOffer(arrivals, 300, 500).predicted).toBe(0)
  })

  it('never predicts fewer gamblers for a lower edge (property)', () => {
    const personas = ['bargain_hunter', 'regular', 'whale', 'thrill_seeker', 'tourist'] as const
    let seed = 7
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed % n
    }
    for (let run = 0; run < 200; run++) {
      const sample: Arrival[] = Array.from({ length: 12 }, () => ({
        persona: personas[next(personas.length)],
        score: next(400) - 50,
        chose: next(2) === 0,
        reason: '',
      }))
      const current = 100 + next(401)
      const lower = 100 + next(current - 99)
      expect(previewOffer(sample, current, lower).predicted).toBeGreaterThanOrEqual(previewOffer(sample, current, current).predicted)
    }
  })
})

describe('tables and seats', () => {
  const mine = dealer('mine', { controller: 'alice.testnet', npc: false })
  const listed = dealer('listed')
  const ada = dealer('ada', { controller: 'ada.tilthouse.testnet', npc: true })

  it('finds my tables by PlayerView.tables or by controller', () => {
    const player = parsePlayer({ balance: '0', lp: [], tables: ['listed'] })
    expect(myTables([ada, mine, listed], player, 'alice.testnet').map((d) => d.id)).toEqual(['mine', 'listed'])
    expect(myTables([ada, mine], null, 'alice.testnet').map((d) => d.id)).toEqual(['mine'])
    expect(myTables([ada, mine], null, '')).toEqual([])
  })

  it('lists the six seats with traffic, rent, dealer and ask', () => {
    const floor = mockFloor([ada, mine])
    floor.seats[1] = { ...floor.seats[1], ask: '50000000' }
    const state = { floor, dealers: [ada, mine, listed], info: new Map(), mock: true }
    const rows = seatMarket(state)
    expect(rows).toHaveLength(6)
    expect(rows[0]).toMatchObject({ index: 0, traffic_bp: 15_000, rent: '1500000', dealer: { id: 'ada' }, ask: null })
    expect(rows[1]).toMatchObject({ index: 1, dealer: { id: 'mine' }, ask: '50000000', controller: 'alice.testnet' })
    expect(rows[5]).toMatchObject({ rent: null, dealer: null, min_rent: '600000' })
    expect(isSeated(state, 'mine')).toBe(true)
    expect(isSeated(state, 'listed')).toBe(false)
  })
})

describe('bidProblem', () => {
  it('needs the outbid minimum, a pool that prepays two hours, and no eviction cooldown', () => {
    expect(bidProblem(dealer('d'), 1_000_000n, 1_000_000n, NOW)).toBeNull()
    expect(bidProblem(dealer('d'), 999_999n, 1_000_000n, NOW)).toMatch(/at least 1.00/)
    expect(bidProblem(dealer('d'), null, 1_000_000n, NOW)).toMatch(/at least/)
    expect(bidProblem(dealer('d', { reserved: '1999000000' }), 1_000_000n, 1_000_000n, NOW)).toMatch(/prepay 2 hours/)
    expect(bidProblem(dealer('d', { cooldown_until: NOW + 90 }), 1_000_000n, 1_000_000n, NOW)).toMatch(/1:30/)
  })
})

describe('rename and retire', () => {
  it('follows core validate_table_name', () => {
    expect(tableNameProblem('Lucky Lou')).toBeNull()
    expect(tableNameProblem('')).toMatch(/1 to 32 bytes/)
    expect(tableNameProblem('x'.repeat(33))).toMatch(/1 to 32 bytes/)
    // 11 × 3 bytes: 11 characters but over 32 bytes.
    expect(tableNameProblem('€'.repeat(11))).toMatch(/bytes/)
    expect(tableNameProblem('Lou\n')).toMatch(/control/)
    expect(tableNameProblem(' Lou')).toMatch(/spaces/)
  })

  it('offers retiring only off the floor, with no play and every share held', () => {
    const table = dealer('mine', { controller: 'alice.testnet', npc: false, shares: '5000000', open_sessions: 0, reserved: '0' })
    const owner = parsePlayer({ balance: '0', lp: [{ dealer_id: 'mine', shares: '5000000', value: '5000000' }], tables: ['mine'] })
    expect(retireProblem(table, owner, false)).toBeNull()
    expect(retireProblem(table, owner, true)).toMatch(/seat/)
    expect(retireProblem({ ...table, open_sessions: 1 }, owner, false)).toMatch(/still playing/)
    expect(retireProblem({ ...table, reserved: '1' }, owner, false)).toMatch(/still playing/)
    const partner = parsePlayer({ balance: '0', lp: [{ dealer_id: 'mine', shares: '4000000', value: '4000000' }], tables: ['mine'] })
    expect(retireProblem(table, partner, false)).toMatch(/other LPs/)
    expect(retireProblem(table, null, false)).toMatch(/other LPs/)
  })
})
