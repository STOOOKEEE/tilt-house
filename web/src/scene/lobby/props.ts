// The lobby's small tables and their idle props: dice that get thrown, a wheel that turns and a
// ball the dealer flicks, cards dealt and swept back. Pure decoration: nothing here reads a round.
import * as THREE from 'three'
import type { Game } from '../../near/views'
import { Animator, arcTo, easeOut, PALETTE } from '../table/props'
import type { CharacterRig } from '../types'
import { pixelTexture, px, shade, texturedBox, voxelPart, type PixelTexture, type VoxelBox } from '../voxel'

export const LOBBY_TABLE_W = 2.4
export const LOBBY_TABLE_D = 1.3
/** Same felt height as the table page, so the seated dealers' hands rest on it. */
export const FELT_Y = 0.78
/** The dealer sits this far behind the table's center. */
export const DEALER_Z = -LOBBY_TABLE_D / 2 - 0.3
const WOOD = '#4a2c1c'
const FELT = '#1f6b46'

// ---- table ----------------------------------------------------------------------------------

export function buildTableMesh(accent: string): THREE.Mesh {
  const w = LOBBY_TABLE_W
  const d = LOBBY_TABLE_D
  const boxes: VoxelBox[] = [
    { size: [w, 0.1, d], at: [0, FELT_Y - 0.06, 0], color: WOOD },
    { size: [w - 0.2, 0.04, d - 0.2], at: [0, FELT_Y - 0.01, 0], color: FELT },
    // stepped half-round front, the classic dealer table silhouette in blocks
    { size: [w - 0.6, 0.1, 0.2], at: [0, FELT_Y - 0.06, d / 2 + 0.1], color: WOOD },
    { size: [w - 0.8, 0.04, 0.16], at: [0, FELT_Y - 0.01, d / 2 + 0.04], color: FELT },
    { size: [w + 0.04, 0.04, d + 0.04], at: [0, FELT_Y - 0.12, 0], color: accent },
    { size: [w - 0.4, FELT_Y - 0.14, d - 0.5], at: [0, (FELT_Y - 0.14) / 2, 0], color: shade(WOOD, -0.06) },
  ]
  return voxelPart(boxes)
}

/** The rug under a table: its accent color lights up on hover. */
export function buildRug(accent: string): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.12, depthWrite: false })
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(LOBBY_TABLE_W + 0.9, LOBBY_TABLE_D + 1.9), material)
  rug.rotation.x = -Math.PI / 2
  rug.position.set(0, 0.012, -0.3)
  return rug
}

// ---- nameplate ------------------------------------------------------------------------------

/** A seated table's plate, or an empty seat's. Amounts arrive formatted ("1.10"). */
export type PlateInfo =
  | { kind: 'table'; name: string; game: Game; edge: string; open: boolean; rent: string; playerOwned: boolean; accent: string }
  | { kind: 'empty'; seat: number; from: string }

export interface Nameplate {
  object: THREE.Mesh
  set(info: PlateInfo): void
  redraw(): void
}

const PLATE_W = 512
const PLATE_H = 128
const MONO = "'JetBrains Mono', ui-monospace, monospace"

export function buildNameplate(): Nameplate {
  let info: PlateInfo = { kind: 'empty', seat: 0, from: '' }
  const art: PixelTexture = pixelTexture(PLATE_W, PLATE_H, (ctx) => drawPlate(ctx, info), { smooth: true })
  const object = texturedBox([1.9, 0.48, 0.06], shade(WOOD, -0.1), art.texture)
  object.position.set(0, 0.4, LOBBY_TABLE_D / 2 + 0.24)
  return {
    object,
    set(next) {
      if (JSON.stringify(next) === JSON.stringify(info)) return
      info = next
      art.redraw()
    },
    redraw: art.redraw,
  }
}

