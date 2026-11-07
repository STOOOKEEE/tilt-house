// The casino floor (docs/floor.md): six seats in a gentle arc. A seated dealer plays its game with
// mood and reason from the live lobby; an empty seat hangs a "FOR RENT" sign. When a seat changes
// hands between polls, the old dealer stands up and walks off, the sign drops in, then the new one
// walks in and sits. Hover lights a seat up, click opens its table (or the "open a table" page).
import * as THREE from 'three'
import { formatBp, formatUsdc } from '../../format'
import { SEAT_TRAFFIC_BP, type SeatedTable } from '../../near/floor'
import type { DealerView } from '../../near/views'
import { createCharacter, type WalkerRig } from '../characters'
import { dealerLook } from '../looks'
import { dealerMood } from '../mood'
import { mountRenderer } from '../renderer'
import { Animator, PALETTE, easeOut } from '../table/props'
import type { Mood } from '../types'
import { pixelTexture, px, voxelPart } from '../voxel'
import type { GamblerCue } from '../../sim/gamblers'
import { createCrowd } from './gamblers'
import { turnTo, walkTo } from './walk'
import {
  buildDrapes,
  buildNameplate,
  buildRentSign,
  buildRug,
  buildTableMesh,
  createProp,
  DEALER_Z,
  LOBBY_TABLE_D,
  LOBBY_TABLE_W,
  SIGN_Y,
  type Drapes,
  type LobbyProp,
  type Nameplate,
  type RentSign,
} from './props'

export interface LobbySceneApi {
  /** One entry per seat (null = for rent); `rentFrom` is the rent needed to take a seat, base units. */
  setFloor(seats: readonly (SeatedTable | null)[], rentFrom: string): void
  /** NPC gamblers' next steps; each gambler plays its own in order. */
  cueGamblers(cues: readonly GamblerCue[]): void
  /** The guided tour's camera; null gives the camera back to its idle drift. */
  focus(target: FloorFocus | null): void
  dispose(): void
}

/** What the guided tour points at: the door, one seat (0-based), the seats lit by traffic, the pot. */
export type FloorFocus =
  | { kind: 'overview' }
  | { kind: 'entrance' }
  | { kind: 'seat'; seat: number }
  | { kind: 'traffic' }
  | { kind: 'jackpot' }

export interface LobbySceneEvents {
  onTable(dealerId: string): void
  onEmptySeat(): void
}

const SEAT_COUNT = 6
const SPACING = 3.1
/** z = ARC × x²: outer tables come forward, so the row curves around the viewer. */
const ARC = 0.05
const CAMERA_Z = 9.5
const LOOK_AT = new THREE.Vector3(0, 1.35, 0.6)
/** Half the floor width that must stay in view, beyond the outermost table centers. */
const FRAME_MARGIN = 3.2
const HOVER_LIFT = 0.06
const LAMP_ON = 7
const LAMP_OFF = 1.2
const LAMP_EMPTY = 3
/** A press that moves farther than this (px) is a drag, not a click. */
const CLICK_SLOP = 6
/** Walking: units per second; dealers leave behind the row, toward the nearest side, out of frame. */
const WALK_SPEED = 2.4
const AISLE_BEHIND = 1.2
const EXIT_X = 13
/** Where the sign waits, out of frame above the seat. */
const SIGN_UP_Y = 7
const SIGN_DROP_S = 0.9
const PROP_POP_S = 0.4
/** How fast the camera glides to the tour's next shot (1/s, exponential). */
const CAMERA_EASE = 2.2
/** A seat close-up: this far in front of the table, this high. */
const SEAT_SHOT_DIST = 6.4
const SEAT_SHOT_Y = 2.8
/** The tour card covers the right of the floor: the shot slides right so the table sits left of center. */
const SEAT_SHOT_SHIFT = 1.4
/** The entrance shot: from the front of the row, looking down the walkway toward the door (seat 1's side). */
const ENTRANCE_SHOT = { at: new THREE.Vector3(-2.5, 3, 10), look: new THREE.Vector3(-8, 1.2, 3.4) }
/** The jackpot shot: pulled back over the whole floor, the sign at the top, never above the wall. */
const JACKPOT_SHOT = { at: new THREE.Vector3(0, 3.4, 13), look: new THREE.Vector3(0, 0.8, 0) }
const TRAFFIC_MIN_BP = Math.min(...SEAT_TRAFFIC_BP)
const TRAFFIC_SPAN_BP = Math.max(...SEAT_TRAFFIC_BP) - TRAFFIC_MIN_BP

