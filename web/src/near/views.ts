/**
 * Read-only calls to the house contract over JSON-RPC `call_function`: no wallet, no key.
 * Shapes follow docs/contract-api.md. Every reply is checked at runtime; a reply that does not
 * match fails loudly instead of rendering wrong numbers.
 */

export type Game = 'dice' | 'roulette' | 'blackjack'
export const GAMES: readonly Game[] = ['dice', 'roulette', 'blackjack']

export interface DealerView extends DealerTycoonView {
  id: string
  name: string
  game: Game
  temperament: string
  /** Rake in force now (boost included). */
  rake_bp: number
  /** Game base edge + rake: what the lobby shows. */
  total_edge_bp: number
  min_bet: string
  max_bet: string
  /** `core::worst_case_multiple(game)`: sizes max bets and the reopen threshold. */
  worst_case_multiple: string
  /** Unix seconds; 0 or past = no boost. */
  boost_until: number
  reason: string
  reason_text: string
  open: boolean
  bankroll: string
  reserved: string
  open_stakes: string
  shares: string
  /** Millionths of the launch price. */
  share_price_buy: string
  share_price_sell: string
}

/** v2 fields of `get_lobby` (docs/contract-api.md): null when the v1 contract omits them. */
export interface DealerTycoonView {
  /** NPC dealer (launch table) vs a player's table. */
  npc: boolean | null
  controller: string | null
  autopilot: boolean | null
  /** Unix seconds; 0 = never. */
  temperament_changed_at: number | null
  last_boost_at: number | null
  /** 0-based seat index (JSON seats are 1-based); null off the floor. */
  seat: number | null
  seat_traffic_bp: number | null
  rent_per_hour: string | null
  rent_owed: string | null
  /** Unix seconds the prepaid rent covers. */
  paid_until: number | null
  /** Seat sale price; null when not listed. */
  ask: string | null
  /** Unix seconds before the dealer may bid again after an eviction; 0 = none. */
  cooldown_until: number | null
  /** The rake the dealer set (`rake_bp` is the rake in force, lower during a boost). */
  offer_rake_bp: number | null
  base_edge_bp: number | null
  open_sessions: number | null
  /** Signed decimal strings: what players lost here, rent paid, and their difference, last hour. */
  earnings_1h: string | null
  rent_1h: string | null
  pnl_1h: string | null
  gamblers_1h: number | null
  /** This table's share of its game's bets at seated tables over the hour. */
  game_share_bp: number | null
}

export interface LpPosition {
  dealer_id: string
  shares: string
  /** Sell value right now, base units. */
  value: string
}

export interface PlayerView {
  balance: string
  lp: LpPosition[]
  /** v1 only (per-round betting); null on v2. */
  open_round: number | null
  /** The latest round whatever its status: how the table finds a round that settled fast. */
  last_round: number | null
  // ---- v2: empty / null on the v1 contract ----
  /** Dealer ids the account controls. */
  tables: string[]
  /** 0-based seat indexes it holds (JSON seats are 1-based). */
  seats: number[]
  open_session: string | null
  /** The last session ids, oldest first. */
  sessions: string[]
}

/** Done = `settled` or `refunded`; moves are legal only in `player_turn`. */
export type RoundStatus = 'waiting_vrf' | 'player_turn' | 'failed' | 'settled' | 'refunded'
const STATUSES: readonly RoundStatus[] = ['waiting_vrf', 'player_turn', 'failed', 'settled', 'refunded']

/** `core_rules::RouletteBet` serde form. */
export type RouletteBet =
  | 'red'
  | 'black'
  | 'odd'
  | 'even'
  | 'low'
  | 'high'
  | { straight: number }
  | { dozen: number }
  | { column: number }

/** `core_rules::Bet` serde form. */
export type Bet = { dice: { chance_bp: number; over: boolean } } | { roulette: RouletteBet } | 'blackjack'

/** One VRF draw of a round, enough to re-verify it: Ed25519(signature, alpha) under the VRF key. */
export interface VrfProof {
  step: number
  alpha: string
  signature_hex: string
  output_hex: string
}

