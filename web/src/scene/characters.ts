// The dealers: original blocky characters (boxes + a 16×16 pixel face), seated, facing +Z.
// Everything is animated procedurally from a small pose model (shoulders, elbows, lean, head):
// moods pick a resting pose and a face, gestures are short keyframe sequences on top of it.
// The lobby can also stand a dealer up and walk them on or off the floor (jointed legs).
import * as THREE from 'three'
import { createBubble } from './bubble'
import { disposeObject } from './renderer'
import type { CharacterRig, DealerLook, Gesture, Mood } from './types'
import { pixelTexture, px, shade, texturedBox, voxelPart, type Vec3, type VoxelBox } from './voxel'

/** Seat height: the body pivots at the hips. */
const HIP_Y = 0.55
/** Shoulder pivot, relative to the hips; the arms hang along -Y from it. */
const SHOULDER: Vec3 = [0.4, 0.64, 0]
const UPPER_ARM = 0.34
const NECK_Y = 0.72
const HEAD = 0.5
const PANTS = '#23252b'
const SHOES = '#121214'
const STOOL = '#5a3b26'
const BOW_TIE = '#16161a'

// ---- pose model -----------------------------------------------------------------------------

type Euler3 = [number, number, number]

interface Pose {
  /** Right shoulder rotation (XYZ); the dealer's right arm is on -X since it faces +Z. */
  rS: Euler3
  rE: number
  lS: Euler3
  lE: number
  /** Forward lean of the upper body (radians). */
  lean: number
  headX: number
  headY: number
  headZ: number
  /** Little hop of the upper body (celebrations). */
  lift: number
}

type Face = 'neutral' | 'happy' | 'nervous' | 'broke'

interface Keyframe {
  to: Partial<Pose>
  /** Seconds to reach `to` from the previous keyframe. */
  dur: number
  face?: Face
}

const REST: Pose = {
  rS: [-0.35, 0, 0.1],
  rE: -1.05,
  lS: [-0.35, 0, -0.1],
  lE: -1.05,
  lean: 0.05,
  headX: 0,
  headY: 0,
  headZ: 0,
  lift: 0,
}

const MOOD_POSE: Record<Mood, Pose> = {
  neutral: REST,
  happy: { ...REST, headX: -0.08, lean: 0 },
  nervous: { ...REST, rS: [-0.45, 0, 0.2], lS: [-0.45, 0, -0.2], rE: -1.25, lE: -1.25, lean: 0.12, headX: 0.06 },
  // Slumped over the table, arms dangling, head down.
  broke: { ...REST, rS: [-0.1, 0, 0.08], lS: [-0.1, 0, -0.08], rE: -0.35, lE: -0.35, lean: 0.35, headX: 0.2 },
}

/** Both arms, the left one mirrored (Y and Z rotations flip sign). */
function arms(s: Euler3, e: number): Partial<Pose> {
  return { rS: s, rE: e, lS: [s[0], -s[1], -s[2]], lE: e }
}

