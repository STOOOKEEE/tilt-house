/**
 * Provably fair sessions (docs/sessions.md), browser side: the session server's HTTP API, a check
 * of every signed state as it arrives, and the full replay of a closed session from its revealed
 * seed. The byte layouts mirror `core_rules::session` exactly (borsh, domains, HMAC message): a
 * drift here makes verification fail, never pass. Cross-checked by session-vectors.json, which
 * was produced by the Rust code.
 */
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { PublicKey } from 'near-api-js'
import { applyRake, diceWins, handTotal, pocketColor } from '../house'
import {
  amount,
  bool,
  fail,
  GAMES,
  int,
  list,
  oneOf,
  optional,
  parseBet,
  parseHand,
  record,
  str,
  type Bet,
  type BlackjackHand,
  type Game,
  type RouletteBet,
} from './views'

// ---- protocol constants (core_rules::session) ---------------------------------------------

const TICKET_DOMAIN = 'tilt-house/session-ticket/v1'
const STATE_DOMAIN = 'tilt-house/session-state/v1'
export const MAX_CLIENT_SEED_LEN = 64
const ROLL_RANGE = 10_000
const POCKETS = 37
const RANKS = 13
const DEALER_STANDS_ON = 17

// ---- types (JSON forms of the Rust structs) -----------------------------------------------

export type BjAction = 'hit' | 'stand' | 'double'
export type Outcome = { dice: { roll: number } } | { roulette: { pocket: number } } | { blackjack: BlackjackHand }

export interface CompactRound {
  nonce: number
  bet: Bet
  stake: string
  actions: BjAction[]
  outcome: Outcome
  payout: string
}

export interface SessionTicket {
  session_id: string
  player: string
  dealer_id: string
  game: Game
  lock: string
  server_seed_hash: string
  client_seed: string
  rake_bp: number
  max_bet: string
  max_win: string
  expires_at: number
}

export interface SessionState {
  session_id: string
  nonce: number
  balance: string
  chain: string
}

export interface SignedState extends SessionState {
  signature: string
}

/** A blackjack hand still being played: `state.done` false. */
export interface BjSession {
  nonce: number
  stake: string
  rake_bp: number
  actions: BjAction[]
  state: BlackjackHand
}

export interface StartedSession {
  session_id: string
  token: string
  /** `ed25519:<base58>`. */
  server_public_key: string
  ticket: SessionTicket
  ticket_signature: string
  state: SignedState
}

export interface RoundReply {
  done: boolean
  round: CompactRound | null
  hand: BjSession | null
  state: SignedState
}

export interface ClosedSession {
  server_seed: string
  ticket: SessionTicket
  state: SignedState
  rounds: CompactRound[]
}

// ---- Rng (core_rules::rng, xoshiro256** seeded through splitmix64) ------------------------

const MASK64 = (1n << 64n) - 1n

function rotl(x: bigint, k: bigint): bigint {
  return ((x << k) | (x >> (64n - k))) & MASK64
}

export class Rng {
  private s: [bigint, bigint, bigint, bigint]

  constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error('Rng seed must be 32 bytes')
    const view = new DataView(seed.buffer, seed.byteOffset, 32)
    const s: [bigint, bigint, bigint, bigint] = [0n, 1n, 2n, 3n].map((i) => view.getBigUint64(Number(i) * 8, true)) as [
      bigint,
      bigint,
      bigint,
      bigint,
    ]
    const mix = { x: s[0] ^ rotl(s[1], 16n) ^ rotl(s[2], 32n) ^ rotl(s[3], 48n) }
    for (let i = 0; i < 4; i++) s[i] = s[i] ^ ((splitmix64(mix) + BigInt(i)) & MASK64)
    this.s = s
  }

  private nextU64(): bigint {
    const s = this.s
    const result = (rotl((s[1] * 5n) & MASK64, 7n) * 9n) & MASK64
    const t = (s[1] << 17n) & MASK64
    s[2] ^= s[0]
    s[3] ^= s[1]
    s[1] ^= s[2]
    s[0] ^= s[3]
    s[2] ^= t
    s[3] = rotl(s[3], 45n)
    return result
  }

  /** Uniform in [0, n) without modulo bias (Lemire-style rejection, as in core). */
  below(n: number): number {
    if (n <= 0) throw new Error('Rng.below(0)')
    const threshold = (2 ** 32 - n) % n
    for (;;) {
      const x = Number(this.nextU64() >> 32n)
      if (x >= threshold) return x % n
    }
  }
}

