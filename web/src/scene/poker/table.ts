// The poker furniture: a blocky oval table (stepped wooden rim around a printed felt), the dealer
// button, the deck, and the ring of blocks that counts down the player to act.
import * as THREE from 'three'
import { cardMesh } from '../table/cards'
import { PALETTE } from '../table/props'
import { pixelTexture, shade, voxelPart, type VoxelBox } from '../voxel'
import { OVAL_A, OVAL_B, POKER_FELT_Y } from './layout'

const RIM_BLOCKS = 72
const RIM_BLOCK = 0.26
const RIM_H = 0.13
const FELT_SEGMENTS = 48
const FELT_PX = 1024
/** Blocks in the turn timer ring; it empties one block at a time. */
export const TIMER_BLOCKS = 20
const TIMER_RADIUS = 0.42

export function buildOvalTable(accent: string, title: string): THREE.Group {
  const group = new THREE.Group()
  const print = pixelTexture(FELT_PX, FELT_PX, (ctx, w, h) => paintPokerFelt(ctx, w, h, accent, title), { smooth: true })
  const felt = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.1, FELT_SEGMENTS), [
    new THREE.MeshLambertMaterial({ color: PALETTE.felt }),
    new THREE.MeshLambertMaterial({ map: print.texture }),
    new THREE.MeshLambertMaterial({ color: PALETTE.felt }),
  ])
  felt.scale.set(OVAL_A, 1, OVAL_B)
  felt.position.y = POKER_FELT_Y - 0.05
  felt.receiveShadow = true
  group.add(felt, rim(accent))
  return group
}

/** Axis-aligned blocks stepping round the oval: the same chunky language as the characters. */
function rim(accent: string): THREE.Mesh {
  const wood = '#5b3420'
  const boxes: VoxelBox[] = []
  for (let i = 0; i < RIM_BLOCKS; i++) {
    const a = (i / RIM_BLOCKS) * Math.PI * 2
    const x = Math.sin(a) * (OVAL_A + RIM_BLOCK / 2)
    const z = Math.cos(a) * (OVAL_B + RIM_BLOCK / 2)
    boxes.push({ size: [RIM_BLOCK, RIM_H, RIM_BLOCK], at: [x, POKER_FELT_Y + RIM_H / 2 - 0.04, z], color: i % 2 ? wood : shade(wood, -0.08) })
    const tx = Math.sin(a) * (OVAL_A - 0.02)
    const tz = Math.cos(a) * (OVAL_B - 0.02)
    boxes.push({ size: [0.08, 0.03, 0.08], at: [tx, POKER_FELT_Y + 0.005, tz], color: accent })
  }
  // Pedestal: a narrower stack of dark blocks down to the carpet.
  boxes.push({ size: [OVAL_A * 1.2, POKER_FELT_Y - 0.2, OVAL_B * 0.9], at: [0, (POKER_FELT_Y - 0.1) / 2, 0], color: shade(wood, -0.15) })
  boxes.push({ size: [OVAL_A * 1.5, 0.12, OVAL_B * 1.2], at: [0, 0.06, 0], color: shade(wood, -0.2) })
  return voxelPart(boxes)
}

/** The cylinder cap maps the square texture onto the oval: the print sits in the inner circle. */
function paintPokerFelt(ctx: CanvasRenderingContext2D, w: number, h: number, accent: string, title: string): void {
  ctx.fillStyle = PALETTE.felt
  ctx.fillRect(0, 0, w, h)
  const cell = 16
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
      ctx.fillStyle = n - Math.floor(n) > 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.05)'
      ctx.fillRect(x, y, cell, cell)
    }
  }
  // A stepped inner line, inset from the rim.
  ctx.strokeStyle = 'rgba(243,234,210,0.35)'
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.ellipse(w / 2, h / 2, w * 0.43, h * 0.43, 0, 0, Math.PI * 2)
  ctx.stroke()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // The cap's u runs along x and v along z: text upright for the camera at +z.
  ctx.save()
  ctx.translate(w / 2, h / 2)
  ctx.scale(OVAL_B / OVAL_A, 1)
  ctx.fillStyle = 'rgba(243,234,210,0.22)'
  ctx.font = 'bold 54px "JetBrains Mono", ui-monospace, monospace'
  ctx.fillText(title.toUpperCase(), 0, h * 0.2)
  ctx.fillStyle = accent
  ctx.globalAlpha = 0.45
  ctx.font = 'bold 34px "JetBrains Mono", ui-monospace, monospace'
  ctx.fillText("NO-LIMIT HOLD'EM · PROVABLY FAIR", 0, h * 0.27)
  ctx.restore()
}

/** A white disc with a big D on top. */
export function dealerButton(): THREE.Mesh {
  const face = pixelTexture(64, 64, (ctx, w, h) => {
    ctx.fillStyle = '#f7f3e8'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#16161a'
    ctx.font = 'bold 44px "JetBrains Mono", ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('D', w / 2, h / 2 + 2)
  })
  const side = new THREE.MeshLambertMaterial({ color: '#d8d2c0' })
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.04, 8), [side, new THREE.MeshLambertMaterial({ map: face.texture }), side.clone()])
  mesh.castShadow = true
  return mesh
}

/** A short pile of face-down cards: where every dealt card flies from. */
export function deckPile(): THREE.Group {
  const group = new THREE.Group()
  for (let i = 0; i < 4; i++) {
    const card = cardMesh(null)
    card.rotation.z = Math.PI
    card.position.y = 0.006 + i * 0.012
    group.add(card)
  }
  return group
}

export interface TimerRing {
  object: THREE.Group
  /** 1 = full time left, 0 = out of time. */
  set(fraction: number): void
}

export function timerRing(): TimerRing {
  const object = new THREE.Group()
  const geometry = new THREE.BoxGeometry(0.07, 0.03, 0.07)
  const material = new THREE.MeshBasicMaterial({ color: PALETTE.gold })
  const blocks: THREE.Mesh[] = []
  for (let i = 0; i < TIMER_BLOCKS; i++) {
    const a = (i / TIMER_BLOCKS) * Math.PI * 2
    const block = new THREE.Mesh(geometry, material)
    block.position.set(Math.sin(a) * TIMER_RADIUS, 0.02, -Math.cos(a) * TIMER_RADIUS)
    blocks.push(block)
    object.add(block)
  }
  object.visible = false
  return {
    object,
    set(fraction) {
      const lit = Math.ceil(Math.max(0, Math.min(1, fraction)) * TIMER_BLOCKS)
      blocks.forEach((block, i) => (block.visible = i < lit))
      material.color.set(fraction < 0.25 ? PALETTE.red : PALETTE.gold)
    },
  }
}
