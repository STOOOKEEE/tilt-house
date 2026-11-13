/**
 * Poker tables (docs/poker-api.md), browser side: the session server's table API with every reply
 * checked, the checks behind the action buttons, and the proof of a finished hand: its revealed
 * seed replayed with the TypeScript mirror of core's rules (poker-rules.ts). Nothing here is
 * trusted by the server; it is how the player checks the server.
 */
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import {
  cardText,
  historyHash,
  legalAllows,
  parseCard,
  replayHand,
  type ActionRecord,
  type HandHistory,
  type HandStart,
  type Legal,
  type PokerAction,
} from './poker-rules'
import { parseCompactRound, roundBorsh, SessionError, type CompactRound, type SignedState } from './session-client'
import { amount, bool, fail, int, list, oneOf, optional, record, str } from './views'

// ---- types (JSON forms, docs/poker-api.md and core's serde) --------------------------------

/** Rank + suit: "As", "Td", "7c". */
export type Card = string
export type HandPhase = 'seeding' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'
const PHASES: readonly HandPhase[] = ['seeding', 'preflop', 'flop', 'turn', 'river', 'showdown']

export interface TableSummary {
  table_id: string
  name: string
  seats: number
  humans: number
  npcs: number
  small_blind: string
  big_blind: string
  min_buy_in: string
  max_buy_in: string
  /** False: no buy-in now (the pool can't cover one), `reason` says why; old servers omit it (= open). */
  open: boolean
  reason: string | null
  rake_bp: number
  hand_number: number
}

export interface SeatView {
  seat: number
  player: string
  name: string
  npc: boolean
  stack: string
  bet: string
  total_in: string
  folded: boolean
  all_in: boolean
  in_hand: boolean
  waiting: boolean
  leaving: boolean
  last_action: PokerAction | null
  /** Shown cards only (showdown); never someone's live hole cards. */
  cards: Card[] | null
}

export interface PotView {
  amount: string
  eligible: number[]
  winners: number[]
}

export interface HandView {
  number: number
  phase: HandPhase
  commitment: string
  /** Seats dealt into this hand. */
  seats: number[]
  seeds_in: number[]
  button: number
  /** Null while seeding. */
  small_blind_seat: number | null
  big_blind_seat: number | null
  board: Card[]
  pots: PotView[]
  current_bet: string
  to_act: number | null
  deadline: number | null
}

export interface YouView {
  /** Null while queued for a seat an NPC is giving up. */
  seat: number | null
  session_id: string
  hole: Card[] | null
  /** Non-null exactly when it is your turn. */
  legal: Legal | null
  /** The session's latest signed state, the proof `force_close` needs. */
  state: SignedState | null
  /** Your session round of your latest recorded hand. */
  last_round: CompactRound | null
}

export interface TableConfigView {
  small_blind: string
  big_blind: string
  rake_cap: string
  min_buy_in: string
  max_buy_in: string
  /** As in `TableSummary`. */
  open: boolean
  reason: string | null
  rake_bp: number
  action_ms: number
  seed_ms: number
}

export interface HistoryPlayer {
  seat: number
  player: string
  name: string
  npc: boolean
  session_id: string
  hole: Card[]
  stake: string
  payout: string
  /** The session round this hand became; null when the player put nothing in. */
  nonce: number | null
}

export interface ResultSeat {
  seat: number
  player: string
  put_in: string
  won: string
  stack_after: string
  shown: Card[] | null
  value: number | null
}

export interface HandResultView {
  board: Card[]
  showdown: boolean
  pots: PotView[]
  rake: string
  seats: ResultSeat[]
}

/** A finished hand, fully revealed: `history` is core's `HandHistory`, which replays it. */
export interface LastHand {
  number: number
  commitment: string
  history: HandHistory
  history_hash: string
  result: HandResultView
  deck: Card[]
  players: HistoryPlayer[]
  ended_at: number
}

export interface TableState {
  table_id: string
  name: string
  version: number
  seats: (SeatView | null)[]
  config: TableConfigView
  hand: HandView | null
  last_hand: LastHand | null
  you: YouView | null
}

// ---- actions -------------------------------------------------------------------------------