export interface BlackjackHand {
  player: number[]
  dealer: number[]
  doubled: boolean
  done: boolean
}

export interface RoundView {
  id: number
  player: string
  dealer_id: string
  game: Game
  bet: Bet
  stake: string
  /** Total at risk (2 × stake after a double). */
  wager: string
  rake_bp: number
  status: RoundStatus
  step: number
  /** Unix seconds. */
  created_at: number
  updated_at: number
  /** Dice roll 0..9999 once known. */
  roll: number | null
  /** Roulette pocket 0..36 once known. */
  pocket: number | null
  bj: BlackjackHand | null
  /** After rake; null until settled, "0" on a loss. */
  payout: string | null
  proofs: VrfProof[]
  /** Why the last step failed, when status = failed. */
  error: string | null
}

export type HistoryKind = 'reprice' | 'boost' | 'bust' | 'reopen' | 'invest' | 'divest'
const HISTORY_KINDS: readonly HistoryKind[] = ['reprice', 'boost', 'bust', 'reopen', 'invest', 'divest']

export interface HistoryEntry {
  seq: number
  /** Unix seconds. */
  t: number
  kind: HistoryKind
  /** Display line, same wording as the simulator's events. */
  text: string
  reason: string | null
  reason_text: string | null
  rake_bp: number | null
  max_bet: string | null
  boost_until: number | null
  account_id: string | null
  /** tUSDC in/out for invest/divest. */
  amount: string | null
}

export interface VrfConfig {
  vrf_pubkey_hex: string
  min_bet: string
  refund_after_secs: number
  /** Id the next round will get: rounds 1..next_round_id-1 exist (spectator view). */
  next_round_id: number
}

// ---- guards -------------------------------------------------------------------------------

export class ViewShapeError extends Error {}

type Json = Record<string, unknown>

export function fail(path: string, expected: string): never {
  throw new ViewShapeError(`unexpected contract reply: ${path} should be ${expected}`)
}

export function record(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'an object')
  return value as Json
}

export function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'an array')
  return value
}

export function str(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'a string')
  return value
}

export function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'a boolean')
  return value
}

/** u64 values (ids, seconds, bp) are JSON numbers per the API conventions. */
export function int(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(path, 'a non-negative integer')
  return value
}

const DECIMAL = /^\d+$/

/** u128 amounts: decimal strings only, never JSON numbers (they lose precision). */
export function amount(value: unknown, path: string): string {
  if (typeof value !== 'string' || !DECIMAL.test(value)) fail(path, 'a decimal string')
  return value
}

const SIGNED_DECIMAL = /^-?\d+$/

/** Signed amounts (P&L): decimal strings with an optional `-`. */
export function signedAmount(value: unknown, path: string): string {
  if (typeof value !== 'string' || !SIGNED_DECIMAL.test(value)) fail(path, 'a signed decimal string')
  return value
}

/** The floor's seats (docs/floor.md). */
export const SEATS = 6

/** JSON seats are 1-based (seat 1 by the entrance); the UI indexes them from 0. */
export function seatIndex(value: unknown, path: string): number {
  const seat = int(value, path)
  if (seat < 1 || seat > SEATS) fail(path, `a seat number 1..${SEATS}`)
  return seat - 1
}

export function optional<T>(value: unknown, read: (v: unknown) => T): T | null {
  return value === undefined || value === null ? null : read(value)
}

export function oneOf<T extends string>(allowed: readonly T[], value: unknown, path: string): T {
  const found = allowed.find((a) => a === value)
  if (found === undefined) fail(path, `one of ${allowed.join(', ')}`)
  return found
}