interface Occupant {
  dealer: DealerView
  rig: WalkerRig
  prop: LobbyProp
  mood: Mood
  /** Seated and playing; false while walking in or out. */
  seated: boolean
}

interface Seat {
  index: number
  group: THREE.Group
  plate: Nameplate
  sign: RentSign
  rug: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  lamp: THREE.PointLight
  drapes: Drapes
  hit: THREE.Mesh
  occupant: Occupant | null
  /** Who the latest poll seats here; animations catch up with it one step at a time. */
  wanted: SeatedTable | null
  busy: boolean
  hover: number
  closed: number
}

export function createLobbyScene(el: HTMLElement, events: LobbySceneEvents): LobbySceneApi {
  const mounted = mountRenderer(el)
  const { scene, camera, renderer } = mounted
  camera.fov = 38
  buildRoom(scene)

  const anim = new Animator()
  const seats = Array.from({ length: SEAT_COUNT }, (_, i) => buildSeat(i))
  for (const seat of seats) scene.add(seat.group)
  const crowd = createCrowd(scene, seats.map((s) => s.group), anim)
  let rentFrom = ''
  let firstFloor = true
  let hovered: Seat | null = null
  let disposed = false
  let focus: FloorFocus | null = null
  /** Where the camera is and looks, eased toward the wanted shot each frame; null before the first frame. */
  let shot: { at: THREE.Vector3; look: THREE.Vector3 } | null = null

  /**
   * Plays the table's game now and then, briskly while gamblers sit there (one of them cheers or
   * despairs at the result); happy dealers sometimes cheer, nervous ones despair.
   */
  const idleLoop = async (seat: Seat, occupant: Occupant): Promise<void> => {
    await anim.wait(0.5 + Math.random() * 3)
    const here = (): boolean => !disposed && seat.occupant === occupant && occupant.seated
    while (here()) {
      const players = crowd.seatedAt(seat.index)
      if (occupant.dealer.open) await occupant.prop.play(occupant.rig, anim)
      if (!here()) break
      const player = players[Math.floor(Math.random() * players.length)]
      if (player) void player.gesture({ kind: Math.random() < 0.45 ? 'celebrate' : 'facepalm' })
      if (occupant.mood === 'happy' && Math.random() < 0.3) await occupant.rig.gesture({ kind: 'celebrate' })
      if (occupant.mood === 'nervous' && Math.random() < 0.3) await occupant.rig.gesture({ kind: 'facepalm' })
      await anim.wait(players.length > 0 ? 0.6 + Math.random() * 1.2 : 2 + Math.random() * 3)
    }
  }

  const seatOccupant = (seat: Seat, table: SeatedTable): Occupant => {
    const look = dealerLook(table.dealer.id, table.look, table.dealer.temperament)
    const rig = createCharacter(look, table.dealer.name)
    rig.object.position.z = DEALER_Z
    const prop = createProp(table.dealer.game)
    seat.group.add(rig.object, prop.object)
    seat.rug.material.color.set(look.accent)
    const occupant: Occupant = { dealer: table.dealer, rig, prop, mood: 'neutral', seated: false }
    seat.occupant = occupant
    applyTable(seat, table)
    return occupant
  }

  const showEmpty = (seat: Seat): void => {
    seat.plate.set({ kind: 'empty', seat: seat.index + 1, from: rentFrom })
    seat.sign.set(rentFrom)
    seat.rug.material.color.set(PALETTE.gold)
  }

  // ---- walking --------------------------------------------------------------------------------

  const walk = (rig: WalkerRig, to: THREE.Vector3): Promise<void> => walkTo(anim, rig, to, WALK_SPEED)

  /** The aisle behind the seat and the exit beside the floor, in the rig's own space. */
  const pathOut = (seat: Seat, rig: WalkerRig): [THREE.Vector3, THREE.Vector3] => {
    seat.group.updateWorldMatrix(true, true)
    const chair = rig.object.getWorldPosition(new THREE.Vector3())
    const side = chair.x >= 0 ? 1 : -1
    const aisle = new THREE.Vector3(chair.x, 0, chair.z - AISLE_BEHIND)
    const exit = new THREE.Vector3(side * EXIT_X, 0, aisle.z)
    return [rig.object.worldToLocal(aisle), rig.object.worldToLocal(exit)]
  }

  const dropSign = (seat: Seat, down: boolean): Promise<void> => {
    const sign = seat.sign.object
    const from = sign.position.y
    const to = down ? SIGN_Y : SIGN_UP_Y
    sign.visible = true
    return anim
      .tween(SIGN_DROP_S, (t) => {
        sign.position.y = from + (to - from) * t
      }, down ? easeOutBack : easeOut)
      .then(() => {
        sign.visible = down
      })
  }

  const popProp = (prop: LobbyProp, show: boolean): Promise<void> =>
    anim.tween(PROP_POP_S, (t) => prop.object.scale.setScalar(show ? t : 1 - t))

  /** Stand up, walk off the floor; the sign drops in once the seat is clear. */
  const evict = async (seat: Seat, occupant: Occupant): Promise<void> => {
    occupant.seated = false
    occupant.rig.say('lost my seat')
    const [aisle, exit] = pathOut(seat, occupant.rig)
    await Promise.all([occupant.rig.setStanding(true), popProp(occupant.prop, false)])
    await walk(occupant.rig, aisle)
    showEmpty(seat)
    await Promise.all([dropSign(seat, true), walk(occupant.rig, exit)])
    seat.occupant = null
    occupant.rig.dispose()
    occupant.prop.object.removeFromParent()
  }

  /** Walk in from the side, the sign lifts, sit down, then start playing. */
  const arrive = async (seat: Seat, table: SeatedTable): Promise<void> => {
    const occupant = seatOccupant(seat, table)
    const { rig, prop } = occupant
    prop.object.scale.setScalar(0)
    rig.say('took this seat')
    const [aisle, entrance] = pathOut(seat, rig)
    rig.figure.position.copy(entrance)
    await rig.setStanding(true)
    await walk(rig, aisle)
    await Promise.all([dropSign(seat, false), walk(rig, new THREE.Vector3(0, 0, 0))])
    await turnTo(anim, rig.figure, 0)
    await Promise.all([rig.setStanding(false), popProp(prop, true)])
    occupant.seated = true
    rig.say(occupant.dealer.reason_text)
    void idleLoop(seat, occupant)
  }

  /** Brings the seat to `wanted`, one animation at a time; later polls just move the target. */
  const settle = async (seat: Seat): Promise<void> => {
    if (seat.busy) return
    seat.busy = true
    while (!disposed) {
      const wanted = seat.wanted
      const here = seat.occupant
      if (here && wanted && here.dealer.id === wanted.dealer.id) {
        applyTable(seat, wanted)
        break
      }
      if (!here && !wanted) {
        showEmpty(seat)
        break
      }
      if (here) await evict(seat, here)
      else if (wanted) await arrive(seat, wanted)
    }
    seat.busy = false
  }

  /** First paint: everyone already in place, no walking. */
  const place = (seat: Seat): void => {
    const wanted = seat.wanted
    if (!wanted) {
      showEmpty(seat)
      seat.sign.object.position.y = SIGN_Y
      seat.sign.object.visible = true
      return
    }
    const occupant = seatOccupant(seat, wanted)
    occupant.seated = true
    void idleLoop(seat, occupant)
  }

  const idleShot = (elapsed: number): { at: THREE.Vector3; look: THREE.Vector3 } => {
    const halfWidth = ((SEAT_COUNT - 1) / 2) * SPACING + FRAME_MARGIN
    const tanHalfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect
    // Narrow screens back the camera off so the whole row stays in frame.
    const distance = Math.max(CAMERA_Z, halfWidth / tanHalfH + 1)
    const at = new THREE.Vector3(Math.sin(elapsed * 0.08) * 1.2, 2.6 + distance * 0.12 + Math.sin(elapsed * 0.11) * 0.25, distance)
    return { at, look: LOOK_AT }
  }

  const focusShot = (target: FloorFocus, elapsed: number): { at: THREE.Vector3; look: THREE.Vector3 } => {
    if (target.kind === 'entrance') return ENTRANCE_SHOT
    if (target.kind === 'jackpot') return JACKPOT_SHOT
    const group = target.kind === 'seat' ? seats[target.seat]?.group : undefined
    if (!group) return idleShot(elapsed)
    // Straight in front of the table, whichever way the arc turns it.
    const facing = new THREE.Vector3(Math.sin(group.rotation.y), 0, Math.cos(group.rotation.y))
    const right = new THREE.Vector3(facing.z, 0, -facing.x)
    const look = group.position.clone().addScaledVector(right, SEAT_SHOT_SHIFT).setY(1.1)
    const at = look.clone().addScaledVector(facing, SEAT_SHOT_DIST).setY(SEAT_SHOT_Y)
    return { at, look }
  }

  const frameCamera = (dt: number, elapsed: number): void => {
    const wanted = focus ? focusShot(focus, elapsed) : idleShot(elapsed)
    if (!shot) shot = { at: wanted.at.clone(), look: wanted.look.clone() }
    const k = 1 - Math.exp(-dt * CAMERA_EASE)
    shot.at.lerp(wanted.at, k)
    shot.look.lerp(wanted.look, k)
    camera.position.copy(shot.at)
    camera.lookAt(shot.look)
  }

  /** How much the tour lights a seat up, 0..1: its own close-up, or its share of the passers-by. */
  const spotlight = (seat: Seat): number => {
    if (focus?.kind === 'seat') return focus.seat === seat.index ? 1 : 0
    if (focus?.kind === 'traffic') return (SEAT_TRAFFIC_BP[seat.index] - TRAFFIC_MIN_BP) / TRAFFIC_SPAN_BP
    return 0
  }

  const unsubscribe = mounted.onFrame((dt, elapsed) => {
    anim.update(dt)
    frameCamera(dt, elapsed)
    for (const seat of seats) updateSeat(seat, Math.max(seat === hovered ? 1 : 0, spotlight(seat)), dt)
    crowd.update(dt)
  })

  // ---- pointer --------------------------------------------------------------------------------

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  let pressedAt: { x: number; y: number } | null = null

  const pick = (event: PointerEvent): Seat | null => {
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointer, camera)
    const first = raycaster.intersectObjects(seats.map((s) => s.hit), false)[0]?.object
    return seats.find((s) => s.hit === first) ?? null
  }
  const onMove = (event: PointerEvent): void => {
    hovered = pick(event)
    renderer.domElement.style.cursor = hovered ? 'pointer' : 'default'
  }
  const onLeave = (): void => {
    hovered = null
  }
  const onDown = (event: PointerEvent): void => {
    pressedAt = { x: event.clientX, y: event.clientY }
  }
  const onUp = (event: PointerEvent): void => {
    const start = pressedAt
    pressedAt = null
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP) return
    const seat = pick(event)
    if (!seat) return
    // Clicks follow the data, not the animation: a dealer walking off has already lost the seat.
    if (seat.wanted) events.onTable(seat.wanted.dealer.id)
    else events.onEmptySeat()
  }
  const canvas = renderer.domElement
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', onUp)

  // Canvas text drawn before the web font loaded uses the fallback: redraw once it is there.
  void document.fonts?.ready.then(() => {
    if (disposed) return
    for (const seat of seats) {
      seat.plate.redraw()
      seat.sign.redraw()
    }
  })

  return {
    setFloor(next, from) {
      rentFrom = formatUsdc(from)
      seats.forEach((seat, i) => {
        seat.wanted = next[i] ?? null
        if (firstFloor) place(seat)
        else void settle(seat)
      })
      firstFloor = false
    },
    cueGamblers(cues) {
      for (const cue of cues) crowd.cue(cue)
    },
    focus(target) {
      focus = target
    },
    dispose() {
      disposed = true
      unsubscribe()
      crowd.dispose()
      anim.finishAll()
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      for (const seat of seats) seat.occupant?.rig.dispose()
      mounted.dispose()
    },
  }
}