/** Base units of 0.01: buy-ins are shown and typed in cents. */
const CENT = 10_000n

export const NO_BUY_IN = "This table's pool can't cover a buy-in right now"

/**
 * The buy-in range at 2 decimals: min rounded up, max rounded down, so both ends shown are
 * accepted. Null when the table is closed or no buy-in fits (an old server reported min > max).
 */
export function buyInRange(config: Pick<TableConfigView, 'open' | 'min_buy_in' | 'max_buy_in'>): { min: bigint; max: bigint } | null {
  const min = ((BigInt(config.min_buy_in) + CENT - 1n) / CENT) * CENT
  const max = (BigInt(config.max_buy_in) / CENT) * CENT
  return !config.open || min > max ? null : { min, max }
}

/**
 * Why `action` is not allowed by the server's `legal` (null: allowed), the same rule as core
 * `Legal::allows`. The buttons only send what this accepts; the server checks again.
 */
export function actionProblem(legal: Legal | null, action: PokerAction): string | null {
  if (!legal) return 'not your turn'
  if (legalAllows(legal, action)) return null
  if (action === 'check') return 'there is a bet to call'
  if (action === 'call') return 'nothing to call: check'
  if (!legal.raise) return 'raising is closed this round'
  if (action === 'all_in' || action === 'fold') return 'not allowed'
  return action.raise_to < legal.raise.min_to ? `the minimum is ${legal.raise.min_to}` : `the maximum is ${legal.raise.max_to}`
}

/**
 * The slider's presets as bet-to levels: half pot, ¾ pot and pot (after calling), clamped to
 * the legal range, duplicates dropped. `pot` counts every chip in the middle and in front.
 */
export function raisePresets(legal: Legal, pot: bigint, currentBet: bigint): { label: string; to: bigint }[] {
  const range = legal.raise
  if (!range) return []
  const potAfterCall = pot + legal.call
  const presets = [
    { label: '½ pot', to: currentBet + potAfterCall / 2n },
    { label: '¾ pot', to: currentBet + (potAfterCall * 3n) / 4n },
    { label: 'pot', to: currentBet + potAfterCall },
  ].map((p) => ({ label: p.label, to: p.to < range.min_to ? range.min_to : p.to > range.max_to ? range.max_to : p.to }))
  return presets.filter((p, i) => presets.findIndex((q) => q.to === p.to) === i)
}

/** A slider level as an action: everything is `all_in` (so a short stack can always shove). */
export function raiseAction(legal: Legal, to: bigint): PokerAction {
  return legal.raise && to >= legal.raise.max_to ? 'all_in' : { raise_to: to }
}

// ---- the proof of a hand -------------------------------------------------------------------

export type HandCheck = { ok: true; checks: string[] } | { ok: false; error: string }

/**
 * Replays a finished hand from its revealed seed: the seed matches the commitment published
 * before the deal, the deck is the one the seeds give (with `mySeed` among them when given), the
 * actions replay legally to the published result, and the history hash is the one each player's
 * session round commits to.
 */
