// Roulette props: a European wheel (37 pockets in wheel order), a ball that orbits the track and
// drops into the drawn pocket, and the betting layout printed on the felt.
import * as THREE from 'three'
import { pocketColor } from '../../house'
import { pixelTexture, voxelPart } from '../voxel'
import { betCell, numberCell, OUTSIDE, type Cell } from './felt'
import { type Animator, easeOut, feltPoint, PALETTE, textSprite, type TextSprite } from './props'

/** Pockets in European wheel order, going around the rotor. */
export const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29,
  7, 28, 12, 35, 3, 26,
] as const
const STEP = (Math.PI * 2) / WHEEL_ORDER.length

/** Felt point of the wheel's center. */
export const WHEEL_AT = { u: 0.22, v: 0.47 }
const ROTOR_R = 0.52
const POCKET_R = 0.42
const TRACK_R = 0.61
const ROTOR_Y = 0.105
const TRACK_Y = 0.15
const IDLE_SPEED = 0.35
const SPIN_SECONDS = 3.8
/** While the draw runs: the rotor turns faster and the ball orbits the track (rad/s). */
const RUN_ROTOR_SPEED = 1.4
const RUN_BALL_SPEED = 9
/** From the running loop the ball only has to slow down and drop: a short landing. */
const LAND_SECONDS = 2

const COLOR = { red: '#b3202f', black: '#17161a', green: '#178a4a' } as const

/** Angle of a pocket on the rotor (counterclockwise from +X seen from above, like `rotation.y`). */
export function pocketAngle(pocket: number): number {
  return WHEEL_ORDER.indexOf(pocket as (typeof WHEEL_ORDER)[number]) * STEP
}

function rotorTexture(): THREE.Texture {
  const size = 512
  const c = size / 2
  return pixelTexture(
    size,
    size,
    (ctx) => {
      ctx.fillStyle = '#4a2a18'
      ctx.fillRect(0, 0, size, size)
      WHEEL_ORDER.forEach((pocket, k) => {
        // Canvas angles run clockwise (y down); the disc maps canvas (cos a, sin a) to rotor angle -a.
        const a = -k * STEP
        ctx.beginPath()
        ctx.moveTo(c, c)
        ctx.arc(c, c, c, a - STEP / 2, a + STEP / 2)
        ctx.closePath()
        ctx.fillStyle = COLOR[pocketColor(pocket)]
        ctx.fill()
        ctx.save()
        ctx.translate(c + Math.cos(a) * c * 0.88, c + Math.sin(a) * c * 0.88)
        ctx.rotate(a + Math.PI / 2)
        ctx.fillStyle = '#f7f1e3'
        ctx.font = 'bold 22px "JetBrains Mono", ui-monospace, monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(pocket), 0, 0)
        ctx.restore()
      })
      ctx.beginPath()
      ctx.arc(c, c, c * 0.68, 0, Math.PI * 2)
      ctx.fillStyle = '#6b3d22'
      ctx.fill()
      ctx.strokeStyle = PALETTE.gold
      ctx.lineWidth = 4
      ctx.stroke()
    },
    { smooth: true },
  ).texture
}

