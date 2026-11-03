// Shared three.js plumbing for the lobby and table scenes: one renderer per mounted element,
// sized to it, capped pixel ratio, paused while the tab is hidden, fully disposed on unmount.
import * as THREE from 'three'

export type FrameCallback = (dt: number, elapsed: number) => void

export interface MountedRenderer {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  /** Registers a per-frame callback (dt in seconds); returns its unsubscribe function. */
  onFrame(cb: FrameCallback): () => void
  dispose(): void
}

const MAX_PIXEL_RATIO = 2
// A long pause (tab switch, debugger) must not make animations jump ahead in one frame.
const MAX_DT = 0.1

export function mountRenderer(el: HTMLElement): MountedRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  el.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200)

  const resize = (): void => {
    const width = Math.max(1, el.clientWidth)
    const height = Math.max(1, el.clientHeight)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }
  resize()
  const observer = new ResizeObserver(resize)
  observer.observe(el)

  const callbacks = new Set<FrameCallback>()
  let elapsed = 0
  let frame = 0
  let last = 0

  const tick = (now: number): void => {
    frame = requestAnimationFrame(tick)
    const dt = Math.min(Math.max(0, now - last) / 1000, MAX_DT)
    last = now
    elapsed += dt
    for (const cb of callbacks) cb(dt, elapsed)
    renderer.render(scene, camera)
  }
  const start = (): void => {
    if (frame !== 0) return
    last = performance.now()
    frame = requestAnimationFrame(tick)
  }
  const stop = (): void => {
    cancelAnimationFrame(frame)
    frame = 0
  }
  const onVisibility = (): void => (document.hidden ? stop() : start())
  document.addEventListener('visibilitychange', onVisibility)
  if (!document.hidden) start()

  return {
    scene,
    camera,
    renderer,
    onFrame(cb) {
      callbacks.add(cb)
      return () => callbacks.delete(cb)
    },
    dispose() {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      observer.disconnect()
      callbacks.clear()
      disposeObject(scene)
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}

/** Frees geometries, materials and their textures under `root`. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as Partial<THREE.Mesh> & THREE.Object3D
    mesh.geometry?.dispose()
    const material = mesh.material
    if (!material) return
    for (const m of Array.isArray(material) ? material : [material]) disposeMaterial(m)
  })
}

function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) value.dispose()
  }
  material.dispose()
}
