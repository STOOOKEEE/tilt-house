/**
 * Table owner dashboard math (docs/tycoon.md, "Owner controls" and "Seats"): pure functions over
 * contract views and the session server's footfall. UI-side copies of core constants only guide
 * the forms; the contract clamps every offer (`core::clamp_owner_offer`) and re-checks every bid.
 */
import { formatCountdown, formatUsdc } from './format'
import { freeBankroll } from './house'
import { PREPAY_HOURS, type FloorState } from './near/floor'
import type { DealerView, Game, PlayerView } from './near/views'
import type { Arrival, Persona } from './sim/gamblers'

/** `core::rake_bounds(game)`: keeps the total edge within 1–5 % for every bet of the game. */
export const RAKE_BOUNDS: Record<Game, readonly [number, number]> = {
  dice: [100, 495],
  roulette: [0, 230],
  blackjack: [0, 389],
  poker: [0, 500],
}

/** `core::base_edge_bp(game)`: used when the v1 contract does not send `base_edge_bp`. */
const BASE_EDGE_BP: Record<Game, number> = { dice: 0, roulette: 270, blackjack: 117, poker: 0 }

/** `core::dealer_rules::{MAX_BOOST_SECS, BOOST_COOLDOWN_SECS}` and `core::floor::TEMPERAMENT_COOLDOWN_SECS`. */
export const MAX_BOOST_SECS = 15 * 60
export const BOOST_COOLDOWN_SECS = 60 * 60
export const TEMPERAMENT_COOLDOWN_SECS = 60 * 60

/** The `dealer_rules` temperaments an owner can put the table on autopilot with. */
export const TEMPERAMENTS = ['greedy', 'promoter', 'cautious'] as const
export type Temperament = (typeof TEMPERAMENTS)[number]

/** `core_rules::SHARES_PER_UNIT`: one LP token (as shown) = what 1 tUSDC bought at launch. */
export const SHARES_PER_UNIT = 1_000_000n

const BP = 10_000

// ---- the table's hour ---------------------------------------------------------------------

/** Seat traffic as players read it: 15000 bp → "1.5×". */
export function trafficMultiple(bp: number): string {
  return `${(bp / BP).toFixed(1)}×`
}

export interface HourMoney {
  /** What players lost at the table over the last hour (`earnings_1h`). */
  revenue: bigint | null
  /** The seat's rent per hour now; null off the floor. */
  rentPerHour: bigint | null
  /** Rent actually paid over the last hour. */
  rentPaid: bigint | null
  /** revenue − rent paid, last hour. */
  pnl: bigint | null
}

/** Null fields: the v1 contract does not report them. */
export function hourMoney(dealer: DealerView): HourMoney {
  const big = (value: string | null) => (value === null ? null : BigInt(value))
  return {
    revenue: big(dealer.earnings_1h),
    rentPerHour: big(dealer.rent_per_hour),
    rentPaid: big(dealer.rent_1h),
    pnl: big(dealer.pnl_1h),
  }
}

// ---- offer controls -----------------------------------------------------------------------

/**
 * Total edge for a rake: base edge + rake. For roulette and blackjack the true edge is a little
 * lower (the rake only bites winning rounds), so this never understates what gamblers pay.
 */
export function totalEdgeBp(dealer: Pick<DealerView, 'game' | 'base_edge_bp'>, rakeBp: number): number {
  return (dealer.base_edge_bp ?? BASE_EDGE_BP[dealer.game]) + rakeBp
}

/** The biggest max bet the pool covers: free bankroll / worst-case multiple (the contract caps there). */
export function maxBetCap(dealer: Pick<DealerView, 'bankroll' | 'reserved' | 'worst_case_multiple'>): bigint {
  const multiple = BigInt(dealer.worst_case_multiple)
  return multiple > 0n ? freeBankroll(dealer) / multiple : 0n
}

/** Seconds before a once-an-hour action is allowed again; 0 = now (`last` 0 or null = never). */
export function cooldownLeft(last: number | null, cooldownSecs: number, now: number): number {
  if (!last) return 0
  return Math.max(0, last + cooldownSecs - now)
}

export interface OfferInput {
  rakeBp: number
  /** Null when the typed amount is not a valid tUSDC amount. */
  maxBet: bigint | null
  boostSecs: number
}

/** Why `set_offer` would be clamped or refused, or null. */
export function offerProblem(dealer: DealerView, input: OfferInput, now: number): string | null {
  const [low, high] = RAKE_BOUNDS[dealer.game]
  if (!Number.isInteger(input.rakeBp) || input.rakeBp < low || input.rakeBp > high) {
    return `rake: ${low}–${high} bp for ${dealer.game}`
  }
  const minBet = BigInt(dealer.min_bet)
  if (input.maxBet === null || input.maxBet < minBet) return `max bet: at least ${formatUsdc(minBet)} tUSDC`
  const cap = maxBetCap(dealer)
  if (input.maxBet > cap) return `max bet: the pool covers at most ${formatUsdc(cap)} tUSDC`
  if (!Number.isInteger(input.boostSecs) || input.boostSecs < 0 || input.boostSecs > MAX_BOOST_SECS) {
    return `boost: 0 to ${MAX_BOOST_SECS / 60} minutes`
  }
  const wait = cooldownLeft(dealer.last_boost_at, BOOST_COOLDOWN_SECS, now)
  if (input.boostSecs > 0 && wait > 0) return `one boost per hour: next in ${formatCountdown(wait)}`
  return null
}

