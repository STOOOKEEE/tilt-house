// NPC gamblers on the lobby floor (docs/tycoon.md): smaller figures in their persona's colors walk
// in from the entrance on seat 1's side, along the front of the row, stop in front of a table with
// their reason in a bubble, sit on one of its stools facing the dealer, then stand up and leave.
// Each gambler plays its cues one after the other, so a burst of data never makes anyone teleport.
import * as THREE from 'three'
import type { GamblerCue, Persona } from '../../sim/gamblers'
import { buildStool, createCharacter, type WalkerRig } from '../characters'
import type { Animator } from '../table/props'
import type { DealerLook } from '../types'
import { LOBBY_TABLE_D } from './props'
import { turnTo, walkTo } from './walk'

export interface Crowd {
  cue(cue: GamblerCue): void
  /** Gamblers seated at this seat's stools, to react to the dealer's draws. */
  seatedAt(seat: number): WalkerRig[]
  update(dt: number): void
  dispose(): void
}

/** Gamblers are smaller than dealers: customers, not staff. */
const GAMBLER_SCALE = 0.62
const WALK_SPEED = 2.2
const STOOLS_X = [-0.75, 0, 0.75]
const STOOL_Z = LOBBY_TABLE_D / 2 + 0.38
/** Where a gambler stops to look at the table, in front of its stool. */
const LOOK_Z = STOOL_Z + 0.7
/** The walkway in front of the row, in seat space. */
const AISLE_Z = LOBBY_TABLE_D / 2 + 1.7
const ENTRANCE_X = -12
/** Each gambler keeps its own lane on the walkway, so a group does not walk as one blob. */
const LANES = 5
const LANE_WIDTH = 0.22
const THINK_S = 1.6
/** The reason stays up a little after sitting, then the bubble clears for the game. */
const SAY_AFTER_SIT_S = 2.5

const PERSONA_COLORS: Record<Persona, { vest: string; accent: string; hat: DealerLook['hat'] }> = {
  bargain_hunter: { vest: '#3f7a52', accent: '#7ccf8f', hat: 'beanie' },
  regular: { vest: '#2f5d8a', accent: '#6fa8ec', hat: 'none' },
  whale: { vest: '#1a1a22', accent: '#f0c26a', hat: 'top_hat' },
  thrill_seeker: { vest: '#a8306f', accent: '#ec6fae', hat: 'visor' },
  tourist: { vest: '#c8692c', accent: '#f0915f', hat: 'visor' },
}
const SKINS = ['#f3c9a6', '#e8b48a', '#c98f66', '#a8714a', '#7a4a2e', '#d9a17a']
const HAIRS = ['#2b1d14', '#1a1210', '#b8662f', '#8a8a8a', '#e0c070', '#3a2a1e']
const SHIRTS = ['#f2efe6', '#fff6d8', '#e2e8e2', '#f6e0e6']

/** A stable small number from an id: the same gambler always looks the same. */
function idHash(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return h >>> 0
}

export function gamblerLook(id: string, persona: Persona): DealerLook {
  const h = idHash(id)
  const colors = PERSONA_COLORS[persona]
  return {
    skin: SKINS[h % SKINS.length],
    hair: HAIRS[(h >>> 4) % HAIRS.length],
    shirt: SHIRTS[(h >>> 8) % SHIRTS.length],
    vest: colors.vest,
    hat: colors.hat,
    accent: colors.accent,
  }
}

interface Gambler {
  id: string
  rig: WalkerRig
  /** Seat whose aisle point the gambler is at (or walking from); -1 = at the entrance. */
  at: number
  stool: { seat: number; index: number } | null
  seated: boolean
  chain: Promise<void>
  gone: boolean
}

