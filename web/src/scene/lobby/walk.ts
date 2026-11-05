// Walking on the lobby floor, shared by dealers (seat changes) and gamblers (coming to play).
import * as THREE from 'three'
import type { WalkerRig } from '../characters'
import type { Animator } from '../table/props'

const TURN_S = 0.25

export function turnTo(anim: Animator, figure: THREE.Object3D, yaw: number): Promise<void> {
  const start = figure.rotation.y
  // The short way round.
  const diff = Math.atan2(Math.sin(yaw - start), Math.cos(yaw - start))
  return anim.tween(TURN_S, (t) => {
    figure.rotation.y = start + diff * t
  })
}

/** Turns the figure toward `to` (in the rig's own space), then walks there at `speed` units/s. */
export async function walkTo(anim: Animator, rig: WalkerRig, to: THREE.Vector3, speed: number): Promise<void> {
  const figure = rig.figure
  const from = figure.position.clone()
  from.y = 0
  const delta = new THREE.Vector3(to.x - from.x, 0, to.z - from.z)
  const distance = delta.length()
  if (distance < 1e-3) return
  await turnTo(anim, figure, Math.atan2(delta.x, delta.z))
  rig.setWalking(true)
  await anim.tween(distance / speed, (t) => {
    figure.position.x = from.x + delta.x * t
    figure.position.z = from.z + delta.z * t
  }, (t) => t)
  rig.setWalking(false)
}