/** Overshoots a little then settles: a sign landing on its chains. */
function easeOutBack(t: number): number {
  const c1 = 1.70158
  return 1 + (c1 + 1) * (t - 1) ** 3 + c1 * (t - 1) ** 2
}

// ---- one seat ---------------------------------------------------------------------------------

function buildSeat(index: number): Seat {
  const group = new THREE.Group()
  const x = (index - (SEAT_COUNT - 1) / 2) * SPACING
  const z = ARC * x * x
  group.position.set(x, 0, z)
  group.rotation.y = Math.atan2(-x, CAMERA_Z - z)
  const plate = buildNameplate()
  const sign = buildRentSign()
  sign.object.visible = false
  sign.object.position.y = SIGN_UP_Y
  const rug = buildRug(PALETTE.gold) as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  const lamp = new THREE.PointLight('#ffd7a0', LAMP_EMPTY, 5, 1.4)
  lamp.position.set(0, 2.7, 0.3)
  const drapes = buildDrapes()
  // An invisible box around table and dealer: an easy target for hover and click.
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(LOBBY_TABLE_W + 0.4, 2.6, LOBBY_TABLE_D + 1.4),
    new THREE.MeshBasicMaterial({ visible: false }),
  )
  hit.position.set(0, 1.3, -0.3)
  group.add(buildTableMesh(PALETTE.gold), plate.object, sign.object, rug, lamp, drapes.object, hit)
  return { index, group, plate, sign, rug, lamp, drapes, hit, occupant: null, wanted: null, busy: false, hover: 0, closed: 0 }
}

