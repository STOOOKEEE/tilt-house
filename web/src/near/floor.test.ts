import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEV_NEWCOMER_ID,
  MIN_RENT_PER_HOUR,
  devEvict,
  floorSeats,
  getFloorState,
  isPlayerOwned,
  mockFloor,
  openTableProblem,
  outbidMin,
  parseFloor,
  parseFloorInfo,
  type SeatView,
} from './floor'
import { ViewShapeError, type DealerView } from './views'

function dealer(id: string): DealerView {
  return {
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
    reason_text: 'steady: nothing to react to',
    open: true,
    bankroll: '2000000000',
    reserved: '0',
    open_stakes: '0',
    shares: '2000000000000000',
    share_price_buy: '1000000',
    share_price_sell: '1000000',
  }
}

const IDS = ['ada', 'bruno', 'chloe', 'dmitri', 'eve']
const LOBBY = IDS.map(dealer)

function seat(i: number, dealerId: string | null, rent = '1000000'): SeatView {
  return { seat: i, dealer_id: dealerId, rent_per_hour: dealerId ? rent : '0', seated_at: dealerId ? 1_762_000_000 : 0 }
}

const FLOOR = {
  seats: [...IDS.map((id, i) => seat(i, id)), seat(5, null)],
  lowest_rent: '1000000',
  outbid_min: '1000000',
  jackpot: '42000000',
  jackpot_odds_unit: '2000000000',
}

describe('parseFloor', () => {
  it('accepts the documented shape', () => {
    expect(parseFloor(FLOOR)).toEqual(FLOOR)
  })

  it('accepts a null lowest rent and a null seated_at on empty seats', () => {
    const empty = { ...FLOOR, lowest_rent: null, seats: FLOOR.seats.map((_, i) => ({ ...seat(i, null), seated_at: null })) }
    const parsed = parseFloor(empty)
    expect(parsed.lowest_rent).toBeNull()
    expect(parsed.seats.every((s) => s.seated_at === 0)).toBe(true)
  })

  it('fails closed on a wrong seat count, order, duplicate dealer or amounts as numbers', () => {
    const bad = [
      { ...FLOOR, seats: FLOOR.seats.slice(0, 5) },
      { ...FLOOR, seats: [FLOOR.seats[1], FLOOR.seats[0], ...FLOOR.seats.slice(2)] },
      { ...FLOOR, seats: [...FLOOR.seats.slice(0, 5), seat(5, 'ada')] },
      { ...FLOOR, jackpot: 42 },
      { ...FLOOR, seats: [{ ...FLOOR.seats[0], rent_per_hour: 1_000_000 }, ...FLOOR.seats.slice(1)] },
      { ...FLOOR, seats: FLOOR.seats.map((s, i) => (i === 0 ? { ...s, dealer_id: 7 } : s)) },
    ]
    for (const value of bad) expect(() => parseFloor(value)).toThrow(ViewShapeError)
  })

  it('refuses a seated rent or an outbid minimum below the minimum rent', () => {
    expect(() => parseFloor({ ...FLOOR, seats: [seat(0, 'ada', '999999'), ...FLOOR.seats.slice(1)] })).toThrow(/minimum rent/)
    expect(() => parseFloor({ ...FLOOR, outbid_min: '0' })).toThrow(/minimum rent/)
  })
})

describe('outbidMin', () => {
  it('is the minimum rent while a seat is empty', () => {
    expect(outbidMin(FLOOR.seats)).toBe(MIN_RENT_PER_HOUR)
  })

  it('is the lowest seated rent × 110 % rounded up on a full floor', () => {
    const full = [...IDS.map((id, i) => seat(i, id, String(2_000_000 + i))), seat(5, 'zed', '1500001')]
    expect(outbidMin(full)).toBe(1_650_002n)
  })
})

describe('mockFloor', () => {
  it('seats the first five dealers at the minimum rent and leaves one seat for rent', () => {
    const floor = mockFloor([...LOBBY, dealer('extra')])
    expect(floor.seats.map((s) => s.dealer_id)).toEqual([...IDS, null])
    expect(floor.seats.slice(0, 5).every((s) => s.rent_per_hour === '1000000')).toBe(true)
    expect(floor).toMatchObject({ lowest_rent: '1000000', outbid_min: '1000000', jackpot: '0' })
    expect(() => parseFloor(floor)).not.toThrow()
  })
})

