// The casino floor: every dealer at its own small table in a gentle arc, mood and reason from
// the live lobby, an idle animation per game so the room feels alive. Hover lights a table up,
// click opens it.
import * as THREE from 'three'
import { formatBp } from '../../format'
import type { DealerView } from '../../near/views'
import { createCharacter } from '../characters'
import { dealerLook } from '../looks'
import { dealerMood } from '../mood'
import { mountRenderer } from '../renderer'
import { Animator, PALETTE } from '../table/props'
import type { CharacterRig, Mood } from '../types'
import { pixelTexture, px, voxelPart } from '../voxel'
import {
  buildDrapes,
  buildNameplate,
  buildRug,
  buildTableMesh,
  createProp,
  DEALER_Z,
  LOBBY_TABLE_D,
  LOBBY_TABLE_W,
  type Drapes,
  type LobbyProp,
  type Nameplate,
} from './props'

export interface LobbySceneApi {
  setDealers(dealers: readonly DealerView[]): void
  dispose(): void
}

const SPACING = 3.1
/** z = ARC × x²: outer tables come forward, so the row curves around the viewer. */
const ARC = 0.05
const CAMERA_Z = 9.5
const LOOK_AT = new THREE.Vector3(0, 1.35, 0.6)
/** Half the floor width that must stay in view, beyond the outermost table centers. */
const FRAME_MARGIN = 2.4
const HOVER_LIFT = 0.06
const LAMP_ON = 7
const LAMP_OFF = 1.2
/** A press that moves farther than this (px) is a drag, not a click. */
const CLICK_SLOP = 6

interface FloorTable {
  dealer: DealerView
  group: THREE.Group
  rig: CharacterRig
  prop: LobbyProp
  plate: Nameplate
  rug: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  lamp: THREE.PointLight
  drapes: Drapes
  hit: THREE.Mesh
  hover: number
  closed: number
  mood: Mood
}

export function createLobbyScene(el: HTMLElement, onSelect: (dealerId: string) => void): LobbySceneApi {
  const mounted = mountRenderer(el)
  const { scene, camera, renderer } = mounted
  camera.fov = 38
  buildRoom(scene)

  const anim = new Animator()
  const tables = new Map<string, FloorTable>()
  let hovered: FloorTable | null = null
  let disposed = false

  const add = (dealer: DealerView): FloorTable => {
    const table = buildFloorTable(dealer)
    scene.add(table.group)
    tables.set(dealer.id, table)
    void idleLoop(table)
    return table
  }

  /** Plays the table's game now and then; happy dealers sometimes cheer, nervous ones despair. */
  const idleLoop = async (table: FloorTable): Promise<void> => {
    await anim.wait(0.5 + Math.random() * 3)
    while (!disposed && tables.get(table.dealer.id) === table) {
      if (table.dealer.open) await table.prop.play(table.rig, anim)
      if (table.mood === 'happy' && Math.random() < 0.3) await table.rig.gesture({ kind: 'celebrate' })
      if (table.mood === 'nervous' && Math.random() < 0.3) await table.rig.gesture({ kind: 'facepalm' })
      await anim.wait(2 + Math.random() * 3)
    }
  }

  const layout = (): void => {
    const list = [...tables.values()]
    list.forEach((table, i) => {
      const x = (i - (list.length - 1) / 2) * SPACING
      const z = ARC * x * x
      table.group.position.set(x, 0, z)
      table.group.rotation.y = Math.atan2(-x, CAMERA_Z - z)
    })
  }

  const frameCamera = (elapsed: number): void => {
    const count = Math.max(1, tables.size)
    const halfWidth = ((count - 1) / 2) * SPACING + FRAME_MARGIN
    const tanHalfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect
    // Narrow screens back the camera off so the whole row stays in frame.
    const distance = Math.max(CAMERA_Z, halfWidth / tanHalfH + 1)
    camera.position.set(Math.sin(elapsed * 0.08) * 1.2, 2.6 + distance * 0.12 + Math.sin(elapsed * 0.11) * 0.25, distance)
    camera.lookAt(LOOK_AT)
  }

  const unsubscribe = mounted.onFrame((dt, elapsed) => {
    anim.update(dt)
    frameCamera(elapsed)
    for (const table of tables.values()) updateTable(table, table === hovered, dt)
  })

  // ---- pointer --------------------------------------------------------------------------------

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  let pressedAt: { x: number; y: number } | null = null

  const pick = (event: PointerEvent): FloorTable | null => {
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointer, camera)
    const hits = raycaster.intersectObjects([...tables.values()].map((t) => t.hit), false)
    const first = hits[0]?.object
    return [...tables.values()].find((t) => t.hit === first) ?? null
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
    const table = pick(event)
    if (table) onSelect(table.dealer.id)
  }
  const canvas = renderer.domElement
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', onUp)

  // Canvas text drawn before the web font loaded uses the fallback: redraw once it is there.
  void document.fonts?.ready.then(() => {
    if (!disposed) for (const table of tables.values()) table.plate.redraw()
  })

  return {
    setDealers(dealers) {
      const ids = new Set(dealers.map((d) => d.id))
      let changed = false
      for (const [id, table] of tables) {
        if (ids.has(id)) continue
        table.rig.dispose()
        scene.remove(table.group)
        tables.delete(id)
        changed = true
      }
      for (const dealer of dealers) {
        let table = tables.get(dealer.id)
        if (!table) {
          table = add(dealer)
          changed = true
        }
        applyDealer(table, dealer)
      }
      if (changed) layout()
    },
    dispose() {
      disposed = true
      unsubscribe()
      anim.finishAll()
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      for (const table of tables.values()) table.rig.dispose()
      tables.clear()
      mounted.dispose()
    },
  }
}

