// "How the house works": a guided tour of the lobby, one economy step per screen. The state
// machine and the picks of live data to show are pure, so they are tested without a browser.
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { freeBankroll } from './house'
import type { SeatedTable } from './near/floor'
import { chainStep, replayRound, roundWager, type CompactRound, type SessionState, type SessionTicket } from './near/session-client'
import type { FloorFocus } from './scene/lobby/LobbyScene'
import type { FootfallReply, GamblerSnapshot, Persona } from './sim/gamblers'

export const TOUR_STEPS = ['walk_in', 'compare', 'pools', 'seats', 'jackpot', 'fair', 'your_move'] as const
export type TourStep = (typeof TOUR_STEPS)[number]

export type TourState = { kind: 'hidden' } | { kind: 'offered' } | { kind: 'step'; index: number }

export type TourAction =
  | { type: 'offer' }
  | { type: 'start' }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'go'; index: number }
  | { type: 'close' }

export const TOUR_HIDDEN: TourState = { kind: 'hidden' }

export function tourReducer(state: TourState, action: TourAction): TourState {
  switch (action.type) {
    case 'offer':
      // Never interrupts a tour already running, nor comes back once dismissed in this visit.
      return state.kind === 'hidden' ? { kind: 'offered' } : state
    case 'start':
      return { kind: 'step', index: 0 }
    case 'next':
      if (state.kind !== 'step') return state
      return state.index + 1 < TOUR_STEPS.length ? { kind: 'step', index: state.index + 1 } : TOUR_HIDDEN
    case 'back':
      return state.kind === 'step' && state.index > 0 ? { kind: 'step', index: state.index - 1 } : state
    case 'go':
      return Number.isInteger(action.index) && action.index >= 0 && action.index < TOUR_STEPS.length
        ? { kind: 'step', index: action.index }
        : state
    case 'close':
      return TOUR_HIDDEN
  }
}

export function currentStep(state: TourState): TourStep | null {
  return state.kind === 'step' ? TOUR_STEPS[state.index] : null
}

// ---- first visit ------------------------------------------------------------------------------

export const TOUR_SEEN_KEY = 'tilt-house:tour-seen'

/** Storage may be missing or throw (private mode, blocked cookies): then the offer just shows again. */
export function tourSeen(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(TOUR_SEEN_KEY) === '1'
  } catch {
    return false
  }
}

export function markTourSeen(storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(TOUR_SEEN_KEY, '1')
  } catch {
    // Not remembered: the offer comes back next visit, which is harmless.
  }
}

// ---- economy constants shown in the captions ---------------------------------------------------

/** `core_rules::gambler_rules::GAMBLER_SALARY_PER_HOUR`: the economy's only outside money. */
export const GAMBLER_SALARY_PER_HOUR = 5_000_000n
/** `core_rules::gambler_rules::GAMBLER_MAX_BALANCE`: no salary past this balance. */
export const GAMBLER_MAX_BALANCE = 200_000_000n

// ---- what each step points the camera at -----------------------------------------------------

export interface TourPicks {
  /** 0-based seat of the table the chooser picked. */
  chooserSeat: number | null
  /** 0-based seat of the table the tour features. */
  tableSeat: number | null
}

export function tourFocus(step: TourStep, picks: TourPicks): FloorFocus {
  const seatOr = (seat: number | null): FloorFocus => (seat === null ? { kind: 'overview' } : { kind: 'seat', seat })
  switch (step) {
    case 'walk_in':
      return { kind: 'entrance' }
    case 'compare':
      return seatOr(picks.chooserSeat)
    case 'pools':
    case 'fair':
      return seatOr(picks.tableSeat)
    case 'seats':
      return { kind: 'traffic' }
    case 'jackpot':
      return { kind: 'jackpot' }
    case 'your_move':
      return { kind: 'overview' }
  }
}

// ---- live picks -------------------------------------------------------------------------------

const STATE_RANK: Record<GamblerSnapshot['state'], number> = { deciding: 0, seated: 1, walking: 2, leaving: 3 }

/** The gambler to follow: one weighing a table (its reason in the bubble) beats one just walking. */
export function pickGambler(gamblers: readonly GamblerSnapshot[]): GamblerSnapshot | null {
  const ranked = [...gamblers].sort((a, b) => rank(a) - rank(b))
  return ranked[0] ?? null
}

function rank(g: GamblerSnapshot): number {
  const withReason = g.reason !== null && g.dealer_id !== null ? 0 : 10
  return withReason + STATE_RANK[g.state]
}

/** The table to feature: a player's table shows the game best, else the deepest pool. */
export function pickTable(seats: readonly (SeatedTable | null)[]): number | null {
  let best: number | null = null
  seats.forEach((s, i) => {
    if (!s || !s.dealer.open) return
    const current = best === null ? null : seats[best]
    if (!current) {
      best = i
      return
    }
    if (s.playerOwned !== current.playerOwned) {
      if (s.playerOwned) best = i
      return
    }
    if (freeBankroll(s.dealer) > freeBankroll(current.dealer)) best = i
  })
  return best
}

/** A gambler that picked a table, with the one-line reason it gave. */
export interface Chooser {
  /** Null when known only from the footfall, which keeps personas and not names. */
  name: string | null
  persona: Persona | null
  reason: string
  dealer_id: string
}