function drawPlate(ctx: CanvasRenderingContext2D, info: PlateInfo): void {
  const accent = info.kind === 'table' ? info.accent : PALETTE.gold
  ctx.fillStyle = '#1a1210'
  ctx.fillRect(0, 0, PLATE_W, PLATE_H)
  ctx.fillStyle = accent
  ctx.fillRect(0, 0, PLATE_W, 8)
  ctx.fillRect(0, PLATE_H - 8, PLATE_W, 8)
  ctx.textBaseline = 'middle'
  if (info.kind === 'empty') {
    ctx.font = `bold 46px ${MONO}`
    ctx.fillStyle = accent
    ctx.fillText('FOR RENT', 22, 44)
    ctx.font = `28px ${MONO}`
    ctx.fillStyle = PALETTE.cream
    ctx.fillText(`seat ${info.seat} · from ${info.from}/h`, 22, 92)
    return
  }
  ctx.font = `bold 46px ${MONO}`
  ctx.fillStyle = accent
  ctx.fillText(info.name, 22, 44)
  ctx.font = `24px ${MONO}`
  ctx.fillStyle = PALETTE.cream
  ctx.fillText(`${info.game} · ${info.edge} · ${info.rent}/h`, 22, 92)
  drawBadge(ctx, info.open ? 'OPEN' : 'CLOSED', info.open ? PALETTE.green : PALETTE.red, 24)
  // Player-run tables are marked so the floor shows who is an NPC and who is a player business.
  if (info.playerOwned) drawBadge(ctx, 'PLAYER', PALETTE.pink, 72, 20)
}

/** A filled pill on the plate's right edge. */
function drawBadge(ctx: CanvasRenderingContext2D, text: string, color: string, top: number, size = 28): void {
  ctx.font = `bold ${size}px ${MONO}`
  const w = ctx.measureText(text).width + 24
  const h = size + 12
  ctx.fillStyle = color
  ctx.fillRect(PLATE_W - w - 18, top, w, h)
  ctx.fillStyle = '#141517'
  ctx.fillText(text, PLATE_W - w - 6, top + h / 2 + 1)
}

// ---- for rent sign --------------------------------------------------------------------------

export interface RentSign {
  object: THREE.Group
  /** `from` is the formatted rent needed to take the seat. */
  set(from: string): void
  redraw(): void
}

const SIGN_W = 256
const SIGN_H = 128
/** Hanging height of the board's center over the empty table. */
export const SIGN_Y = 1.75

/** A board hanging on two chains over an empty seat: "FOR RENT · from X/h". */
export function buildRentSign(): RentSign {
  let from = ''
  const art = pixelTexture(SIGN_W, SIGN_H, (ctx) => drawSign(ctx, from), { smooth: true })
  const object = new THREE.Group()
  const board = texturedBox([1.5, 0.75, 0.06], shade(WOOD, -0.1), art.texture)
  const chains = voxelPart(
    [-0.55, 0.55].map((x): VoxelBox => ({ size: [0.04, 3, 0.04], at: [x, 1.85, 0], color: PALETTE.gold })),
    { shadows: false },
  )
  object.add(board, chains)
  object.position.set(0, SIGN_Y, DEALER_Z + 0.3)
  return {
    object,
    set(next) {
      if (next === from) return
      from = next
      art.redraw()
    },
    redraw: art.redraw,
  }
}

