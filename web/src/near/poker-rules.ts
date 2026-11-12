/**
 * `core_rules::poker` (core/src/poker.rs) in TypeScript, for the browser to replay a finished
 * hand from its revealed seed: the deck, hand values, the betting state machine and the
 * settlement, line for line. It never decides anything the server relies on; a drift makes a
 * replay fail, never pass. Cross-checked by poker-vectors.json, produced by the Rust code.
 */
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { clientSeedIsValid, Rng, Writer } from './session-client'

export const MAX_SEATS = 6
const MIN_PLAYERS = 2
export const MAX_RAKE_BP = 500
const MAX_TABLE_LEN = 64
export const DECK_DOMAIN = 'tilt-house/poker-deck/v1'
const BP = 10_000n
const RANKS = '23456789TJQKA'
const SUITS = 'cdhs'

// ---- cards and deck ------------------------------------------------------------------------

/** Card `0..52`: rank `index / 4` (0 = deuce … 12 = ace), suit `index % 4` (c d h s). */
export type CardIndex = number

export function parseCard(text: string): CardIndex {
  const rank = RANKS.indexOf(text[0] ?? '')
  const suit = SUITS.indexOf(text[1] ?? '')
  if (text.length !== 2 || rank < 0 || suit < 0) throw new Error(`not a card: ${text}`)
  return rank * 4 + suit
}

export function cardText(card: CardIndex): string {
  if (!Number.isInteger(card) || card < 0 || card >= 52) throw new Error(`not a card index: ${card}`)
  return RANKS[card >> 2] + SUITS[card & 3]
}

/** `HMAC-SHA256(hand_seed, DECK_DOMAIN || ":" || seed_1 || ":" || …)`, client seeds in seat order. */
export function deckSeed(handSeed: Uint8Array, clientSeeds: readonly string[]): Uint8Array {
  const message = [DECK_DOMAIN, ...clientSeeds].join(':')
  return hmac(sha256, handSeed, new TextEncoder().encode(message))
}

/** Fisher–Yates from the top over the sorted deck (`i` = 51 down to 1 swaps with `below(i + 1)`). */
export function deckFor(handSeed: Uint8Array, clientSeeds: readonly string[]): CardIndex[] {
  const deck = Array.from({ length: 52 }, (_, i) => i)
  const rng = new Rng(deckSeed(handSeed, clientSeeds))
  for (let i = 51; i >= 1; i--) {
    const j = rng.below(i + 1)
    ;[deck[i], deck[j]] = [deck[j], deck[i]]
  }
  return deck
}

// ---- hand values ---------------------------------------------------------------------------

export const CATEGORIES = [
  'high card',
  'pair',
  'two pair',
  'three of a kind',
  'straight',
  'flush',
  'full house',
  'four of a kind',
  'straight flush',
] as const

/** `category << 20 | r1 << 16 | … | r5`: higher wins, equal splits (core `HandValue`). */
export type HandValue = number

function handValue(category: number, ranks: readonly number[]): HandValue {
  let value = category << 20
  ranks.slice(0, 5).forEach((rank, i) => (value |= rank << (16 - 4 * i)))
  return value
}

export function categoryOf(value: HandValue): (typeof CATEGORIES)[number] {
  return CATEGORIES[Math.min(8, value >> 20)]
}

/** Top card of the highest straight in a 13-bit rank mask, the ace also playing low. */
function straightHigh(mask: number): number | null {
  // Bit 0 is the ace played low, bits 1..=13 the ranks deuce..ace.
  const extended = (mask << 1) | ((mask >> 12) & 1)
  for (let top = 13; top >= 4; top--) if (((extended >> (top - 4)) & 0x1f) === 0x1f) return top - 1
  return null
}

function ranksDesc(mask: number): number[] {
  const ranks: number[] = []
  for (let r = 12; r >= 0; r--) if (mask & (1 << r)) ranks.push(r)
  return ranks
}