function splitmix64(state: { x: bigint }): bigint {
  state.x = (state.x + 0x9e3779b97f4a7c15n) & MASK64
  let z = state.x
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64
  return z ^ (z >> 31n)
}

// ---- seeds --------------------------------------------------------------------------------

/** `HMAC-SHA256(server_seed, client_seed:nonce[:step])`, step 0 = the round's first draw. */
export function stepSeed(serverSeed: Uint8Array, clientSeed: string, nonce: number, step: number): Uint8Array {
  const message = step > 0 ? `${clientSeed}:${nonce}:${step}` : `${clientSeed}:${nonce}`
  return hmac(sha256, serverSeed, new TextEncoder().encode(message))
}

/** Same rule as core `client_seed_is_valid`: printable ASCII, no ':' (it separates the HMAC message). */
export function clientSeedIsValid(seed: string): boolean {
  return seed.length >= 1 && seed.length <= MAX_CLIENT_SEED_LEN && /^[\x21-\x39\x3b-\x7e]+$/.test(seed)
}

export function randomClientSeed(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
}

// ---- game rules (core_rules: dice, roulette, blackjack) ------------------------------------

function rouletteWins(bet: RouletteBet, pocket: number): boolean {
  if (pocket === 0) return typeof bet !== 'string' && 'straight' in bet && bet.straight === 0
  if (typeof bet === 'string') {
    switch (bet) {
      case 'red':
        return pocketColor(pocket) === 'red'
      case 'black':
        return pocketColor(pocket) === 'black'
      case 'odd':
        return pocket % 2 === 1
      case 'even':
        return pocket % 2 === 0
      case 'low':
        return pocket <= 18
      case 'high':
        return pocket >= 19
    }
  }
  if ('straight' in bet) return bet.straight === pocket
  if ('dozen' in bet) return Math.floor((pocket - 1) / 12) + 1 === bet.dozen
  return ((pocket - 1) % 3) + 1 === bet.column
}

function rouletteMultiple(bet: RouletteBet): bigint {
  if (typeof bet === 'string') return 1n
  return 'straight' in bet ? 35n : 2n
}

function draw(rng: Rng): number {
  return rng.below(RANKS) + 1
}

const isNatural = (cards: readonly number[]): boolean => cards.length === 2 && handTotal(cards).total === 21

function bjDeal(rng: Rng): BlackjackHand {
  const hand: BlackjackHand = { player: [draw(rng), draw(rng)], dealer: [draw(rng)], doubled: false, done: false }
  if (isNatural(hand.player)) {
    hand.dealer.push(draw(rng))
    hand.done = true
  }
  return hand
}

function dealerPlays(hand: BlackjackHand, rng: Rng): void {
  while (handTotal(hand.dealer).total < DEALER_STANDS_ON) hand.dealer.push(draw(rng))
  hand.done = true
}

/** One blackjack move; throws on an illegal one (the replay then fails as tampered). */
function bjAct(hand: BlackjackHand, action: BjAction, rng: Rng): void {
  if (hand.done) throw new Error('the hand is over')
  if (action === 'stand') return dealerPlays(hand, rng)
  if (action === 'double') {
    if (hand.player.length !== 2) throw new Error('double is only allowed on the first two cards')
    hand.doubled = true
    hand.player.push(draw(rng))
    if (handTotal(hand.player).total > 21) hand.done = true
    else dealerPlays(hand, rng)
    return
  }
  hand.player.push(draw(rng))
  const total = handTotal(hand.player).total
  if (total > 21) hand.done = true
  else if (total === 21) dealerPlays(hand, rng)
}