function gestureFrames(g: Exclude<Gesture, { kind: 'deal' }>): Keyframe[] {
  switch (g.kind) {
    case 'flip':
      return [
        { to: arms([-0.95, 0, 0.4], -0.85), dur: 0.22 },
        { to: { ...arms([-1.1, 0, 0.4], -1.7), headX: 0.15 }, dur: 0.14 },
        { to: arms([-0.95, 0, 0.4], -0.85), dur: 0.14 },
      ]
    case 'spin':
      return [
        { to: { rS: [-1.0, 0.2, 0.75], rE: -0.7, headY: 0.25 }, dur: 0.25 },
        { to: { rS: [-1.15, -0.2, -0.25], rE: -0.15 }, dur: 0.1 },
        { to: {}, dur: 0.35 },
      ]
    case 'throw':
      return [
        { to: { rS: [-1.3, 0, 0.35], rE: -1.7 }, dur: 0.2 },
        { to: { rE: -1.2 }, dur: 0.09 },
        { to: { rE: -1.8 }, dur: 0.09 },
        { to: { rE: -1.2 }, dur: 0.09 },
        { to: { rE: -1.8 }, dur: 0.09 },
        { to: { rS: [-1.45, 0, 0.1], rE: -0.05, lean: 0.2 }, dur: 0.12 },
        { to: {}, dur: 0.25 },
      ]
    case 'collect':
      return [
        { to: { ...arms([-1.2, 0, 0.2], -0.2), lean: 0.3 }, dur: 0.3 },
        { to: { ...arms([-0.35, 0, 0.3], -1.45), lean: 0.02 }, dur: 0.4 },
      ]
    case 'pay':
      return [
        { to: { ...arms([-0.35, 0, 0.3], -1.45), lean: 0.02 }, dur: 0.2 },
        { to: { ...arms([-1.2, 0, 0.2], -0.2), lean: 0.3 }, dur: 0.35 },
        { to: {}, dur: 0.15 },
      ]
    case 'celebrate':
      return [
        { to: { ...arms([-2.8, 0, -0.45], -0.3), lift: 0.08, headX: -0.2 }, dur: 0.2, face: 'happy' },
        { to: { ...arms([-2.5, 0, -0.7], -0.6), lift: 0 }, dur: 0.15, face: 'happy' },
        { to: { ...arms([-2.8, 0, -0.45], -0.3), lift: 0.08 }, dur: 0.15, face: 'happy' },
        { to: { ...arms([-2.5, 0, -0.7], -0.6), lift: 0 }, dur: 0.15, face: 'happy' },
        { to: {}, dur: 0.2, face: 'happy' },
      ]
    case 'facepalm':
      return [
        { to: { rS: [-1.45, 0, 0.95], rE: -2.4, headX: 0.3, headY: 0 }, dur: 0.3, face: 'broke' },
        { to: { headZ: 0.12 }, dur: 0.5, face: 'broke' },
        { to: { headZ: -0.12 }, dur: 0.5, face: 'broke' },
      ]
  }
}

const RETURN_DUR = 0.3

function lerpPose(a: Pose, b: Pose, k: number): Pose {
  const l = THREE.MathUtils.lerp
  const v = (x: Euler3, y: Euler3): Euler3 => [l(x[0], y[0], k), l(x[1], y[1], k), l(x[2], y[2], k)]
  return {
    rS: v(a.rS, b.rS),
    rE: l(a.rE, b.rE, k),
    lS: v(a.lS, b.lS),
    lE: l(a.lE, b.lE, k),
    lean: l(a.lean, b.lean, k),
    headX: l(a.headX, b.headX, k),
    headY: l(a.headY, b.headY, k),
    headZ: l(a.headZ, b.headZ, k),
    lift: l(a.lift, b.lift, k),
  }
}

// ---- face -----------------------------------------------------------------------------------

const EYE = '#1b1b22'
const WHITE = '#f4f4f4'
const MOUTH = '#6e2a2a'
const BLUSH = '#e98a8a'
const TEAR = '#6cc4ff'

function drawFace(ctx: CanvasRenderingContext2D, look: DealerLook, face: Face, blink: boolean): void {
  px(ctx, look.skin, 0, 0, 16, 16)
  px(ctx, look.hair, 0, 0, 16, 2) // fringe under the hat
  px(ctx, shade(look.skin, -0.08), 7, 9, 2, 1) // nose shadow
  if (face === 'happy') drawHappy(ctx, look)
  else if (face === 'nervous') drawNervous(ctx, look, blink)
  else if (face === 'broke') drawBroke(ctx, look)
  else drawNeutral(ctx, look, blink)
}

function drawEyes(ctx: CanvasRenderingContext2D, blink: boolean): void {
  for (const x of [4, 10]) {
    if (blink) {
      px(ctx, EYE, x, 8, 2, 1)
      continue
    }
    px(ctx, EYE, x, 7, 2, 2)
    px(ctx, WHITE, x, 7)
  }
}

