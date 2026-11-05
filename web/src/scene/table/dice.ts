// Dice props: a leather cup, two big blocky dice whose top faces read the roll (42 | 17 for
// 42.17), and a 0-100 bar on the felt with the bet's winning zone and a marker for the roll.
import * as THREE from 'three'
import { diceWins } from '../../house'
import { pixelTexture, voxelPart, type PixelTexture } from '../voxel'
import { type Animator, arcTo, feltPoint, PALETTE, textSprite, type TextSprite } from './props'

const DIE = 0.3
const CUP_AT = { u: 0.63, v: 0.2 }
const REST = [
  { u: 0.45, v: 0.48 },
  { u: 0.55, v: 0.5 },
] as const
const BAR = { u0: 0.14, u1: 0.86, v: 0.8 }
const BAR_W = (BAR.u1 - BAR.u0) * 4.2
const BAR_H = 0.3
const SHAKE_STEP = 0.07
/** `roll` is 0..9999: shown as 0.00-99.99. */
export const ROLL_SCALE = 100

export interface DiceBet {
  chance_bp: number
  over: boolean
}

/** "42.17" for 4217. */
export function rollLabel(roll: number): string {
  return (roll / ROLL_SCALE).toFixed(2).padStart(5, '0')
}

const PIPS: Record<number, [number, number][]> = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
}

function pipTexture(n: number): THREE.Texture {
  return pixelTexture(9, 9, (ctx) => {
    ctx.fillStyle = '#f7f1e3'
    ctx.fillRect(0, 0, 9, 9)
    ctx.fillStyle = n === 1 ? '#c8283c' : '#17161a'
    for (const [x, y] of PIPS[n]) ctx.fillRect(1 + x * 3, 1 + y * 3, 1, 1)
  }).texture
}

class Die {
  readonly mesh: THREE.Mesh
  private text = ''
  private readonly top: PixelTexture

  constructor() {
    this.top = pixelTexture(
      64,
      64,
      (ctx, w, h) => {
        ctx.fillStyle = '#f7f1e3'
        ctx.fillRect(0, 0, w, h)
        ctx.strokeStyle = PALETTE.gold
        ctx.lineWidth = 4
        ctx.strokeRect(2, 2, w - 4, h - 4)
        ctx.fillStyle = '#17161a'
        ctx.font = 'bold 34px "JetBrains Mono", ui-monospace, monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(this.text, w / 2, h / 2 + 2)
      },
      { smooth: true },
    )
    // BoxGeometry faces: +X, -X, +Y, -Y, +Z, -Z. The readout is on top and on the face toward the
    // camera, which sees the dice from the front.
    const faces = [3, 4, 0, 6, 0, 5].map((n) =>
      n === 0 ? new THREE.MeshLambertMaterial({ map: this.top.texture }) : new THREE.MeshLambertMaterial({ map: pipTexture(n) }),
    )
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(DIE, DIE, DIE), faces)
    this.mesh.castShadow = true
  }

  show(text: string): void {
    this.text = text
    this.top.redraw()
  }
}

export class Dice {
  readonly group = new THREE.Group()
  private readonly dice = [new Die(), new Die()]
  private readonly cup: THREE.Mesh
  private readonly bar: PixelTexture
  private readonly marker: THREE.Mesh
  private readonly readout: TextSprite = textSprite(0.22, 7)
  private bet: DiceBet | null = null
  /** The drawing loop: the cup shakes in the air until `throw` tips it. */
  private shaking = false
  private shakeStep = -1

  private readonly anim: Animator

