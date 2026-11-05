import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEV_NEWCOMER_ID,
  SEAT_TRAFFIC_BP,
  devEvict,
  floorSeats,
  getFloorState,
  isPlayerOwned,
  mockFloor,
  openTableProblem,
  outbidMin,
  parseFloor,
  parseFloorInfo,
  seatMinRent,
} from './floor'
import { ViewShapeError, parseLobby } from './views'

/** A v1 lobby entry (no tycoon fields), as the deployed contract sends it. */
function dealerJson(id: string) {
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
const LOBBY_JSON = IDS.map(dealerJson)
const LOBBY = parseLobby(LOBBY_JSON)

/** One `get_floor` seat in JSON form: 1-based, seated at the seat's minimum unless `rent` is given. */
function seatJson(index: number, dealerId: string | null, rent?: string) {
  const minRent = seatMinRent(index).toString()
  return {
    seat: index + 1,
    token_id: `seat-${index + 1}`,
    traffic_bp: SEAT_TRAFFIC_BP[index],
    min_rent: minRent,
    dealer_id: dealerId,
    controller: dealerId ? `${dealerId}.tilthouse.testnet` : null,
    rent_per_hour: dealerId ? (rent ?? minRent) : null,
    seated_at: dealerId ? 1_762_000_000 : null,
    paid_until: dealerId ? 1_762_007_200 : null,
    rent_owed: '0',
    ask: null,
  }
}

const FLOOR = {
  seats: [...IDS.map((id, i) => seatJson(i, id)), seatJson(5, null)],
  lowest_rent: '800000',
  outbid_min: '600000',
  jackpot: '42000000',
  jackpot_odds_unit: '2000000000',
  min_jackpot: '10000000',
}

describe('parseFloor', () => {
  it('reads the documented shape, turning 1-based seats into indexes', () => {
    const floor = parseFloor(FLOOR)
    expect(floor.seats.map((s) => s.seat)).toEqual([0, 1, 2, 3, 4, 5])
    expect(floor.seats[0]).toEqual({
      seat: 0,
      dealer_id: 'ada',
      rent_per_hour: '1500000',
      seated_at: 1_762_000_000,
      traffic_bp: 15_000,
      min_rent: '1500000',
      controller: 'ada.tilthouse.testnet',
      rent_owed: '0',
      paid_until: 1_762_007_200,
      ask: null,
    })
    expect(floor).toMatchObject({ lowest_rent: '800000', outbid_min: '600000', jackpot: '42000000' })
  })

  it('reads an empty seat (null rent, times) and a listed seat', () => {
    const listed = { ...FLOOR, seats: [{ ...seatJson(0, 'ada'), ask: '50000000' }, ...FLOOR.seats.slice(1)] }
    const floor = parseFloor(listed)
    expect(floor.seats[0].ask).toBe('50000000')
    expect(floor.seats[5]).toMatchObject({ dealer_id: null, rent_per_hour: '0', seated_at: 0, paid_until: 0, controller: null })
  })

  it('fails closed on a wrong seat count, order, numbering, duplicate dealer or amounts as numbers', () => {
    const bad = [
      { ...FLOOR, seats: FLOOR.seats.slice(0, 5) },
      { ...FLOOR, seats: [FLOOR.seats[1], FLOOR.seats[0], ...FLOOR.seats.slice(2)] },
      { ...FLOOR, seats: FLOOR.seats.map((s) => ({ ...s, seat: s.seat - 1 })) },
      { ...FLOOR, seats: [...FLOOR.seats.slice(0, 5), seatJson(5, 'ada')] },
      { ...FLOOR, jackpot: 42 },
      { ...FLOOR, seats: [{ ...FLOOR.seats[0], rent_per_hour: 1_500_000 }, ...FLOOR.seats.slice(1)] },
      { ...FLOOR, seats: FLOOR.seats.map((s, i) => (i === 0 ? { ...s, dealer_id: 7 } : s)) },
      { ...FLOOR, seats: FLOOR.seats.map((s, i) => (i === 0 ? { ...s, traffic_bp: undefined } : s)) },
      { ...FLOOR, seats: FLOOR.seats.map((s, i) => (i === 0 ? { ...s, ask: 5 } : s)) },
    ]
    for (const value of bad) expect(() => parseFloor(value)).toThrow(ViewShapeError)
  })

  it("refuses a rent below its seat's minimum, a seat minimum below the rule or a bad outbid minimum", () => {
    expect(() => parseFloor({ ...FLOOR, seats: [seatJson(0, 'ada', '1499999'), ...FLOOR.seats.slice(1)] })).toThrow(/seat minimum rent/)
    const cheapSeat = { ...seatJson(0, null), min_rent: '1000000' }
    expect(() => parseFloor({ ...FLOOR, seats: [cheapSeat, ...FLOOR.seats.slice(1)] })).toThrow(/seat minimum/)
    expect(() => parseFloor({ ...FLOOR, outbid_min: '0' })).toThrow(/minimum rent/)
  })
})

describe('seat rents', () => {
  it('scales the minimum rent with seat traffic: 1.5 down to 0.6 tUSDC/h', () => {
    expect(SEAT_TRAFFIC_BP.map((_, i) => seatMinRent(i))).toEqual([1_500_000n, 1_300_000n, 1_100_000n, 1_000_000n, 800_000n, 600_000n])
  })

  it("outbidMin is the cheapest empty seat's minimum", () => {
    const { seats } = parseFloor(FLOOR)
    expect(outbidMin(seats)).toBe(600_000n)
    // Seat 6 taken, seat 4 free: the free seat's minimum, not the cheapest seat's.
    const seat4Free = seats.map((s) =>
      s.seat === 3 ? { ...s, dealer_id: null } : s.seat === 5 ? { ...s, dealer_id: 'zed', rent_per_hour: '600000' } : s,
    )
    expect(outbidMin(seat4Free)).toBe(1_000_000n)
  })

  it('outbidMin is the lowest seated rent × 110 % rounded up on a full floor', () => {
    const full = parseFloor({
      ...FLOOR,
      seats: [...IDS.map((id, i) => seatJson(i, id, String(2_000_000 + i))), seatJson(5, 'zed', '1500001')],
    }).seats
    expect(outbidMin(full)).toBe(1_650_002n)
  })
})

describe('mockFloor', () => {
  it("seats the first five dealers at their seat's minimum rent and leaves the last seat for rent", () => {
    const floor = mockFloor(parseLobby([...LOBBY_JSON, dealerJson('extra')]))
    expect(floor.seats.map((s) => s.dealer_id)).toEqual([...IDS, null])
    expect(floor.seats.map((s) => s.traffic_bp)).toEqual(SEAT_TRAFFIC_BP)
    expect(floor.seats.map((s) => s.rent_per_hour)).toEqual(['1500000', '1300000', '1100000', '1000000', '800000', '0'])
    expect(floor.seats[5].min_rent).toBe('600000')
    expect(floor).toMatchObject({ lowest_rent: '800000', outbid_min: '600000', jackpot: '0' })
  })
})

describe('ownership', () => {
  it('reads npc, controller, dealer account and look from the lobby entries', () => {
    const info = parseFloorInfo([
      { id: 'ada', dealer_account: 'ada.tilthouse.testnet', controller: 'ada.tilthouse.testnet' },
      { id: 'mine', dealer_account: 'mine.tilthouse.testnet', controller: 'alice.testnet', look: 'beanie' },
      { id: 'old' },
      { id: 'npc-v2', npc: true, controller: 'bruno.tilthouse.testnet' },
      { id: 'player-v2', npc: false, controller: 'alice.testnet' },
    ])
    expect(isPlayerOwned(info.get('ada'))).toBe(false)
    expect(isPlayerOwned(info.get('mine'))).toBe(true)
    expect(info.get('mine')?.look).toBe('beanie')
    expect(isPlayerOwned(info.get('old'))).toBe(false)
    expect(isPlayerOwned(info.get('npc-v2'))).toBe(false)
    expect(isPlayerOwned(info.get('player-v2'))).toBe(true)
    expect(() => parseFloorInfo([{ id: 'x', controller: 3 }])).toThrow(ViewShapeError)
    expect(() => parseFloorInfo([{ id: 'x', npc: 'yes' }])).toThrow(ViewShapeError)
  })
})

describe('devEvict', () => {
  const state = { floor: mockFloor(LOBBY), dealers: LOBBY, info: new Map(), mock: true }

  it("puts a player's table in the evicted dealer's seat at an outbid rent", () => {
    const next = devEvict(state, 'ada')
    const seats = floorSeats(next)
    expect(seats[0]).toMatchObject({ dealer: { id: DEV_NEWCOMER_ID }, rent: '1650000', playerOwned: true })
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
  /** Answers get_lobby with the lobby and get_floor with `floorReply`; returns how many get_floor calls were made. */
  function stub(floorReply: () => Response): () => number {
    let floorCalls = 0
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      if (!String(init.body).includes('"method_name":"get_floor"')) return rpc(LOBBY_JSON)
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
    expect(floorSeats(state).map((s) => s?.dealer.id ?? null)).toEqual([...IDS, null])
  })

  it('falls back to the mock floor on MethodNotFound and asks again after a minute', async () => {
    const target = { rpcUrl: 'https://rpc.test', houseContract: 'old.testnet' }
    const floorCalls = stub(() => contractError('wasm execution failed with error: MethodResolveError(MethodNotFound)'))
    const state = await getFloorState(target, 1_000)
    expect(state.mock).toBe(true)
    expect(state.floor.seats[5].dealer_id).toBeNull()
    expect(state.floor.seats[0].traffic_bp).toBe(15_000)
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
    stub(() => rpc({ ...FLOOR, seats: [seatJson(0, 'ghost'), ...FLOOR.seats.slice(1)] }))
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