export function parseDealer(value: unknown, path = 'dealer'): DealerView {
  const d = record(value, path)
  return {
    id: str(d.id, `${path}.id`),
    name: str(d.name, `${path}.name`),
    game: oneOf(GAMES, d.game, `${path}.game`),
    temperament: str(d.temperament, `${path}.temperament`),
    rake_bp: int(d.rake_bp, `${path}.rake_bp`),
    total_edge_bp: int(d.total_edge_bp, `${path}.total_edge_bp`),
    min_bet: amount(d.min_bet, `${path}.min_bet`),
    max_bet: amount(d.max_bet, `${path}.max_bet`),
    worst_case_multiple: amount(d.worst_case_multiple, `${path}.worst_case_multiple`),
    boost_until: int(d.boost_until, `${path}.boost_until`),
    reason: str(d.reason, `${path}.reason`),
    reason_text: str(d.reason_text, `${path}.reason_text`),
    open: bool(d.open, `${path}.open`),
    bankroll: amount(d.bankroll, `${path}.bankroll`),
    reserved: amount(d.reserved, `${path}.reserved`),
    open_stakes: amount(d.open_stakes, `${path}.open_stakes`),
    shares: amount(d.shares, `${path}.shares`),
    share_price_buy: amount(d.share_price_buy, `${path}.share_price_buy`),
    share_price_sell: amount(d.share_price_sell, `${path}.share_price_sell`),
    ...parseDealerV2(d, path),
  }
}

/** v2 fields: each may be absent (v1 contract), but a present one must have the documented type. */
function parseDealerV2(d: Json, path: string): DealerTycoonView {
  const n = (key: string) => optional(d[key], (v) => int(v, `${path}.${key}`))
  const signed = (key: string) => optional(d[key], (v) => signedAmount(v, `${path}.${key}`))
  const stats = optional(d.stats, (v) => record(v, `${path}.stats`))
  return {
    npc: optional(d.npc, (v) => bool(v, `${path}.npc`)),
    controller: optional(d.controller, (v) => str(v, `${path}.controller`)),
    autopilot: optional(d.autopilot, (v) => bool(v, `${path}.autopilot`)),
    temperament_changed_at: n('temperament_changed_at'),
    last_boost_at: n('last_boost_at'),
    seat: optional(d.seat, (v) => seatIndex(v, `${path}.seat`)),
    seat_traffic_bp: n('seat_traffic_bp'),
    rent_per_hour: optional(d.rent_per_hour, (v) => amount(v, `${path}.rent_per_hour`)),
    rent_owed: optional(d.rent_owed, (v) => amount(v, `${path}.rent_owed`)),
    paid_until: n('paid_until'),
    ask: optional(d.ask, (v) => amount(v, `${path}.ask`)),
    cooldown_until: n('cooldown_until'),
    offer_rake_bp: n('offer_rake_bp'),
    base_edge_bp: n('base_edge_bp'),
    open_sessions: n('open_sessions'),
    earnings_1h: signed('earnings_1h'),
    rent_1h: signed('rent_1h'),
    pnl_1h: signed('pnl_1h'),
    gamblers_1h: stats && optional(stats.gamblers_1h, (v) => int(v, `${path}.stats.gamblers_1h`)),
    game_share_bp: stats && optional(stats.game_share_bp, (v) => int(v, `${path}.stats.game_share_bp`)),
  }
}

export function parseLobby(value: unknown): DealerView[] {
  return list(value, 'lobby').map((d, i) => parseDealer(d, `lobby[${i}]`))
}

export function parsePlayer(value: unknown): PlayerView {
  const p = record(value, 'player')
  const lp = list(p.lp, 'player.lp').map((entry, i) => {
    const e = record(entry, `player.lp[${i}]`)
    return {
      dealer_id: str(e.dealer_id, `player.lp[${i}].dealer_id`),
      shares: amount(e.shares, `player.lp[${i}].shares`),
      value: amount(e.value, `player.lp[${i}].value`),
    }
  })
  return {
    balance: amount(p.balance, 'player.balance'),
    lp,
    open_round: optional(p.open_round, (v) => int(v, 'player.open_round')),
    last_round: optional(p.last_round, (v) => int(v, 'player.last_round')),
    tables: optional(p.tables, (v) => list(v, 'player.tables').map((t, i) => str(t, `player.tables[${i}]`))) ?? [],
    seats: optional(p.seats, (v) => list(v, 'player.seats').map((s, i) => seatIndex(s, `player.seats[${i}]`))) ?? [],
    open_session: optional(p.open_session, (v) => str(v, 'player.open_session')),
    sessions: optional(p.sessions, (v) => list(v, 'player.sessions').map((s, i) => str(s, `player.sessions[${i}]`))) ?? [],
  }
}

