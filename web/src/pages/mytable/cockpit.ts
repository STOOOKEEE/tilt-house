/**
 * The owner's cockpit on My table (docs/tycoon.md): pure functions over the floor, the lobby and
 * the live gambler feed. They only word the choices and fill the arguments of calls that already
 * exist (`set_offer`, `bid_for_seat`); the contract clamps and re-checks every one of them.
 */
import { formatBp, formatCountdown, formatUsdc, tokenSymbol } from '../../format'
import { freeBankroll } from '../../house'
import { isPlayerOwned, type FloorState, type SeatView } from '../../near/floor'
import type { DealerView } from '../../near/views'
import { tablePath } from '../../paths'
import type { GamblerSnapshot, Hesitation, Persona } from '../../sim/gamblers'
import { BOOST_COOLDOWN_SECS, MAX_BOOST_SECS, RAKE_BOUNDS, cooldownLeft, maxBetCap, offerProblem, totalEdgeBp } from '../../tycoon'

/** Sends one relayed owner call (`set_offer`, `invest`, …) to the house. */
export type Send = (label: string, method: string, args: object) => void

const BP = 10_000n
const SECS_PER_HOUR = 3_600n
/** 0.01 tUSDC in base units: suggested amounts are round to the cent. */
const CENT = 10_000n

/** `core::gambler_rules` personas in the owner's words. */
export const PERSONA_WORDS: Record<Persona, { label: string; cares: string }> = {
  bargain_hunter: { label: 'bargain hunter', cares: 'the total edge above everything' },
  regular: { label: 'regular', cares: 'tables that treated it well' },
  whale: { label: 'whale', cares: 'a max bet that takes its big stakes' },
  thrill_seeker: { label: 'thrill seeker', cares: 'boosts and a fat jackpot' },
  tourist: { label: 'tourist', cares: 'the first table it walks past' },
}

export function personaLabel(persona: Persona | null): string {
  return persona === null ? 'gambler' : PERSONA_WORDS[persona].label
}

// ---- customers at your door ---------------------------------------------------------------

/** `set_offer` arguments (docs/contract-api.md). */
export interface SetOfferArgs {
  dealer_id: string
  rake_bp: number
  max_bet: string
  boost_secs: number
}

/** One-click answer to what a hesitating gambler asks for. */
export type DoorAnswer =
  | { kind: 'offer'; label: string; args: SetOfferArgs }
  /** The pool cannot cover the max bet asked for: invest `need` first. */
  | { kind: 'invest'; label: string; need: bigint }
  | { kind: 'blocked'; label: string; reason: string }

/** The offer as it stands: the rake the owner set, the max bet (down to what the pool covers now), no boost. */
export function currentOffer(dealer: DealerView): SetOfferArgs {
  const maxBet = BigInt(dealer.max_bet)
  const cap = maxBetCap(dealer)
  return {
    dealer_id: dealer.id,
    rake_bp: dealer.offer_rake_bp ?? dealer.rake_bp,
    max_bet: String(maxBet < cap ? maxBet : cap),
    boost_secs: 0,
  }
}

/** What the free bankroll lacks for the pool to cover `maxBet` (`maxBetCap` = free / worst-case multiple). */
export function investToCover(dealer: DealerView, maxBet: bigint): bigint {
  const need = maxBet * BigInt(dealer.worst_case_multiple) - freeBankroll(dealer)
  return need > 0n ? need : 0n
}

const blocked = (label: string, reason: string): DoorAnswer => ({ kind: 'blocked', label, reason })