function drawNeutral(ctx: CanvasRenderingContext2D, look: DealerLook, blink: boolean): void {
  px(ctx, look.hair, 3, 5, 3, 1)
  px(ctx, look.hair, 10, 5, 3, 1)
  drawEyes(ctx, blink)
  px(ctx, MOUTH, 6, 12, 4, 1)
}

function drawHappy(ctx: CanvasRenderingContext2D, look: DealerLook): void {
  px(ctx, look.hair, 3, 4, 3, 1)
  px(ctx, look.hair, 10, 4, 3, 1)
  for (const x of [3, 10]) {
    // ^ ^ eyes: happy squint, so no blink needed
    px(ctx, EYE, x, 8)
    px(ctx, EYE, x + 1, 7)
    px(ctx, EYE, x + 2, 8)
  }
  px(ctx, BLUSH, 2, 10, 2, 1)
  px(ctx, BLUSH, 12, 10, 2, 1)
  px(ctx, MOUTH, 5, 11)
  px(ctx, MOUTH, 10, 11)
  px(ctx, MOUTH, 6, 12, 4, 1)
  px(ctx, WHITE, 6, 11, 4, 1)
}

function drawNervous(ctx: CanvasRenderingContext2D, look: DealerLook, blink: boolean): void {
  // Brows raised in the middle: worry.
  px(ctx, look.hair, 3, 5, 2, 1)
  px(ctx, look.hair, 5, 4)
  px(ctx, look.hair, 11, 5, 2, 1)
  px(ctx, look.hair, 10, 4)
  for (const x of [3, 10]) {
    if (blink) {
      px(ctx, EYE, x, 8, 3, 1)
      continue
    }
    px(ctx, WHITE, x, 6, 3, 3)
    px(ctx, EYE, x + 1, 7)
  }
  for (let i = 0; i < 6; i++) px(ctx, MOUTH, 5 + i, i % 2 === 0 ? 12 : 11)
}

function drawBroke(ctx: CanvasRenderingContext2D, look: DealerLook): void {
  // Brows sloping down outward, eyes shut, a tear, and a frown.
  px(ctx, look.hair, 3, 6)
  px(ctx, look.hair, 4, 5, 2, 1)
  px(ctx, look.hair, 10, 5, 2, 1)
  px(ctx, look.hair, 12, 6)
  px(ctx, EYE, 3, 8, 3, 1)
  px(ctx, EYE, 10, 8, 3, 1)
  px(ctx, TEAR, 4, 9, 1, 2)
  px(ctx, MOUTH, 5, 12)
  px(ctx, MOUTH, 6, 11, 4, 1)
  px(ctx, MOUTH, 10, 12)
}

// ---- build ----------------------------------------------------------------------------------

/** Seated, the thigh is horizontal and knee-to-sole equals the seat height, so the feet touch the floor. */
const THIGH = 0.4
/** Standing (legs straight) raises the hips by the thigh length. */
const STAND_LIFT = THIGH
const SEATED_HIP_X = -Math.PI / 2
const SEATED_KNEE_X = Math.PI / 2
/** Seconds to stand up or sit down; steps per second and leg swing (radians) while walking. */
const STAND_S = 0.45
const STEP_RATE = 2.2
const LEG_SWING = 0.5
const KNEE_BEND = 0.7
const ARM_SWING = 0.45

export function buildStool(): THREE.Mesh {
  return voxelPart([
    { size: [0.5, 0.08, 0.5], at: [0, HIP_Y - 0.12, -0.02], color: STOOL },
    { size: [0.08, HIP_Y - 0.16, 0.08], at: [0, (HIP_Y - 0.16) / 2, -0.02], color: shade(STOOL, -0.1) },
    { size: [0.36, 0.04, 0.36], at: [0, 0.02, -0.02], color: shade(STOOL, -0.1) },
  ])
}

interface Leg {
  hip: THREE.Group
  knee: THREE.Group
}