function buildRotor(): THREE.Group {
  const rotor = new THREE.Group()
  const disc = new THREE.Mesh(new THREE.CircleGeometry(ROTOR_R, 74), new THREE.MeshLambertMaterial({ map: rotorTexture() }))
  disc.rotation.x = -Math.PI / 2
  disc.position.y = ROTOR_Y
  disc.receiveShadow = true
  rotor.add(disc)
  const fretGeometry = new THREE.BoxGeometry(0.17, 0.03, 0.012)
  const fretMaterial = new THREE.MeshLambertMaterial({ color: '#d9c58a' })
  for (let k = 0; k < WHEEL_ORDER.length; k++) {
    const fret = new THREE.Mesh(fretGeometry, fretMaterial)
    const a = (k + 0.5) * STEP
    fret.position.set(Math.cos(a) * 0.43, ROTOR_Y + 0.015, -Math.sin(a) * 0.43)
    fret.rotation.y = a
    rotor.add(fret)
  }
  const turret = voxelPart([
    { size: [0.16, 0.06, 0.16], at: [0, ROTOR_Y + 0.03, 0], color: PALETTE.gold },
    { size: [0.08, 0.1, 0.08], at: [0, ROTOR_Y + 0.11, 0], color: PALETTE.gold },
    { size: [0.34, 0.03, 0.04], at: [0, ROTOR_Y + 0.13, 0], color: '#d4a64a' },
    { size: [0.04, 0.03, 0.34], at: [0, ROTOR_Y + 0.13, 0], color: '#d4a64a' },
    { size: [0.05, 0.05, 0.05], at: [0, ROTOR_Y + 0.19, 0], color: '#fff2c0' },
  ])
  rotor.add(turret)
  return rotor
}

function buildBowl(): THREE.Group {
  const bowl = new THREE.Group()
  const wood = new THREE.MeshLambertMaterial({ color: '#5b3420', flatShading: true })
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.74, 0.1, 24), wood)
  base.position.y = 0.05
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(0.72, 0.72, 0.08, 24, 1, true),
    new THREE.MeshLambertMaterial({ color: '#7a4a2a', flatShading: true, side: THREE.DoubleSide }),
  )
  wall.position.y = 0.14
  const track = new THREE.Mesh(new THREE.RingGeometry(ROTOR_R, 0.72, 48), new THREE.MeshLambertMaterial({ color: '#2a1810' }))
  track.rotation.x = -Math.PI / 2
  track.position.y = TRACK_Y - 0.02
  for (const part of [base, wall, track]) part.receiveShadow = true
  base.castShadow = true
  bowl.add(base, wall, track)
  return bowl
}

export class Roulette {
  readonly group = new THREE.Group()
  private readonly rotor = buildRotor()
  private readonly ball: THREE.Mesh
  private readonly readout: TextSprite = textSprite(0.2, 8)
  private readonly dolly: THREE.Mesh
  private spinning = false
  /** The drawing loop is on; `ballAngle` is where the ball runs on the track. */
  private running = false
  private ballAngle = 0

  private readonly anim: Animator

