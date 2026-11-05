/**
 * NPC gamblers (docs/tycoon.md) as the floor shows them: who is walking in, deciding in front of
 * a table, seated, or leaving, with the one-line reason of their choice. The same snapshot shape
 * comes from the simulator (`sim.json` `gamblers` + per-frame `gamblers`) and from the live
 * gambler runner, so the 3D floor and the dashboard do not care which one feeds them.
 */
import { amount, bool, fail, int, list, oneOf, optional, record, str } from '../near/views'

export const PERSONAS = ['bargain_hunter', 'regular', 'whale', 'thrill_seeker', 'tourist'] as const
export type Persona = (typeof PERSONAS)[number]

export const GAMBLER_STATES = ['walking', 'deciding', 'seated', 'leaving'] as const
export type GamblerState = (typeof GAMBLER_STATES)[number]

export interface GamblerInfo {
  id: string
  name: string
  persona: Persona
}

/** One gambler on the floor at one instant; gamblers off the floor are absent. */
export interface GamblerSnapshot {
  id: string
  /** Live feed only; sim frames take name and persona from the top-level list. */
  name: string | null
  persona: Persona | null
  state: GamblerState
  dealer_id: string | null
  /** 0-based seat of `dealer_id`, null when not at a table. */
  seat: number | null
  reason_code: string | null
  reason: string | null
  balance: string
  /** Signed decimal string: the session's result so far. */
  session_net: string
}

export interface GamblerFrame {
  /** Seconds since the start of the run. */
  t: number
  gamblers: GamblerSnapshot[]
}

export interface GamblerTimeline {
  gamblers: GamblerInfo[]
  frames: GamblerFrame[]
}

const SIGNED = /^-?\d+$/

function parseSnapshot(value: unknown, path: string): GamblerSnapshot {
  const g = record(value, path)
  const net = str(g.session_net ?? '0', `${path}.session_net`)
  return {
    id: str(g.id, `${path}.id`),
    name: optional(g.name, (v) => str(v, `${path}.name`)),
    persona: optional(g.persona, (v) => oneOf(PERSONAS, v, `${path}.persona`)),
    state: oneOf(GAMBLER_STATES, g.state, `${path}.state`),
    dealer_id: optional(g.dealer_id, (v) => str(v, `${path}.dealer_id`)),
    seat: optional(g.seat, (v) => int(v, `${path}.seat`)),
    reason_code: optional(g.reason_code, (v) => str(v, `${path}.reason_code`)),
    reason: optional(g.reason, (v) => str(v, `${path}.reason`)),
    balance: amount(g.balance, `${path}.balance`),
    session_net: SIGNED.test(net) ? net : '0',
  }
}

export function parseGamblerList(value: unknown, path = 'gamblers'): GamblerSnapshot[] {
  return list(value, path).map((g, i) => parseSnapshot(g, `${path}[${i}]`))
}

/** The gambler part of sim.json; null when the file predates gamblers. */
export function parseGamblerTimeline(value: unknown): GamblerTimeline | null {
  const root = record(value, 'sim')
  if (root.gamblers === undefined) return null
  const gamblers = list(root.gamblers, 'sim.gamblers').map((entry, i) => {
    const g = record(entry, `sim.gamblers[${i}]`)
    return {
      id: str(g.id, `sim.gamblers[${i}].id`),
      name: str(g.name, `sim.gamblers[${i}].name`),
      persona: oneOf(PERSONAS, g.persona, `sim.gamblers[${i}].persona`),
    }
  })
  const frames = list(root.frames, 'sim.frames').map((entry, i) => {
    const f = record(entry, `sim.frames[${i}]`)
    return { t: int(f.t, `sim.frames[${i}].t`), gamblers: parseGamblerList(f.gamblers ?? [], `sim.frames[${i}].gamblers`) }
  })
  return { gamblers, frames }
}

/** What happens to one gambler between two snapshots: the floor turns these into animations. */
export type GamblerMove =
  | { kind: 'enter'; id: string }
  | { kind: 'consider'; id: string; dealer_id: string; reason: string | null }
  | { kind: 'sit'; id: string; dealer_id: string; reason: string | null }
  | { kind: 'leave'; id: string; reason: string | null; net: string }

/**
 * The moves that bring the floor from `before` to `after`, in an order that animates well:
 * arrivals first, then choices, then departures. A gambler that skipped steps between two
 * frames (10 sim minutes apart) still gets every step it needs, so nobody teleports onto a stool.
 */