// ---- one table --------------------------------------------------------------------------------

function buildFloorTable(dealer: DealerView): FloorTable {
  const look = dealerLook(dealer.id)
  const group = new THREE.Group()
  const rig = createCharacter(look, dealer.name)
  rig.object.position.z = DEALER_Z
  const prop = createProp(dealer.game)
  const plate = buildNameplate(look.accent)
  const rug = buildRug(look.accent) as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  const lamp = new THREE.PointLight('#ffd7a0', LAMP_ON, 5, 1.4)
  lamp.position.set(0, 2.7, 0.3)
  const drapes = buildDrapes()
  // An invisible box around table and dealer: an easy target for hover and click.
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(LOBBY_TABLE_W + 0.4, 2.6, LOBBY_TABLE_D + 1.4),
    new THREE.MeshBasicMaterial({ visible: false }),
  )
  hit.position.set(0, 1.3, -0.3)
  group.add(buildTableMesh(look.accent), rig.object, prop.object, plate.object, rug, lamp, drapes.object, hit)
  return { dealer, group, rig, prop, plate, rug, lamp, drapes, hit, hover: 0, closed: dealer.open ? 0 : 1, mood: 'neutral' }
}

function applyDealer(table: FloorTable, dealer: DealerView): void {
  table.dealer = dealer
  table.mood = dealerMood(dealer)
  table.rig.setMood(table.mood)
  table.rig.say(dealer.reason_text)
  table.plate.set({ name: dealer.name, game: dealer.game, edge: formatBp(dealer.total_edge_bp), open: dealer.open })
}

function updateTable(table: FloorTable, hovered: boolean, dt: number): void {
  const ease = Math.min(1, dt * 8)
  table.hover += ((hovered ? 1 : 0) - table.hover) * ease
  table.closed += ((table.dealer.open ? 0 : 1) - table.closed) * Math.min(1, dt * 3)
  table.group.position.y = table.hover * HOVER_LIFT
  table.rug.material.opacity = 0.12 + table.hover * 0.38
  table.lamp.intensity = THREE.MathUtils.lerp(LAMP_ON, LAMP_OFF, table.closed) + table.hover * 3
  table.drapes.set(table.closed)
  table.prop.update(dt)
  table.rig.update(dt)
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