const SIMPLE_ROULETTE_BETS = ['red', 'black', 'odd', 'even', 'low', 'high'] as const

function rouletteBet(value: unknown, path: string): RouletteBet {
  if (typeof value === 'string') return oneOf(SIMPLE_ROULETTE_BETS, value, path)
  const b = record(value, path)
  if (b.straight !== undefined) return { straight: int(b.straight, `${path}.straight`) }
  if (b.dozen !== undefined) return { dozen: int(b.dozen, `${path}.dozen`) }
  if (b.column !== undefined) return { column: int(b.column, `${path}.column`) }
  fail(path, 'a roulette bet')
}

export function parseBet(value: unknown): Bet {
  if (value === 'blackjack') return 'blackjack'
  const b = record(value, 'round.bet')
  if (b.roulette !== undefined) return { roulette: rouletteBet(b.roulette, 'round.bet.roulette') }
  const dice = record(b.dice, 'round.bet.dice')
  return { dice: { chance_bp: int(dice.chance_bp, 'round.bet.dice.chance_bp'), over: bool(dice.over, 'round.bet.dice.over') } }
}

export function parseHand(value: unknown): BlackjackHand {
  const h = record(value, 'round.bj')
  const [player, dealer] = (['player', 'dealer'] as const).map((side) =>
    list(h[side], `round.bj.${side}`).map((c, i) => int(c, `round.bj.${side}[${i}]`)),
  )
  return { player, dealer, doubled: bool(h.doubled, 'round.bj.doubled'), done: bool(h.done, 'round.bj.done') }
}

function proof(value: unknown, i: number): VrfProof {
  const path = `round.proofs[${i}]`
  const v = record(value, path)
  return {
    step: int(v.step, `${path}.step`),
    alpha: str(v.alpha, `${path}.alpha`),
    signature_hex: str(v.signature_hex, `${path}.signature_hex`),
    output_hex: str(v.output_hex, `${path}.output_hex`),
  }
}

export function parseRound(value: unknown): RoundView | null {
  if (value === null) return null
  const r = record(value, 'round')
  return {
    id: int(r.id, 'round.id'),
    player: str(r.player, 'round.player'),
    dealer_id: str(r.dealer_id, 'round.dealer_id'),
    game: oneOf(GAMES, r.game, 'round.game'),
    bet: parseBet(r.bet),
    stake: amount(r.stake, 'round.stake'),
    wager: amount(r.wager, 'round.wager'),
    rake_bp: int(r.rake_bp, 'round.rake_bp'),
    status: oneOf(STATUSES, r.status, 'round.status'),
    step: int(r.step, 'round.step'),
    created_at: int(r.created_at, 'round.created_at'),
    updated_at: int(r.updated_at, 'round.updated_at'),
    roll: optional(r.roll, (v) => int(v, 'round.roll')),
    pocket: optional(r.pocket, (v) => int(v, 'round.pocket')),
    bj: optional(r.bj, parseHand),
    payout: optional(r.payout, (v) => amount(v, 'round.payout')),
    proofs: list(r.proofs, 'round.proofs').map(proof),
    error: optional(r.error, (v) => str(v, 'round.error')),
  }
}