export function diffGamblers(before: readonly GamblerSnapshot[], after: readonly GamblerSnapshot[]): GamblerMove[] {
  const was = new Map(before.map((g) => [g.id, g]))
  const now = new Map(after.map((g) => [g.id, g]))
  const moves: GamblerMove[] = []
  for (const g of after) {
    const prev = was.get(g.id)
    if (!prev) moves.push({ kind: 'enter', id: g.id })
    const table = g.dealer_id
    const sameTable = prev !== undefined && prev.dealer_id === table
    if (g.state === 'leaving') {
      if (prev?.state !== 'leaving') moves.push({ kind: 'leave', id: g.id, reason: g.reason, net: g.session_net })
    } else if (table !== null && g.state === 'seated' && !(sameTable && prev.state === 'seated')) {
      if (!sameTable) moves.push({ kind: 'consider', id: g.id, dealer_id: table, reason: g.reason })
      moves.push({ kind: 'sit', id: g.id, dealer_id: table, reason: g.reason })
    } else if (table !== null && g.state === 'deciding' && !(sameTable && prev.state === 'deciding')) {
      moves.push({ kind: 'consider', id: g.id, dealer_id: table, reason: g.reason })
    }
  }
  for (const g of before) {
    if (!now.has(g.id) && g.state !== 'leaving') moves.push({ kind: 'leave', id: g.id, reason: g.reason, net: g.session_net })
  }
  return moves
}

/** A move ready for the 3D floor: who it is, and which seat (0-based) the table sits at. */
export interface GamblerCue {
  kind: GamblerMove['kind']
  id: string
  name: string
  persona: Persona
  seat: number | null
  reason: string | null
}

/**
 * Resolves moves to seats on the floor being shown: by table id first, else (demo floor, whose
 * tables may differ from the simulated week's) by the snapshot's seat if a table sits there.
 * A move toward no table on this floor is dropped; the gambler then just walks in or out.
 */
export function toCues(
  moves: readonly GamblerMove[],
  after: readonly GamblerSnapshot[],
  info: ReadonlyMap<string, GamblerInfo>,
  seatedIds: readonly (string | null)[],
): GamblerCue[] {
  const now = new Map(after.map((g) => [g.id, g]))
  const cues: GamblerCue[] = []
  for (const move of moves) {
    const snapshot = now.get(move.id)
    const known = info.get(move.id)
    const who = {
      id: move.id,
      name: snapshot?.name ?? known?.name ?? move.id,
      persona: snapshot?.persona ?? known?.persona ?? 'tourist',
    }
    if (move.kind === 'enter' || move.kind === 'leave') {
      cues.push({ ...who, kind: move.kind, seat: null, reason: move.kind === 'leave' ? move.reason : null })
      continue
    }
    const byTable = seatedIds.indexOf(move.dealer_id)
    const bySeat = snapshot?.seat ?? null
    const seat = byTable >= 0 ? byTable : bySeat !== null && seatedIds[bySeat] ? bySeat : null
    if (seat !== null) cues.push({ ...who, kind: move.kind, seat, reason: move.reason })
  }
  return cues
}

export interface Footfall {
  /** Distinct gamblers who stopped in front of the table and went elsewhere. */
  passed: number
  /** Distinct gamblers who sat at the table. */
  sat: number
}

/** Footfall of one table over the frames with `from <= t <= to`. */
export function footfall(frames: readonly GamblerFrame[], dealerId: string, from: number, to: number): Footfall {
  const looked = new Set<string>()
  const sat = new Set<string>()
  for (const frame of frames) {
    if (frame.t < from || frame.t > to) continue
    for (const g of frame.gamblers) {
      if (g.dealer_id !== dealerId) continue
      if (g.state === 'seated') sat.add(g.id)
      else if (g.state === 'deciding') looked.add(g.id)
    }
  }
  const passed = [...looked].filter((id) => !sat.has(id)).length
  return { passed, sat: sat.size }
}

// ---- live feed (docs/gamblers-api.md) -----------------------------------------------------

export interface Arrival {
  persona: Persona
  score: number
  chose: boolean
  reason: string
}

export interface FootfallReply {
  dealer_id: string
  passed_1h: number
  sat_1h: number
  arrivals_1h: Arrival[]
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

export async function getLiveFloor(baseUrl: string): Promise<GamblerSnapshot[]> {
  return parseGamblerList(await getJson(`${baseUrl}/gamblers/floor`), 'floor')
}

export function parseFootfall(value: unknown): FootfallReply {
  const f = record(value, 'footfall')
  return {
    dealer_id: str(f.dealer_id, 'footfall.dealer_id'),
    passed_1h: int(f.passed_1h, 'footfall.passed_1h'),
    sat_1h: int(f.sat_1h, 'footfall.sat_1h'),
    arrivals_1h: list(f.arrivals_1h, 'footfall.arrivals_1h').map((entry, i) => {
      const a = record(entry, `footfall.arrivals_1h[${i}]`)
      if (typeof a.score !== 'number' || !Number.isFinite(a.score)) fail(`footfall.arrivals_1h[${i}].score`, 'a number')
      return {
        persona: oneOf(PERSONAS, a.persona, `footfall.arrivals_1h[${i}].persona`),
        score: a.score,
        chose: bool(a.chose, `footfall.arrivals_1h[${i}].chose`),
        reason: str(a.reason, `footfall.arrivals_1h[${i}].reason`),
      }
    }),
  }
}

export async function getFootfall(baseUrl: string, dealerId: string): Promise<FootfallReply> {
  return parseFootfall(await getJson(`${baseUrl}/gamblers/footfall?dealer_id=${encodeURIComponent(dealerId)}`))
}