export function createCrowd(scene: THREE.Scene, seats: readonly THREE.Object3D[], anim: Animator): Crowd {
  const gamblers = new Map<string, Gambler>()
  /** Who sits (or is about to) on each stool, per seat. */
  const taken: (string | null)[][] = seats.map(() => STOOLS_X.map(() => null))
  let disposed = false

  for (const seat of seats) {
    for (const x of STOOLS_X) {
      const stool = buildStool()
      stool.scale.setScalar(GAMBLER_SCALE)
      stool.position.set(x, 0, STOOL_Z)
      seat.add(stool)
    }
  }

  /** A point given in a seat's own space, in world space (gamblers walk in world space). */
  const world = (seat: number, x: number, z: number): THREE.Vector3 => {
    const group = seats[seat]
    group.updateWorldMatrix(true, false)
    const p = group.localToWorld(new THREE.Vector3(x, 0, z))
    p.y = 0
    return p
  }
  const lane = (id: string): number => ((idHash(id) % LANES) - (LANES - 1) / 2) * LANE_WIDTH
  const aisle = (seat: number, id: string): THREE.Vector3 => world(seat, 0, AISLE_Z + lane(id))
  const entrance = (id: string): THREE.Vector3 => {
    const first = aisle(0, id)
    return new THREE.Vector3(ENTRANCE_X, 0, first.z + 0.6)
  }

  /** Along the walkway from one aisle point to another, past every table in between. */
  const walkAisle = async (g: Gambler, to: number): Promise<void> => {
    const step = to > g.at ? 1 : -1
    for (let s = g.at + step; step > 0 ? s <= to : s >= to; s += step) {
      await walkTo(anim, g.rig, s < 0 ? entrance(g.id) : aisle(s, g.id), WALK_SPEED)
      g.at = s
    }
  }

  const freeStool = (g: Gambler, seat: number): void => {
    if (g.stool?.seat === seat) return
    releaseStool(g)
    const index = taken[seat].indexOf(null)
    if (index < 0) return
    taken[seat][index] = g.id
    g.stool = { seat, index }
  }

  const releaseStool = (g: Gambler): void => {
    if (g.stool) taken[g.stool.seat][g.stool.index] = null
    g.stool = null
  }

  const standUp = async (g: Gambler): Promise<void> => {
    if (!g.seated) return
    g.seated = false
    await g.rig.setStanding(true)
    if (g.stool) await walkTo(anim, g.rig, world(g.stool.seat, STOOLS_X[g.stool.index], LOOK_Z), WALK_SPEED)
  }

  const goTo = async (g: Gambler, seat: number): Promise<void> => {
    if (g.stool && g.stool.seat !== seat) {
      await standUp(g)
      releaseStool(g)
    }
    if (g.at !== seat) {
      await walkTo(anim, g.rig, g.at < 0 ? entrance(g.id) : aisle(g.at, g.id), WALK_SPEED)
      await walkAisle(g, seat)
    }
    freeStool(g, seat)
    const x = g.stool ? STOOLS_X[g.stool.index] : 0
    await walkTo(anim, g.rig, world(seat, x, LOOK_Z), WALK_SPEED)
    await turnTo(anim, g.rig.figure, faceTable(seat, g.rig.figure.position))
  }

  const faceTable = (seat: number, from: THREE.Vector3): number => {
    const table = world(seat, 0, 0)
    return Math.atan2(table.x - from.x, table.z - from.z)
  }

  const play = async (g: Gambler, cue: GamblerCue): Promise<void> => {
    switch (cue.kind) {
      case 'enter':
        await g.rig.setStanding(true)
        await walkTo(anim, g.rig, aisle(0, g.id), WALK_SPEED)
        g.at = 0
        return
      case 'consider':
        if (cue.seat === null) return
        await goTo(g, cue.seat)
        g.rig.say(cue.reason)
        await anim.wait(THINK_S)
        return
      case 'sit': {
        if (cue.seat === null) return
        if (g.seated && g.stool?.seat === cue.seat) return
        await goTo(g, cue.seat)
        g.rig.say(cue.reason)
        if (!g.stool) return // the table is full: it watches, standing
        const stool = world(cue.seat, STOOLS_X[g.stool.index], STOOL_Z)
        await walkTo(anim, g.rig, stool, WALK_SPEED)
        await turnTo(anim, g.rig.figure, faceTable(cue.seat, stool))
        await g.rig.setStanding(false)
        g.seated = true
        await anim.wait(SAY_AFTER_SIT_S)
        g.rig.say(null)
        return
      }
      case 'leave':
        g.rig.say(cue.reason)
        await standUp(g)
        releaseStool(g)
        if (g.at >= 0) {
          await walkTo(anim, g.rig, aisle(g.at, g.id), WALK_SPEED)
          await walkAisle(g, -1)
        }
        g.gone = true
        gamblers.delete(cue.id)
        g.rig.dispose()
    }
  }

  const spawn = (cue: GamblerCue): Gambler => {
    const rig = createCharacter(gamblerLook(cue.id, cue.persona), cue.id, { stool: false })
    rig.figure.scale.setScalar(GAMBLER_SCALE)
    rig.figure.position.copy(entrance(cue.id))
    scene.add(rig.object)
    const g: Gambler = { id: cue.id, rig, at: -1, stool: null, seated: false, chain: Promise.resolve(), gone: false }
    gamblers.set(cue.id, g)
    return g
  }

  return {
    cue(cue) {
      if (disposed) return
      const known = gamblers.get(cue.id)
      // A gambler first seen mid-session still walks in from the door.
      if (!known && cue.kind === 'leave') return
      const g = known ?? spawn(cue)
      if (!known && cue.kind !== 'enter') g.chain = g.chain.then(() => play(g, { ...cue, kind: 'enter' }))
      g.chain = g.chain.then(() => (disposed || g.gone ? undefined : play(g, cue)))
    },
    seatedAt(seat) {
      return [...gamblers.values()].filter((g) => g.seated && g.stool?.seat === seat).map((g) => g.rig)
    },
    update(dt) {
      for (const g of gamblers.values()) g.rig.update(dt)
    },
    dispose() {
      disposed = true
      for (const g of gamblers.values()) g.rig.dispose()
      gamblers.clear()
    },
  }
}