  constructor(anim: Animator) {
    this.anim = anim
    this.cup = buildCup()
    this.cup.position.copy(feltPoint(CUP_AT.u, CUP_AT.v))
    this.dice.forEach((die, i) => {
      die.mesh.position.copy(feltPoint(REST[i].u, REST[i].v, DIE / 2))
      die.mesh.rotation.y = (i - 0.5) * 0.3
      die.show(i === 0 ? 'TI' : 'LT')
      this.group.add(die.mesh)
    })
    this.bar = pixelTexture(1024, 104, (ctx, w, h) => paintBar(ctx, w, h, this.bet), { smooth: true })
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(BAR_W, BAR_H), new THREE.MeshLambertMaterial({ map: this.bar.texture, transparent: true }))
    bar.rotation.x = -Math.PI / 2
    bar.position.copy(feltPoint((BAR.u0 + BAR.u1) / 2, BAR.v, 0.002))
    this.marker = voxelPart([
      { size: [0.05, 0.12, 0.05], at: [0, 0.06, 0], color: PALETTE.gold },
      { size: [0.12, 0.05, 0.12], at: [0, 0.14, 0], color: PALETTE.gold },
    ])
    this.marker.visible = false
    this.readout.sprite.position.copy(feltPoint(0.32, 0.48, 0.3))
    this.group.add(this.cup, bar, this.marker, this.readout.sprite)
  }

  setBet(bet: DiceBet): void {
    this.bet = bet
    this.bar.redraw()
  }

  /** Dice back into the cup, readout off. */
  async clear(): Promise<void> {
    this.readout.set('')
    this.marker.visible = false
    // Already in the cup (cleared when the player clicked): the bet goes down at once.
    if (this.dice.every((die) => !die.mesh.visible)) return
    const inCup = this.cup.position.clone().setY(this.cup.position.y + DIE / 2)
    await Promise.all(this.dice.map((die) => arcTo(this.anim, die.mesh, inCup, 0.3, 0.15)))
    for (const die of this.dice) die.mesh.visible = false
  }

  startShaking(): void {
    this.shaking = true
  }

  stopShaking(): void {
    this.shaking = false
    this.cup.position.copy(feltPoint(CUP_AT.u, CUP_AT.v))
    this.cup.rotation.z = 0
  }

  /** Every frame: the drawing loop's stepped jitter, held a little above the felt. */
  update(elapsed: number): void {
    if (!this.shaking) return
    const step = Math.floor(elapsed / SHAKE_STEP)
    if (step === this.shakeStep) return
    this.shakeStep = step
    this.jitter(feltPoint(CUP_AT.u, CUP_AT.v), 0.18 + Math.random() * 0.06)
  }

  /**
   * Shakes the cup, tips it, the dice tumble out and land showing the roll, the marker slides to it.
   * After the drawing loop the cup is shaken already, so it tips at once.
   */
  async throw(roll: number): Promise<void> {
    if (this.shaking) this.stopShaking()
    else await this.shake()
    const label = rollLabel(roll)
    const [whole, cents] = label.split('.')
    await this.anim.tween(0.18, (t) => (this.cup.rotation.x = t * 1.1))
    await Promise.all(this.dice.map((die, i) => this.tumble(die, i)))
    this.dice[0].show(whole)
    this.dice[1].show(cents)
    void this.anim.tween(0.25, (t) => (this.cup.rotation.x = (1 - t) * 1.1))
    await this.slideMarker(roll)
    const win = this.bet ? diceWins(roll, this.bet.chance_bp, this.bet.over) : null
    this.readout.set(label, win === null ? PALETTE.cream : win ? PALETTE.green : PALETTE.red)
  }

  private async shake(): Promise<void> {
    const base = this.cup.position.clone()
    let next = 0
    // Snappy, stepped jitter: the cup jumps between poses instead of sliding.
    await this.anim.tween(
      0.7,
      (t) => {
        if (t < next && t < 1) return
        next = t + SHAKE_STEP / 0.7
        this.jitter(base, Math.sin(t * Math.PI) * 0.25)
      },
      (t) => t,
    )
    this.cup.position.copy(base)
    this.cup.rotation.z = 0
  }

  /** One random pose of the shaking cup, `lift` above `base`. */
  private jitter(base: THREE.Vector3, lift: number): void {
    this.cup.position.set(base.x + (Math.random() - 0.5) * 0.08, base.y + lift, base.z + (Math.random() - 0.5) * 0.06)
    this.cup.rotation.z = (Math.random() - 0.5) * 0.4
  }

  private async tumble(die: Die, i: number): Promise<void> {
    die.mesh.visible = true
    die.mesh.position.copy(this.cup.position).setY(this.cup.position.y + 0.25)
    const spin = new THREE.Euler(Math.random() * 3 + 4, Math.random() * 3, Math.random() * 3 + 4)
    let face = 0
    await Promise.all([
      arcTo(this.anim, die.mesh, feltPoint(REST[i].u, REST[i].v, DIE / 2), 0.6 + i * 0.08, 0.5),
      this.anim.tween(0.6 + i * 0.08, (t) => {
        die.mesh.rotation.set(spin.x * t, spin.y * t, spin.z * t)
        const step = Math.floor(t * 8)
        if (step !== face && t < 1) {
          face = step
          die.show(String(Math.floor(Math.random() * 100)).padStart(2, '0'))
        }
      }),
    ])
    // Snap flat, readout face up.
    die.mesh.rotation.set(0, (i - 0.5) * 0.3, 0)
  }

  private async slideMarker(roll: number): Promise<void> {
    const at = (fraction: number) => feltPoint(BAR.u0 + (BAR.u1 - BAR.u0) * fraction, BAR.v + 0.02, 0)
    this.marker.visible = true
    this.marker.position.copy(at(0))
    const to = at(roll / (ROLL_SCALE * ROLL_SCALE))
    await arcTo(this.anim, this.marker, to, 0.5, 0.12)
  }
}