function applyTable(seat: Seat, table: SeatedTable): void {
  const occupant = seat.occupant
  if (!occupant) return
  const { dealer } = table
  occupant.dealer = dealer
  occupant.mood = dealerMood(dealer)
  occupant.rig.setMood(occupant.mood)
  if (occupant.seated) occupant.rig.say(dealer.reason_text)
  seat.plate.set({
    kind: 'table',
    name: dealer.name,
    game: dealer.game,
    edge: formatBp(dealer.total_edge_bp),
    open: dealer.open,
    rent: formatUsdc(table.rent),
    playerOwned: table.playerOwned,
    accent: dealerLook(dealer.id, table.look, dealer.temperament).accent,
  })
}

/** `light` 0..1: hover, or the tour's spotlight. */
function updateSeat(seat: Seat, light: number, dt: number): void {
  const ease = Math.min(1, dt * 8)
  const occupant = seat.occupant
  const closed = occupant && !occupant.dealer.open ? 1 : 0
  seat.hover += (light - seat.hover) * ease
  seat.closed += (closed - seat.closed) * Math.min(1, dt * 3)
  seat.group.position.y = seat.hover * HOVER_LIFT
  seat.rug.material.opacity = 0.12 + seat.hover * 0.38
  const lit = occupant ? THREE.MathUtils.lerp(LAMP_ON, LAMP_OFF, seat.closed) : LAMP_EMPTY
  seat.lamp.intensity = lit + seat.hover * 3
  seat.drapes.set(seat.closed)
  if (!occupant) return
  occupant.prop.update(dt)
  occupant.rig.update(dt)
}