function draftAnswer(dealer: DealerView, want: Hesitation, keep: SetOfferArgs, now: number): DoorAnswer {
  switch (want.want) {
    case 'lower_edge': {
      const base = totalEdgeBp(dealer, 0)
      const [low] = RAKE_BOUNDS[dealer.game]
      const target = want.edge_bp ?? 0
      const rake = Math.max(target - base, low)
      const label = `Cut my edge to ${formatBp(base + rake)}`
      if (base + rake > target) return blocked(label, `${dealer.game} cannot go under ${formatBp(base + low)}`)
      if (rake >= keep.rake_bp) return blocked(label, `your edge is already ${formatBp(totalEdgeBp(dealer, keep.rake_bp))}`)
      return { kind: 'offer', label, args: { ...keep, rake_bp: rake } }
    }
    case 'higher_max_bet': {
      const wanted = BigInt(want.max_bet ?? '0')
      const label = `Raise my max bet to ${formatUsdc(wanted)} ${tokenSymbol()}`
      if (wanted <= BigInt(dealer.max_bet)) return blocked(label, `your max bet is already ${formatUsdc(dealer.max_bet)}`)
      if (wanted > maxBetCap(dealer)) return { kind: 'invest', label, need: investToCover(dealer, wanted) }
      return { kind: 'offer', label, args: { ...keep, max_bet: String(wanted) } }
    }
    case 'boost': {
      const label = `Boost ${MAX_BOOST_SECS / 60} min`
      const wait = cooldownLeft(dealer.last_boost_at, BOOST_COOLDOWN_SECS, now)
      if (wait > 0) return blocked(label, `a boost ran in the last hour: next in ${formatCountdown(wait)}`)
      return { kind: 'offer', label, args: { ...keep, boost_secs: MAX_BOOST_SECS } }
    }
  }
}

/** The one change that answers `want`, every other field of the offer kept as it is. */
export function answerWant(dealer: DealerView, want: Hesitation, now: number): DoorAnswer {
  const answer = draftAnswer(dealer, want, currentOffer(dealer), now)
  if (answer.kind !== 'offer') return answer
  const { rake_bp, max_bet, boost_secs } = answer.args
  const problem = offerProblem(dealer, { rakeBp: rake_bp, maxBet: BigInt(max_bet), boostSecs: boost_secs }, now)
  return problem === null ? answer : blocked(answer.label, problem)
}

export function decidesIn(until: number, now: number): string {
  const left = until - now
  return left > 0 ? `decides in ${formatCountdown(left)}` : 'deciding now…'
}

/** A gambler that hesitated at the table, kept after its pause to show what it chose. */
export interface DoorCard {
  gambler_id: string
  name: string
  persona: Persona | null
  /** Its ask, in its words. */
  ask: string | null
  hesitating: Hesitation
}

/** How long a card stays up after the pause, with the outcome. */
export const OUTCOME_SHOWN_SECS = 120

/**
 * The cards to show after a new feed: every gambler hesitating at `dealerId` now (fresh data
 * wins), plus earlier ones whose outcome is still on show. Soonest decision first.
 */
export function trackDoor(cards: readonly DoorCard[], feed: readonly GamblerSnapshot[], dealerId: string, now: number): DoorCard[] {
  const fresh: DoorCard[] = []
  for (const g of feed) {
    if (g.hesitating?.dealer_id !== dealerId) continue
    fresh.push({ gambler_id: g.id, name: g.name ?? g.id, persona: g.persona, ask: g.reason, hesitating: g.hesitating })
  }
  const freshIds = new Set(fresh.map((c) => c.gambler_id))
  const kept = cards.filter((c) => !freshIds.has(c.gambler_id) && c.hesitating.until + OUTCOME_SHOWN_SECS > now)
  return [...fresh, ...kept].sort((a, b) => a.hesitating.until - b.hesitating.until)
}

export type DoorOutcome =
  | { kind: 'deciding' }
  | { kind: 'sat'; reason: string | null }
  | { kind: 'rival'; dealer_id: string; reason: string | null }
  | { kind: 'left'; reason: string | null }

/** What the gambler of `card` did once its pause ran out, from the feed. */
export function doorOutcome(card: DoorCard, feed: readonly GamblerSnapshot[], now: number): DoorOutcome {
  const table = card.hesitating.dealer_id
  const g = feed.find((entry) => entry.id === card.gambler_id)
  if (now < card.hesitating.until || g?.hesitating?.dealer_id === table) return { kind: 'deciding' }
  if (g === undefined || g.state === 'leaving' || g.dealer_id === null) return { kind: 'left', reason: g?.reason ?? null }
  if (g.dealer_id !== table) return { kind: 'rival', dealer_id: g.dealer_id, reason: g.reason }
  return g.state === 'seated' ? { kind: 'sat', reason: g.reason } : { kind: 'deciding' }
}

