/**
 * $TILT views (docs/tilt.md) and the USD floor's day and Tilt Hour (docs/contract-api.md). Every
 * reply is checked at runtime like views.ts. While the token (or the floor's new views) is not
 * deployed yet the page shows clearly labelled mock data instead of an error.
 */
import { formatAmount, formatBp } from '../format'
import { amount, fail, int, list, oneOf, optional, record, signedAmount, str, viewCall } from './views'

export const TILT_LOG_KINDS = ['mint', 'burn', 'streak', 'tilt_hour'] as const
export type TiltLogKind = (typeof TILT_LOG_KINDS)[number]

/** One parameter of `get_params`: fixed at launch, no admin key can change it. */
export type TiltParam = string | number | null

/** Nanosecond timestamps (`*_ns`) travel as U64 decimal strings. */
export interface TiltHourProgress {
  round: number
  burned: string
  burners: number
  /** Nanoseconds; "0" = no window open. */
  window_end_ns: string
  triggers: number
  last_started_ns: string | null
}

export interface TiltState {
  total_supply: string
  treasury: string
  circulating: string
  welcome_remaining: string
  welcome_claims: number
  minted_total: string
  burned_total: string
  /** UTC day index (unix seconds / 86 400). */
  today: number
  last_reported_day: number | null
  streak: number
  longest_streak: number
  longest_streak_day: number | null
  tilt_hour: TiltHourProgress
  log_next_seq: number
}

export interface TiltLogEntry {
  seq: number
  kind: TiltLogKind
  /** mint: launch|daily|welcome · burn: daily|tilt_hour · streak: grow|reset · tilt_hour: triggered|started|failed. */
  reason: string
  account: string | null
  /** Base units; for `streak` the new streak, for `tilt_hour` what burned in the window. */
  amount: string
  day: number
  timestamp_ns: string
}

export interface DayPlayer {
  account_id: string
  wagered: string
  net: string
}

/** The USD floor's count of one UTC day: human players vs the house (NPC gamblers excluded). */
export interface DayView {
  day: number
  closed: boolean
  /** Signed: positive = the players beat the house. */
  players_net: string
  wagered: string
  /** Largest wagerers first. */
  players: DayPlayer[]
}

export interface TiltSnapshot {
  params: Record<string, TiltParam>
  state: TiltState
  log: TiltLogEntry[]
  /** True when the token is not deployed yet: everything above is a mock. */
  mock: boolean
}

export interface FloorDaySnapshot {
  /** Null: the floor has not counted anything today yet. */
  today: DayView | null
  /** Unix seconds; 0 = no Tilt Hour ever ran. Active while > now. */
  tiltHourUntil: number
  mock: boolean
}

// ---- parsing ---------------------------------------------------------------------------------

export function parseTiltParams(value: unknown): Record<string, TiltParam> {
  const p = record(value, 'tilt.params')
  const params: Record<string, TiltParam> = {}
  for (const [key, v] of Object.entries(p)) {
    if (typeof v === 'string' || v === null) params[key] = v
    else params[key] = int(v, `tilt.params.${key}`)
  }
  return params
}

export function parseTiltState(value: unknown): TiltState {
  const s = record(value, 'tilt.state')
  const h = record(s.tilt_hour, 'tilt.state.tilt_hour')
  return {
    total_supply: amount(s.total_supply, 'tilt.state.total_supply'),
    treasury: amount(s.treasury, 'tilt.state.treasury'),
    circulating: amount(s.circulating, 'tilt.state.circulating'),
    welcome_remaining: amount(s.welcome_remaining, 'tilt.state.welcome_remaining'),
    welcome_claims: int(s.welcome_claims, 'tilt.state.welcome_claims'),
    minted_total: amount(s.minted_total, 'tilt.state.minted_total'),
    burned_total: amount(s.burned_total, 'tilt.state.burned_total'),
    today: int(s.today, 'tilt.state.today'),
    last_reported_day: optional(s.last_reported_day, (v) => int(v, 'tilt.state.last_reported_day')),
    streak: int(s.streak, 'tilt.state.streak'),
    longest_streak: int(s.longest_streak, 'tilt.state.longest_streak'),
    longest_streak_day: optional(s.longest_streak_day, (v) => int(v, 'tilt.state.longest_streak_day')),
    tilt_hour: {
      round: int(h.round, 'tilt.state.tilt_hour.round'),
      burned: amount(h.burned, 'tilt.state.tilt_hour.burned'),
      burners: int(h.burners, 'tilt.state.tilt_hour.burners'),
      window_end_ns: amount(h.window_end_ns, 'tilt.state.tilt_hour.window_end_ns'),
      triggers: int(h.triggers, 'tilt.state.tilt_hour.triggers'),
      last_started_ns: optional(h.last_started_ns, (v) => amount(v, 'tilt.state.tilt_hour.last_started_ns')),
    },
    log_next_seq: int(s.log_next_seq, 'tilt.state.log_next_seq'),
  }
}

