// A dealer's speech bubble: a sprite (always faces the camera) with a canvas texture, blocky
// border and tail, word-wrapped text, fading in and out.
import * as THREE from 'three'
import { pixelTexture, type PixelTexture } from './voxel'

/** Longer reasons are cut with an ellipsis: the bubble is a teaser, the page has the full text. */
export const BUBBLE_MAX_CHARS = 60
const CANVAS_W = 512
const CANVAS_H = 210
const FONT_PX = 38
const LINE_H = 44
const MAX_LINES = 3
const PADDING = 22
const TAIL_H = 26
const WORLD_WIDTH = 2.3
const FADE_PER_S = 4

export function clipText(text: string, max = BUBBLE_MAX_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
}

/** Greedy word wrap with a measure function (canvas `measureText` in the browser). */
export function wrapWords(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const candidate = line ? `${line} ${word}` : word
    if (measure(candidate) <= maxWidth || !line) {
      line = candidate
      continue
    }
    lines.push(line)
    line = word
  }
  if (line) lines.push(line)
  return lines
}

export interface Bubble {
  readonly object: THREE.Sprite
  say(text: string | null): void
  update(dt: number): void
}

export function createBubble(accent: string): Bubble {
  let text = ''
  let shown = 0
  let visible = false
  const art: PixelTexture = pixelTexture(CANVAS_W, CANVAS_H, (ctx) => drawBubble(ctx, text, accent), { smooth: true })
  const material = new THREE.SpriteMaterial({ map: art.texture, transparent: true, opacity: 0, depthTest: false, depthWrite: false })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(WORLD_WIDTH, (WORLD_WIDTH * CANVAS_H) / CANVAS_W, 1)
  sprite.center.set(0.5, 0) // anchored at the tail tip, so it grows upward from the head
  sprite.renderOrder = 10
  sprite.visible = false

  return {
    object: sprite,
    say(next) {
      const clipped = next ? clipText(next) : ''
      visible = clipped !== ''
      if (!visible || clipped === text) return
      text = clipped
      art.redraw()
    },
    update(dt) {
      const target = visible ? 1 : 0
      shown = target > shown ? Math.min(target, shown + dt * FADE_PER_S) : Math.max(target, shown - dt * FADE_PER_S)
      material.opacity = shown
      sprite.visible = shown > 0.01
      // A small pop on entry reads as "speaking".
      const pop = 0.85 + 0.15 * shown
      sprite.scale.set(WORLD_WIDTH * pop, ((WORLD_WIDTH * CANVAS_H) / CANVAS_W) * pop, 1)
    },
  }
}

function drawBubble(ctx: CanvasRenderingContext2D, text: string, accent: string): void {
  ctx.font = `bold ${FONT_PX}px 'JetBrains Mono', ui-monospace, monospace`
  const lines = wrapWords(text, CANVAS_W - PADDING * 2, (s) => ctx.measureText(s).width).slice(0, MAX_LINES)
  const boxH = lines.length * LINE_H + PADDING * 1.4
  const top = CANVAS_H - TAIL_H - boxH
  const step = 8 // stepped corners instead of round ones: same pixel language as the dealers
  ctx.fillStyle = accent
  ctx.fillRect(step, top, CANVAS_W - step * 2, boxH)
  ctx.fillRect(0, top + step, CANVAS_W, boxH - step * 2)
  ctx.fillStyle = '#141517'
  ctx.fillRect(step + 4, top + 4, CANVAS_W - step * 2 - 8, boxH - 8)
  ctx.fillRect(4, top + step + 4, CANVAS_W - 8, boxH - step * 2 - 8)
  drawTail(ctx, accent, top + boxH)
  ctx.fillStyle = '#f2f2f2'
  ctx.textBaseline = 'top'
  ctx.textAlign = 'center'
  lines.forEach((line, i) => ctx.fillText(line, CANVAS_W / 2, top + PADDING * 0.7 + i * LINE_H))
}

function drawTail(ctx: CanvasRenderingContext2D, accent: string, y: number): void {
  const cx = CANVAS_W / 2
  for (let row = 0; row < 3; row++) {
    const w = 24 - row * 8
    ctx.fillStyle = accent
    ctx.fillRect(cx - w / 2 - 4, y - 4 + row * 8, w + 8, 8)
    ctx.fillStyle = '#141517'
    if (w > 8) ctx.fillRect(cx - w / 2 + 4, y - 4 + row * 8, w - 8, 8)
  }
}