export function verifyHand(hand: LastHand, mine: { seat: number; clientSeed: string } | null = null): HandCheck {
  const checks: string[] = []
  try {
    const { history } = hand
    const commitment = bytesToHex(sha256(hexToBytes(history.hand_seed)))
    if (commitment !== hand.commitment || commitment !== history.start.hand_seed_hash) return { ok: false, error: 'the seed does not match its commitment' }
    checks.push('seed revealed: sha256 matches the commitment')
    if (mine) {
      const seat = history.start.seats.find((s) => s.seat === mine.seat)
      if (seat && seat.client_seed !== mine.clientSeed) return { ok: false, error: 'your client seed is not the one in the deck' }
      if (seat) checks.push('your client seed is in the deck')
    }
    const replayed = replayHand(history)
    if (replayed.deck.map(cardText).join(' ') !== hand.deck.join(' ')) return { ok: false, error: 'the deck does not come from the seeds' }
    checks.push('deck verified: the seeds give this exact deck')
    const result = replayed.result
    if (!result) return { ok: false, error: 'the hand does not finish' }
    if (result.board.map(cardText).join(' ') !== hand.result.board.join(' ')) return { ok: false, error: 'the board is not the dealt one' }
    if (result.rake.toString() !== hand.result.rake) return { ok: false, error: 'the rake is not the rule' }
    for (const seat of result.seats) {
      const published = hand.result.seats.find((s) => s.seat === seat.seat)
      const player = hand.players.find((p) => p.seat === seat.seat)
      const hole = replayed.hole(seat.seat)?.map(cardText).join(' ')
      if (!published || published.put_in !== seat.put_in.toString() || published.won !== seat.won.toString()) {
        return { ok: false, error: `seat ${seat.seat + 1} was not paid by the rules` }
      }
      if (!player || player.stake !== seat.put_in.toString() || player.payout !== seat.won.toString() || player.hole.join(' ') !== hole) {
        return { ok: false, error: `seat ${seat.seat + 1}'s line does not replay` }
      }
    }
    checks.push('every action legal, every pot paid by the rules')
    if (historyHash(history) !== hand.history_hash) return { ok: false, error: 'the history hash is wrong' }
    checks.push('history hash matches the session rounds')
    return { ok: true, checks }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Core `Hand::round_for`: the session round a seat's line of this hand must be, at `nonce`.
 * Comparing its borsh to the server's round links the session chain to the replayed hand.
 */
export function expectedRound(hand: LastHand, seat: number, nonce: number): CompactRound {
  const line = hand.result.seats.find((s) => s.seat === seat)
  if (!line) throw new Error(`seat ${seat + 1} was not in hand ${hand.number}`)
  return {
    nonce,
    bet: { poker: { table: hand.history.start.table, hand: hand.history.start.hand } },
    stake: line.put_in,
    actions: [],
    outcome: { poker: { hand_seed_hash: hand.history.start.hand_seed_hash, history_hash: hand.history_hash, seat, board: hand.result.board } },
    payout: line.won,
  }
}

export function roundMatchesHand(round: CompactRound, hand: LastHand, seat: number): boolean {
  return bytesToHex(roundBorsh(round)) === bytesToHex(roundBorsh(expectedRound(hand, seat, round.nonce)))
}

// ---- HTTP client -------------------------------------------------------------------------

async function call(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init.headers } })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = typeof body === 'object' && body !== null && 'error' in body ? body.error : null
    throw new SessionError(`poker table: ${typeof error === 'string' ? error : `HTTP ${response.status}`}`, response.status)
  }
  return body
}

export function actionJson(action: PokerAction): string | { raise_to: string } {
  return typeof action === 'object' ? { raise_to: action.raise_to.toString() } : action
}

export interface PokerClient {
  tables(): Promise<TableSummary[]>
  /** Long-polls when `since` is the current version (the server holds up to 10 s). */
  state(tableId: string, token: string | null, since: number | null, signal?: AbortSignal): Promise<TableState>
  /** `seat` null: queued until an NPC gives its seat up at the end of the hand. */
  join(tableId: string, token: string, sessionId: string, seat: number | null): Promise<{ seat: number | null; waiting: boolean }>
  seed(tableId: string, token: string, hand: number, clientSeed: string): Promise<void>
  act(tableId: string, token: string, hand: number, action: PokerAction): Promise<TableState>
  leave(tableId: string, token: string): Promise<{ left: boolean }>
}