// ---- capital at risk ----------------------------------------------------------------------

export interface Exposure {
  bankroll: bigint
  /** What open sessions reserve: the most their players can still win from the table. */
  reserved: bigint
  free: bigint
  /** reserved / bankroll, 0–10000. */
  reserved_bp: number
}

export function exposure(dealer: DealerView): Exposure {
  const bankroll = BigInt(dealer.bankroll)
  const reserved = BigInt(dealer.reserved)
  const bp = bankroll > 0n ? (reserved * BP) / bankroll : reserved > 0n ? BP : 0n
  return { bankroll, reserved, free: freeBankroll(dealer), reserved_bp: Number(bp > BP ? BP : bp) }
}

/** A customer is "up big" once its session won this share of the table's bankroll. */
export const UP_BIG_BP = 500n

export interface Customer {
  gambler: GamblerSnapshot
  net: bigint
  /** Who to watch: anyone up big, else a whale. */
  flag: 'up_big' | 'whale' | null
}

/** The gamblers seated at the table now, biggest winner first. */
export function seatedCustomers(feed: readonly GamblerSnapshot[], dealer: DealerView): Customer[] {
  const bankroll = BigInt(dealer.bankroll)
  return feed
    .filter((g) => g.dealer_id === dealer.id && g.state === 'seated')
    .map((gambler) => {
      const net = BigInt(gambler.session_net)
      const upBig = net > 0n && net * BP >= bankroll * UP_BIG_BP
      const flag = upBig ? 'up_big' : gambler.persona === 'whale' ? 'whale' : null
      return { gambler, net, flag } satisfies Customer
    })
    .sort((a, b) => (a.net === b.net ? 0 : a.net > b.net ? -1 : 1))
}

/** "Cap max bet at X": half the max bet in whole cents (never under the min bet), rake kept; null when it cannot go lower. */
export function capMaxBet(dealer: DealerView): SetOfferArgs | null {
  const keep = currentOffer(dealer)
  const minBet = BigInt(dealer.min_bet)
  const half = (BigInt(keep.max_bet) / 2n / CENT) * CENT
  const capped = half > minBet ? half : minBet
  return capped < BigInt(dealer.max_bet) ? { ...keep, max_bet: String(capped) } : null
}

// ---- rent and seats -----------------------------------------------------------------------

/**
 * Seconds before the seat's table is evicted for unpaid rent at today's numbers: the prepaid time
 * left, then as long as the free bankroll pays the rent (the keeper settles it every minute and
 * evicts at its next pass once the pool cannot pay). Null on an empty or rent-free seat.
 */
export function evictionIn(seat: SeatView, dealer: DealerView, now: number): number | null {
  const rent = BigInt(seat.rent_per_hour)
  if (seat.dealer_id === null || rent === 0n) return null
  const prepaid = Math.max(0, seat.paid_until - now)
  const left = freeBankroll(dealer) - BigInt(seat.rent_owed)
  return prepaid + (left > 0n ? Number((left * SECS_PER_HOUR) / rent) : 0)
}

/** Rivals whose eviction this close frees their seat. */
export const FREEING_SOON_SECS = 3_600

export interface SeatRef {
  seat: SeatView
  dealer: DealerView | null
}

export interface Ladder {
  mine: SeatView | null
  /** The next seat up (more traffic), when seated below seat 1. */
  above: SeatRef | null
  /** Where a bid from off the floor lands: the busiest empty seat, else the weakest one it evicts. */
  target: SeatRef | null
  /** Rent per hour that takes `target` now (an empty seat's minimum, else the lowest rent + 10 %). */
  outbid: bigint
  /** Seated, and the weakest seat of a full floor: the rent that lifts the table off the bottom. */
  defend: bigint | null
  /** Other tables' seats listed for sale. */
  for_sale: SeatRef[]
  /** Other tables close to eviction for unpaid rent. */
  freeing: (SeatRef & { in_secs: number })[]
}