function buildCup(): THREE.Mesh {
  return voxelPart([
    { size: [0.34, 0.04, 0.34], at: [0, 0.02, 0], color: PALETTE.gold },
    { size: [0.3, 0.32, 0.3], at: [0, 0.2, 0], color: '#6e1a24' },
    { size: [0.34, 0.04, 0.34], at: [0, 0.38, 0], color: PALETTE.gold },
    { size: [0.1, 0.03, 0.1], at: [0, 0.415, 0], color: '#f3ead2' },
  ])
}

/** Felt print: the dice game's rule line. */
export function paintDiceFelt(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.textAlign = 'center'
  ctx.font = 'bold 30px "JetBrains Mono", ui-monospace, monospace'
  ctx.fillStyle = PALETTE.gold
  ctx.fillText('DICE · ROLL 00.00 - 99.99', w / 2, h * 0.33)
  ctx.font = '22px "JetBrains Mono", ui-monospace, monospace'
  ctx.fillStyle = 'rgba(243,234,210,0.7)'
  ctx.fillText('PAYS FAIR ODDS · VRF DRAWN', w / 2, h * 0.38)
}

/** Scale 0-100 with the bet's winning zone in green and the rest in red. */
function paintBar(ctx: CanvasRenderingContext2D, w: number, h: number, bet: DiceBet | null): void {
  const top = 40
  const barH = h - top - 6
  ctx.fillStyle = 'rgba(10,10,10,0.55)'
  ctx.fillRect(0, top, w, barH)
  if (bet) {
    const edge = (bet.over ? 10_000 - bet.chance_bp : bet.chance_bp) / 10_000
    const split = edge * w
    ctx.fillStyle = bet.over ? 'rgba(240,113,95,0.75)' : 'rgba(124,207,143,0.85)'
    ctx.fillRect(0, top, split, barH)
    ctx.fillStyle = bet.over ? 'rgba(124,207,143,0.85)' : 'rgba(240,113,95,0.75)'
    ctx.fillRect(split, top, w - split, barH)
    ctx.fillStyle = PALETTE.gold
    ctx.fillRect(split - 3, top - 6, 6, barH + 6)
  }
  ctx.fillStyle = '#f3ead2'
  for (let tick = 0; tick <= 10; tick++) {
    const x = Math.min(w - 3, (tick / 10) * w)
    ctx.fillRect(x, top, 3, 12)
  }
  ctx.font = 'bold 28px "JetBrains Mono", ui-monospace, monospace'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  // Same rule as `diceWins`: over wins at or above 100 - chance, under wins below chance.
  const label = bet
    ? `ROLL ${bet.over ? '≥' : '<'} ${rollLabel(bet.over ? 10_000 - bet.chance_bp : bet.chance_bp)} WINS`
    : 'ROLL 00.00 - 99.99'
  ctx.fillText(label, w / 2, top / 2)
}