export function parseTiltLog(value: unknown): TiltLogEntry[] {
  return list(value, 'tilt.log').map((entry, i) => {
    const path = `tilt.log[${i}]`
    const e = record(entry, path)
    return {
      seq: int(e.seq, `${path}.seq`),
      kind: oneOf(TILT_LOG_KINDS, e.kind, `${path}.kind`),
      reason: str(e.reason, `${path}.reason`),
      account: optional(e.account, (v) => str(v, `${path}.account`)),
      amount: amount(e.amount, `${path}.amount`),
      day: int(e.day, `${path}.day`),
      timestamp_ns: amount(e.timestamp_ns, `${path}.timestamp_ns`),
    }
  })
}

/** `get_day`: null when the floor has nothing for that day. */
export function parseDay(value: unknown): DayView | null {
  if (value === null) return null
  const d = record(value, 'day')
  return {
    day: int(d.day, 'day.day'),
    closed: d.closed === true,
    players_net: signedAmount(d.players_net, 'day.players_net'),
    wagered: amount(d.wagered, 'day.wagered'),
    players: list(d.players, 'day.players').map((p, i) => {
      const r = record(p, `day.players[${i}]`)
      return {
        account_id: str(r.account_id, `day.players[${i}].account_id`),
        wagered: amount(r.wagered, `day.players[${i}].wagered`),
        net: signedAmount(r.net, `day.players[${i}].net`),
      }
    }),
  }
}

/** `get_floor.tilt_hour_until` (unix seconds); 0 on a floor without Tilt Hour. */
export function parseTiltHourUntil(floor: unknown): number {
  return optional(record(floor, 'floor').tilt_hour_until, (v) => int(v, 'floor.tilt_hour_until')) ?? 0
}

// ---- derived ---------------------------------------------------------------------------------

export const NS_PER_SEC = 1_000_000_000n
export const SECS_PER_DAY = 86_400

export function nsToSecs(value: string): number {
  return Number(BigInt(value) / NS_PER_SEC)
}

/** The burn window closes at `window_end_ns`; "0" or past = no window open (the next burn opens one). */
export function windowSecsLeft(hour: TiltHourProgress, now: number): number {
  return Math.max(0, nsToSecs(hour.window_end_ns) - now)
}

/** Basis points of the Tilt Hour threshold burned in the open window (0 when none is open), capped at 10 000. */
export function tiltHourProgressBp(hour: TiltHourProgress, threshold: bigint, now: number): number {
  if (threshold <= 0n || windowSecsLeft(hour, now) === 0) return 0
  const bp = (BigInt(hour.burned) * 10_000n) / threshold
  return Number(bp > 10_000n ? 10_000n : bp)
}

/** UTC day index → "2026-11-13". */
export function dayLabel(day: number): string {
  return new Date(day * SECS_PER_DAY * 1000).toISOString().slice(0, 10)
}

/** A param read as base units, or null if absent / not an amount. */
export function paramAmount(params: Record<string, TiltParam>, key: string): bigint | null {
  const v = params[key]
  return typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null
}

/** A param read as an integer (bp, counts, seconds), or null. */
export function paramInt(params: Record<string, TiltParam>, key: string): number | null {
  const v = params[key]
  if (typeof v === 'number') return v
  return typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null
}

/** What each launch parameter means, for the page; unknown keys show under their raw name. */
export const PARAM_LABELS: Record<string, string> = {
  floor: 'the only floor allowed to report a day',
  welcome_operator: 'the only account that hands out the welcome',
  house_receiver: 'received the house allocation (TILT floor dealers)',
  launch_day: 'launch day (UTC)',
  treasury_initial: 'treasury at launch',
  house_allocation: 'house allocation',
  welcome_pool: 'welcome pool',
  welcome_amount: 'welcome per account (once)',
  welcome_daily_claims: 'welcome claims per day',
  mint_rate_bp: 'mint per chip wagered on a winning day',
  streak_bonus_bp: 'streak bonus per day',
  streak_bonus_max_days: 'streak bonus stops growing after (days)',
  player_day_cap: 'mint cap per player per day',
  day_cap: 'mint cap per day',
  burn_bp: 'treasury burned on a house day',
  max_players: 'players paid per day (largest wagerers)',
  tilt_hour_amount: 'Tilt Hour: total burn needed',
  tilt_hour_min_burners: 'Tilt Hour: distinct burners needed',
  tilt_hour_min_burn: 'Tilt Hour: smallest burn that counts',
  tilt_hour_window_secs: 'Tilt Hour: burn window',
  log_capacity: 'mint/burn log entries kept on chain',
}

