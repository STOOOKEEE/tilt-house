// The room and the furniture every table shares: tween clock, lights, floor, walls, the felt
// table with its accent trim, chip stacks, text panels, the "VRF is drawing" hourglass, the curtain.
import * as THREE from 'three'
import { pixelTexture, shade, voxelPart, type PixelTexture } from '../voxel'

// ---- layout (meters; the camera looks down -Z, the dealer stands behind the table) --------

export const TABLE_W = 4.2
export const TABLE_D = 2.4
/** Height of the felt surface (the seated dealers' hands rest at ~0.8): props rest on it. */
export const FELT_Y = 0.78
const RIM = 0.2
const RIM_H = 0.12

/** Felt texture coordinates (u right, v down, 0..1) to a point on the felt. */
export function feltPoint(u: number, v: number, lift = 0): THREE.Vector3 {
  return new THREE.Vector3((u - 0.5) * TABLE_W, FELT_Y + lift, (v - 0.5) * TABLE_D)
}

export const PALETTE = {
  pink: '#ec6fae',
  gold: '#f0c26a',
  green: '#7ccf8f',
  red: '#f0715f',
  felt: '#1f6b46',
  cream: '#f3ead2',
}

// ---- animation clock ------------------------------------------------------------------------

export type Ease = (t: number) => number
export const easeInOut: Ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
export const easeOut: Ease = (t) => 1 - (1 - t) ** 3

interface Task {
  elapsed: number
  duration: number
  onUpdate: (t: number) => void
  ease: Ease
  done: () => void
}

/** Frame-driven tweens: pausing the renderer (hidden tab) pauses every animation with it. */
export class Animator {
  /** >1 plays faster: the scene speeds up when rounds queue up instead of skipping them. */
  timeScale = 1
  private tasks = new Set<Task>()

  update(dt: number): void {
    for (const task of [...this.tasks]) {
      task.elapsed += dt * this.timeScale
      const t = Math.min(1, task.elapsed / task.duration)
      task.onUpdate(task.ease(t))
      if (t >= 1) {
        this.tasks.delete(task)
        task.done()
      }
    }
  }

  tween(duration: number, onUpdate: (t: number) => void, ease: Ease = easeInOut): Promise<void> {
    return new Promise((done) => this.tasks.add({ elapsed: 0, duration, onUpdate, ease, done }))
  }

  wait(seconds: number): Promise<void> {
    return this.tween(seconds, () => undefined)
  }

  /** Ends every running tween at its final state, so pending steps finish instead of hanging. */
  finishAll(): void {
    for (const task of this.tasks) {
      task.onUpdate(1)
      task.done()
    }
    this.tasks.clear()
  }
}

/** Moves `object` to `to` along an arc `height` high. */
export function arcTo(anim: Animator, object: THREE.Object3D, to: THREE.Vector3, duration: number, height: number) {
  const from = object.position.clone()
  return anim.tween(duration, (t) => {
    object.position.lerpVectors(from, to, t)
    object.position.y += Math.sin(Math.PI * t) * height
  })
}

// ---- room -----------------------------------------------------------------------------------

export function buildLights(scene: THREE.Scene): void {
  scene.background = new THREE.Color('#0a0708')
  scene.fog = new THREE.Fog('#0a0708', 9, 18)
  scene.add(new THREE.HemisphereLight('#ffe2b8', '#1a0e0a', 1.1))
  const spot = new THREE.SpotLight('#ffd7a0', 60, 12, Math.PI / 4.2, 0.45, 1.6)
  spot.position.set(0, 5.2, 1.2)
  spot.target.position.set(0, FELT_Y, -0.2)
  spot.castShadow = true
  spot.shadow.mapSize.set(1024, 1024)
  spot.shadow.bias = -0.0015
  scene.add(spot, spot.target)
  const pinkRim = new THREE.PointLight(PALETTE.pink, 6, 9)
  pinkRim.position.set(-3.6, 2.6, -2.4)
  const goldRim = new THREE.PointLight(PALETTE.gold, 6, 9)
  goldRim.position.set(3.6, 2.6, -2.4)
  scene.add(pinkRim, goldRim)
}

