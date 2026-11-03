// Blocky building blocks: each body part is one mesh merged from colored boxes (one draw call,
// vertex colors, flat shading), plus tiny canvas textures drawn pixel by pixel for faces and signs.
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export type Vec3 = readonly [number, number, number]

export interface VoxelBox {
  /** Width, height, depth. */
  size: Vec3
  /** Center of the box, relative to the part's origin (its pivot). */
  at: Vec3
  color: THREE.ColorRepresentation
}

function coloredBox(box: VoxelBox): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(...box.size)
  geometry.translate(...box.at)
  const color = new THREE.Color(box.color)
  const count = geometry.getAttribute('position').count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) color.toArray(colors, i * 3)
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geometry
}

/** One mesh from several boxes; the part's origin is its pivot, so rotate it to animate. */
export function voxelPart(boxes: readonly VoxelBox[], options: { shadows?: boolean } = {}): THREE.Mesh {
  const pieces = boxes.map(coloredBox)
  const geometry = mergeGeometries(pieces)
  for (const piece of pieces) piece.dispose()
  if (!geometry) throw new Error('voxelPart: could not merge boxes')
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }))
  const shadows = options.shadows ?? true
  mesh.castShadow = shadows
  mesh.receiveShadow = shadows
  return mesh
}

/** Draws on a small canvas; `draw` gets the 2D context and is called again by `redraw()`. */
export interface PixelTexture {
  texture: THREE.CanvasTexture
  redraw(): void
}

export function pixelTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
  options: { smooth?: boolean } = {},
): PixelTexture {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('pixelTexture: no 2D canvas context')
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  if (!options.smooth) {
    // Hard pixel edges: the whole point of the blocky look.
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    texture.generateMipmaps = false
  }
  const redraw = (): void => {
    ctx.clearRect(0, 0, width, height)
    draw(ctx, width, height)
    texture.needsUpdate = true
  }
  redraw()
  return { texture, redraw }
}

/** BoxGeometry face order is +X, -X, +Y, -Y, +Z, -Z: index of the front (+Z) face. */
export const FRONT_FACE = 4

/** A single box whose front (+Z) face shows `front` and other faces a flat color. */
export function texturedBox(size: Vec3, color: THREE.ColorRepresentation, front: THREE.Texture): THREE.Mesh {
  const plain = (): THREE.Material => new THREE.MeshLambertMaterial({ color, flatShading: true })
  const materials = [plain(), plain(), plain(), plain(), plain(), plain()]
  materials[FRONT_FACE] = new THREE.MeshLambertMaterial({ map: front })
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), materials)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

/** Fills one pixel-art cell (integer coordinates on a low-res canvas). */
export function px(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w = 1, h = 1): void {
  ctx.fillStyle = color
  ctx.fillRect(x, y, w, h)
}

/** Darkens (negative) or lightens (positive) a CSS color, for shading boxes of the same part. */
export function shade(color: THREE.ColorRepresentation, amount: number): string {
  const c = new THREE.Color(color)
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl)
  c.setHSL(hsl.h, hsl.s, THREE.MathUtils.clamp(hsl.l + amount, 0, 1))
  return `#${c.getHexString()}`
}
