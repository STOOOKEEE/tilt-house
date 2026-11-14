import { describe, expect, it } from 'vitest'
import { mockFloor, type FloorState } from '../../near/floor'
import { parseDealer } from '../../near/views'
import type { GamblerSnapshot, Hesitation } from '../../sim/gamblers'
import {
  answerWant,
  capMaxBet,
  decidesIn,
  doorOutcome,
  evictionIn,
  exposure,
  OUTCOME_SHOWN_SECS,
  practicePath,
  seatedCustomers,
  seatLadder,
  trackDoor,
  undercutters,
} from './cockpit'

const NOW = 1_762_190_000

/** Dice, 3 % edge, max bet 1, bankroll 2,000 with 100 reserved: the pool covers a 19 max bet. */
function dealer(id: string, extra: object = {}) {
  return parseDealer({
    id,
    name: id[0].toUpperCase() + id.slice(1),
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

const want = (extra: Partial<Hesitation>): Hesitation => ({
  dealer_id: 'mine',
  rival_id: 'ada',
  want: 'lower_edge',
  edge_bp: null,
  max_bet: null,
  until: NOW + 30,
  ...extra,
})

function gambler(id: string, extra: Partial<GamblerSnapshot> = {}): GamblerSnapshot {
  return {
    id,
    name: id.slice(2),
    persona: 'regular',
    state: 'seated',
    dealer_id: 'mine',
    seat: 0,
    reason_code: null,
    reason: null,
    balance: '0',
    session_net: '0',
    hesitating: null,
    ...extra,
  }
}

describe('answerWant', () => {
  it('cuts the rake to the asked edge and keeps the rest of the offer', () => {
    expect(answerWant(dealer('mine'), want({ edge_bp: 250 }), NOW)).toEqual({
      kind: 'offer',
      label: 'Cut my edge to 2.50%',
      args: { dealer_id: 'mine', rake_bp: 250, max_bet: '1000000', boost_secs: 0 },
    })
    // During a boost `rake_bp` is the boosted one: the owner's own rake is the one kept.
    const boosting = dealer('mine', { rake_bp: 100, offer_rake_bp: 280 })
    expect(answerWant(boosting, want({ want: 'boost' }), NOW)).toMatchObject({ args: { rake_bp: 280, boost_secs: 900 } })
  })

  it('refuses an edge under the game minimum or one already met', () => {
    expect(answerWant(dealer('mine'), want({ edge_bp: 50 }), NOW)).toMatchObject({ kind: 'blocked', reason: /under 1.00%/ })
    expect(answerWant(dealer('mine'), want({ edge_bp: 300 }), NOW)).toMatchObject({ kind: 'blocked', reason: /already 3.00%/ })
  })

  it('raises the max bet the pool covers, else says how much to invest', () => {
    expect(answerWant(dealer('mine'), want({ want: 'higher_max_bet', max_bet: '5000000' }), NOW)).toMatchObject({
      kind: 'offer',
      label: 'Raise my max bet to 5.00 tUSDC',
      args: { rake_bp: 300, max_bet: '5000000', boost_secs: 0 },
    })
    // 25 × 100 = 2,500 must be free; 1,900 is.
    expect(answerWant(dealer('mine'), want({ want: 'higher_max_bet', max_bet: '25000000' }), NOW)).toEqual({
      kind: 'invest',
      label: 'Raise my max bet to 25.00 tUSDC',
      need: 600_000_000n,
    })
  })

  it('boosts 15 minutes unless a boost ran in the last hour', () => {
    expect(answerWant(dealer('mine', { last_boost_at: 0 }), want({ want: 'boost' }), NOW)).toMatchObject({
      kind: 'offer',
      label: 'Boost 15 min',
      args: { boost_secs: 900 },
    })
    expect(answerWant(dealer('mine', { last_boost_at: NOW - 600 }), want({ want: 'boost' }), NOW)).toMatchObject({
      kind: 'blocked',
      reason: 'a boost ran in the last hour: next in 50:00',
    })
  })

  it('keeps the max bet within what the pool covers now', () => {
    const squeezed = dealer('mine', { max_bet: '30000000' })
    expect(answerWant(squeezed, want({ edge_bp: 200 }), NOW)).toMatchObject({ args: { max_bet: '19000000' } })
  })
})

describe('door cards', () => {
  const asking = gambler('g-mia', { state: 'deciding', reason: 'go under 2.5 %', hesitating: want({ edge_bp: 250 }) })

  it('counts down to the decision', () => {
    expect(decidesIn(NOW + 42, NOW)).toBe('decides in 0:42')
    expect(decidesIn(NOW, NOW)).toBe('deciding now…')
  })

  it('tracks gamblers hesitating here and keeps decided ones for a while', () => {
    const cards = trackDoor([], [asking, gambler('g-leo', { hesitating: null })], 'mine', NOW)
    expect(cards).toEqual([{ gambler_id: 'g-mia', name: 'mia', persona: 'regular', ask: 'go under 2.5 %', hesitating: asking.hesitating }])
    expect(trackDoor(cards, [], 'mine', NOW + 30 + OUTCOME_SHOWN_SECS - 1)).toHaveLength(1)
    expect(trackDoor(cards, [], 'mine', NOW + 30 + OUTCOME_SHOWN_SECS)).toEqual([])
    expect(trackDoor([], [asking], 'other', NOW)).toEqual([])
  })

  it('reads the outcome from the feed once the pause is over', () => {
    const [card] = trackDoor([], [asking], 'mine', NOW)
    const after = NOW + 31
    expect(doorOutcome(card, [asking], NOW + 10)).toEqual({ kind: 'deciding' })
    expect(doorOutcome(card, [asking], after)).toEqual({ kind: 'deciding' })
    expect(doorOutcome(card, [gambler('g-mia', { reason: 'your offer won me over' })], after)).toEqual({
      kind: 'sat',
      reason: 'your offer won me over',
    })
    expect(doorOutcome(card, [gambler('g-mia', { dealer_id: 'ada' })], after)).toMatchObject({ kind: 'rival', dealer_id: 'ada' })
    expect(doorOutcome(card, [gambler('g-mia', { state: 'leaving', dealer_id: null })], after)).toMatchObject({ kind: 'left' })
    expect(doorOutcome(card, [], after)).toEqual({ kind: 'left', reason: null })
  })
})

describe('capital at risk', () => {
  it('compares what open sessions reserve with the bankroll', () => {
    expect(exposure(dealer('mine'))).toEqual({ bankroll: 2_000_000_000n, reserved: 100_000_000n, free: 1_900_000_000n, reserved_bp: 500 })
    expect(exposure(dealer('mine', { bankroll: '0', reserved: '0' })).reserved_bp).toBe(0)
  })

  it('lists who is seated here, biggest winner first, flagging anyone up big and whales', () => {
    const feed = [
      gambler('g-ava', { persona: 'whale', session_net: '-5000000' }),
      gambler('g-bo', { session_net: '100000000' }),
      gambler('g-cy', { session_net: '99999999' }),
      gambler('g-di', { dealer_id: 'ada', session_net: '900000000' }),
      gambler('g-ed', { state: 'deciding' }),
    ]
    expect(seatedCustomers(feed, dealer('mine')).map((c) => [c.gambler.id, c.flag])).toEqual([
      ['g-bo', 'up_big'],
      ['g-cy', null],
      ['g-ava', 'whale'],
    ])
  })

  it('caps the max bet at half, never under the min bet', () => {
    expect(capMaxBet(dealer('mine'))).toEqual({ dealer_id: 'mine', rake_bp: 300, max_bet: '500000', boost_secs: 0 })
    expect(capMaxBet(dealer('mine', { max_bet: '150000' }))?.max_bet).toBe('100000')
    expect(capMaxBet(dealer('mine', { max_bet: '100000' }))).toBeNull()
  })
})

describe('rent and seats', () => {
  const names = ['ada', 'bruno', 'chloe', 'dmitri', 'eve']

  function floorWith(mineAt: number | null, extra: Record<string, object> = {}): FloorState {
    const dealers = [...names.map((n) => dealer(n, { npc: true, ...extra[n] })), dealer('mine', { npc: false, ...extra.mine })]
    const floor = mockFloor(dealers.filter((d) => d.id !== 'mine'))
    if (mineAt !== null) {
      const seat = floor.seats[mineAt]
      const moved = seat.dealer_id
      floor.seats[mineAt] = { ...seat, dealer_id: 'mine', rent_per_hour: seat.min_rent, controller: 'alice.testnet' }
      if (mineAt < 5 && moved) floor.seats[5] = { ...floor.seats[5], dealer_id: moved, rent_per_hour: floor.seats[5].min_rent }
    }
    floor.outbid_min = '880000'
    return { floor, dealers, info: new Map(), mock: true }
  }

  it('counts prepaid time, then the hours the free bankroll pays', () => {
    const seat = { ...floorWith(2).floor.seats[2], rent_per_hour: '1000000', paid_until: NOW + 600 }
    expect(evictionIn(seat, dealer('mine'), NOW)).toBe(600 + 1900 * 3600)
    expect(evictionIn({ ...seat, paid_until: NOW - 60, rent_owed: '2000000000' }, dealer('mine'), NOW)).toBe(0)
    expect(evictionIn(floorWith(null).floor.seats[5], dealer('mine'), NOW)).toBeNull()
  })

  it('shows the next seat up and where a bid from off the floor lands', () => {
    const seated = seatLadder(floorWith(2), 'mine', NOW)
    expect(seated.mine?.seat).toBe(2)
    expect(seated.above).toMatchObject({ seat: { seat: 1 }, dealer: { id: 'bruno' } })
    expect(seated.defend).toBeNull()
    const off = seatLadder(floorWith(null), 'mine', NOW)
    expect(off).toMatchObject({ mine: null, above: null, target: { seat: { seat: 5, dealer_id: null } }, outbid: 880_000n })
  })

  it('offers to lift the weakest seat of a full floor off the bottom', () => {
    const ladder = seatLadder(floorWith(5), 'mine', NOW)
    expect(ladder.target?.dealer?.id).toBe('mine')
    // Lowest other rent: seat 5 at 0.80/h; one cent above leaves the bottom.
    expect(ladder.defend).toBe(810_000n)
  })

  it('lists seats for sale and rivals about to be evicted', () => {
    const state = floorWith(5, { chloe: { bankroll: '500000', reserved: '0' } })
    state.floor.seats[0] = { ...state.floor.seats[0], ask: '50000000' }
    const ladder = seatLadder(state, 'mine', NOW)
    expect(ladder.for_sale.map((r) => r.dealer?.id)).toEqual(['ada'])
    // 0.5 left at 1.10/h: about 27 minutes.
    expect(ladder.freeing).toEqual([expect.objectContaining({ dealer: expect.objectContaining({ id: 'chloe' }), in_secs: 1636 })])
  })
})

describe('undercutters', () => {
  const state = (mineSeated: boolean, adaEdge: number): FloorState => {
    const mine = dealer('mine', { npc: false })
    const bruno = dealer('bruno', { reason: 'undercut', total_edge_bp: 299 })
    const ada = dealer('ada', { total_edge_bp: adaEdge })
    const floor = mockFloor(mineSeated ? [ada, bruno, mine] : [ada, bruno])
    return { floor, dealers: [ada, bruno, mine], info: new Map([['mine', { npc: false, controller: 'alice', dealer_account: null, look: null }]]), mock: true }
  }

  it('names the NPC that cut under our table when ours was the cheapest rival', () => {
    expect(undercutters(state(true, 400), dealer('mine')).map((d) => d.id)).toEqual(['bruno'])
  })

  it('stays quiet when a cheaper table drew the undercut, or ours is off the floor', () => {
    expect(undercutters(state(true, 250), dealer('mine'))).toEqual([])
    expect(undercutters(state(false, 400), dealer('mine'))).toEqual([])
  })
})

describe('practicePath', () => {
  it('practises at the table, poker against bots', () => {
    expect(practicePath({ id: 'mine', game: 'dice' })).toBe('/table/mine?demo=1')
    expect(practicePath({ id: 'mine', game: 'poker' })).toBe('/poker?demo=1')
  })
})
