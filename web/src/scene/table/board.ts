// The dealer's display: a lit board on a stand beside the dealer, like the history board of a
// casino roulette. It shows the table's offer, the dealer's pricing reason and the last results.
import * as THREE from 'three'
import { pixelTexture, voxelPart } from '../voxel'
import { PALETTE } from './props'

export interface BoardLine {
  label: string
  value: string
  color?: string
}

export interface BoardResult {
  text: string
  /** Chip colour of the result: pocket colour, win/loss. */
  color: string
}

export interface BoardInfo {
  title: string
  lines: BoardLine[]
  /** The dealer's current pricing reason. */
  strategy: string
  /** Oldest first; the board shows the last ones. */
  results: BoardResult[]
}

export interface Board {
  object: THREE.Group
  set(info: BoardInfo): void
}

const PX_W = 640
const PX_H = 400
const WORLD_W = 1.5
const MAX_RESULTS = 10
const FONT = '"JetBrains Mono", ui-monospace, monospace'

/** Splits `text` into lines that fit `width` px with the current font (at most `max` lines). */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (ctx.measureText(next).width <= width || !line) line = next
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines.length > max ? [...lines.slice(0, max - 1), `${lines[max - 1]}…`] : lines
}

function paint(ctx: CanvasRenderingContext2D, w: number, h: number, info: BoardInfo | null): void {
  ctx.fillStyle = '#0d0b0c'
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = PALETTE.gold
  ctx.lineWidth = 6
  ctx.strokeRect(3, 3, w - 6, h - 6)
  if (!info) return
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.fillStyle = PALETTE.pink
  ctx.font = `bold 34px ${FONT}`
  ctx.fillText(info.title, 22, 18)

  ctx.font = `24px ${FONT}`
  info.lines.forEach((line, i) => {
    const y = 66 + i * 32
    ctx.fillStyle = 'rgba(243,234,210,0.6)'
    ctx.fillText(line.label, 22, y)
    ctx.fillStyle = line.color ?? PALETTE.cream
    ctx.textAlign = 'right'
    ctx.fillText(line.value, w - 22, y)
    ctx.textAlign = 'left'
  })

  const strategyY = 66 + info.lines.length * 32 + 8
  ctx.fillStyle = PALETTE.gold
  ctx.font = `italic 22px ${FONT}`
  wrap(ctx, `“${info.strategy}”`, w - 44, 2).forEach((line, i) => ctx.fillText(line, 22, strategyY + i * 26))

  const results = info.results.slice(-MAX_RESULTS)
  const cell = (w - 44) / MAX_RESULTS
  const y = h - 70
  ctx.fillStyle = 'rgba(243,234,210,0.5)'
  ctx.font = `18px ${FONT}`
  ctx.fillText(results.length ? 'LAST RESULTS →' : 'NO ROUNDS YET', 22, y - 26)
  ctx.font = `bold 22px ${FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  results.forEach((result, i) => {
    const x = 22 + i * cell
    ctx.fillStyle = result.color
    ctx.fillRect(x + 3, y, cell - 6, 46)
    // The newest result gets a gold frame.
    if (i === results.length - 1) {
      ctx.strokeStyle = PALETTE.gold
      ctx.lineWidth = 4
      ctx.strokeRect(x + 1, y - 2, cell - 2, 50)
    }
    ctx.fillStyle = '#fbf6ea'
    ctx.fillText(result.text, x + cell / 2, y + 24)
  })
}

export function createBoard(): Board {
  let info: BoardInfo | null = null
  const screen = pixelTexture(PX_W, PX_H, (ctx, w, h) => paint(ctx, w, h, info), { smooth: true })
  const object = new THREE.Group()
  const worldH = (WORLD_W * PX_H) / PX_W
  // Unlit: a screen glows in the dim room.
  const face = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_W, worldH), new THREE.MeshBasicMaterial({ map: screen.texture }))
  face.position.set(0, 0, 0.051)
  const frame = voxelPart([
    { size: [WORLD_W + 0.08, worldH + 0.08, 0.1], at: [0, 0, 0], color: '#1a1214' },
    { size: [0.08, 1.6, 0.08], at: [0, -worldH / 2 - 0.8, -0.02], color: '#2a1a14' },
    { size: [0.5, 0.06, 0.4], at: [0, -worldH / 2 - 1.6, -0.02], color: '#2a1a14' },
  ])
  object.add(frame, face)
  return {
    object,
    set(next) {
      info = next
      screen.redraw()
    },
  }
}