const ACCOUNT_PARAMS = new Set(['floor', 'welcome_operator', 'house_receiver'])
const AMOUNT_PARAMS = new Set([
  'treasury_initial',
  'house_allocation',
  'welcome_pool',
  'welcome_amount',
  'player_day_cap',
  'day_cap',
  'tilt_hour_amount',
  'tilt_hour_min_burn',
])

/** A launch parameter as the page shows it: TILT amounts, %, durations, days, accounts. */
export function formatParam(key: string, value: TiltParam): string {
  if (value === null) return '—'
  if (ACCOUNT_PARAMS.has(key)) return String(value)
  if (key.endsWith('_bp')) return formatBp(Number(value))
  if (key.endsWith('_secs')) {
    const secs = Number(value)
    return secs % 60 === 0 ? `${secs / 60} min` : `${secs} s`
  }
  if (key.endsWith('_day')) return dayLabel(Number(value))
  if (AMOUNT_PARAMS.has(key) && typeof value === 'string' && /^\d+$/.test(value)) return formatAmount(value, 'TILT')
  return String(value)
}

// ---- RPC -------------------------------------------------------------------------------------

/** The contract (or account) is not there yet, or lacks the method: show the mock. */
export function isNotDeployed(error: unknown): boolean {
  return error instanceof Error && /MethodNotFound|UNKNOWN_ACCOUNT|does not exist|CodeDoesNotExist|NO_CONTRACT_CODE/.test(error.message)
}

const LOG_LIMIT = 50

export async function getTiltSnapshot(rpcUrl: string, token: string, now = Date.now() / 1000): Promise<TiltSnapshot> {
  let rawState: unknown
  try {
    rawState = await viewCall(rpcUrl, token, 'get_state')
  } catch (error) {
    if (!isNotDeployed(error)) throw error
    return mockTilt(now)
  }
  const state = parseTiltState(rawState)
  const from = Math.max(0, state.log_next_seq - LOG_LIMIT)
  const [params, log] = await Promise.all([
    viewCall(rpcUrl, token, 'get_params'),
    viewCall(rpcUrl, token, 'get_log', { from, limit: LOG_LIMIT }),
  ])
  return { params: parseTiltParams(params), state, log: parseTiltLog(log), mock: false }
}

export async function getFloorDay(rpcUrl: string, usdFloor: string, now = Date.now() / 1000): Promise<FloorDaySnapshot> {
  const [floor, day] = await Promise.all([
    viewCall(rpcUrl, usdFloor, 'get_floor'),
    viewCall(rpcUrl, usdFloor, 'get_day', { day: null }).catch((error: unknown) => {
      if (isNotDeployed(error)) return undefined
      throw error
    }),
  ])
  if (day === undefined) return { ...mockFloorDay(now), tiltHourUntil: parseTiltHourUntil(floor) }
  return { today: parseDay(day), tiltHourUntil: parseTiltHourUntil(floor), mock: false }
}

/** Just the Tilt Hour end of the USD floor (lobby banner). */
export async function getTiltHourUntil(rpcUrl: string, usdFloor: string): Promise<number> {
  return parseTiltHourUntil(await viewCall(rpcUrl, usdFloor, 'get_floor'))
}

// ---- mock ------------------------------------------------------------------------------------

const UNIT = 1_000_000n
const tilt = (whole: number) => (BigInt(whole) * UNIT).toString()

/** Launch parameters as docs/tilt.md lists them, with plausible values; shown only while undeployed. */
export const MOCK_PARAMS: Record<string, TiltParam> = {
  floor: 'floor.tilthouse.testnet',
  welcome_operator: 'relayer.tilthouse.testnet',
  house_receiver: 'floor-tilt.tilthouse.testnet',
  launch_day: 20_405,
  treasury_initial: tilt(600_000_000),
  house_allocation: tilt(200_000_000),
  welcome_pool: tilt(200_000_000),
  welcome_amount: tilt(1_000),
  welcome_daily_claims: 500,
  mint_rate_bp: 1_000,
  streak_bonus_bp: 1_000,
  streak_bonus_max_days: 7,
  player_day_cap: tilt(50_000),
  day_cap: tilt(1_000_000),
  burn_bp: 100,
  max_players: 50,
  tilt_hour_amount: tilt(10_000),
  tilt_hour_min_burners: 5,
  tilt_hour_min_burn: tilt(10),
  tilt_hour_window_secs: 3_600,
  log_capacity: 256,
}