/** A leg hanging along -Y from the hip; the seated pose folds it at hip and knee. */
function buildLeg(x: number): Leg {
  const hip = new THREE.Group()
  hip.position.set(x, HIP_Y, 0)
  hip.add(voxelPart([{ size: [0.24, THIGH + 0.1, 0.2], at: [0, -THIGH / 2, 0], color: PANTS }]))
  const knee = new THREE.Group()
  knee.position.y = -THIGH
  knee.add(
    voxelPart([
      { size: [0.22, HIP_Y - 0.1, 0.22], at: [0, -(HIP_Y - 0.1) / 2 - 0.05, 0], color: PANTS },
      { size: [0.24, 0.1, 0.32], at: [0, -HIP_Y + 0.05, 0.06], color: SHOES },
    ]),
  )
  hip.add(knee)
  hip.rotation.x = SEATED_HIP_X
  knee.rotation.x = SEATED_KNEE_X
  return { hip, knee }
}

/** A dealer the lobby can stand up and walk on or off the floor. */
export interface WalkerRig extends CharacterRig {
  /** The person without the stool: the lobby moves it (x, z, rotation.y) along a path. */
  readonly figure: THREE.Object3D
  /** Resolves once fully standing (true) or seated (false). */
  setStanding(standing: boolean): Promise<void>
  setWalking(walking: boolean): void
}

function buildTorso(look: DealerLook): THREE.Mesh {
  const button = shade(look.vest, 0.35)
  return voxelPart([
    { size: [0.62, 0.72, 0.36], at: [0, 0.36, 0], color: look.shirt },
    { size: [0.64, 0.6, 0.3], at: [0, 0.3, -0.04], color: look.vest },
    { size: [0.22, 0.6, 0.03], at: [-0.2, 0.3, 0.19], color: look.vest },
    { size: [0.22, 0.6, 0.03], at: [0.2, 0.3, 0.19], color: look.vest },
    { size: [0.04, 0.04, 0.02], at: [-0.12, 0.38, 0.21], color: button },
    { size: [0.04, 0.04, 0.02], at: [-0.12, 0.22, 0.21], color: button },
    { size: [0.64, 0.1, 0.37], at: [0, 0.04, 0], color: PANTS },
    // bow tie: two wings and a knot
    { size: [0.09, 0.08, 0.04], at: [-0.065, 0.66, 0.2], color: BOW_TIE },
    { size: [0.09, 0.08, 0.04], at: [0.065, 0.66, 0.2], color: BOW_TIE },
    { size: [0.05, 0.05, 0.05], at: [0, 0.66, 0.21], color: shade(BOW_TIE, 0.15) },
  ])
}

function hatBoxes(look: DealerLook): VoxelBox[] {
  const top = HEAD
  switch (look.hat) {
    case 'visor':
      return [
        { size: [0.53, 0.07, 0.53], at: [0, top - 0.04, 0], color: look.accent },
        { size: [0.5, 0.03, 0.22], at: [0, top - 0.05, 0.36], color: shade(look.accent, -0.12) },
      ]
    case 'top_hat':
      return [
        { size: [0.72, 0.04, 0.72], at: [0, top + 0.02, 0], color: '#17171c' },
        { size: [0.44, 0.42, 0.44], at: [0, top + 0.25, 0], color: '#17171c' },
        { size: [0.45, 0.08, 0.45], at: [0, top + 0.09, 0], color: look.accent },
      ]
    case 'beanie':
      return [
        { size: [0.56, 0.2, 0.56], at: [0, top + 0.02, 0], color: shade(look.accent, -0.2) },
        { size: [0.57, 0.07, 0.57], at: [0, top - 0.07, 0], color: shade(look.accent, -0.3) },
        { size: [0.12, 0.1, 0.12], at: [0, top + 0.17, 0], color: shade(look.accent, -0.05) },
      ]
    case 'none':
      return []
  }
}

function buildHair(look: DealerLook): THREE.Mesh {
  const h = HEAD
  return voxelPart([
    { size: [0.54, 0.08, 0.54], at: [0, h + 0.02, 0], color: look.hair },
    { size: [0.54, 0.4, 0.08], at: [0, h - 0.18, -0.24], color: look.hair },
    { size: [0.06, 0.2, 0.46], at: [-0.26, h - 0.1, -0.03], color: look.hair },
    { size: [0.06, 0.2, 0.46], at: [0.26, h - 0.1, -0.03], color: look.hair },
    ...hatBoxes(look),
  ])
}

