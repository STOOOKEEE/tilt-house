/**
 * The floor (docs/floor.md): six seats that dealers rent, and the jackpot the rent fills.
 * Read from `get_floor` and `get_lobby`, checked at runtime like every other view.
 *
 * MOCK: until the deployed contract has `get_floor`, a floor is derived from the lobby (the first
 * five dealers seated at the minimum rent, one seat empty, jackpot 0) so the 3D floor works today.
 * `get_floor` is probed again every minute and takes over as soon as it exists.
 */
import { formatUsdc } from '../format'
import {
  amount,
  fail,
  int,
  list,
  optional,
  parseLobby,
  record,
  str,
  viewCall,
  type DealerView,
  type ViewTarget,
} from './views'

// Constants mirrored from core (docs/floor.md); the contract enforces them, the UI only guides.
export const SEATS = 6
/** 1 tUSDC per hour, in base units. */
export const MIN_RENT_PER_HOUR = 1_000_000n
/** 200 tUSDC: the smallest seed a player can open a table with. */
export const MIN_TABLE_SEED = 200_000_000n
/** Taking a seat prepays this many hours of rent from the pool. */
export const PREPAY_HOURS = 2n
/** Taking a seat on a full floor costs the lowest seated rent × 110 %. */
const OUTBID_BP = 11_000n
const BP = 10_000n
/** How long a missing `get_floor` is trusted before asking again. */
const REPROBE_MS = 60_000

export interface SeatView {
  seat: number
  dealer_id: string | null
  /** Base units per hour; meaningless on an empty seat. */
  rent_per_hour: string
  /** Unix seconds; 0 on an empty seat. */
  seated_at: number
}

export interface FloorView {
  seats: SeatView[]
  /** Null when nobody is seated. */
  lowest_rent: string | null
  /** The rent needed to take a seat now: the minimum while a seat is empty. */
  outbid_min: string
  jackpot: string
  jackpot_odds_unit: string
}

/** Floor fields DealerView gains with the new contract; absent (null) on the current one. */
export interface DealerFloorInfo {
  controller: string | null
  dealer_account: string | null
  look: string | null
}

export interface FloorState {
  floor: FloorView
  dealers: DealerView[]
  info: ReadonlyMap<string, DealerFloorInfo>
  /** True while the floor is derived from the lobby (contract without `get_floor`). */
  mock: boolean
}

/** What the 3D floor needs for an occupied seat. */
export interface SeatedTable {
  dealer: DealerView
  rent: string
  playerOwned: boolean
  look: string | null
}

// ---- guards -------------------------------------------------------------------------------

function parseSeat(value: unknown, index: number): SeatView {
  const path = `floor.seats[${index}]`
  const s = record(value, path)
  const seat = int(s.seat, `${path}.seat`)
  if (seat !== index) fail(`${path}.seat`, String(index))
  const dealerId = optional(s.dealer_id, (v) => str(v, `${path}.dealer_id`))
  const rent = amount(s.rent_per_hour, `${path}.rent_per_hour`)
  if (dealerId !== null && BigInt(rent) < MIN_RENT_PER_HOUR) fail(`${path}.rent_per_hour`, 'at least the minimum rent')
  return {
    seat,
    dealer_id: dealerId,
    rent_per_hour: rent,
    seated_at: optional(s.seated_at, (v) => int(v, `${path}.seated_at`)) ?? 0,
  }
}

export function parseFloor(value: unknown): FloorView {
  const f = record(value, 'floor')
  const seats = list(f.seats, 'floor.seats').map(parseSeat)
  if (seats.length !== SEATS) fail('floor.seats', `${SEATS} seats`)
  const seated = seats.flatMap((s) => (s.dealer_id === null ? [] : [s.dealer_id]))
  if (new Set(seated).size !== seated.length) fail('floor.seats', 'one seat per dealer')
  const outbidMin = amount(f.outbid_min, 'floor.outbid_min')
  if (BigInt(outbidMin) < MIN_RENT_PER_HOUR) fail('floor.outbid_min', 'at least the minimum rent')
  return {
    seats,
    lowest_rent: optional(f.lowest_rent, (v) => amount(v, 'floor.lowest_rent')),
    outbid_min: outbidMin,
    jackpot: amount(f.jackpot, 'floor.jackpot'),
    jackpot_odds_unit: amount(f.jackpot_odds_unit, 'floor.jackpot_odds_unit'),
  }
}