/** Best five-card hand among `cards` (seven at showdown). */
export function evaluate(cards: readonly CardIndex[]): HandValue {
  const counts = new Array<number>(13).fill(0)
  const suits = [0, 0, 0, 0]
  let mask = 0
  for (const card of cards) {
    counts[card >> 2]++
    suits[card & 3] |= 1 << (card >> 2)
    mask |= 1 << (card >> 2)
  }
  const withCount = (n: number) => ranksDesc(0x1fff).filter((r) => counts[r] === n)
  const kickers = (skip: readonly number[], n: number) => ranksDesc(mask).filter((r) => !skip.includes(r)).slice(0, n)
  const popcount = (m: number) => ranksDesc(m).length
  const flush = suits.find((s) => popcount(s) >= 5)

  const flushHigh = flush === undefined ? null : straightHigh(flush)
  if (flushHigh !== null) return handValue(8, [flushHigh])
  const quad = withCount(4)[0]
  if (quad !== undefined) return handValue(7, [quad, ...kickers([quad], 1)])
  const trips = withCount(3)
  const pairs = withCount(2)
  if (trips.length > 0) {
    // The pair of a full house may be a second set of trips.
    const candidates = [trips[1], pairs[0]].filter((r): r is number => r !== undefined)
    if (candidates.length > 0) return handValue(6, [trips[0], Math.max(...candidates)])
  }
  if (flush !== undefined) return handValue(5, ranksDesc(flush).slice(0, 5))
  const high = straightHigh(mask)
  if (high !== null) return handValue(4, [high])
  if (trips.length > 0) return handValue(3, [trips[0], ...kickers([trips[0]], 2)])
  if (pairs.length >= 2) return handValue(2, [pairs[0], pairs[1], ...kickers([pairs[0], pairs[1]], 1)])
  if (pairs.length === 1) return handValue(1, [pairs[0], ...kickers([pairs[0]], 3)])
  return handValue(0, kickers([], 5))
}

// ---- setup ---------------------------------------------------------------------------------

export interface TableRules {
  small_blind: bigint
  big_blind: bigint
  rake_cap: bigint
}

export interface SeatStart {
  seat: number
  player: string
  stack: bigint
  client_seed: string
  rake_bp: number
}

export interface HandStart {
  table: string
  hand: number
  config: TableRules
  button: number
  /** Increasing seat order, also the order of the client seeds in the deck seed. */
  seats: SeatStart[]
  /** Hex `sha256(hand_seed)`. */
  hand_seed_hash: string
}

/** The hand's rake: the lowest of its players' tickets. */
export function handRakeBp(start: HandStart): number {
  return Math.min(...start.seats.map((s) => s.rake_bp))
}

function startProblem(start: HandStart): string | null {
  if (start.table.length === 0 || new TextEncoder().encode(start.table).length > MAX_TABLE_LEN) return 'table name'
  if (!(start.config.small_blind > 0n && start.config.small_blind <= start.config.big_blind)) return 'blinds'
  if (start.seats.length < MIN_PLAYERS || start.seats.length > MAX_SEATS) return 'player count'
  if (!start.seats.every((s, i) => i === 0 || start.seats[i - 1].seat < s.seat)) return 'seats must be distinct and in increasing order'
  for (const seat of start.seats) {
    if (seat.seat >= MAX_SEATS) return 'seat number'
    if (seat.stack === 0n) return 'empty stack'
    if (!clientSeedIsValid(seat.client_seed)) return 'client seed'
    if (seat.rake_bp > MAX_RAKE_BP) return 'rake'
  }
  if (!start.seats.some((s) => s.seat === start.button)) return 'button must be on a player'
  return null
}

/** The next hand's button: the next seated seat after `previous`, wrapping. */
export function nextButton(seated: readonly number[], previous: number): number | null {
  const after = seated.filter((s) => s > previous)
  if (after.length > 0) return Math.min(...after)
  return seated.length > 0 ? Math.min(...seated) : null
}

// ---- actions -------------------------------------------------------------------------------

/** Core `PokerAction`; JSON `"fold"` or `{"raise_to": "400000"}`. */
export type PokerAction = 'fold' | 'check' | 'call' | 'all_in' | { raise_to: bigint }