/**
 * The choice to explain: the followed gambler's own when it is weighing a table, else the latest
 * arrival that sat somewhere over the last hour (live footfall), so a quiet floor still shows one.
 */
export function pickChooser(gambler: GamblerSnapshot | null, footfalls: ReadonlyMap<string, FootfallReply>): Chooser | null {
  if (gambler?.reason && gambler.dealer_id) {
    return { name: gambler.name, persona: gambler.persona, reason: gambler.reason, dealer_id: gambler.dealer_id }
  }
  let best: { chooser: Chooser; age: number } | null = null
  // Every footfall lists the same arrivals, newest last: how far from the end the table's last pick is.
  for (const footfall of footfalls.values()) {
    const arrivals = footfall.arrivals_1h
    let index = arrivals.length - 1
    while (index >= 0 && !arrivals[index].chose) index--
    const age = arrivals.length - 1 - index
    if (index < 0 || (best !== null && best.age <= age)) continue
    const a = arrivals[index]
    best = { chooser: { name: null, persona: a.persona, reason: a.reason, dealer_id: footfall.dealer_id }, age }
  }
  return best?.chooser ?? null
}

export interface ComparedOffer {
  seat: number
  dealerId: string
  name: string
  game: string
  edgeBp: number
  maxBet: string
  boosted: boolean
  /** The gambler's score for this table (footfall), null when not known. */
  score: number | null
  chosen: boolean
}

/**
 * The offers on the floor as the gambler saw them. A footfall lists every arrival scored for that
 * table with the reason of its final choice, so the gambler's arrival is the latest one with its
 * persona and reason; its score per table is what it compared.
 */
export function comparedOffers(
  seats: readonly (SeatedTable | null)[],
  chooser: Chooser,
  footfalls: ReadonlyMap<string, FootfallReply>,
  nowSecs: number,
): ComparedOffer[] {
  const offers: ComparedOffer[] = []
  seats.forEach((s, seat) => {
    if (!s || !s.dealer.open) return
    const d = s.dealer
    offers.push({
      seat,
      dealerId: d.id,
      name: d.name,
      game: d.game,
      edgeBp: d.total_edge_bp,
      maxBet: d.max_bet,
      boosted: d.boost_until > nowSecs,
      score: arrivalScore(footfalls.get(d.id), chooser),
      chosen: d.id === chooser.dealer_id,
    })
  })
  return offers
}

function arrivalScore(footfall: FootfallReply | undefined, chooser: Chooser): number | null {
  if (!footfall) return null
  for (let i = footfall.arrivals_1h.length - 1; i >= 0; i--) {
    const a = footfall.arrivals_1h[i]
    if (a.reason === chooser.reason && (chooser.persona === null || a.persona === chooser.persona)) return a.score
  }
  return null
}

/** Rent paid per hour by every seated table: what flows into the jackpot. */
export function rentPerHour(seats: readonly (SeatedTable | null)[]): bigint {
  return seats.reduce((sum, s) => sum + (s ? BigInt(s.rent) : 0n), 0n)
}

// ---- the fairness demo ------------------------------------------------------------------------

export interface FairDemo {
  ticket: SessionTicket
  rounds: CompactRound[]
  state: SessionState
  /** Hex, revealed only once the demo "leaves the table". */
  serverSeed: string
}

/** Three 1 tUSDC rolls under 50 at 1 % rake: enough to show a win, a loss and the replay. */
const DEMO_ROLLS = 3
const DEMO_STAKE = 1_000_000n
const DEMO_LOCK = 10_000_000n
const DEMO_RAKE_BP = 100

/**
 * A tiny session played in the browser with the same rules as the session server: commit
 * (hash of a secret seed), play, then reveal. Nothing is signed or sent; `verifySession` checks it
 * exactly as the table page checks a real one.
 */
export function playFairDemo(seed: Uint8Array, clientSeed: string): FairDemo {
  const ticket: SessionTicket = {
    session_id: 'tour',
    player: 'you',
    dealer_id: 'tour',
    game: 'dice',
    lock: DEMO_LOCK.toString(),
    server_seed_hash: bytesToHex(sha256(seed)),
    client_seed: clientSeed,
    rake_bp: DEMO_RAKE_BP,
    max_bet: DEMO_STAKE.toString(),
    max_win: DEMO_LOCK.toString(),
    expires_at: 0,
  }
  let state: SessionState = { session_id: 'tour', nonce: 0, balance: ticket.lock, chain: ticket.server_seed_hash }
  const rounds: CompactRound[] = []
  for (let nonce = 1; nonce <= DEMO_ROLLS; nonce++) {
    const round = replayRound(seed, ticket, nonce, { dice: { chance_bp: 5_000, over: false } }, DEMO_STAKE, [])
    const balance = BigInt(state.balance) - roundWager(round) + BigInt(round.payout)
    state = { ...state, nonce, balance: balance.toString(), chain: chainStep(state.chain, round) }
    rounds.push(round)
  }
  return { ticket, rounds, state, serverSeed: bytesToHex(seed) }
}

/** The same rounds with one roll changed: what a cheating server would have to publish. */
export function tamperedRounds(rounds: readonly CompactRound[]): CompactRound[] {
  return rounds.map((round, i) => {
    if (i !== 0 || !('dice' in round.outcome)) return round
    return { ...round, outcome: { dice: { roll: (round.outcome.dice.roll + 1) % 10_000 } } }
  })
}