export function parseHistory(value: unknown): HistoryEntry[] {
  return list(value, 'history').map((entry, i) => {
    const path = `history[${i}]`
    const e = record(entry, path)
    return {
      seq: int(e.seq, `${path}.seq`),
      t: int(e.t, `${path}.t`),
      kind: oneOf(HISTORY_KINDS, e.kind, `${path}.kind`),
      text: str(e.text, `${path}.text`),
      reason: optional(e.reason, (v) => str(v, `${path}.reason`)),
      reason_text: optional(e.reason_text, (v) => str(v, `${path}.reason_text`)),
      rake_bp: optional(e.rake_bp, (v) => int(v, `${path}.rake_bp`)),
      max_bet: optional(e.max_bet, (v) => amount(v, `${path}.max_bet`)),
      boost_until: optional(e.boost_until, (v) => int(v, `${path}.boost_until`)),
      account_id: optional(e.account_id, (v) => str(v, `${path}.account_id`)),
      amount: optional(e.amount, (v) => amount(v, `${path}.amount`)),
    }
  })
}

const HEX_32 = /^[0-9a-f]{64}$/i

export function parseConfig(value: unknown): VrfConfig {
  const c = record(value, 'config')
  const pubkey = str(c.vrf_pubkey_hex, 'config.vrf_pubkey_hex')
  if (!HEX_32.test(pubkey)) fail('config.vrf_pubkey_hex', '64 hex characters')
  return {
    vrf_pubkey_hex: pubkey,
    min_bet: amount(c.min_bet, 'config.min_bet'),
    refund_after_secs: int(c.refund_after_secs, 'config.refund_after_secs'),
    next_round_id: int(c.next_round_id, 'config.next_round_id'),
  }
}

// ---- RPC ----------------------------------------------------------------------------------

export interface ViewTarget {
  rpcUrl: string
  houseContract: string
}

/** One `call_function` view; returns the contract's JSON result, unparsed. */
export async function viewCall(rpcUrl: string, contractId: string, method: string, args: object = {}): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'tilt-house',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'optimistic',
        account_id: contractId,
        method_name: method,
        args_base64: toBase64(JSON.stringify(args)),
      },
    }),
  })
  if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}`)
  return decodeViewReply(method, await response.json())
}

/** Unwraps a JSON-RPC `call_function` reply: errors throw, bytes are decoded as JSON. */
export function decodeViewReply(method: string, body: unknown): unknown {
  const reply = record(body, 'rpc')
  if (reply.error !== undefined) throw new Error(`RPC ${method}: ${JSON.stringify(reply.error)}`)
  const result = record(reply.result, 'rpc.result')
  // Contract panics come back as a successful RPC call with an `error` string.
  if (typeof result.error === 'string') throw new Error(`${method}: ${result.error}`)
  const bytes = list(result.result, 'rpc.result.result').map((b, i) => int(b, `rpc.result.result[${i}]`))
  const text = new TextDecoder().decode(new Uint8Array(bytes))
  return text === '' ? null : (JSON.parse(text) as unknown)
}

function toBase64(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export async function getLobby(target: ViewTarget): Promise<DealerView[]> {
  return parseLobby(await viewCall(target.rpcUrl, target.houseContract, 'get_lobby'))
}

export async function getPlayer(target: ViewTarget, accountId: string): Promise<PlayerView> {
  return parsePlayer(await viewCall(target.rpcUrl, target.houseContract, 'get_player', { account_id: accountId }))
}

export async function getRound(target: ViewTarget, roundId: number): Promise<RoundView | null> {
  return parseRound(await viewCall(target.rpcUrl, target.houseContract, 'get_round', { round_id: roundId }))
}

/** The latest `limit` (≤ 50) entries of a dealer's log, oldest first. */
export async function getHistory(target: ViewTarget, dealerId: string, limit = 50): Promise<HistoryEntry[]> {
  return parseHistory(
    await viewCall(target.rpcUrl, target.houseContract, 'get_history', { dealer_id: dealerId, from: null, limit }),
  )
}

export async function getConfig(target: ViewTarget): Promise<VrfConfig> {
  return parseConfig(await viewCall(target.rpcUrl, target.houseContract, 'get_config'))
}

/** The player's wallet balance on the token contract (not yet deposited in the house). */
export async function getTokenBalance(rpcUrl: string, tokenContract: string, accountId: string): Promise<string> {
  return amount(await viewCall(rpcUrl, tokenContract, 'ft_balance_of', { account_id: accountId }), 'ft_balance_of')
}