export function pokerClient(baseUrl: string): PokerClient {
  const base = `${baseUrl.replace(/\/+$/, '')}/poker/tables`
  const table = (id: string) => `${base}/${encodeURIComponent(id)}`
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  return {
    async tables() {
      return list(await call(base, { method: 'GET' }), 'tables').map((t, i) => parseSummary(t, `tables[${i}]`))
    },
    async state(tableId, token, since, signal) {
      const query = since === null ? '' : `?since=${since}`
      return parseTableState(await call(`${table(tableId)}${query}`, { method: 'GET', headers: token ? auth(token) : {}, signal }))
    },
    async join(tableId, token, sessionId, seat) {
      const payload = seat === null ? { session_id: sessionId } : { session_id: sessionId, seat }
      const body = record(await call(`${table(tableId)}/join`, { method: 'POST', headers: auth(token), body: JSON.stringify(payload) }), 'join')
      return { seat: maybeInt(body.seat, 'join.seat'), waiting: bool(body.waiting, 'join.waiting') }
    },
    async seed(tableId, token, hand, clientSeed) {
      await call(`${table(tableId)}/seed`, { method: 'POST', headers: auth(token), body: JSON.stringify({ hand, client_seed: clientSeed }) })
    },
    async act(tableId, token, hand, action) {
      const body = JSON.stringify({ hand, action: actionJson(action) })
      return parseTableState(await call(`${table(tableId)}/action`, { method: 'POST', headers: auth(token), body }))
    },
    async leave(tableId, token) {
      const body = record(await call(`${table(tableId)}/leave`, { method: 'POST', headers: auth(token), body: '{}' }), 'leave')
      return { left: bool(body.left, 'leave.left') }
    },
  }
}

// ---- reply guards: a reply that does not match is refused, never half-used ----------------

function hex(value: unknown, path: string, bytes: number): string {
  const v = str(value, path)
  if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(v)) fail(path, `${bytes} bytes of hex`)
  return v.toLowerCase()
}

function card(value: unknown, path: string): Card {
  const v = str(value, path)
  try {
    parseCard(v)
  } catch {
    fail(path, 'a card like "As"')
  }
  return v
}

const cards = (value: unknown, path: string): Card[] => list(value, path).map((c, i) => card(c, `${path}[${i}]`))
const ints = (value: unknown, path: string): number[] => list(value, path).map((n, i) => int(n, `${path}[${i}]`))
const maybeInt = (value: unknown, path: string): number | null => optional(value, (v) => int(v, path))
const big = (value: unknown, path: string): bigint => BigInt(amount(value, path))

/** Core `PokerAction`: `"fold"`, `"check"`, `"call"`, `"all_in"` or `{"raise_to": "<amount>"}`. */
export function parseAction(value: unknown, path: string): PokerAction {
  if (typeof value === 'string') return oneOf(['fold', 'check', 'call', 'all_in'] as const, value, path)
  return { raise_to: big(record(value, path).raise_to, `${path}.raise_to`) }
}

function parseSummary(value: unknown, path: string): TableSummary {
  const t = record(value, path)
  return {
    table_id: str(t.table_id, `${path}.table_id`),
    name: str(t.name, `${path}.name`),
    seats: int(t.seats, `${path}.seats`),
    humans: int(t.humans, `${path}.humans`),
    npcs: int(t.npcs, `${path}.npcs`),
    small_blind: amount(t.small_blind, `${path}.small_blind`),
    big_blind: amount(t.big_blind, `${path}.big_blind`),
    min_buy_in: amount(t.min_buy_in, `${path}.min_buy_in`),
    max_buy_in: amount(t.max_buy_in, `${path}.max_buy_in`),
    open: optional(t.open, (v) => bool(v, `${path}.open`)) ?? true,
    reason: optional(t.reason, (v) => str(v, `${path}.reason`)),
    rake_bp: int(t.rake_bp, `${path}.rake_bp`),
    hand_number: int(t.hand_number, `${path}.hand_number`),
  }
}

function parsePot(value: unknown, path: string): PotView {
  const p = record(value, path)
  return {
    amount: amount(p.amount, `${path}.amount`),
    eligible: ints(p.eligible, `${path}.eligible`),
    winners: p.winners === undefined ? [] : ints(p.winners, `${path}.winners`),
  }
}

const pots = (value: unknown, path: string): PotView[] => list(value, path).map((p, i) => parsePot(p, `${path}[${i}]`))

function parseSeat(value: unknown, path: string): SeatView {
  const s = record(value, path)
  return {
    seat: int(s.seat, `${path}.seat`),
    player: str(s.player, `${path}.player`),
    name: str(s.name, `${path}.name`),
    npc: bool(s.npc, `${path}.npc`),
    stack: amount(s.stack, `${path}.stack`),
    bet: amount(s.bet, `${path}.bet`),
    total_in: amount(s.total_in, `${path}.total_in`),
    folded: bool(s.folded, `${path}.folded`),
    all_in: bool(s.all_in, `${path}.all_in`),
    in_hand: bool(s.in_hand, `${path}.in_hand`),
    waiting: bool(s.waiting, `${path}.waiting`),
    leaving: bool(s.leaving, `${path}.leaving`),
    last_action: optional(s.last_action, (v) => parseAction(v, `${path}.last_action`)),
    cards: optional(s.cards, (v) => cards(v, `${path}.cards`)),
  }
}