/** Checkered carpet, a wall of dark wood panels with warm sconces, a hanging lamp over the felt. */
export function buildRoom(dealerName: string, accent: string): THREE.Group {
  const room = new THREE.Group()
  const carpet = pixelTexture(16, 16, (ctx) => {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#3a1218' : '#2a0c12'
        ctx.fillRect(x, y, 1, 1)
      }
    }
    ctx.fillStyle = '#5a2a1a'
    ctx.fillRect(0, 7, 16, 1)
    ctx.fillRect(7, 0, 1, 16)
  })
  carpet.texture.wrapS = carpet.texture.wrapT = THREE.RepeatWrapping
  carpet.texture.repeat.set(6, 6)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshLambertMaterial({ map: carpet.texture }))
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  room.add(floor)

  const wall = voxelPart(wallPanels(), { shadows: false })
  wall.receiveShadow = true
  room.add(wall)
  room.add(neonSign(dealerName, accent))
  room.add(hangingLamp())
  return room
}

const WALL_Z = -3.2

function wallPanels() {
  const boxes = []
  for (let x = -7; x <= 7; x++) {
    const tone = x % 2 === 0 ? '#2b1a12' : '#24150f'
    boxes.push({ size: [1, 5, 0.3] as const, at: [x, 2.5, WALL_Z] as const, color: tone })
    if (x % 3 === 0) {
      // Sconces: a glowing block on a brass stub.
      boxes.push({ size: [0.24, 0.3, 0.16] as const, at: [x, 2.2, WALL_Z + 0.22] as const, color: '#ffcf7a' })
      boxes.push({ size: [0.1, 0.1, 0.12] as const, at: [x, 2.0, WALL_Z + 0.2] as const, color: '#8a6a2a' })
    }
  }
  boxes.push({ size: [15, 0.18, 0.4] as const, at: [0, 0.09, WALL_Z + 0.1] as const, color: '#1a0f0a' })
  boxes.push({ size: [15, 0.14, 0.36] as const, at: [0, 3.1, WALL_Z + 0.1] as const, color: '#5a3a1a' })
  return boxes
}

function neonSign(name: string, accent: string): THREE.Mesh {
  const sign = pixelTexture(
    512,
    128,
    (ctx, w, h) => {
      ctx.font = 'bold 64px "JetBrains Mono", ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.shadowColor = accent
      ctx.shadowBlur = 24
      ctx.fillStyle = accent
      ctx.fillText(name.toUpperCase(), w / 2, h / 2)
      ctx.shadowBlur = 0
      ctx.fillStyle = '#fff4f9'
      ctx.fillText(name.toUpperCase(), w / 2, h / 2)
    },
    { smooth: true },
  )
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 0.8),
    new THREE.MeshBasicMaterial({ map: sign.texture, transparent: true, fog: false }),
  )
  mesh.position.set(0, 3.75, WALL_Z + 0.2)
  return mesh
}

function hangingLamp(): THREE.Mesh {
  const lamp = voxelPart(
    [
      { size: [0.04, 1.6, 0.04], at: [0, 0.8, 0], color: '#222' },
      { size: [1.4, 0.18, 0.5], at: [0, 0, 0], color: '#1f3a2a' },
      { size: [1.3, 0.04, 0.42], at: [0, -0.1, 0], color: '#fff1c4' },
    ],
    { shadows: false },
  )
  lamp.position.set(0, 4.3, 0.2)
  return lamp
}

// ---- table ----------------------------------------------------------------------------------

export interface FeltTable {
  object: THREE.Group
  /** The felt surface, for pointer picking. */
  top: THREE.Mesh
  /** Repaints the felt print (game layout) with `draw` on top of the plain felt. */
  paint(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): void
}

const FELT_PX_W = 1024
const FELT_PX_H = Math.round((FELT_PX_W * TABLE_D) / TABLE_W)

export function buildTable(accent: string): FeltTable {
  const object = new THREE.Group()
  let print: (ctx: CanvasRenderingContext2D, w: number, h: number) => void = () => undefined
  const felt: PixelTexture = pixelTexture(
    FELT_PX_W,
    FELT_PX_H,
    (ctx, w, h) => {
      paintFelt(ctx, w, h)
      print(ctx, w, h)
    },
    { smooth: true },
  )
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE_W, 0.1, TABLE_D),
    [0, 1, 2, 3, 4, 5].map((face) =>
      face === 2 ? new THREE.MeshLambertMaterial({ map: felt.texture }) : new THREE.MeshLambertMaterial({ color: PALETTE.felt }),
    ),
  )
  top.position.y = FELT_Y - 0.05
  top.receiveShadow = true
  object.add(top, rimAndBase(accent))
  return {
    object,
    top,
    paint(draw) {
      print = draw
      felt.redraw()
    },
  }
}