/** Mirror of `core::Floor::weakest_seat`: lowest rent, then the latest seated, then the highest index. */
function weakestSeat(seats: readonly SeatView[]): SeatView | null {
  let weakest: SeatView | null = null
  for (const s of seats) {
    if (s.dealer_id === null) continue
    if (weakest === null) {
      weakest = s
      continue
    }
    const rent = BigInt(s.rent_per_hour)
    const best = BigInt(weakest.rent_per_hour)
    if (rent < best || (rent === best && (s.seated_at > weakest.seated_at || (s.seated_at === weakest.seated_at && s.seat > weakest.seat)))) {
      weakest = s
    }
  }
  return weakest
}

/** Rents shown and typed with cents: the smallest round amount strictly above `value`. */
function centAbove(value: bigint): bigint {
  return (value / CENT + 1n) * CENT
}

export function seatLadder(state: FloorState, dealerId: string, now: number): Ladder {
  const seats = state.floor.seats
  const ref = (seat: SeatView): SeatRef => ({ seat, dealer: state.dealers.find((d) => d.id === seat.dealer_id) ?? null })
  const mine = seats.find((s) => s.dealer_id === dealerId) ?? null
  const above = mine && mine.seat > 0 ? (seats.find((s) => s.seat === mine.seat - 1) ?? null) : null
  const empty = seats.find((s) => s.dealer_id === null) ?? null
  const weakest = weakestSeat(seats)
  const others = seats.filter((s) => s.dealer_id !== null && s.dealer_id !== dealerId)
  const lowestOther = others.reduce<bigint | null>((low, s) => {
    const rent = BigInt(s.rent_per_hour)
    return low === null || rent < low ? rent : low
  }, null)
  const defend = mine && !empty && weakest?.seat === mine.seat && lowestOther !== null ? centAbove(lowestOther) : null
  const freeing = others.flatMap((s) => {
    const r = ref(s)
    const inSecs = r.dealer ? evictionIn(s, r.dealer, now) : null
    return inSecs !== null && inSecs < FREEING_SOON_SECS ? [{ ...r, in_secs: inSecs }] : []
  })
  return {
    mine,
    above: above ? ref(above) : null,
    target: empty ? ref(empty) : weakest ? ref(weakest) : null,
    outbid: BigInt(state.floor.outbid_min),
    defend,
    for_sale: others.filter((s) => s.ask !== null).map(ref),
    freeing: freeing.sort((a, b) => a.in_secs - b.in_secs),
  }
}

// ---- rivals -------------------------------------------------------------------------------

/**
 * NPC dealers whose latest reprice undercut a cheaper table that is ours: `core::dealer_rules`
 * `undercut` cuts just under the cheapest seated rival of the same game after losing players to
 * it, so it is aimed at us when ours is that cheapest table.
 */
export function undercutters(state: FloorState, mine: DealerView): DealerView[] {
  const seated = new Set(state.floor.seats.flatMap((s) => (s.dealer_id === null ? [] : [s.dealer_id])))
  if (!seated.has(mine.id)) return []
  const sameGame = state.dealers.filter((d) => d.game === mine.game && seated.has(d.id))
  return sameGame.filter(
    (rival) =>
      rival.id !== mine.id &&
      !isPlayerOwned(state.info.get(rival.id)) &&
      rival.reason === 'undercut' &&
      rival.total_edge_bp < mine.total_edge_bp &&
      sameGame.every((other) => other.id === rival.id || other.total_edge_bp >= mine.total_edge_bp),
  )
}

// ---- test my table ------------------------------------------------------------------------

/** Practice at the table: same rules, local seed, nothing on chain. Poker practises against bots. */
export function practicePath(dealer: Pick<DealerView, 'id' | 'game'>): string {
  return dealer.game === 'poker' ? '/poker?demo=1' : `${tablePath(dealer)}?demo=1`
}