// ---- room -------------------------------------------------------------------------------------

function buildRoom(scene: THREE.Scene): void {
  scene.background = new THREE.Color('#0a0708')
  scene.fog = new THREE.Fog('#0a0708', 16, 34)
  scene.add(new THREE.HemisphereLight('#ffe2b8', '#1a0e0a', 0.9))
  const key = new THREE.DirectionalLight('#ffdcb0', 1.4)
  key.position.set(3, 10, 8)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  const shadowBox = key.shadow.camera
  shadowBox.left = -12
  shadowBox.right = 12
  shadowBox.top = 8
  shadowBox.bottom = -6
  shadowBox.far = 30
  key.shadow.bias = -0.002
  scene.add(key)
  const pink = new THREE.PointLight(PALETTE.pink, 18, 16, 1.4)
  pink.position.set(-9, 4, -5)
  const gold = new THREE.PointLight(PALETTE.gold, 18, 16, 1.4)
  gold.position.set(9, 4, -5)
  scene.add(pink, gold, buildFloor(), buildBackWall(), buildSign())
}

function buildFloor(): THREE.Mesh {
  const carpet = pixelTexture(16, 16, (ctx) => {
    px(ctx, '#3a0f18', 0, 0, 16, 16)
    for (let i = 0; i < 16; i += 8) {
      // a small gold diamond pattern, the casino carpet cliché in pixels
      px(ctx, '#5a1a24', i + 2, i + 2, 4, 4)
      px(ctx, '#7a5a2a', i + 3, i + 3, 2, 2)
      px(ctx, '#4a1420', ((i + 8) % 16) + 3, i + 3, 2, 2)
    }
  })
  carpet.texture.wrapS = THREE.RepeatWrapping
  carpet.texture.wrapT = THREE.RepeatWrapping
  carpet.texture.repeat.set(24, 16)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 40), new THREE.MeshLambertMaterial({ map: carpet.texture }))
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  return floor
}

