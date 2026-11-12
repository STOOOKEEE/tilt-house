import { describe, expect, it } from 'vitest'
import { verifyHand } from '../../near/poker-client'
import { botAction, DEMO_PLAYER, PokerDemo } from '../../near/poker-demo'
import { chairAt, seatSlot, slotAngle, towardSeat } from './layout'
import { pokerScene } from './view'

describe('poker layout', () => {
  it('puts the own seat nearest the camera and the others clockwise', () => {
    expect(seatSlot(3, 3, 6)).toBe(0)
    expect(seatSlot(4, 3, 6)).toBe(1)
    expect(seatSlot(2, 3, 6)).toBe(5)
    const near = towardSeat(slotAngle(0, 6), 1)
    expect(near.x).toBeCloseTo(0)
    expect(near.z).toBeGreaterThan(0)
    // Characters face the middle of the table.
    const chair = chairAt(slotAngle(2, 6))
    expect(Math.sin(chair.yaw) * -chair.x + Math.cos(chair.yaw) * -chair.z).toBeGreaterThan(0)
  })
})

/** Plays the practice table until a hand is over, the player always checking or calling. */
function playDemoHand(): PokerDemo {
  let now = 1_000_000
  const demo = new PokerDemo(() => 0.5)
  demo.join(5_000_000n, now)
  for (let i = 0; i < 500 && !demo.state().last_hand; i++) {
    now += 25_000
    const state = demo.state()
    const legal = state.you?.legal
    if (legal) demo.act(legal.can_check ? 'check' : 'call', now)
    else demo.tick(now)
  }
  return demo
}

describe('practice table', () => {
  it('plays a 3-seat hand that the replay verifies, chips conserved', () => {
    const demo = playDemoHand()
    const state = demo.state()
    const last = state.last_hand
    expect(last).not.toBeNull()
    if (!last) return
    expect(last.history.start.seats.map((s) => s.seat)).toEqual([0, 2, 4])
    const mine = last.history.start.seats.find((s) => s.player === DEMO_PLAYER)
    expect(verifyHand(last, mine ? { seat: mine.seat, clientSeed: mine.client_seed } : null)).toMatchObject({ ok: true })
    const stakes = last.players.reduce((sum, p) => sum + BigInt(p.stake), 0n)
    const payouts = last.players.reduce((sum, p) => sum + BigInt(p.payout), 0n)
    expect(payouts + BigInt(last.result.rake)).toBe(stakes)
  })

  it('shows the result: winners paid, the board, nobody to act', () => {
    const scene = pokerScene(playDemoHand().state())
    expect(scene.winners.length).toBeGreaterThan(0)
    expect(scene.toAct).toBeNull()
    expect(scene.seats.filter((s) => s !== null)).toHaveLength(3)
  })

  it('never shows another player hole cards during a hand', () => {
    let now = 1_000_000
    const demo = new PokerDemo(() => 0.5)
    demo.join(5_000_000n, now)
    for (let i = 0; i < 50 && demo.state().hand?.phase !== 'preflop'; i++) demo.tick((now += 2_000))
    const scene = pokerScene(demo.state())
    const others = scene.seats.filter((s) => s && !s.you)
    expect(others.length).toBe(2)
    for (const s of others) expect(s?.cards.every((c) => c === null)).toBe(true)
    expect(scene.seats.find((s) => s?.you)?.cards.every((c) => c !== null)).toBe(true)
  })

  it('practice bots stay legal', () => {
    const open = { seat: 2, can_check: true, call: 0n, raise: { min_to: 200n, max_to: 900n }, stack: 900n }
    expect(botAction(open, 1, 1)).toEqual({ raise_to: 287n })
    expect(botAction(open, 0, 0)).toBe('check')
    const facing = { ...open, can_check: false, call: 5_000_000n, raise: null }
    expect(botAction(facing, 0.1, 0)).toBe('fold')
    expect(botAction(facing, 0.9, 0)).toBe('call')
  })
})