export interface ActionRecord {
  seat: number
  action: PokerAction
}

export interface Legal {
  seat: number
  can_check: boolean
  /** Chips a call adds (capped at the stack); 0 when checking is possible. */
  call: bigint
  raise: { min_to: bigint; max_to: bigint } | null
  stack: bigint
}

export function legalAllows(legal: Legal, action: PokerAction): boolean {
  if (action === 'fold') return true
  if (action === 'check') return legal.can_check
  if (action === 'call') return !legal.can_check
  // Without a raise, all in is only a call that takes the whole stack.
  if (action === 'all_in') return legal.raise !== null || (legal.call > 0n && legal.call === legal.stack)
  return legal.raise !== null && action.raise_to >= legal.raise.min_to && action.raise_to <= legal.raise.max_to
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'
const STREET_ORDER: readonly Street[] = ['preflop', 'flop', 'turn', 'river', 'showdown']
const BOARD_LEN: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5 }

export class PokerError extends Error {}

// ---- settling ------------------------------------------------------------------------------

export interface SettleSeat {
  seat: number
  committed: bigint
  folded: boolean
  value: HandValue | null
}

export interface Pot {
  amount: bigint
  eligible: number[]
  winners: number[]
}

export interface SeatSettlement {
  seat: number
  put_in: bigint
  won: bigint
}

export interface Settlement {
  seats: SeatSettlement[]
  pots: Pot[]
  rake: bigint
}

const minBig = (a: bigint, b: bigint) => (a < b ? a : b)

/** `rake_bp` of the pot (rounded down), at most `rake_cap`, nothing without a flop. */
export function rakeFor(pot: bigint, rakeBp: number, rakeCap: bigint, flopSeen: boolean): bigint {
  if (!flopSeen) return 0n
  return minBig((pot * BigInt(rakeBp)) / BP, rakeCap)
}