  constructor(anim: Animator) {
    this.anim = anim
    this.group.position.copy(feltPoint(WHEEL_AT.u, WHEEL_AT.v))
    this.ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.03, 0), new THREE.MeshLambertMaterial({ color: '#fbfbf7', flatShading: true }))
    this.ball.castShadow = true
    this.ball.visible = false
    this.readout.sprite.position.set(0, 0.55, 0)
    this.dolly = voxelPart([
      { size: [0.06, 0.08, 0.06], at: [0, 0.04, 0], color: '#f7f1e3' },
      { size: [0.08, 0.03, 0.08], at: [0, 0.095, 0], color: PALETTE.gold },
    ])
    this.dolly.visible = false
    this.group.add(buildBowl(), this.rotor, this.readout.sprite)
  }

  /** The marker for the winning number; it sits on the felt, so the scene adds it to the table. */
  get marker(): THREE.Object3D {
    return this.dolly
  }

  update(dt: number): void {
    if (this.spinning) return
    this.rotor.rotation.y += dt * (this.running ? RUN_ROTOR_SPEED : IDLE_SPEED)
    if (!this.running) return
    this.ballAngle -= dt * RUN_BALL_SPEED
    this.ball.position.set(Math.cos(this.ballAngle) * TRACK_R, TRACK_Y, -Math.sin(this.ballAngle) * TRACK_R)
  }

  /** The drawing loop: the ball leaves its pocket and runs the track until `spin` lands it. */
  startRunning(): void {
    this.running = true
    this.ballAngle = this.rotor.rotation.y + Math.PI
    this.group.add(this.ball)
    this.ball.visible = true
    this.dolly.visible = false
    this.readout.set('')
  }

  stopRunning(): void {
    this.running = false
    this.ball.visible = false
  }

  clear(): void {
    // A ball already running for the next draw stays on the track.
    if (!this.running) this.ball.visible = false
    this.dolly.visible = false
    this.readout.set('')
  }

  /**
   * Spins the rotor one way and the ball the other, landing the ball in `pocket`. After the
   * drawing loop the ball is running already: it only slows down and drops.
   */
  async spin(pocket: number): Promise<void> {
    const landing = this.running
    this.running = false
    this.spinning = true
    this.group.add(this.ball)
    this.ball.visible = true
    const from = this.rotor.rotation.y
    const to = from + Math.PI * (landing ? 0.5 : 2.5)
    const ballFrom = landing ? this.ballAngle : from + Math.PI
    const ballTo = to + pocketAngle(pocket)
    // The ball runs the other way: laps back, ending exactly on the pocket.
    const laps = Math.PI * (landing ? 2 : 8)
    const travel = (((ballFrom - ballTo) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) + laps
    await this.anim.tween(
      landing ? LAND_SECONDS : SPIN_SECONDS,
      (t) => {
        this.rotor.rotation.y = from + (to - from) * easeOut(t)
        const angle = ballFrom - travel * easeOut(t)
        const drop = Math.max(0, (t - 0.62) / 0.38)
        const radius = TRACK_R + (POCKET_R - TRACK_R) * Math.min(1, drop * 1.6)
        const hop = drop > 0 && drop < 1 ? Math.abs(Math.sin(drop * Math.PI * 4)) * 0.05 * (1 - drop) : 0
        this.ball.position.set(Math.cos(angle) * radius, TRACK_Y + hop - drop * 0.03, -Math.sin(angle) * radius)
      },
      (t) => t,
    )
    // Ride with the rotor from now on.
    this.rotor.attach(this.ball)
    this.spinning = false
    const color = pocketColor(pocket)
    this.readout.set(`${pocket} ${color.toUpperCase()}`, color === 'red' ? PALETTE.red : color === 'green' ? PALETTE.green : PALETTE.cream)
    const cell = numberCell(pocket)
    this.dolly.position.copy(feltPoint(cell.u + cell.w / 2, cell.v + cell.h / 2))
    this.dolly.visible = true
  }
}

// ---- betting layout (felt coordinates, see felt.ts) -------------------------------------

const OUTSIDE_LABEL: Record<(typeof OUTSIDE)[number], string> = {
  low: '1-18',
  even: 'EVEN',
  red: 'RED',
  black: 'BLACK',
  odd: 'ODD',
  high: '19-36',
}

export function paintRouletteFelt(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const box = (cell: Cell, fill: string | null, label: string, color = '#f3ead2') => {
    const x = cell.u * w
    const y = cell.v * h
    if (fill) {
      ctx.fillStyle = fill
      ctx.fillRect(x, y, cell.w * w, cell.h * h)
    }
    ctx.strokeStyle = 'rgba(243,234,210,0.8)'
    ctx.lineWidth = 2
    ctx.strokeRect(x, y, cell.w * w, cell.h * h)
    ctx.fillStyle = color
    ctx.fillText(label, x + (cell.w * w) / 2, y + (cell.h * h) / 2 + 1)
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = 'bold 18px "JetBrains Mono", ui-monospace, monospace'
  for (let n = 0; n <= 36; n++) box(numberCell(n), COLOR[pocketColor(n)], String(n))
  for (const column of [1, 2, 3]) box(betCell({ column }), null, '2:1')
  for (const dozen of [1, 2, 3]) box(betCell({ dozen }), null, ['1st 12', '2nd 12', '3rd 12'][dozen - 1])
  for (const bet of OUTSIDE) {
    const fill = bet === 'red' ? COLOR.red : bet === 'black' ? COLOR.black : null
    box(betCell(bet), fill, OUTSIDE_LABEL[bet])
  }
}