function parseHand(value: unknown, path: string): HandView {
  const h = record(value, path)
  return {
    number: int(h.number, `${path}.number`),
    phase: oneOf(PHASES, h.phase, `${path}.phase`),
    commitment: hex(h.commitment, `${path}.commitment`, 32),
    seats: ints(h.seats, `${path}.seats`),
    seeds_in: ints(h.seeds_in, `${path}.seeds_in`),
    button: int(h.button, `${path}.button`),
    small_blind_seat: maybeInt(h.small_blind_seat, `${path}.small_blind_seat`),
    big_blind_seat: maybeInt(h.big_blind_seat, `${path}.big_blind_seat`),
    board: cards(h.board, `${path}.board`),
    pots: pots(h.pots, `${path}.pots`),
    current_bet: amount(h.current_bet, `${path}.current_bet`),
    to_act: maybeInt(h.to_act, `${path}.to_act`),
    deadline: maybeInt(h.deadline, `${path}.deadline`),
  }
}

export function parseLegal(value: unknown, path: string): Legal {
  const l = record(value, path)
  return {
    seat: int(l.seat, `${path}.seat`),
    can_check: bool(l.can_check, `${path}.can_check`),
    call: big(l.call, `${path}.call`),
    raise: optional(l.raise, (v) => {
      const r = record(v, `${path}.raise`)
      return { min_to: big(r.min_to, `${path}.raise.min_to`), max_to: big(r.max_to, `${path}.raise.max_to`) }
    }),
    stack: big(l.stack, `${path}.stack`),
  }
}

function parseSignedState(value: unknown, path: string): SignedState {
  const s = record(value, path)
  return {
    session_id: str(s.session_id, `${path}.session_id`),
    nonce: int(s.nonce, `${path}.nonce`),
    balance: amount(s.balance, `${path}.balance`),
    chain: hex(s.chain, `${path}.chain`, 32),
    signature: hex(s.signature, `${path}.signature`, 64),
  }
}

/** Core `HandHistory` (serde): amounts as decimal strings, hashes as hex. */
export function parseHandHistory(value: unknown, path: string): HandHistory {
  const h = record(value, path)
  const s = record(h.start, `${path}.start`)
  const c = record(s.config, `${path}.start.config`)
  const start: HandStart = {
    table: str(s.table, `${path}.start.table`),
    hand: int(s.hand, `${path}.start.hand`),
    config: {
      small_blind: big(c.small_blind, `${path}.start.config.small_blind`),
      big_blind: big(c.big_blind, `${path}.start.config.big_blind`),
      rake_cap: big(c.rake_cap, `${path}.start.config.rake_cap`),
    },
    button: int(s.button, `${path}.start.button`),
    seats: list(s.seats, `${path}.start.seats`).map((v, i) => {
      const at = `${path}.start.seats[${i}]`
      const seat = record(v, at)
      return {
        seat: int(seat.seat, `${at}.seat`),
        player: str(seat.player, `${at}.player`),
        stack: big(seat.stack, `${at}.stack`),
        client_seed: str(seat.client_seed, `${at}.client_seed`),
        rake_bp: int(seat.rake_bp, `${at}.rake_bp`),
      }
    }),
    hand_seed_hash: hex(s.hand_seed_hash, `${path}.start.hand_seed_hash`, 32),
  }
  const actions: ActionRecord[] = list(h.actions, `${path}.actions`).map((v, i) => {
    const a = record(v, `${path}.actions[${i}]`)
    return { seat: int(a.seat, `${path}.actions[${i}].seat`), action: parseAction(a.action, `${path}.actions[${i}].action`) }
  })
  return { start, hand_seed: hex(h.hand_seed, `${path}.hand_seed`, 32), actions }
}