function drawSign(ctx: CanvasRenderingContext2D, from: string): void {
  ctx.fillStyle = '#120a0c'
  ctx.fillRect(0, 0, SIGN_W, SIGN_H)
  ctx.strokeStyle = PALETTE.gold
  ctx.lineWidth = 6
  ctx.strokeRect(5, 5, SIGN_W - 10, SIGN_H - 10)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold 40px ${MONO}`
  ctx.fillStyle = PALETTE.gold
  ctx.fillText('FOR RENT', SIGN_W / 2, 48)
  ctx.font = `24px ${MONO}`
  ctx.fillStyle = PALETTE.cream
  ctx.fillText(`from ${from}/h`, SIGN_W / 2, 90)
}

// ---- curtain --------------------------------------------------------------------------------

export interface Drapes {
  object: THREE.Group
  /** 0 = gathered out of sight, 1 = drawn across both sides of the table. */
  set(closed: number): void
}

/** Two red drapes drawn in from the sides when a table is closed; the gap keeps the sad dealer visible. */
export function buildDrapes(): Drapes {
  const object = new THREE.Group()
  const halves = [-1, 1].map((side) => {
    const boxes: VoxelBox[] = []
    for (let i = 0; i < 4; i++) {
      boxes.push({ size: [0.22, 1.7, 0.08], at: [-side * (0.11 + i * 0.22), 0.85, (i % 2) * 0.05], color: i % 2 ? '#741522' : '#8e1b2b' })
    }
    boxes.push({ size: [0.9, 0.08, 0.16], at: [-side * 0.45, 1.72, 0.02], color: PALETTE.gold })
    const half = voxelPart(boxes)
    half.position.x = side * (LOBBY_TABLE_W / 2 + 0.05)
    object.add(half)
    return half
  })
  object.position.set(0, FELT_Y, DEALER_Z + 0.45)
  const set = (closed: number): void => {
    object.visible = closed > 0.01
    for (const half of halves) half.scale.x = closed
  }
  set(0)
  return { object, set }
}

// ---- game props -----------------------------------------------------------------------------

/** An idle animation loop for one game: the dealer and the prop act together. */
export interface LobbyProp {
  object: THREE.Object3D
  update(dt: number): void
  play(rig: CharacterRig, anim: Animator): Promise<void>
}

export function createProp(game: Game): LobbyProp {
  if (game === 'dice') return createDice()
  if (game === 'roulette') return createWheel()
  return createCards()
}

/** World → the prop's own space: the dealer's hand is in world coordinates. */
function toLocal(object: THREE.Object3D, world: THREE.Vector3): THREE.Vector3 {
  object.updateWorldMatrix(true, false)
  return object.worldToLocal(world.clone())
}

function toWorld(object: THREE.Object3D, local: THREE.Vector3): THREE.Vector3 {
  object.updateWorldMatrix(true, false)
  return object.localToWorld(local.clone())
}

// dice

const PIPS: Record<number, [number, number][]> = {
  1: [[3, 3]],
  2: [[1, 1], [5, 5]],
  3: [[1, 1], [3, 3], [5, 5]],
  4: [[1, 1], [5, 1], [1, 5], [5, 5]],
  5: [[1, 1], [5, 1], [3, 3], [1, 5], [5, 5]],
  6: [[1, 1], [5, 1], [1, 3], [5, 3], [1, 5], [5, 5]],
}
/** BoxGeometry faces (+X, -X, +Y, -Y, +Z, -Z) get values whose opposite faces sum to 7. */
const FACE_VALUES = [1, 6, 2, 5, 3, 4]
const DIE = 0.13

function dieMesh(): THREE.Mesh {
  const materials = FACE_VALUES.map((value) => {
    const art = pixelTexture(7, 7, (ctx) => {
      px(ctx, PALETTE.cream, 0, 0, 7, 7)
      for (const [x, y] of PIPS[value]) px(ctx, value === 1 ? PALETTE.red : '#1b1b22', x, y)
    })
    return new THREE.MeshLambertMaterial({ map: art.texture })
  })
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(DIE, DIE, DIE), materials)
  mesh.castShadow = true
  return mesh
}

const QUARTER = Math.PI / 2

function createDice(): LobbyProp {
  const object = new THREE.Group()
  const dice = [dieMesh(), dieMesh()]
  const rest = [new THREE.Vector3(-0.12, FELT_Y + DIE / 2, 0.15), new THREE.Vector3(0.14, FELT_Y + DIE / 2, 0.22)]
  dice.forEach((die, i) => {
    die.position.copy(rest[i])
    object.add(die)
  })
  return {
    object,
    update: () => undefined,
    async play(rig, anim) {
      const throwing = rig.gesture({ kind: 'throw' })
      // Dice ride in the shaking hand until the release (~0.7 s into the throw).
      await anim.tween(0.7, () => {
        const hand = toLocal(object, rig.handPosition())
        dice.forEach((die, i) => die.position.set(hand.x + (i - 0.5) * 0.1, hand.y - 0.05, hand.z))
      })
      await Promise.all(dice.map((die, i) => tumble(anim, die, landing(i))))
      await throwing
    },
  }
}

function landing(i: number): THREE.Vector3 {
  const x = (i - 0.5) * 0.35 + (Math.random() - 0.5) * 0.2
  return new THREE.Vector3(x, FELT_Y + DIE / 2, 0.15 + Math.random() * 0.25)
}

function tumble(anim: Animator, die: THREE.Mesh, to: THREE.Vector3): Promise<void> {
  const from = die.rotation.clone()
  // Land on a random face: whole quarter turns, plus a few extra spins on the way.
  const turnsX = (4 + Math.floor(Math.random() * 4)) * QUARTER
  const turnsZ = (2 + Math.floor(Math.random() * 4)) * QUARTER
  const move = arcTo(anim, die, to, 0.55, 0.35)
  const spin = anim.tween(
    0.55,
    (t) => die.rotation.set(from.x + turnsX * t, from.y, from.z + turnsZ * t),
    easeOut,
  )
  return Promise.all([move, spin]).then(() => undefined)
}

// roulette

const POCKETS = 37
const WHEEL_R = 0.34
const BALL_OUTER = 0.3
const BALL_INNER = 0.22
const ROTOR_SPEED = 0.6
const WHEEL_AT = new THREE.Vector3(-0.5, FELT_Y, -0.05)

function rotorTexture(): PixelTexture {
  return pixelTexture(64, 64, (ctx) => {
    px(ctx, '#3a2416', 0, 0, 64, 64)
    for (let i = 0; i < POCKETS; i++) {
      const a0 = (i / POCKETS) * Math.PI * 2
      const a1 = ((i + 1) / POCKETS) * Math.PI * 2
      ctx.fillStyle = i === 0 ? '#1f8a4c' : i % 2 ? '#b8242f' : '#16161a'
      ctx.beginPath()
      ctx.moveTo(32, 32)
      ctx.arc(32, 32, 31, a0, a1)
      ctx.fill()
    }
    ctx.fillStyle = '#5a3b26'
    ctx.beginPath()
    ctx.arc(32, 32, 18, 0, Math.PI * 2)
    ctx.fill()
    px(ctx, PALETTE.gold, 29, 29, 6, 6)
  })
}

function createWheel(): LobbyProp {
  const object = new THREE.Group()
  object.position.copy(WHEEL_AT)
  const bowl = voxelPart([
    { size: [0.86, 0.08, 0.5], at: [0, 0.04, 0], color: WOOD },
    { size: [0.5, 0.08, 0.86], at: [0, 0.04, 0], color: WOOD },
    { size: [0.74, 0.1, 0.74], at: [0, 0.05, 0], color: shade(WOOD, 0.06) },
  ])
  const top = rotorTexture()
  const rotor = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.05, 24), [
    new THREE.MeshLambertMaterial({ color: '#3a2416' }),
    new THREE.MeshLambertMaterial({ map: top.texture }),
    new THREE.MeshLambertMaterial({ color: '#3a2416' }),
  ])
  rotor.position.y = 0.11
  const turret = voxelPart([
    { size: [0.06, 0.12, 0.06], at: [0, 0.06, 0], color: PALETTE.gold },
    { size: [0.18, 0.03, 0.03], at: [0, 0.1, 0], color: PALETTE.gold },
    { size: [0.03, 0.03, 0.18], at: [0, 0.1, 0], color: PALETTE.gold },
  ])
  turret.position.y = 0.13
  rotor.add(turret)
  const ball = voxelPart([{ size: [0.04, 0.04, 0.04], at: [0, 0, 0], color: '#ffffff' }])
  object.add(bowl, rotor, ball)

  // The ball either rides in a pocket (offset from the rotor) or is thrown around the rim.
  let riding = true
  let pocketOffset = 0
  let ballAngle = 0
  const placeBall = (angle: number, radius: number, hop: number): void => {
    ball.position.set(Math.cos(angle) * radius, 0.16 + hop, Math.sin(angle) * radius)
  }
  return {
    object,
    update(dt) {
      rotor.rotation.y += dt * ROTOR_SPEED
      if (!riding) return
      // rotation.y turns counter-clockwise seen from above, i.e. negative angle in x/z.
      ballAngle = -rotor.rotation.y + pocketOffset
      placeBall(ballAngle, BALL_INNER, 0)
    },
    async play(rig, anim) {
      const spinning = rig.gesture({ kind: 'spin' })
      await anim.wait(0.3)
      riding = false
      const start = ballAngle
      await anim.tween(
        2.8,
        (t) => {
          ballAngle = start + t * Math.PI * 2 * 4
          const radius = THREE.MathUtils.lerp(BALL_OUTER, BALL_INNER, Math.max(0, t - 0.6) / 0.4)
          const hop = t > 0.7 ? Math.abs(Math.sin(t * 40)) * 0.03 * (1 - t) : 0
          placeBall(ballAngle, radius, hop)
        },
        easeOut,
      )
      pocketOffset = ballAngle + rotor.rotation.y
      riding = true
      await spinning
    },
  }
}

// blackjack

const CARD: [number, number, number] = [0.2, 0.012, 0.28]
const SHOE_AT = new THREE.Vector3(-0.85, FELT_Y, -0.3)
const SPOTS = [new THREE.Vector3(-0.55, 0, 0.3), new THREE.Vector3(0, 0, 0.38), new THREE.Vector3(0.55, 0, 0.3)]

function cardFace(red: boolean): THREE.Texture {
  const ink = red ? '#c42a3a' : '#1b1b22'
  return pixelTexture(10, 14, (ctx) => {
    px(ctx, '#fbfbf5', 0, 0, 10, 14)
    // a diamond or a blocky spade
    px(ctx, ink, 4, 4, 2, 1)
    px(ctx, ink, 3, 5, 4, 1)
    px(ctx, ink, 2, 6, 6, 2)
    px(ctx, ink, 3, 8, 4, 1)
    px(ctx, ink, 4, 9, 2, red ? 1 : 2) // the diamond's tip, or the spade's stem
    px(ctx, ink, 1, 1)
    px(ctx, ink, 8, 12)
  }).texture
}

function cardBack(): THREE.Texture {
  return pixelTexture(10, 14, (ctx) => {
    px(ctx, '#fbfbf5', 0, 0, 10, 14)
    for (let y = 1; y < 13; y++) for (let x = 1; x < 9; x++) px(ctx, (x + y) % 2 ? PALETTE.pink : '#b4467f', x, y)
  }).texture
}

function cardMesh(back: THREE.Texture, face: THREE.Texture): THREE.Mesh {
  const edge = new THREE.MeshLambertMaterial({ color: '#fbfbf5' })
  // Face down: the back is on top (+Y), the face below (-Y) shows once flipped.
  const materials = [edge, edge, new THREE.MeshLambertMaterial({ map: back }), new THREE.MeshLambertMaterial({ map: face }), edge, edge]
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...CARD), materials)
  mesh.castShadow = true
  mesh.visible = false
  return mesh
}

function createCards(): LobbyProp {
  const object = new THREE.Group()
  const back = cardBack()
  const shoe = voxelPart([
    { size: [0.26, 0.14, 0.36], at: [0, 0.07, 0], color: '#2a1a12' },
    { size: [0.22, 0.04, 0.3], at: [0, 0.15, 0], color: PALETTE.pink },
  ])
  shoe.position.copy(SHOE_AT)
  const cards = SPOTS.map((_, i) => cardMesh(back, cardFace(i % 2 === 0)))
  object.add(shoe, ...cards)
  return {
    object,
    update: () => undefined,
    async play(rig, anim) {
      for (let i = 0; i < cards.length; i++) await dealCard(rig, anim, object, cards[i], SPOTS[i])
      await anim.wait(0.4)
      const flipping = rig.gesture({ kind: 'flip' })
      await anim.wait(0.15)
      await anim.tween(0.3, (t) => cards.forEach((card) => (card.rotation.z = Math.PI * t)))
      await flipping
      await anim.wait(1.6)
      const collecting = rig.gesture({ kind: 'collect' })
      await anim.wait(0.3)
      const pile = new THREE.Vector3(0, FELT_Y + 0.01, -0.35)
      await Promise.all(
        cards.map((card) => {
          const from = card.position.clone()
          return anim.tween(0.35, (t) => card.position.lerpVectors(from, pile, t))
        }),
      )
      for (const card of cards) card.visible = false
      await collecting
    },
  }
}

async function dealCard(rig: CharacterRig, anim: Animator, object: THREE.Object3D, card: THREE.Mesh, spot: THREE.Vector3): Promise<void> {
  const target = new THREE.Vector3(spot.x, FELT_Y + CARD[1] / 2, spot.z)
  const dealing = rig.gesture({ kind: 'deal', to: toWorld(object, target) })
  await anim.wait(0.2)
  card.position.copy(toLocal(object, rig.handPosition()))
  card.rotation.set(0, 0, 0)
  card.visible = true
  await arcTo(anim, card, target, 0.28, 0.12)
  await dealing
}
