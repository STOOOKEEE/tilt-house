// Where things sit around the oval poker table. Pure geometry (no three.js objects), so the seat
// rotation is testable: the player's own seat is always the one nearest the camera.

/** Half-width (x) and half-depth (z) of the felt oval, meters. */
export const OVAL_A = 2.5
export const OVAL_B = 1.45
/** Height of the felt surface: the seated characters' hands rest at about this height. */
export const POKER_FELT_Y = 0.78
/** How far beyond the felt edge a seated character sits. */
const SEAT_OUT = 0.78

/** Where the players' things lie on the felt, as a fraction of the way from the center to the edge. */
export const RADIUS = {
  bet: 0.5,
  cards: 0.74,
  ownCards: 0.7,
  button: 0.7,
  plate: 1.02,
} as const

export interface FlatPoint {
  x: number
  z: number
}

/**
 * The slot a seat is drawn in: slot 0 is nearest the camera, the others go round clockwise
 * (seen from above). `pivot` is the player's own seat, else 0.
 */
export function seatSlot(seat: number, pivot: number, seats: number): number {
  return (((seat - pivot) % seats) + seats) % seats
}

/** Angle of a slot around the oval: 0 at the near side (+z), growing clockwise seen from above. */
export function slotAngle(slot: number, seats: number): number {
  return (slot / seats) * Math.PI * 2
}

/** A point on the felt toward the seat at `angle`, `fraction` of the way to the oval's edge. */
export function towardSeat(angle: number, fraction: number): FlatPoint {
  return { x: -Math.sin(angle) * OVAL_A * fraction, z: Math.cos(angle) * OVAL_B * fraction }
}

/** Where a seated character's stool stands, and its yaw so it faces the table's center. */
export function chairAt(angle: number): FlatPoint & { yaw: number } {
  const x = -Math.sin(angle) * (OVAL_A + SEAT_OUT)
  const z = Math.cos(angle) * (OVAL_B + SEAT_OUT)
  // Characters face +z at yaw 0: turn them toward the origin.
  return { x, z, yaw: Math.atan2(-x, -z) }
}

/** Community cards: one row across the middle, `gap` apart, centered. */
export function boardSlot(index: number, gap: number): FlatPoint {
  return { x: (index - 2) * gap, z: -0.2 }
}

/** The pots: main pot in the middle, side pots to its right. */
export function potSlot(index: number): FlatPoint {
  return { x: index * 0.42 - 0.2, z: 0.38 }
}