function bjWager(hand: BlackjackHand, stake: bigint): bigint {
  return hand.doubled ? stake * 2n : stake
}

function bjGross(hand: BlackjackHand, stake: bigint): bigint {
  const wager = bjWager(hand, stake)
  const player = handTotal(hand.player).total
  if (player > 21) return 0n
  const dealerNatural = isNatural(hand.dealer)
  if (isNatural(hand.player) && !hand.doubled) return dealerNatural ? wager : (wager * 5n) / 2n
  if (dealerNatural) return 0n
  const dealer = handTotal(hand.dealer).total
  if (dealer > 21 || player > dealer) return wager * 2n
  return player === dealer ? wager : 0n
}

export function betGame(bet: Bet): Game {
  if (bet === 'blackjack') return 'blackjack'
  return 'dice' in bet ? 'dice' : 'roulette'
}

/** What a round puts at risk: the stake, twice it after a blackjack double. */
export function roundWager(round: CompactRound): bigint {
  const stake = BigInt(round.stake)
  return 'blackjack' in round.outcome ? bjWager(round.outcome.blackjack, stake) : stake
}

/** A blackjack hand after the deal and `actions`, finished or not (`BjSession::deal` + `act`). */
export function playHand(serverSeed: Uint8Array, clientSeed: string, nonce: number, actions: readonly BjAction[]): BlackjackHand {
  const hand = bjDeal(new Rng(stepSeed(serverSeed, clientSeed, nonce, 0)))
  actions.forEach((action, i) => bjAct(hand, action, new Rng(stepSeed(serverSeed, clientSeed, nonce, i + 1))))
  return hand
}

/** `core_rules::session::replay_round`: the round the seeds produce for this bet and these moves. */
export function replayRound(
  serverSeed: Uint8Array,
  ticket: Pick<SessionTicket, 'client_seed' | 'game' | 'rake_bp'>,
  nonce: number,
  bet: Bet,
  stake: bigint,
  actions: readonly BjAction[],
): CompactRound {
  if (betGame(bet) !== ticket.game) throw new Error('bet for another game')
  const rng = new Rng(stepSeed(serverSeed, ticket.client_seed, nonce, 0))
  const base = { nonce, bet, stake: stake.toString(), actions: [...actions] }
  if (bet === 'blackjack') {
    const hand = playHand(serverSeed, ticket.client_seed, nonce, actions)
    if (!hand.done) throw new Error('the hand is not finished')
    const payout = applyRake(bjGross(hand, stake), bjWager(hand, stake), ticket.rake_bp)
    return { ...base, outcome: { blackjack: hand }, payout: payout.toString() }
  }
  if ('dice' in bet) {
    const { chance_bp: chance, over } = bet.dice
    if (chance < 100 || chance > 9_800) throw new Error('invalid dice bet')
    const roll = rng.below(ROLL_RANGE)
    const gross = diceWins(roll, chance, over) ? (stake * BigInt(ROLL_RANGE)) / BigInt(chance) : 0n
    return { ...base, actions: [], outcome: { dice: { roll } }, payout: applyRake(gross, stake, ticket.rake_bp).toString() }
  }
  const pocket = rng.below(POCKETS)
  const gross = rouletteWins(bet.roulette, pocket) ? stake * (rouletteMultiple(bet.roulette) + 1n) : 0n
  return { ...base, actions: [], outcome: { roulette: { pocket } }, payout: applyRake(gross, stake, ticket.rake_bp).toString() }
}

// ---- borsh (only what the protocol hashes and signs) --------------------------------------