// ---- offer preview ------------------------------------------------------------------------

/**
 * Mirror of `core::gambler_rules::weights`: how much the edge counts for each persona (percent)
 * and the score a table needs. Only the edge part is replayed here.
 */
const PERSONA_EDGE: Record<Persona, { weight: number; threshold: number }> = {
  bargain_hunter: { weight: 300, threshold: 150 },
  regular: { weight: 80, threshold: 90 },
  whale: { weight: 80, threshold: 220 },
  thrill_seeker: { weight: 40, threshold: 110 },
  tourist: { weight: 40, threshold: 130 },
}
/** `gambler_rules` maps total edges 1–5 % to an edge score of 100–0. */
const EDGE_FLOOR_BP = 100
const EDGE_CEILING_BP = 500

/** The weighted edge points a persona gives a table, with the same integer rounding as core. */
function edgePoints(persona: Persona, edgeBp: number): number {
  const edge = Math.min(Math.max(edgeBp, EDGE_FLOOR_BP), EDGE_CEILING_BP)
  const part = Math.trunc(((EDGE_CEILING_BP - edge) * 100) / (EDGE_CEILING_BP - EDGE_FLOOR_BP))
  return Math.trunc((part * PERSONA_EDGE[persona].weight) / 100)
}

export interface OfferPreview {
  /** Arrivals on the floor over the last hour. */
  arrivals: number
  /** How many of them sat here. */
  sat: number
  /** How many would have sat here with the new edge (see `previewOffer`). */
  predicted: number
}

/**
 * How many of the last hour's arrivals would have sat here with a different total edge.
 * Approximation, kept honest: each arrival's recorded score for this table is shifted by the
 * edge points it gains or loses, then only threshold crossings count. A gambler who sat here
 * stays unless its score drops below its persona's threshold; one who left the floor ("nothing
 * worth it") is won if its score clears the threshold. Gamblers who went to a rival are left as
 * they were: their rival's score is not known, so the preview never claims to steal them.
 */
export function previewOffer(arrivals: readonly Arrival[], currentEdgeBp: number, newEdgeBp: number): OfferPreview {
  let predicted = 0
  for (const a of arrivals) {
    const { threshold } = PERSONA_EDGE[a.persona]
    const score = a.score - edgePoints(a.persona, currentEdgeBp) + edgePoints(a.persona, newEdgeBp)
    const leftTheFloor = !a.chose && a.score < threshold
    if ((a.chose || leftTheFloor) && score >= threshold) predicted += 1
  }
  return { arrivals: arrivals.length, sat: arrivals.filter((a) => a.chose).length, predicted }
}

// ---- tables and seats ---------------------------------------------------------------------

/** The tables `walletId` controls: listed in its PlayerView (v2) or naming it as controller. */
export function myTables(dealers: readonly DealerView[], player: PlayerView | null, walletId: string): DealerView[] {
  if (!walletId) return []
  return dealers.filter((d) => player?.tables.includes(d.id) || d.controller === walletId)
}

export function isSeated(state: FloorState, dealerId: string): boolean {
  return state.floor.seats.some((s) => s.dealer_id === dealerId)
}

export interface SeatRow {
  /** 0-based; `buy_seat` wants `index + 1`. */
  index: number
  traffic_bp: number
  min_rent: string
  /** Null on an empty seat. */
  rent: string | null
  dealer: DealerView | null
  controller: string | null
  ask: string | null
}

/** The six seats for the seat market, in seat order. */
export function seatMarket(state: FloorState): SeatRow[] {
  return state.floor.seats.map((s) => ({
    index: s.seat,
    traffic_bp: s.traffic_bp,
    min_rent: s.min_rent,
    rent: s.dealer_id === null ? null : s.rent_per_hour,
    dealer: state.dealers.find((d) => d.id === s.dealer_id) ?? null,
    controller: s.controller,
    ask: s.ask,
  }))
}

/** Why `bid_for_seat` from off the floor would fail, or null. */
export function bidProblem(dealer: DealerView, rent: bigint | null, outbidMin: bigint, now: number): string | null {
  if (dealer.cooldown_until !== null && dealer.cooldown_until > now) {
    return `evicted recently: can bid again in ${formatCountdown(dealer.cooldown_until - now)}`
  }
  if (rent === null || rent < outbidMin) return `rent: at least ${formatUsdc(outbidMin)} tUSDC/h takes a seat now`
  if (rent * PREPAY_HOURS > freeBankroll(dealer)) return `the pool must prepay ${PREPAY_HOURS} hours of rent: invest first`
  return null
}