describe('ownership', () => {
  it('reads controller, dealer account and look from the lobby entries', () => {
    const info = parseFloorInfo([
      { id: 'ada', dealer_account: 'ada.tilthouse.testnet', controller: 'ada.tilthouse.testnet' },
      { id: 'mine', dealer_account: 'mine.tilthouse.testnet', controller: 'alice.testnet', look: 'beanie' },
      { id: 'old' },
    ])
    expect(isPlayerOwned(info.get('ada'))).toBe(false)
    expect(isPlayerOwned(info.get('mine'))).toBe(true)
    expect(info.get('mine')?.look).toBe('beanie')
    expect(isPlayerOwned(info.get('old'))).toBe(false)
    expect(() => parseFloorInfo([{ id: 'x', controller: 3 }])).toThrow(ViewShapeError)
  })
})

describe('devEvict', () => {
  const state = { floor: mockFloor(LOBBY), dealers: LOBBY, info: new Map(), mock: true }

  it("puts a player's table in the evicted dealer's seat at an outbid rent", () => {
    const next = devEvict(state, 'ada')
    const seats = floorSeats(next)
    expect(seats[0]).toMatchObject({ dealer: { id: DEV_NEWCOMER_ID }, rent: '1100000', playerOwned: true })
    expect(seats[5]).toBeNull()
    expect(next.dealers.some((d) => d.id === 'ada')).toBe(true)
  })

  it('leaves real (non-mock) floors and unknown dealers alone', () => {
    const real = { ...state, mock: false }
    expect(devEvict(real, 'ada')).toBe(real)
    expect(devEvict(state, 'nobody')).toBe(state)
  })
})

describe('getFloorState', () => {
  afterEach(() => vi.unstubAllGlobals())

  function rpc(result: unknown) {
    const bytes = [...new TextEncoder().encode(JSON.stringify(result))]
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { result: bytes, logs: [] } }))
  }
  function contractError(message: string) {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { error: message, logs: [] } }))
  }
  /** Answers get_lobby with LOBBY and get_floor with `floorReply`; returns how many get_floor calls were made. */
  function stub(floorReply: () => Response): () => number {
    let floorCalls = 0
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      if (!String(init.body).includes('"method_name":"get_floor"')) return rpc(LOBBY)
      floorCalls += 1
      return floorReply()
    })
    return () => floorCalls
  }

  it('uses get_floor when the contract has it', async () => {
    stub(() => rpc(FLOOR))
    const state = await getFloorState({ rpcUrl: 'https://rpc.test', houseContract: 'with-floor.testnet' })
    expect(state.mock).toBe(false)
    expect(state.floor.jackpot).toBe('42000000')
  })

  it('falls back to the mock floor on MethodNotFound and asks again after a minute', async () => {
    const target = { rpcUrl: 'https://rpc.test', houseContract: 'old.testnet' }
    const floorCalls = stub(() => contractError('wasm execution failed with error: MethodResolveError(MethodNotFound)'))
    const state = await getFloorState(target, 1_000)
    expect(state.mock).toBe(true)
    expect(state.floor.seats[5].dealer_id).toBeNull()
    await getFloorState(target, 30_000)
    expect(floorCalls()).toBe(1)
    await getFloorState(target, 61_001)
    expect(floorCalls()).toBe(2)
  })

  it('does not hide other errors behind the mock', async () => {
    stub(() => contractError('Smart contract panicked: boom'))
    await expect(getFloorState({ rpcUrl: 'https://rpc.test', houseContract: 'broken.testnet' })).rejects.toThrow(/boom/)
  })

  it('refuses a floor that seats a dealer the lobby does not have', async () => {
    stub(() => rpc({ ...FLOOR, seats: [seat(0, 'ghost'), ...FLOOR.seats.slice(1)] }))
    await expect(getFloorState({ rpcUrl: 'https://rpc.test', houseContract: 'ghost.testnet' })).rejects.toThrow(ViewShapeError)
  })
})

describe('openTableProblem', () => {
  const ok = { id: 'my-table', name: 'Mine', seed: 200_000_000n, rent: 1_000_000n, rentToSit: 1_000_000n, balance: 500_000_000n }

  it('accepts a valid table', () => {
    expect(openTableProblem(ok)).toBeNull()
  })

  it('refuses bad ids, a small seed, a rent below the seat price, an unprepaid rent or a missing balance', () => {
    expect(openTableProblem({ ...ok, id: 'A' })).toMatch(/table id/)
    expect(openTableProblem({ ...ok, name: '  ' })).toMatch(/name/)
    expect(openTableProblem({ ...ok, seed: 199_999_999n })).toMatch(/at least 200.00/)
    expect(openTableProblem({ ...ok, seed: null })).toMatch(/seed/)
    expect(openTableProblem({ ...ok, rentToSit: 1_100_000n })).toMatch(/at least 1.10/)
    expect(openTableProblem({ ...ok, rent: 150_000_000n })).toMatch(/2 hours/)
    expect(openTableProblem({ ...ok, balance: 100_000_000n })).toMatch(/deposit/)
    expect(openTableProblem({ ...ok, balance: null })).toBeNull()
  })
})