class Writer {
  private bytes: number[] = []

  u8(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error(`u8 out of range: ${v}`)
    this.bytes.push(v)
    return this
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0)
  }

  private uint(v: bigint, size: number): this {
    if (v < 0n || v >= 1n << BigInt(size * 8)) throw new Error(`u${size * 8} out of range: ${v}`)
    for (let i = 0; i < size; i++) this.bytes.push(Number((v >> BigInt(8 * i)) & 0xffn))
    return this
  }

  u16(v: number): this {
    return this.uint(BigInt(v), 2)
  }

  u32(v: number): this {
    return this.uint(BigInt(v), 4)
  }

  u64(v: number | bigint): this {
    return this.uint(BigInt(v), 8)
  }

  u128(v: string | bigint): this {
    return this.uint(BigInt(v), 16)
  }

  raw(v: Uint8Array): this {
    this.bytes.push(...v)
    return this
  }

  string(v: string): this {
    const utf8 = new TextEncoder().encode(v)
    return this.u32(utf8.length).raw(utf8)
  }

  u8s(v: readonly number[]): this {
    this.u32(v.length)
    for (const x of v) this.u8(x)
    return this
  }

  done(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

const GAME_INDEX: Record<Game, number> = { dice: 0, roulette: 1, blackjack: 2 }
const ACTION_INDEX: Record<BjAction, number> = { hit: 0, stand: 1, double: 2 }
// Declaration order of `RouletteBet`: Straight(u8), Red, Black, Odd, Even, Low, High, Dozen(u8), Column(u8).
const ROULETTE_UNIT_INDEX: Record<string, number> = { red: 1, black: 2, odd: 3, even: 4, low: 5, high: 6 }

function writeRouletteBet(w: Writer, bet: RouletteBet): void {
  if (typeof bet === 'string') {
    const index = ROULETTE_UNIT_INDEX[bet]
    if (index === undefined) throw new Error(`unknown roulette bet ${bet}`)
    w.u8(index)
  } else if ('straight' in bet) w.u8(0).u8(bet.straight)
  else if ('dozen' in bet) w.u8(7).u8(bet.dozen)
  else w.u8(8).u8(bet.column)
}

function writeBet(w: Writer, bet: Bet): void {
  if (bet === 'blackjack') w.u8(2)
  else if ('dice' in bet) w.u8(0).u16(bet.dice.chance_bp).bool(bet.dice.over)
  else {
    w.u8(1)
    writeRouletteBet(w, bet.roulette)
  }
}

function writeOutcome(w: Writer, outcome: Outcome): void {
  if ('dice' in outcome) w.u8(0).u32(outcome.dice.roll)
  else if ('roulette' in outcome) w.u8(1).u8(outcome.roulette.pocket)
  else {
    const hand = outcome.blackjack
    w.u8(2).u8s(hand.player).u8s(hand.dealer).bool(hand.doubled).bool(hand.done)
  }
}

export function roundBorsh(round: CompactRound): Uint8Array {
  const w = new Writer().u64(round.nonce)
  writeBet(w, round.bet)
  w.u128(round.stake).u32(round.actions.length)
  for (const action of round.actions) w.u8(ACTION_INDEX[action])
  writeOutcome(w, round.outcome)
  return w.u128(round.payout).done()
}

function hex32(value: string, what: string): Uint8Array {
  const bytes = hexToBytes(value)
  if (bytes.length !== 32) throw new Error(`${what} must be 32 bytes`)
  return bytes
}

export function stateMessage(state: SessionState): Uint8Array {
  return new Writer()
    .raw(new TextEncoder().encode(STATE_DOMAIN))
    .string(state.session_id)
    .u64(state.nonce)
    .u128(state.balance)
    .raw(hex32(state.chain, 'chain'))
    .done()
}

export function ticketMessage(t: SessionTicket): Uint8Array {
  return new Writer()
    .raw(new TextEncoder().encode(TICKET_DOMAIN))
    .string(t.session_id)
    .string(t.player)
    .string(t.dealer_id)
    .u8(GAME_INDEX[t.game])
    .u128(t.lock)
    .raw(hex32(t.server_seed_hash, 'server_seed_hash'))
    .string(t.client_seed)
    .u16(t.rake_bp)
    .u128(t.max_bet)
    .u128(t.max_win)
    .u64(t.expires_at)
    .done()
}

/** `chain_n = sha256(chain_{n-1} || borsh(round_n))`, hex. */
export function chainStep(prevHex: string, round: CompactRound): string {
  const prev = hex32(prevHex, 'chain')
  const body = roundBorsh(round)
  const joined = new Uint8Array(prev.length + body.length)
  joined.set(prev)
  joined.set(body, prev.length)
  return bytesToHex(sha256(joined))
}

// ---- signatures ---------------------------------------------------------------------------

function verifySignature(publicKey: string, message: Uint8Array, signatureHex: string): boolean {
  try {
    const signature = hexToBytes(signatureHex)
    if (signature.length !== 64) return false
    return PublicKey.fromString(publicKey).verify(message, signature)
  } catch {
    // A malformed key or signature is a failed check, not a crash.
    return false
  }
}

export function verifyTicket(publicKey: string, ticket: SessionTicket, signatureHex: string): boolean {
  return verifySignature(publicKey, ticketMessage(ticket), signatureHex)
}

// ---- live checks: one signed state after another ------------------------------------------

/**
 * Checks a new signed state against the previous one and the round that led to it: right
 * signature, next nonce, hash chain extended by exactly this round, balance moved by exactly
 * `payout − wager`. The outcome itself can only be checked after the seed is revealed.
 * Returns why it fails, or null.
 */
export function checkNextState(
  publicKey: string,
  previous: SessionState,
  round: CompactRound,
  next: SignedState,
): string | null {
  if (!verifySignature(publicKey, stateMessage(next), next.signature)) return 'bad server signature'
  if (next.session_id !== previous.session_id) return 'state of another session'
  if (round.nonce !== previous.nonce + 1 || next.nonce !== round.nonce) return `expected round ${previous.nonce + 1}`
  if (chainStep(previous.chain, round) !== next.chain.toLowerCase()) return 'hash chain does not extend with this round'
  const balance = BigInt(previous.balance) - roundWager(round) + BigInt(round.payout)
  if (balance < 0n || balance.toString() !== next.balance) return 'balance does not match the round'
  return null
}

// ---- full replay after the reveal ---------------------------------------------------------

export interface SessionSummary {
  rounds: number
  wagered: bigint
  paid: bigint
  balance: bigint
  chain: string
}

export type VerifyResult = { ok: true; summary: SessionSummary } | { ok: false; error: string; nonce: number | null }

/**
 * `core_rules::session::verify_session` over the whole round list: the seed matches its
 * commitment, every round replays bit for bit, the chain and balance end where the last signed
 * state says.
 */
export function verifySession(
  serverSeedHex: string,
  ticket: SessionTicket,
  rounds: readonly CompactRound[],
  finalState: SessionState,
): VerifyResult {
  let seed: Uint8Array
  try {
    seed = hex32(serverSeedHex, 'server seed')
  } catch {
    return { ok: false, error: 'server seed is not 32 bytes of hex', nonce: null }
  }
  if (bytesToHex(sha256(seed)) !== ticket.server_seed_hash.toLowerCase()) {
    return { ok: false, error: 'server seed does not match its hash', nonce: null }
  }
  const summary: SessionSummary = { rounds: 0, wagered: 0n, paid: 0n, balance: BigInt(ticket.lock), chain: ticket.server_seed_hash.toLowerCase() }
  for (const round of rounds) {
    const expected = summary.rounds + 1
    if (round.nonce !== expected) return { ok: false, error: `expected round ${expected}, got ${round.nonce}`, nonce: round.nonce }
    let replayed: CompactRound
    try {
      replayed = replayRound(seed, ticket, round.nonce, round.bet, BigInt(round.stake), round.actions)
    } catch {
      return { ok: false, error: `round ${round.nonce} does not replay`, nonce: round.nonce }
    }
    if (bytesToHex(roundBorsh(replayed)) !== bytesToHex(roundBorsh(round))) {
      return { ok: false, error: `round ${round.nonce} does not replay`, nonce: round.nonce }
    }
    const wager = roundWager(round)
    summary.balance = summary.balance - wager + BigInt(round.payout)
    if (summary.balance < 0n) return { ok: false, error: `balance negative at round ${round.nonce}`, nonce: round.nonce }
    summary.rounds = expected
    summary.wagered += wager
    summary.paid += BigInt(round.payout)
    summary.chain = chainStep(summary.chain, round)
  }
  if (summary.rounds !== finalState.nonce) return { ok: false, error: `the last state is round ${finalState.nonce}, replayed ${summary.rounds}`, nonce: null }
  if (summary.chain !== finalState.chain.toLowerCase()) return { ok: false, error: 'hash chain broken', nonce: null }
  if (summary.balance.toString() !== finalState.balance) return { ok: false, error: 'final balance wrong', nonce: null }
  return { ok: true, summary }
}

// ---- HTTP client --------------------------------------------------------------------------

export class SessionError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** The server answers 409 until `open_session` is final on chain. */
export const NOT_OPEN_YET = 409

async function call(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init.headers } })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = typeof body === 'object' && body !== null && 'error' in body ? body.error : null
    const message = typeof error === 'string' ? error : `HTTP ${response.status}`
    throw new SessionError(`session server: ${message}`, response.status)
  }
  return body
}

