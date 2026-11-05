/**
 * The fast-forward data (`/sim.json`, written by `cargo run -p tilt-house-sim`) and the pure
 * logic of its frame player. One frame = 10 simulated minutes.
 */

const EVENT_KINDS = [
  'bust',
  'reopen',
  'boost',
  'reprice',
  'seated',
  'evicted',
  'seat_listed',
  'seat_sold',
  'opened',
  'jackpot',
  'price_war',
  'rent',
] as const
export type SimEventKind = (typeof EVENT_KINDS)[number]

export interface SimDealer {
  id: string
  name: string
  game: string
  temperament: string
}

export interface SimDealerFrame {
  id: string
  bankroll: string
  /** Millionths of the launch price. */
  share_price: string
  rake_bp: number
  max_bet: string
  boost: boolean
  open: boolean
  reason: string
}

export interface SimEvent {
  t: number
  dealer: string
  kind: SimEventKind
  text: string
}

export interface SimFrame {
  t: number
  dealers: SimDealerFrame[]
  events: SimEvent[]
}

export interface SimData {
  seed: number
  days: number
  dealers: SimDealer[]
  frames: SimFrame[]
}

/** At 1× the whole run plays in about a minute, whatever its length. */
export const RUN_SECONDS_AT_1X = 60

type Json = Record<string, unknown>

function record(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`sim.json: ${path} should be an object`)
  return value as Json
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`sim.json: ${path} should be an array`)
  return value
}

function field<T>(value: unknown, path: string, check: (v: unknown) => v is T, expected: string): T {
  if (!check(value)) throw new Error(`sim.json: ${path} should be ${expected}`)
  return value
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isAmount = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v)
const isKind = (v: unknown): v is SimEventKind => EVENT_KINDS.some((k) => k === v)

function parseDealerFrame(value: unknown, path: string): SimDealerFrame {
  const d = record(value, path)
  return {
    id: field(d.id, `${path}.id`, isString, 'a string'),
    bankroll: field(d.bankroll, `${path}.bankroll`, isAmount, 'a decimal string'),
    share_price: field(d.share_price, `${path}.share_price`, isAmount, 'a decimal string'),
    rake_bp: field(d.rake_bp, `${path}.rake_bp`, isNumber, 'a number'),
    max_bet: field(d.max_bet, `${path}.max_bet`, isAmount, 'a decimal string'),
    boost: field(d.boost, `${path}.boost`, isBool, 'a boolean'),
    open: field(d.open, `${path}.open`, isBool, 'a boolean'),
    reason: field(d.reason, `${path}.reason`, isString, 'a string'),
  }
}

function parseEvent(value: unknown, path: string, frameT: number): SimEvent {
  const e = record(value, path)
  return {
    t: e.t === undefined ? frameT : field(e.t, `${path}.t`, isNumber, 'a number'),
    dealer: field(e.dealer, `${path}.dealer`, isString, 'a string'),
    kind: field(e.kind, `${path}.kind`, isKind, EVENT_KINDS.join('|')),
    text: field(e.text, `${path}.text`, isString, 'a string'),
  }
}

export function parseSim(value: unknown): SimData {
  const root = record(value, 'root')
  const dealers = list(root.dealers, 'dealers').map((entry, i) => {
    const d = record(entry, `dealers[${i}]`)
    return {
      id: field(d.id, `dealers[${i}].id`, isString, 'a string'),
      name: field(d.name, `dealers[${i}].name`, isString, 'a string'),
      game: field(d.game, `dealers[${i}].game`, isString, 'a string'),
      temperament: field(d.temperament, `dealers[${i}].temperament`, isString, 'a string'),
    }
  })
  const frames = list(root.frames, 'frames').map((entry, i) => {
    const f = record(entry, `frames[${i}]`)
    const t = field(f.t, `frames[${i}].t`, isNumber, 'a number')
    return {
      t,
      dealers: list(f.dealers, `frames[${i}].dealers`).map((d, j) => parseDealerFrame(d, `frames[${i}].dealers[${j}]`)),
      events: list(f.events, `frames[${i}].events`).map((e, j) => parseEvent(e, `frames[${i}].events[${j}]`, t)),
    }
  })
  if (frames.length === 0) throw new Error('sim.json: no frames')
  return {
    seed: field(root.seed, 'seed', isNumber, 'a number'),
    days: field(root.days, 'days', isNumber, 'a number'),
    dealers,
    frames,
  }
}

/**
 * Advances the play head. `position` is a fractional frame index so slow speeds still move
 * smoothly; it stops on the last frame and reports `ended`.
 */
export function advance(
  position: number,
  elapsedMs: number,
  speed: number,
  frameCount: number,
): { position: number; ended: boolean } {
  const last = frameCount - 1
  const framesPerMs = frameCount / (RUN_SECONDS_AT_1X * 1000)
  const next = position + elapsedMs * framesPerMs * speed
  return next >= last ? { position: last, ended: true } : { position: Math.max(0, next), ended: false }
}

/** One numeric series per dealer across all frames (for charts). */
export function dealerSeries(sim: SimData, pick: (frame: SimDealerFrame) => number): Map<string, number[]> {
  const series = new Map<string, number[]>(sim.dealers.map((d) => [d.id, []]))
  for (const frame of sim.frames) {
    for (const dealer of frame.dealers) series.get(dealer.id)?.push(pick(dealer))
  }
  return series
}

/** Notable events (no plain reprices) up to and including `frameIndex`, newest first. */
export function eventsUpTo(sim: SimData, frameIndex: number, kinds: readonly SimEventKind[]): SimEvent[] {
  const events: SimEvent[] = []
  for (const frame of sim.frames.slice(0, frameIndex + 1)) {
    for (const event of frame.events) if (kinds.includes(event.kind)) events.push(event)
  }
  return events.reverse()
}