/** Reads the floor fields of each lobby entry; the rest of the entry is `parseLobby`'s job. */
export function parseFloorInfo(value: unknown): Map<string, DealerFloorInfo> {
  const info = new Map<string, DealerFloorInfo>()
  list(value, 'lobby').forEach((entry, i) => {
    const path = `lobby[${i}]`
    const d = record(entry, path)
    info.set(str(d.id, `${path}.id`), {
      controller: optional(d.controller, (v) => str(v, `${path}.controller`)),
      dealer_account: optional(d.dealer_account, (v) => str(v, `${path}.dealer_account`)),
      look: optional(d.look, (v) => str(v, `${path}.look`)),
    })
  })
  return info
}

/** A seat must hold a dealer the lobby knows, or the scene would draw a stranger. */
function checkSeatedDealers(floor: FloorView, dealers: readonly DealerView[]): void {
  const known = new Set(dealers.map((d) => d.id))
  floor.seats.forEach((s, i) => {
    if (s.dealer_id !== null && !known.has(s.dealer_id)) fail(`floor.seats[${i}].dealer_id`, 'a dealer of the lobby')
  })
}

// ---- derived values -----------------------------------------------------------------------

function lowestRent(seats: readonly SeatView[]): bigint | null {
  let lowest: bigint | null = null
  for (const s of seats) {
    if (s.dealer_id === null) continue
    const rent = BigInt(s.rent_per_hour)
    if (lowest === null || rent < lowest) lowest = rent
  }
  return lowest
}

/** lowest × 110 %, rounded up so an outbid is never below the rule. */
function outbidOver(lowest: bigint): bigint {
  return (lowest * OUTBID_BP + BP - 1n) / BP
}

/** Same rule as core `outbid_min`: the minimum while a seat is empty, else lowest × 110 % rounded up. */
export function outbidMin(seats: readonly SeatView[]): bigint {
  const lowest = lowestRent(seats)
  if (lowest === null || seats.some((s) => s.dealer_id === null)) return MIN_RENT_PER_HOUR
  return outbidOver(lowest)
}

/** NPC dealers are controlled by their own dealer account; anyone else is a player. */
export function isPlayerOwned(info: DealerFloorInfo | undefined): boolean {
  return info !== undefined && info.controller !== null && info.controller !== info.dealer_account
}

/** One entry per seat, in seat order: the table sitting there, or null for a seat for rent. */
export function floorSeats(state: FloorState): (SeatedTable | null)[] {
  return state.floor.seats.map((s) => {
    const dealer = state.dealers.find((d) => d.id === s.dealer_id)
    if (!dealer) return null
    const info = state.info.get(dealer.id)
    return { dealer, rent: s.rent_per_hour, playerOwned: isPlayerOwned(info), look: info?.look ?? null }
  })
}

// ---- open a table -------------------------------------------------------------------------

/** Dealer ids the contract accepts (docs/contract-api.md `add_dealer`). */
const TABLE_ID = /^[a-z0-9-]{2,16}$/

export interface OpenTableInput {
  id: string
  name: string
  /** Null when the typed amount is not a valid tUSDC amount. */
  seed: bigint | null
  rent: bigint | null
  /** The rent that takes a seat right now (`outbid_min`). */
  rentToSit: bigint
  /** The player's house balance, null while unknown. */
  balance: bigint | null
}

/**
 * Why `open_table` + `bid_for_seat` would fail, or null. The contract decides; this only saves
 * the player a signature on a request that cannot pass.
 */
export function openTableProblem(input: OpenTableInput): string | null {
  const { seed, rent } = input
  if (!TABLE_ID.test(input.id)) return 'table id: 2 to 16 characters, a-z, 0-9 and -'
  if (input.name.trim() === '') return 'give your table a name'
  if (seed === null || seed < MIN_TABLE_SEED) return `seed: at least ${formatUsdc(MIN_TABLE_SEED)} tUSDC`
  if (rent === null || rent < input.rentToSit) return `rent: at least ${formatUsdc(input.rentToSit)} tUSDC/h takes a seat now`
  if (rent * PREPAY_HOURS > seed) return `the seed must cover ${PREPAY_HOURS} hours of rent, prepaid when you take the seat`
  if (input.balance !== null && seed > input.balance) {
    return `your house balance is ${formatUsdc(input.balance)} tUSDC: deposit in Pools first`
  }
  return null
}