export interface SessionClient {
  start(input: { player: string; dealer_id: string; lock: bigint; client_seed: string }): Promise<StartedSession>
  /** A new round (`bet` + `stake`) or the next move of a live blackjack hand (`action`). */
  play(sessionId: string, token: string, nonce: number, move: { bet: Bet; stake: bigint } | { action: BjAction }): Promise<RoundReply>
  close(sessionId: string, token: string): Promise<ClosedSession>
  /** The revealed seed of a session the server already closed (null while it is open). */
  revealedSeed(sessionId: string): Promise<string | null>
}

export function sessionClient(baseUrl: string): SessionClient {
  const base = baseUrl.replace(/\/+$/, '')
  return {
    async start(input) {
      const body = await call(`${base}/sessions`, {
        method: 'POST',
        body: JSON.stringify({ ...input, lock: input.lock.toString() }),
      })
      return parseStarted(body)
    },
    async play(sessionId, token, nonce, move) {
      const payload = 'action' in move ? { nonce, action: move.action } : { nonce, bet: move.bet, stake: move.stake.toString() }
      const body = await call(`${base}/sessions/${encodeURIComponent(sessionId)}/rounds`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      })
      return parseRoundReply(body)
    },
    async close(sessionId, token) {
      const body = await call(`${base}/sessions/${encodeURIComponent(sessionId)}/close`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: '{}',
      })
      return parseClosed(body)
    },
    async revealedSeed(sessionId) {
      const body = record(await call(`${base}/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' }), 'session')
      return optional(body.server_seed, (v) => hex(v, 'session.server_seed', 32))
    },
  }
}

// ---- reply guards: a reply that does not match is refused, never half-used ----------------

const ACTIONS: readonly BjAction[] = ['hit', 'stand', 'double']

function hex(value: unknown, path: string, bytes: number): string {
  const v = str(value, path)
  if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(v)) fail(path, `${bytes} bytes of hex`)
  return v.toLowerCase()
}

function parseOutcome(value: unknown, path: string): Outcome {
  const o = record(value, path)
  if (o.dice !== undefined) return { dice: { roll: int(record(o.dice, `${path}.dice`).roll, `${path}.dice.roll`) } }
  if (o.roulette !== undefined) {
    return { roulette: { pocket: int(record(o.roulette, `${path}.roulette`).pocket, `${path}.roulette.pocket`) } }
  }
  return { blackjack: parseHand(o.blackjack) }
}

const parseActions = (value: unknown, path: string): BjAction[] =>
  list(value, path).map((a, i) => oneOf(ACTIONS, a, `${path}[${i}]`))

export function parseCompactRound(value: unknown, path = 'round'): CompactRound {
  const r = record(value, path)
  return {
    nonce: int(r.nonce, `${path}.nonce`),
    bet: parseBet(r.bet),
    stake: amount(r.stake, `${path}.stake`),
    actions: parseActions(r.actions, `${path}.actions`),
    outcome: parseOutcome(r.outcome, `${path}.outcome`),
    payout: amount(r.payout, `${path}.payout`),
  }
}

function parseState(value: unknown, path = 'state'): SignedState {
  const s = record(value, path)
  return {
    session_id: str(s.session_id, `${path}.session_id`),
    nonce: int(s.nonce, `${path}.nonce`),
    balance: amount(s.balance, `${path}.balance`),
    chain: hex(s.chain, `${path}.chain`, 32),
    signature: hex(s.signature, `${path}.signature`, 64),
  }
}

export function parseTicket(value: unknown, path = 'ticket'): SessionTicket {
  const t = record(value, path)
  return {
    session_id: str(t.session_id, `${path}.session_id`),
    player: str(t.player, `${path}.player`),
    dealer_id: str(t.dealer_id, `${path}.dealer_id`),
    game: oneOf(GAMES, t.game, `${path}.game`),
    lock: amount(t.lock, `${path}.lock`),
    server_seed_hash: hex(t.server_seed_hash, `${path}.server_seed_hash`, 32),
    client_seed: str(t.client_seed, `${path}.client_seed`),
    rake_bp: int(t.rake_bp, `${path}.rake_bp`),
    max_bet: amount(t.max_bet, `${path}.max_bet`),
    max_win: amount(t.max_win, `${path}.max_win`),
    expires_at: int(t.expires_at, `${path}.expires_at`),
  }
}

function parseStarted(value: unknown): StartedSession {
  const s = record(value, 'session')
  return {
    session_id: str(s.session_id, 'session.session_id'),
    token: str(s.token, 'session.token'),
    server_public_key: str(s.server_public_key, 'session.server_public_key'),
    ticket: parseTicket(s.ticket),
    ticket_signature: hex(s.ticket_signature, 'session.ticket_signature', 64),
    state: parseState(s.state),
  }
}

function parseHandSession(value: unknown): BjSession {
  const h = record(value, 'hand')
  return {
    nonce: int(h.nonce, 'hand.nonce'),
    stake: amount(h.stake, 'hand.stake'),
    rake_bp: int(h.rake_bp, 'hand.rake_bp'),
    actions: parseActions(h.actions, 'hand.actions'),
    state: parseHand(h.state),
  }
}

function parseRoundReply(value: unknown): RoundReply {
  const r = record(value, 'reply')
  return {
    done: bool(r.done, 'reply.done'),
    round: optional(r.round, (v) => parseCompactRound(v)),
    hand: optional(r.hand, parseHandSession),
    state: parseState(r.state),
  }
}

function parseClosed(value: unknown): ClosedSession {
  const c = record(value, 'closed')
  return {
    server_seed: hex(c.server_seed, 'closed.server_seed', 32),
    ticket: parseTicket(c.ticket),
    state: parseState(c.state),
    rounds: list(c.rounds, 'closed.rounds').map((r, i) => parseCompactRound(r, `closed.rounds[${i}]`)),
  }
}
