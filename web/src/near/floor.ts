/**
 * The floor (docs/floor.md, docs/tycoon.md): six seats that dealers rent, and the jackpot the rent fills.
 * Read from `get_floor` and `get_lobby`, checked at runtime like every other view. JSON seats are
 * 1-based (docs/contract-api.md); everything here indexes them from 0 (seat 1 = index 0).
 *
 * MOCK: until the deployed contract has `get_floor`, a floor is derived from the lobby (the first
 * five dealers seated at their seat's minimum rent, one seat empty, jackpot 0) so the 3D floor works today.
 * `get_floor` is probed again every minute and takes over as soon as it exists.
 */
import { formatUsdc, tokenSymbol } from '../format'
import {
  SEATS,
  amount,
  bool,
  fail,
  int,
  list,
  optional,
  parseLobby,
  record,
  seatIndex,
  str,
  viewCall,
  type DealerView,
  type ViewTarget,
} from './views'

export { SEATS }

// Constants mirrored from core (docs/floor.md); the contract enforces them, the UI only guides.
/** 1 tUSDC per hour, in base units: the minimum rent of a seat with 1× traffic. */
export const MIN_RENT_PER_HOUR = 1_000_000n
/** `core::seats::SEAT_TRAFFIC_BP`: seat 1 (by the entrance) sees 1.5× the passers-by, the last 0.6×. */
export const SEAT_TRAFFIC_BP: readonly number[] = [15_000, 13_000, 11_000, 10_000, 8_000, 6_000]
/** 200 tUSDC: the smallest seed a player can open a table with. */
export const MIN_TABLE_SEED = 200_000_000n
/** Taking a seat prepays this many hours of rent from the pool. */
export const PREPAY_HOURS = 2n
/** Taking a seat on a full floor costs the lowest seated rent × 110 %. */
const OUTBID_BP = 11_000n
const BP = 10_000n
/** How long a missing `get_floor` is trusted before asking again. */
const REPROBE_MS = 60_000

/** A seat's minimum rent scales with its traffic (docs/tycoon.md, "Seats"). */
export function seatMinRent(index: number): bigint {
  return (MIN_RENT_PER_HOUR * BigInt(SEAT_TRAFFIC_BP[index] ?? 0)) / BP
}

export interface SeatView {
  /** 0-based index (JSON seat number − 1). */
  seat: number
  dealer_id: string | null
  /** Base units per hour; "0" on an empty seat. */
  rent_per_hour: string
  /** Unix seconds; 0 on an empty seat. */
  seated_at: number
  traffic_bp: number
  /** The lowest rent this seat accepts. */
  min_rent: string
  /** Who holds the seat lease (the seated dealer's controller); null on an empty seat. */
  controller: string | null
  rent_owed: string
  /** Unix seconds the prepaid rent covers; 0 on an empty seat. */
  paid_until: number
  /** Sale price when the holder listed the seat, else null. */
  ask: string | null
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
  npc: boolean | null
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
  const seat = seatIndex(s.seat, `${path}.seat`)
  if (seat !== index) fail(`${path}.seat`, String(index + 1))
  const dealerId = optional(s.dealer_id, (v) => str(v, `${path}.dealer_id`))
  const minRent = amount(s.min_rent, `${path}.min_rent`)
  if (BigInt(minRent) < seatMinRent(index)) fail(`${path}.min_rent`, 'at least the seat minimum')
  const rent = optional(s.rent_per_hour, (v) => amount(v, `${path}.rent_per_hour`)) ?? '0'
  if (dealerId !== null && BigInt(rent) < BigInt(minRent)) fail(`${path}.rent_per_hour`, 'at least the seat minimum rent')
  return {
    seat,
    dealer_id: dealerId,
    rent_per_hour: rent,
    seated_at: optional(s.seated_at, (v) => int(v, `${path}.seated_at`)) ?? 0,
    traffic_bp: int(s.traffic_bp, `${path}.traffic_bp`),
    min_rent: minRent,
    controller: optional(s.controller, (v) => str(v, `${path}.controller`)),
    rent_owed: amount(s.rent_owed, `${path}.rent_owed`),
    paid_until: optional(s.paid_until, (v) => int(v, `${path}.paid_until`)) ?? 0,
    ask: optional(s.ask, (v) => amount(v, `${path}.ask`)),
  }
}