interface Arm {
  shoulder: THREE.Group
  elbow: THREE.Group
  hand: THREE.Object3D
}

function buildArm(look: DealerLook, side: 1 | -1): Arm {
  const shoulder = new THREE.Group()
  shoulder.position.set(side * SHOULDER[0], SHOULDER[1], SHOULDER[2])
  shoulder.add(voxelPart([{ size: [0.17, 0.36, 0.17], at: [0, -0.15, 0], color: look.shirt }]))
  const elbow = new THREE.Group()
  elbow.position.y = -UPPER_ARM
  elbow.add(
    voxelPart([
      { size: [0.16, 0.26, 0.16], at: [0, -0.12, 0], color: look.shirt },
      { size: [0.17, 0.05, 0.17], at: [0, -0.25, 0], color: shade(look.shirt, -0.1) },
      { size: [0.15, 0.13, 0.15], at: [0, -0.34, 0], color: look.skin },
    ]),
  )
  const hand = new THREE.Object3D()
  hand.position.y = -0.36
  elbow.add(hand)
  shoulder.add(elbow)
  return { shoulder, elbow, hand }
}

function buildSweat(): THREE.Mesh[] {
  return [0.29, -0.29].map((x) => {
    const drop = voxelPart([{ size: [0.05, 0.08, 0.05], at: [0, 0, 0], color: TEAR }], { shadows: false })
    drop.position.set(x, 0.42, 0.12)
    drop.visible = false
    return drop
  })
}

// ---- rig ------------------------------------------------------------------------------------

interface Active {
  frames: Keyframe[]
  index: number
  t: number
  from: Pose
  resolve: () => void
}

interface Queued {
  build: () => Keyframe[]
  resolve: () => void
}

/** Breathing period and how far the head turns when looking around, per mood. */
const IDLE: Record<Mood, { breath: number; lookEvery: number; lookRange: number }> = {
  neutral: { breath: 3.2, lookEvery: 3, lookRange: 0.45 },
  happy: { breath: 2.6, lookEvery: 2.5, lookRange: 0.35 },
  nervous: { breath: 1.2, lookEvery: 0.7, lookRange: 0.6 },
  broke: { breath: 4.5, lookEvery: 6, lookRange: 0.12 },
}
const BLINK_S = 0.12
/** Bubble tail height: above the head, and above the tall top hat when there is one. */
const BUBBLE_Y = 2.0
const TOP_HAT_EXTRA = 0.4