function parseResult(value: unknown, path: string): HandResultView {
  const r = record(value, path)
  return {
    board: cards(r.board, `${path}.board`),
    showdown: bool(r.showdown, `${path}.showdown`),
    pots: pots(r.pots, `${path}.pots`),
    rake: amount(r.rake, `${path}.rake`),
    seats: list(r.seats, `${path}.seats`).map((v, i) => {
      const at = `${path}.seats[${i}]`
      const s = record(v, at)
      return {
        seat: int(s.seat, `${at}.seat`),
        player: str(s.player, `${at}.player`),
        put_in: amount(s.put_in, `${at}.put_in`),
        won: amount(s.won, `${at}.won`),
        stack_after: amount(s.stack_after, `${at}.stack_after`),
        shown: optional(s.shown, (x) => cards(x, `${at}.shown`)),
        value: maybeInt(s.value, `${at}.value`),
      }
    }),
  }
}

export function parseLastHand(value: unknown, path = 'last_hand'): LastHand {
  const h = record(value, path)
  return {
    number: int(h.number, `${path}.number`),
    commitment: hex(h.commitment, `${path}.commitment`, 32),
    history: parseHandHistory(h.history, `${path}.history`),
    history_hash: hex(h.history_hash, `${path}.history_hash`, 32),
    result: parseResult(h.result, `${path}.result`),
    deck: cards(h.deck, `${path}.deck`),
    players: list(h.players, `${path}.players`).map((v, i) => {
      const at = `${path}.players[${i}]`
      const p = record(v, at)
      return {
        seat: int(p.seat, `${at}.seat`),
        player: str(p.player, `${at}.player`),
        name: str(p.name, `${at}.name`),
        npc: bool(p.npc, `${at}.npc`),
        session_id: str(p.session_id, `${at}.session_id`),
        hole: cards(p.hole, `${at}.hole`),
        stake: amount(p.stake, `${at}.stake`),
        payout: amount(p.payout, `${at}.payout`),
        nonce: maybeInt(p.nonce, `${at}.nonce`),
      }
    }),
    ended_at: int(h.ended_at, `${path}.ended_at`),
  }
}

export function parseTableState(value: unknown): TableState {
  const t = record(value, 'table')
  const c = record(t.config, 'table.config')
  return {
    table_id: str(t.table_id, 'table.table_id'),
    name: str(t.name, 'table.name'),
    version: int(t.version, 'table.version'),
    seats: list(t.seats, 'table.seats').map((s, i) => optional(s, (v) => parseSeat(v, `table.seats[${i}]`))),
    config: {
      small_blind: amount(c.small_blind, 'table.config.small_blind'),
      big_blind: amount(c.big_blind, 'table.config.big_blind'),
      rake_cap: amount(c.rake_cap, 'table.config.rake_cap'),
      min_buy_in: amount(c.min_buy_in, 'table.config.min_buy_in'),
      max_buy_in: amount(c.max_buy_in, 'table.config.max_buy_in'),
      open: optional(c.open, (v) => bool(v, 'table.config.open')) ?? true,
      reason: optional(c.reason, (v) => str(v, 'table.config.reason')),
      rake_bp: int(c.rake_bp, 'table.config.rake_bp'),
      action_ms: int(c.action_ms, 'table.config.action_ms'),
      seed_ms: int(c.seed_ms, 'table.config.seed_ms'),
    },
    hand: optional(t.hand, (v) => parseHand(v, 'table.hand')),
    last_hand: optional(t.last_hand, (v) => parseLastHand(v, 'table.last_hand')),
    you: optional(t.you, (v) => {
      const y = record(v, 'table.you')
      return {
        seat: maybeInt(y.seat, 'table.you.seat'),
        session_id: str(y.session_id, 'table.you.session_id'),
        hole: optional(y.hole, (h) => cards(h, 'table.you.hole')),
        legal: optional(y.legal, (l) => parseLegal(l, 'table.you.legal')),
        state: optional(y.state, (s) => parseSignedState(s, 'table.you.state')),
        last_round: optional(y.last_round, (r) => parseCompactRound(r, 'table.you.last_round')),
      }
    }),
  }
}