/** Pots by contribution level of the players still in; folded chips above the top level join the last pot. */
export function buildPots(seats: readonly SettleSeat[]): Pot[] {
  const levels = [...new Set(seats.filter((s) => !s.folded && s.committed > 0n).map((s) => s.committed))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  const pots: Pot[] = []
  let below = 0n
  for (const level of levels) {
    const amount = seats.reduce((sum, s) => sum + minBig(s.committed, level) - minBig(s.committed, below), 0n)
    const eligible = seats.filter((s) => !s.folded && s.committed >= level).map((s) => s.seat)
    pots.push({ amount, eligible, winners: [] })
    below = level
  }
  const rest = seats.reduce((sum, s) => sum + (s.committed > below ? s.committed - below : 0n), 0n)
  if (rest > 0n) {
    const last = pots[pots.length - 1]
    if (last) last.amount += rest
    else pots.push({ amount: rest, eligible: [], winners: [] })
  }
  return pots
}

/** Lowers the single highest commitment to the second highest. */
function returnUncalled(seats: SettleSeat[]): void {
  if (seats.length === 0) return
  let top = 0
  // Rust's `max_by_key` returns the last maximum.
  seats.forEach((s, i) => {
    if (s.committed >= seats[top].committed) top = i
  })
  let second = 0n
  seats.forEach((s, i) => {
    if (i !== top && s.committed > second) second = s.committed
  })
  seats[top] = { ...seats[top], committed: minBig(seats[top].committed, second) }
}

function potWinners(seats: readonly SettleSeat[], eligible: readonly number[]): number[] {
  const contenders = seats.filter((s) => eligible.includes(s.seat))
  if (contenders.length <= 1) return contenders.map((s) => s.seat)
  const values = contenders.map((s) => {
    if (s.value === null) throw new PokerError('a pot has players without a hand')
    return s.value
  })
  const best = Math.max(...values)
  return contenders.filter((_, i) => values[i] === best).map((s) => s.seat)
}

/** `seats` in deal order (first left of the button first): it decides who gets odd chips. */
export function settleHand(input: readonly SettleSeat[], rakeBp: number, rakeCap: bigint, flopSeen: boolean): Settlement {
  if (input.every((s) => s.folded)) throw new PokerError('no player left in the hand')
  const seats = input.map((s) => ({ ...s }))
  returnUncalled(seats)
  const pots = buildPots(seats)
  const total = seats.reduce((sum, s) => sum + s.committed, 0n)
  const rake = rakeFor(total, rakeBp, rakeCap, flopSeen)
  let owed = rake
  for (const pot of pots) {
    const cut = minBig(owed, pot.amount)
    pot.amount -= cut
    owed -= cut
  }
  const won = seats.map(() => 0n)
  for (const pot of pots) {
    pot.winners = potWinners(seats, pot.eligible)
    const count = BigInt(pot.winners.length)
    if (count === 0n) throw new PokerError('no player left in the hand')
    const share = pot.amount / count
    const odd = pot.amount % count
    pot.winners.forEach((winner, i) => {
      const at = Math.max(0, seats.findIndex((s) => s.seat === winner))
      won[at] += share + (BigInt(i) < odd ? 1n : 0n)
    })
  }
  return { seats: seats.map((s, i) => ({ seat: s.seat, put_in: s.committed, won: won[i] })), pots, rake }
}

// ---- the hand state machine ------------------------------------------------------------------

interface SeatState {
  stack: bigint
  street_in: bigint
  total_in: bigint
  folded: boolean
  all_in: boolean
  acted: boolean
  acted_at: bigint
}

export interface SeatResult {
  seat: number
  player: string
  put_in: bigint
  won: bigint
  stack_after: bigint
  shown: [CardIndex, CardIndex] | null
  value: HandValue | null
}

export interface HandResult {
  board: CardIndex[]
  showdown: boolean
  pots: Pot[]
  rake: bigint
  seats: SeatResult[]
}

export interface PublicSeat {
  seat: number
  player: string
  stack: bigint
  street_in: bigint
  total_in: bigint
  folded: boolean
  all_in: boolean
}

export class PokerHand {
  readonly start: HandStart
  readonly handSeed: Uint8Array
  readonly deck: CardIndex[]
  private readonly seats: SeatState[]
  private readonly button: number
  street: Street = 'preflop'
  currentBet: bigint
  private minRaise: bigint
  private toActIndex: number | null = null
  private flopSeen = false
  readonly actions: ActionRecord[] = []
  result: HandResult | null = null

  /** Deals and posts the blinds; throws on an invalid start or a seed off its commitment. */
  constructor(start: HandStart, handSeed: Uint8Array) {
    const problem = startProblem(start)
    if (problem) throw new PokerError(`invalid hand start: ${problem}`)
    if (bytesToHex(sha256(handSeed)) !== start.hand_seed_hash.toLowerCase()) throw new PokerError('hand seed does not match its commitment')
    this.start = start
    this.handSeed = handSeed
    this.deck = deckFor(
      handSeed,
      start.seats.map((s) => s.client_seed),
    )
    this.button = start.seats.findIndex((s) => s.seat === start.button)
    this.seats = start.seats.map((s) => ({ stack: s.stack, street_in: 0n, total_in: 0n, folded: false, all_in: false, acted: false, acted_at: 0n }))
    this.currentBet = start.config.big_blind
    this.minRaise = start.config.big_blind
    const [sb, bb] = this.blindPositions()
    this.pay(sb, start.config.small_blind)
    this.pay(bb, start.config.big_blind)
    // A short big blind still sets the price: the others call the full big blind.
    this.continueFrom(this.n === 2 ? sb : this.next(bb))
  }

  private get n(): number {
    return this.seats.length
  }

  private next(i: number): number {
    return (i + 1) % this.n
  }

  /** Heads-up the button posts the small blind. Returns seat indexes. */
  private blindPositions(): [number, number] {
    const sb = this.n === 2 ? this.button : this.next(this.button)
    return [sb, this.next(sb)]
  }

  /** Seat numbers of the small and big blinds. */
  blindSeats(): [number, number] {
    const [sb, bb] = this.blindPositions()
    return [this.start.seats[sb].seat, this.start.seats[bb].seat]
  }

  private pay(i: number, amount: bigint): void {
    const state = this.seats[i]
    const paid = minBig(amount, state.stack)
    state.stack -= paid
    state.street_in += paid
    state.total_in += paid
    if (state.stack === 0n) state.all_in = true
  }

  isDone(): boolean {
    return this.result !== null
  }

  toAct(): number | null {
    return this.toActIndex === null ? null : this.start.seats[this.toActIndex].seat
  }

  private dealPosition(i: number): number {
    return (i + this.n - this.next(this.button)) % this.n
  }

  private holeAt(i: number): [CardIndex, CardIndex] {
    const p = this.dealPosition(i)
    return [this.deck[p], this.deck[p + this.n]]
  }

  hole(seat: number): [CardIndex, CardIndex] | null {
    const i = this.start.seats.findIndex((s) => s.seat === seat)
    return i < 0 ? null : this.holeAt(i)
  }

  board(): CardIndex[] {
    const base = 2 * this.n
    return [base + 1, base + 2, base + 3, base + 5, base + 7].slice(0, BOARD_LEN[this.street]).map((i) => this.deck[i])
  }

  legal(): Legal | null {
    const i = this.toActIndex
    if (i === null) return null
    const state = this.seats[i]
    const toCall = this.currentBet > state.street_in ? this.currentBet - state.street_in : 0n
    const maxTo = state.street_in + state.stack
    const reopened = !state.acted || this.currentBet - state.acted_at >= this.minRaise
    // Raising when every opponent is all in would only bet against nobody.
    const someoneToCall = this.seats.some((s, j) => j !== i && !s.folded && !s.all_in)
    const raise =
      reopened && someoneToCall && maxTo > this.currentBet ? { min_to: minBig(this.currentBet + this.minRaise, maxTo), max_to: maxTo } : null
    return { seat: this.start.seats[i].seat, can_check: toCall === 0n, call: minBig(toCall, state.stack), raise, stack: state.stack }
  }

  act(seat: number, action: PokerAction): void {
    if (this.isDone() || this.toActIndex === null) throw new PokerError('the hand is over')
    const i = this.toActIndex
    if (this.start.seats[i].seat !== seat) throw new PokerError("not this seat's turn")
    const legal = this.legal()
    if (!legal) throw new PokerError('the hand is over')
    if (!legalAllows(legal, action)) throw new PokerError('illegal action')
    const effective: PokerAction = action !== 'all_in' ? action : legal.raise ? { raise_to: legal.raise.max_to } : 'call'
    if (effective === 'fold') this.seats[i].folded = true
    else if (effective === 'call') this.pay(i, legal.call)
    else if (typeof effective === 'object') {
      const raise = effective.raise_to - this.currentBet
      this.pay(i, effective.raise_to - this.seats[i].street_in)
      if (raise >= this.minRaise) this.minRaise = raise
      this.currentBet = effective.raise_to
    }
    this.seats[i].acted = true
    this.seats[i].acted_at = this.currentBet
    this.actions.push({ seat, action })
    if (this.seats.filter((s) => !s.folded).length === 1) this.finish(false)
    else this.continueFrom(this.next(i))
  }

  private findActor(from: number): number | null {
    const able = this.seats.map((s, i) => (!s.folded && !s.all_in ? i : -1)).filter((i) => i >= 0)
    if (able.length === 1) {
      // Alone with chips behind: act only to answer a bet.
      const only = able[0]
      return this.seats[only].street_in < this.currentBet ? only : null
    }
    for (let k = 0; k < this.n; k++) {
      const i = (from + k) % this.n
      const s = this.seats[i]
      if (!s.folded && !s.all_in && (!s.acted || s.street_in < this.currentBet)) return i
    }
    return null
  }

  private continueFrom(from: number): void {
    const actor = this.findActor(from)
    if (actor !== null) {
      this.toActIndex = actor
      return
    }
    for (;;) {
      for (const s of this.seats) {
        s.street_in = 0n
        s.acted = false
        s.acted_at = 0n
      }
      this.currentBet = 0n
      this.minRaise = this.start.config.big_blind
      this.street = STREET_ORDER[STREET_ORDER.indexOf(this.street) + 1] ?? 'showdown'
      if (this.street === 'flop') this.flopSeen = true
      if (this.street === 'showdown') {
        this.finish(true)
        return
      }
      const next = this.findActor(this.next(this.button))
      if (next !== null) {
        this.toActIndex = next
        return
      }
    }
  }

  /** Seat indexes in deal order, from the seat left of the button. */
  private dealOrder(): number[] {
    return Array.from({ length: this.n }, (_, k) => (this.button + 1 + k) % this.n)
  }

  private finish(showdown: boolean): void {
    this.toActIndex = null
    const board = this.board()
    const inputs: SettleSeat[] = this.dealOrder().map((i) => {
      const state = this.seats[i]
      return {
        seat: this.start.seats[i].seat,
        committed: state.total_in,
        folded: state.folded,
        value: showdown && !state.folded ? evaluate([...this.holeAt(i), ...board]) : null,
      }
    })
    const settlement = settleHand(inputs, handRakeBp(this.start), this.start.config.rake_cap, this.flopSeen)
    const seats = this.start.seats.map((start, i) => {
      const line = settlement.seats.find((s) => s.seat === start.seat) ?? { seat: start.seat, put_in: 0n, won: 0n }
      const value = inputs.find((s) => s.seat === start.seat)?.value ?? null
      return {
        seat: start.seat,
        player: start.player,
        put_in: line.put_in,
        won: line.won,
        stack_after: start.stack - line.put_in + line.won,
        shown: value === null ? null : this.holeAt(i),
        value,
      }
    })
    this.result = { board, showdown, pots: settlement.pots, rake: settlement.rake, seats }
  }

  /** Live pots from everything committed so far (as core `view`: no uncalled return, no rake). */
  livePots(): Pot[] {
    if (this.result) return this.result.pots
    return buildPots(
      this.dealOrder().map((i) => ({ seat: this.start.seats[i].seat, committed: this.seats[i].total_in, folded: this.seats[i].folded, value: null })),
    )
  }

  publicSeats(): PublicSeat[] {
    return this.start.seats.map((start, i) => {
      const { stack, street_in, total_in, folded, all_in } = this.seats[i]
      return { seat: start.seat, player: start.player, stack, street_in, total_in, folded, all_in }
    })
  }
}

// ---- history -------------------------------------------------------------------------------

export interface HandHistory {
  start: HandStart
  /** Hex. */
  hand_seed: string
  actions: ActionRecord[]
}

/** Replays a published hand; throws unless its actions are legal and finish it. */
export function replayHand(history: HandHistory): PokerHand {
  const hand = new PokerHand(history.start, hexToBytes(history.hand_seed))
  for (const record of history.actions) hand.act(record.seat, record.action)
  if (!hand.isDone()) throw new PokerError('the hand is not finished')
  return hand
}

const ACTION_TAG = { fold: 0, check: 1, call: 2, raise_to: 3, all_in: 4 } as const

/** `sha256(borsh(history))`: what each player's session round commits to. */
export function historyHash(history: HandHistory): string {
  const w = new Writer()
  const { start } = history
  w.string(start.table).u64(start.hand)
  w.u128(start.config.small_blind).u128(start.config.big_blind).u128(start.config.rake_cap)
  w.u8(start.button).u32(start.seats.length)
  for (const s of start.seats) w.u8(s.seat).string(s.player).u128(s.stack).string(s.client_seed).u16(s.rake_bp)
  w.raw(hexToBytes(start.hand_seed_hash)).raw(hexToBytes(history.hand_seed)).u32(history.actions.length)
  for (const { seat, action } of history.actions) {
    w.u8(seat)
    if (typeof action === 'object') w.u8(ACTION_TAG.raise_to).u128(action.raise_to)
    else w.u8(ACTION_TAG[action])
  }
  return bytesToHex(sha256(w.done()))
}