const WALL_Z = -5

function buildBackWall(): THREE.Mesh {
  const boxes = []
  for (let i = -10; i <= 10; i++) {
    const x = i * 2
    boxes.push(
      { size: [1.9, 6, 0.3] as const, at: [x, 3, WALL_Z] as const, color: i % 2 ? '#2a1712' : '#311b14' },
      { size: [0.12, 6, 0.4] as const, at: [x + 1, 3, WALL_Z + 0.05] as const, color: '#4a2c1c' },
    )
    // warm sconces every other panel
    if (i % 2 === 0) boxes.push({ size: [0.3, 0.4, 0.2] as const, at: [x, 3.2, WALL_Z + 0.25] as const, color: '#ffcf86' })
  }
  boxes.push({ size: [44, 0.3, 0.5] as const, at: [0, 0.15, WALL_Z + 0.1] as const, color: '#1a0f0b' })
  return voxelPart(boxes, { shadows: false })
}

function buildSign(): THREE.Mesh {
  const art = pixelTexture(
    512,
    96,
    (ctx) => {
      ctx.fillStyle = '#120a0c'
      ctx.fillRect(0, 0, 512, 96)
      ctx.strokeStyle = PALETTE.gold
      ctx.lineWidth = 6
      ctx.strokeRect(6, 6, 500, 84)
      ctx.font = "bold 60px 'JetBrains Mono', ui-monospace, monospace"
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.shadowColor = PALETTE.pink
      ctx.shadowBlur = 18
      ctx.fillStyle = PALETTE.pink
      ctx.fillText('TILT HOUSE', 256, 52)
    },
    { smooth: true },
  )
  // Unlit so it reads as a neon sign glowing in the dark.
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.2), new THREE.MeshBasicMaterial({ map: art.texture, fog: false }))
  sign.position.set(0, 4.6, WALL_Z + 0.2)
  return sign
}