export function parseFloor(value: unknown): FloorView {
  const f = record(value, 'floor')
  const seats = list(f.seats, 'floor.seats').map(parseSeat)
  if (seats.length !== SEATS) fail('floor.seats', `${SEATS} seats`)
  const seated = seats.flatMap((s) => (s.dealer_id === null ? [] : [s.dealer_id]))
  if (new Set(seated).size !== seated.length) fail('floor.seats', 'one seat per dealer')
  const outbidMin = amount(f.outbid_min, 'floor.outbid_min')
  if (BigInt(outbidMin) < seatMinRent(SEATS - 1)) fail('floor.outbid_min', 'at least the minimum rent')
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
      npc: optional(d.npc, (v) => bool(v, `${path}.npc`)),
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

/** Same rule as core `outbid_min`: the cheapest empty seat's minimum, else lowest × 110 % rounded up. */
export function outbidMin(seats: readonly SeatView[]): bigint {
  const empty = seats.filter((s) => s.dealer_id === null).map((s) => BigInt(s.min_rent))
  if (empty.length > 0) return empty.reduce((a, b) => (b < a ? b : a))
  const lowest = lowestRent(seats)
  return lowest === null ? MIN_RENT_PER_HOUR : outbidOver(lowest)
}

/** v2 says it outright (`npc`); before, NPC dealers were controlled by their own dealer account. */
export function isPlayerOwned(info: DealerFloorInfo | undefined): boolean {
  if (info === undefined) return false
  if (info.npc !== null) return !info.npc
  return info.controller !== null && info.controller !== info.dealer_account
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
  if (seed === null || seed < MIN_TABLE_SEED) return `seed: at least ${formatUsdc(MIN_TABLE_SEED)} ${tokenSymbol()}`
  if (rent === null || rent < input.rentToSit) return `rent: at least ${formatUsdc(input.rentToSit)} ${tokenSymbol()}/h takes a seat now`
  if (rent * PREPAY_HOURS > seed) return `the seed must cover ${PREPAY_HOURS} hours of rent, prepaid when you take the seat`
  if (input.balance !== null && seed > input.balance) {
    return `your house balance is ${formatUsdc(input.balance)} ${tokenSymbol()}: deposit more under Your money first`
  }
  return null
}

// ---- mock ---------------------------------------------------------------------------------

/**
 * The launch floor of docs/floor.md built from the lobby: five seated at their seat's minimum
 * rent (`launch_floor`), one empty.
 */
export function mockFloor(dealers: readonly DealerView[]): FloorView {
  const seats: SeatView[] = Array.from({ length: SEATS }, (_, seat) => {
    const dealer = seat < SEATS - 1 ? dealers[seat] : undefined
    const minRent = seatMinRent(seat).toString()
    const empty: SeatView = {
      seat,
      dealer_id: null,
      rent_per_hour: '0',
      seated_at: 0,
      traffic_bp: SEAT_TRAFFIC_BP[seat],
      min_rent: minRent,
      controller: null,
      rent_owed: '0',
      paid_until: 0,
      ask: null,
    }
    return dealer ? { ...empty, dealer_id: dealer.id, rent_per_hour: minRent, controller: dealer.controller } : empty
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
const DEV_CONTROLLER = 'you.testnet'

/**
 * Dev demo (`?evict=<id>`) on mock data only: a player's new table outbids `dealerId` and takes its
 * seat, so the eviction and arrival animations can be watched before the contract has seats.
 */
export function devEvict(state: FloorState, dealerId: string): FloorState {
  const evicted = state.dealers.find((d) => d.id === dealerId)
  if (!state.mock || !evicted || !state.floor.seats.some((s) => s.dealer_id === dealerId)) return state
  const seats = state.floor.seats.map((s) =>
    s.dealer_id === dealerId
      ? { ...s, dealer_id: DEV_NEWCOMER_ID, rent_per_hour: outbidOver(BigInt(s.min_rent)).toString(), controller: DEV_CONTROLLER }
      : s,
  )
  const newcomer: DealerView = {
    ...evicted,
    id: DEV_NEWCOMER_ID,
    name: 'Your table',
    temperament: 'promoter',
    reason: 'bidding_for_seat',
    reason_text: 'just opened: outbid the cheapest seat',
    npc: false,
    controller: DEV_CONTROLLER,
  }
  const info = new Map(state.info)
  info.set(DEV_NEWCOMER_ID, { npc: false, controller: DEV_CONTROLLER, dealer_account: null, look: 'top-hat' })
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