/** Felt with a coarse pixel grain, so it reads as cloth and fits the blocky style. */
function paintFelt(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = PALETTE.felt
  ctx.fillRect(0, 0, w, h)
  const cell = 16
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
      const grain = n - Math.floor(n)
      ctx.fillStyle = grain > 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.05)'
      ctx.fillRect(x, y, cell, cell)
    }
  }
}

function rimAndBase(accent: string): THREE.Mesh {
  const wood = '#5b3420'
  const dark = shade(wood, -0.1)
  const y = FELT_Y + RIM_H / 2 - 0.04
  const halfW = TABLE_W / 2 + RIM / 2
  const halfD = TABLE_D / 2 + RIM / 2
  const trimY = FELT_Y + RIM_H - 0.035
  return voxelPart([
    { size: [TABLE_W + RIM * 2, RIM_H, RIM], at: [0, y, halfD], color: wood },
    { size: [TABLE_W + RIM * 2, RIM_H, RIM], at: [0, y, -halfD], color: wood },
    { size: [RIM, RIM_H, TABLE_D], at: [halfW, y, 0], color: wood },
    { size: [RIM, RIM_H, TABLE_D], at: [-halfW, y, 0], color: wood },
    // The dealer's accent color runs along the inner edge of the rim.
    { size: [TABLE_W, 0.03, 0.05], at: [0, trimY, TABLE_D / 2 + 0.03], color: accent },
    { size: [TABLE_W, 0.03, 0.05], at: [0, trimY, -TABLE_D / 2 - 0.03], color: accent },
    { size: [0.05, 0.03, TABLE_D], at: [TABLE_W / 2 + 0.03, trimY, 0], color: accent },
    { size: [0.05, 0.03, TABLE_D], at: [-TABLE_W / 2 - 0.03, trimY, 0], color: accent },
    { size: [TABLE_W - 0.4, FELT_Y - 0.25, TABLE_D - 0.6], at: [0, (FELT_Y - 0.1) / 2, 0], color: dark },
    { size: [TABLE_W, 0.12, TABLE_D], at: [0, 0.06, 0], color: shade(wood, -0.15) },
  ])
}

// ---- chips ----------------------------------------------------------------------------------

export const CHIP_H = 0.035
const CHIP_R = 0.11
const CHIP_COLORS = [PALETTE.pink, PALETTE.gold, '#f4f1ea', PALETTE.green, '#4a7bd6']
const USDC = 1_000_000

/** Stack height for an amount (base units): roughly one chip per doubling of the stake, 1 to 12. */
export function chipCount(amount: string): number {
  const value = Number(amount) / USDC
  if (!(value > 0)) return 0
  return Math.max(1, Math.min(12, Math.round(Math.log2(value * 10)) + 1))
}

/** Octagonal chips (8 sides keeps them blocky), alternating colors with a white edge stripe. */
export function chipStack(count: number, seed = 0): THREE.Group {
  const stack = new THREE.Group()
  const geometry = new THREE.CylinderGeometry(CHIP_R, CHIP_R, CHIP_H, 8)
  for (let i = 0; i < count; i++) {
    const color = CHIP_COLORS[(i + seed) % CHIP_COLORS.length]
    const chip = new THREE.Mesh(i === 0 ? geometry : geometry.clone(), new THREE.MeshLambertMaterial({ color, flatShading: true }))
    chip.position.y = CHIP_H / 2 + i * CHIP_H
    chip.rotation.y = (i % 2) * (Math.PI / 8)
    chip.castShadow = true
    stack.add(chip)
  }
  return stack
}