/** `stool: false` for figures that sit on the room's stools instead of carrying their own (gamblers). */
export function createCharacter(look: DealerLook, name: string, { stool = true } = {}): WalkerRig {
  const root = new THREE.Group()
  root.name = name
  if (stool) root.add(buildStool())
  const figure = new THREE.Group()
  root.add(figure)
  const legs = [buildLeg(-0.14), buildLeg(0.14)]
  for (const leg of legs) figure.add(leg.hip)

  const body = new THREE.Group()
  body.position.y = HIP_Y
  figure.add(body)
  body.add(buildTorso(look))

  const neck = new THREE.Group()
  neck.position.y = NECK_Y
  body.add(neck)
  neck.add(voxelPart([{ size: [0.18, 0.08, 0.18], at: [0, 0.02, 0], color: look.skin }]))
  const headGroup = new THREE.Group()
  headGroup.rotation.order = 'YXZ'
  neck.add(headGroup)

  let mood: Mood = 'neutral'
  let blink = false
  let faceOverride: Face | null = null
  const face = pixelTexture(16, 16, (ctx) => drawFace(ctx, look, faceOverride ?? mood, blink))
  const head = texturedBox([HEAD, HEAD, HEAD], look.skin, face.texture)
  head.position.y = HEAD / 2 + 0.04
  headGroup.add(head)
  const hair = buildHair(look)
  hair.position.y = 0.04
  headGroup.add(hair)
  const sweat = buildSweat()
  for (const drop of sweat) headGroup.add(drop)

  const right = buildArm(look, -1)
  const left = buildArm(look, 1)
  body.add(right.shoulder, left.shoulder)

  const bubble = createBubble(look.accent)
  bubble.object.position.y = BUBBLE_Y + (look.hat === 'top_hat' ? TOP_HAT_EXTRA : 0)
  figure.add(bubble.object)

  let time = 0
  let nextBlink = 2
  let lookTarget = 0
  let lookYaw = 0
  let nextLook = 1
  let active: Active | null = null
  const queue: Queued[] = []
  let pose: Pose = { ...REST }
  let lastFace: Face = 'neutral'
  let lastBlink = false

  const redrawFaceIfChanged = (): void => {
    const shown = faceOverride ?? mood
    if (shown === lastFace && blink === lastBlink) return
    lastFace = shown
    lastBlink = blink
    face.redraw()
  }

  /** Points the right arm at a world position (straight-ish), leaning in when it is far. */
  const reachFrames = (to: THREE.Vector3): Keyframe[] => {
    root.updateWorldMatrix(true, true)
    const local = body.worldToLocal(to.clone())
    const fromShoulder = local.sub(right.shoulder.position)
    const distance = fromShoulder.length()
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), fromShoulder.normalize())
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ')
    const lean = THREE.MathUtils.clamp((distance - 0.75) * 0.4, 0, 0.3)
    return [
      { to: { rS: [e.x, e.y, e.z], rE: -0.15, lean, headY: e.y * 0.5 }, dur: 0.22 },
      { to: {}, dur: 0.08 },
    ]
  }

  const startNext = (): void => {
    const next = queue.shift()
    if (!next) return
    active = { frames: next.build(), index: 0, t: 0, from: pose, resolve: next.resolve }
  }

  /** The target of keyframe `i`: all earlier keyframes' overrides on top of the mood pose. */
  const frameTarget = (frames: Keyframe[], i: number): Pose => {
    let target = MOOD_POSE[mood]
    for (let k = 0; k <= i && k < frames.length; k++) target = { ...target, ...frames[k].to }
    return target
  }

  const stepGesture = (dt: number): Pose => {
    if (!active) return MOOD_POSE[mood]
    active.t += dt
    const returning = active.index >= active.frames.length
    const frame = active.frames[active.index]
    const dur = returning ? RETURN_DUR : frame.dur
    const target = returning ? MOOD_POSE[mood] : frameTarget(active.frames, active.index)
    faceOverride = returning ? null : (frame.face ?? null)
    const k = THREE.MathUtils.smoothstep(Math.min(1, active.t / dur), 0, 1)
    const current = lerpPose(active.from, target, k)
    if (active.t < dur) return current
    if (returning) {
      const done = active.resolve
      active = null
      done()
      startNext()
      return current
    }
    active.index += 1
    active.t = 0
    active.from = target
    return current
  }

  const updateIdle = (dt: number): void => {
    const idle = IDLE[mood]
    nextBlink -= dt
    if (blink && nextBlink < -BLINK_S) {
      blink = false
      nextBlink = 1.5 + Math.random() * 3.5
    } else if (!blink && nextBlink <= 0) blink = true
    nextLook -= dt
    if (nextLook <= 0) {
      lookTarget = (Math.random() * 2 - 1) * idle.lookRange
      nextLook = idle.lookEvery * (0.6 + Math.random() * 0.8)
    }
    // Nervous glances snap; calm dealers turn their head slowly.
    const speed = mood === 'nervous' ? 12 : 2.5
    lookYaw += (lookTarget - lookYaw) * Math.min(1, dt * speed)
  }

  const updateSweat = (): void => {
    sweat.forEach((drop, i) => {
      drop.visible = mood === 'nervous'
      const cycle = (time * 0.9 + i * 0.5) % 1
      drop.position.y = 0.42 - cycle * 0.3
      drop.scale.setScalar(1 - cycle * 0.6)
    })
  }

  let stand = 0
  let standTarget = 0
  const standWaiters: (() => void)[] = []
  let walking = false
  let walkAmount = 0
  let stride = 0

  const updateStance = (dt: number): void => {
    const step = dt / STAND_S
    stand = standTarget > stand ? Math.min(standTarget, stand + step) : Math.max(standTarget, stand - step)
    if (stand === standTarget) for (const done of standWaiters.splice(0)) done()
    walkAmount = THREE.MathUtils.clamp(walkAmount + (walking ? dt : -dt) * 4, 0, 1)
    stride += dt * STEP_RATE * Math.PI * walkAmount
  }

  /** Arms hang and swing against the legs when standing; seated poses fade out as the dealer rises. */
  const standingPose = (p: Pose): Pose => {
    if (stand === 0) return p
    const swing = Math.sin(stride) * ARM_SWING * walkAmount
    const hanging: Pose = { ...p, rS: [swing, 0, 0.08], lS: [-swing, 0, -0.08], rE: -0.2, lE: -0.2, lean: 0, lift: 0 }
    return lerpPose(p, hanging, THREE.MathUtils.smoothstep(stand, 0, 1))
  }

  const applyLegs = (): void => {
    const k = THREE.MathUtils.smoothstep(stand, 0, 1)
    figure.position.y = k * STAND_LIFT
    legs.forEach((leg, i) => {
      const phase = Math.sin(stride + i * Math.PI)
      leg.hip.rotation.x = THREE.MathUtils.lerp(SEATED_HIP_X, 0, k) + phase * LEG_SWING * walkAmount
      leg.knee.rotation.x = THREE.MathUtils.lerp(SEATED_KNEE_X, 0, k) + Math.max(0, -phase) * KNEE_BEND * walkAmount
    })
  }

  const applyPose = (p: Pose): void => {
    const idle = IDLE[mood]
    const breath = Math.sin((time * Math.PI * 2) / idle.breath)
    right.shoulder.rotation.set(p.rS[0] + breath * 0.02, p.rS[1], p.rS[2])
    left.shoulder.rotation.set(p.lS[0] + breath * 0.02, p.lS[1], p.lS[2])
    right.elbow.rotation.x = p.rE
    left.elbow.rotation.x = p.lE
    // Happy dealers sway a little; everyone breathes.
    const sway = mood === 'happy' && stand === 0 ? Math.sin(time * 2.4) * 0.05 : 0
    body.rotation.set(p.lean + breath * 0.015, 0, sway)
    body.position.y = HIP_Y + p.lift + breath * 0.008
    headGroup.rotation.set(p.headX, p.headY + (active ? 0 : lookYaw), p.headZ - sway * 0.5)
  }

  const rig: WalkerRig = {
    object: root,
    figure,
    setStanding(standing) {
      standTarget = standing ? 1 : 0
      if (stand === standTarget) return Promise.resolve()
      return new Promise<void>((resolve) => standWaiters.push(resolve))
    },
    setWalking(next) {
      walking = next
    },
    handPosition() {
      root.updateWorldMatrix(true, true)
      return right.hand.getWorldPosition(new THREE.Vector3())
    },
    setMood(next) {
      mood = next
    },
    say(text) {
      bubble.say(text)
    },
    gesture(g) {
      return new Promise<void>((resolve) => {
        const build = (): Keyframe[] => (g.kind === 'deal' ? reachFrames(g.to) : gestureFrames(g))
        queue.push({ build, resolve })
        if (!active) startNext()
      })
    },
    update(dt) {
      time += dt
      updateIdle(dt)
      updateStance(dt)
      pose = stepGesture(dt)
      applyPose(standingPose(pose))
      applyLegs()
      updateSweat()
      redrawFaceIfChanged()
      bubble.update(dt)
    },
    dispose() {
      // Nobody should wait forever on a gesture of a dealer that is gone.
      active?.resolve()
      for (const queued of queue.splice(0)) queued.resolve()
      for (const done of standWaiters.splice(0)) done()
      active = null
      root.removeFromParent()
      disposeObject(root)
    },
  }
  return rig
}