// ---- mock ---------------------------------------------------------------------------------

/** The launch floor of docs/floor.md built from the lobby: five seated at the minimum rent, one empty. */
export function mockFloor(dealers: readonly DealerView[]): FloorView {
  const seats: SeatView[] = Array.from({ length: SEATS }, (_, seat) => {
    const dealer = seat < SEATS - 1 ? dealers[seat] : undefined
    return dealer
      ? { seat, dealer_id: dealer.id, rent_per_hour: MIN_RENT_PER_HOUR.toString(), seated_at: 0 }
      : { seat, dealer_id: null, rent_per_hour: '0', seated_at: 0 }
  })
  return {
    seats,
    lowest_rent: lowestRent(seats)?.toString() ?? null,
    outbid_min: outbidMin(seats).toString(),
    jackpot: '0',
    jackpot_odds_unit: '2000000000',
  }
}

/** Id of the made-up table that takes the evicted dealer's seat in the dev eviction demo. */
export const DEV_NEWCOMER_ID = 'your-table'

/**
 * Dev demo (`?evict=<id>`) on mock data only: a player's new table outbids `dealerId` and takes its
 * seat, so the eviction and arrival animations can be watched before the contract has seats.
 */
export function devEvict(state: FloorState, dealerId: string): FloorState {
  const evicted = state.dealers.find((d) => d.id === dealerId)
  if (!state.mock || !evicted || !state.floor.seats.some((s) => s.dealer_id === dealerId)) return state
  const rent = outbidOver(MIN_RENT_PER_HOUR)
  const seats = state.floor.seats.map((s) =>
    s.dealer_id === dealerId ? { ...s, dealer_id: DEV_NEWCOMER_ID, rent_per_hour: rent.toString() } : s,
  )
  const newcomer: DealerView = {
    ...evicted,
    id: DEV_NEWCOMER_ID,
    name: 'Your table',
    temperament: 'promoter',
    reason: 'bidding_for_seat',
    reason_text: 'just opened: outbid the cheapest seat',
  }
  const info = new Map(state.info)
  info.set(DEV_NEWCOMER_ID, { controller: 'you.testnet', dealer_account: null, look: 'top-hat' })
  return {
    ...state,
    dealers: [...state.dealers, newcomer],
    info,
    floor: { ...state.floor, seats, lowest_rent: lowestRent(seats)?.toString() ?? null, outbid_min: outbidMin(seats).toString() },
  }
}

// ---- RPC ----------------------------------------------------------------------------------

/** The RPC reply of a contract without the method (see `decodeViewReply`). */
export function isMissingMethod(error: unknown): boolean {
  return error instanceof Error && error.message.includes('MethodNotFound')
}

const missingSince = new Map<string, number>()

/** `get_floor`'s raw reply, or null while the contract does not have it. Other errors throw. */
async function probeFloor(target: ViewTarget, now: number): Promise<unknown> {
  const since = missingSince.get(target.houseContract)
  if (since !== undefined && now - since < REPROBE_MS) return null
  try {
    const value = await viewCall(target.rpcUrl, target.houseContract, 'get_floor')
    missingSince.delete(target.houseContract)
    return value
  } catch (error) {
    if (!isMissingMethod(error)) throw error
    missingSince.set(target.houseContract, now)
    return null
  }
}

export async function getFloorState(target: ViewTarget, now = Date.now()): Promise<FloorState> {
  const [rawLobby, rawFloor] = await Promise.all([
    viewCall(target.rpcUrl, target.houseContract, 'get_lobby'),
    probeFloor(target, now),
  ])
  const dealers = parseLobby(rawLobby)
  const info = parseFloorInfo(rawLobby)
  if (rawFloor === null) return { floor: mockFloor(dealers), dealers, info, mock: true }
  const floor = parseFloor(rawFloor)
  checkSeatedDealers(floor, dealers)
  return { floor, dealers, info, mock: false }
}