/** A stack of the given chip values, bottom first, each in its value's colour. */
export function valueStack(chips: readonly bigint[], color: (value: bigint) => string): THREE.Group {
  const stack = new THREE.Group()
  const geometry = new THREE.CylinderGeometry(CHIP_R, CHIP_R, CHIP_H, 8)
  chips.forEach((value, i) => {
    const chip = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: color(value), flatShading: true }))
    chip.position.y = CHIP_H / 2 + i * CHIP_H
    chip.rotation.y = (i % 2) * (Math.PI / 8)
    chip.castShadow = true
    stack.add(chip)
  })
  return stack
}

// ---- text panels ----------------------------------------------------------------------------

export interface TextSprite {
  sprite: THREE.Sprite
  set(text: string, color?: string): void
}

/** A camera-facing label (totals, results). Empty text hides it. */
export function textSprite(worldHeight: number, widthChars = 8): TextSprite {
  let text = ''
  let color = PALETTE.cream
  const h = 64
  const w = Math.max(64, widthChars * 38)
  const canvas = pixelTexture(
    w,
    h,
    (ctx) => {
      if (!text) return
      ctx.font = 'bold 44px "JetBrains Mono", ui-monospace, monospace'
      const width = Math.min(w, ctx.measureText(text).width + 28)
      ctx.fillStyle = 'rgba(12,10,10,0.82)'
      ctx.fillRect((w - width) / 2, 4, width, h - 8)
      ctx.fillStyle = color
      ctx.fillRect((w - width) / 2, h - 8, width, 4)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, w / 2, h / 2 + 1)
    },
    { smooth: true },
  )
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: canvas.texture, depthTest: false, fog: false }))
  sprite.scale.set((worldHeight * w) / h, worldHeight, 1)
  sprite.renderOrder = 10
  sprite.visible = false
  return {
    sprite,
    set(next, nextColor = PALETTE.cream) {
      text = next
      color = nextColor
      sprite.visible = next !== ''
      canvas.redraw()
    },
  }
}

// ---- "the VRF is drawing" -------------------------------------------------------------------

/** A gold hourglass that turns in quarter steps above the felt while a draw is pending. */
export function hourglass(): THREE.Mesh {
  const gold = PALETTE.gold
  const sand = '#f7e3a8'
  const glass = '#cfe8f0'
  const mesh = voxelPart(
    [
      { size: [0.3, 0.05, 0.3], at: [0, 0.32, 0], color: gold },
      { size: [0.3, 0.05, 0.3], at: [0, -0.32, 0], color: gold },
      { size: [0.2, 0.12, 0.2], at: [0, 0.22, 0], color: glass },
      { size: [0.12, 0.1, 0.12], at: [0, 0.1, 0], color: sand },
      { size: [0.05, 0.08, 0.05], at: [0, 0, 0], color: sand },
      { size: [0.12, 0.1, 0.12], at: [0, -0.1, 0], color: glass },
      { size: [0.2, 0.12, 0.2], at: [0, -0.22, 0], color: sand },
      { size: [0.04, 0.6, 0.04], at: [0.14, 0, 0.14], color: gold },
      { size: [0.04, 0.6, 0.04], at: [-0.14, 0, -0.14], color: gold },
    ],
    { shadows: false },
  )
  mesh.visible = false
  return mesh
}

// ---- curtain (table closed) -----------------------------------------------------------------

export const CURTAIN_UP_Y = 3.4

/** Red velvet slats with a gold hem and a CLOSED plaque; raised out of view while the table is open. */
export function curtain(): THREE.Group {
  const group = new THREE.Group()
  const boxes = []
  for (let i = 0; i < 18; i++) {
    const x = -TABLE_W / 2 - 0.2 + i * 0.27
    const tone = i % 2 === 0 ? '#8e1b2b' : '#741522'
    boxes.push({ size: [0.27, 3.2, 0.12] as const, at: [x, 1.6, (i % 2) * 0.06] as const, color: tone })
  }
  boxes.push({ size: [TABLE_W + 0.6, 0.12, 0.22] as const, at: [-0.05, 0.06, 0.03] as const, color: PALETTE.gold })
  group.add(voxelPart(boxes))
  const plaque = textSprite(0.34, 7)
  plaque.set('CLOSED', PALETTE.red)
  plaque.sprite.position.set(0, 1.3, 0.25)
  group.add(plaque.sprite)
  group.position.set(0, CURTAIN_UP_Y, -0.9)
  group.visible = false
  return group
}