export function mockTilt(now: number): TiltSnapshot {
  const today = Math.floor(now / SECS_PER_DAY)
  const at = (secsAgo: number) => (BigInt(Math.floor(now) - secsAgo) * NS_PER_SEC).toString()
  const log: TiltLogEntry[] = [
    { seq: 0, kind: 'mint', reason: 'launch', account: null, amount: tilt(1_000_000_000), day: today - 3, timestamp_ns: at(3 * SECS_PER_DAY) },
    { seq: 1, kind: 'mint', reason: 'welcome', account: 'alice.testnet', amount: tilt(1_000), day: today - 2, timestamp_ns: at(2 * SECS_PER_DAY) },
    { seq: 2, kind: 'mint', reason: 'daily', account: 'alice.testnet', amount: tilt(4_200), day: today - 2, timestamp_ns: at(2 * SECS_PER_DAY - 600) },
    { seq: 3, kind: 'streak', reason: 'grow', account: null, amount: '1', day: today - 2, timestamp_ns: at(2 * SECS_PER_DAY - 600) },
    { seq: 4, kind: 'burn', reason: 'daily', account: null, amount: tilt(6_000_000), day: today - 1, timestamp_ns: at(SECS_PER_DAY - 600) },
    { seq: 5, kind: 'streak', reason: 'reset', account: null, amount: '0', day: today - 1, timestamp_ns: at(SECS_PER_DAY - 600) },
    { seq: 6, kind: 'burn', reason: 'tilt_hour', account: 'bob.testnet', amount: tilt(500), day: today, timestamp_ns: at(1_200) },
  ]
  return {
    params: MOCK_PARAMS,
    state: {
      total_supply: tilt(993_996_700),
      treasury: tilt(594_000_000),
      circulating: tilt(5_200),
      welcome_remaining: tilt(199_999_000),
      welcome_claims: 1,
      minted_total: tilt(1_000_005_200),
      burned_total: tilt(6_000_500),
      today,
      last_reported_day: today - 1,
      streak: 0,
      longest_streak: 1,
      longest_streak_day: today - 2,
      tilt_hour: {
        round: 0,
        burned: tilt(500),
        burners: 1,
        window_end_ns: at(-2_400),
        triggers: 0,
        last_started_ns: null,
      },
      log_next_seq: log.length,
    },
    log,
    mock: true,
  }
}

export function mockFloorDay(now: number): FloorDaySnapshot {
  return {
    today: {
      day: Math.floor(now / SECS_PER_DAY),
      closed: false,
      players_net: '-3250000',
      wagered: tilt(84),
      players: [
        { account_id: 'alice.testnet', wagered: tilt(60), net: '-5000000' },
        { account_id: 'bob.testnet', wagered: tilt(24), net: '1750000' },
      ],
    },
    tiltHourUntil: 0,
    mock: true,
  }
}

// ---- 60-day simulation (web/public/tilt-sim.json, written by the sim's meme mode) -----------

export interface TiltSimDay {
  day: number
  supply: string
  treasury: string
  minted: string
  burned: string
  streak: number
  /** Signed, tUSDC base units: the players' result against the USD floor that day. */
  players_net: string
  tilt_hours: number
}

export interface TiltSimScenario {
  id: string
  description: string
  series: TiltSimDay[]
}

export interface TiltSim {
  days: number
  scenarios: TiltSimScenario[]
}

export function parseTiltSim(value: unknown): TiltSim {
  const sim = record(value, 'tilt-sim')
  const scenarios = Object.entries(record(sim.scenarios, 'tilt-sim.scenarios')).map(([id, raw]) => {
    const path = `tilt-sim.scenarios.${id}`
    const s = record(raw, path)
    return {
      id,
      description: str(s.description, `${path}.description`),
      series: list(s.series, `${path}.series`).map((entry, i) => {
        const p = `${path}.series[${i}]`
        const d = record(entry, p)
        return {
          day: int(d.day, `${p}.day`),
          supply: amount(d.supply, `${p}.supply`),
          treasury: amount(d.treasury, `${p}.treasury`),
          minted: amount(d.minted, `${p}.minted`),
          burned: amount(d.burned, `${p}.burned`),
          streak: int(d.streak, `${p}.streak`),
          players_net: signedAmount(d.players_net, `${p}.players_net`),
          tilt_hours: int(d.tilt_hours, `${p}.tilt_hours`),
        }
      }),
    }
  })
  if (scenarios.length === 0) fail('tilt-sim.scenarios', 'at least one scenario')
  return { days: int(sim.days, 'tilt-sim.days'), scenarios }
}

/** Null while the sim has not written the file yet (404 or the SPA fallback page). */
export async function loadTiltSim(): Promise<TiltSim | null> {
  const response = await fetch('/tilt-sim.json')
  if (!response.ok || !response.headers.get('content-type')?.includes('json')) return null
  return parseTiltSim(await response.json())
}
