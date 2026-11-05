import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { PublicKey } from 'near-api-js'
import { describe, expect, it } from 'vitest'
import {
  checkNextState,
  clientSeedIsValid,
  parseCompactRound,
  parseTicket,
  replayRound,
  Rng,
  roundBorsh,
  stepSeed,
  ticketMessage,
  verifySession,
  verifyTicket,
  type CompactRound,
  type SignedState,
} from './session-client'
import vectors from './session-vectors.json'

// session-vectors.json comes from core_rules::session (Rust) with a fixed seed and signing key,
// so these tests prove the browser rebuilds the exact protocol bytes, not just its own.
const SEED = hexToBytes(vectors.server_seed)
const PUBLIC_KEY = new PublicKey({ keyType: 0, data: hexToBytes(vectors.server_public_key_hex) }).toString()

const sessions = vectors.sessions.map((s) => ({
  ticket: parseTicket(s.ticket),
  ticketSignature: s.ticket_signature,
  ticketMessage: s.ticket_message,
  rounds: s.rounds.map((r) => parseCompactRound(r)),
  states: s.states.map((x): SignedState & { roundBorsh?: string } => ({
    ...x.state,
    signature: x.signature,
    roundBorsh: 'round_borsh' in x ? x.round_borsh : undefined,
  })),
}))

describe('Rng and seeds', () => {
  it('draws what core_rules::Rng draws', () => {
    const rng = new Rng(new Uint8Array(32).fill(7))
    expect(Array.from({ length: 8 }, () => rng.below(10_000))).toEqual(vectors.rng_below_10000)
  })

  it('derives round and step seeds like the server', () => {
    expect(bytesToHex(stepSeed(SEED, vectors.client_seed, 1, 0))).toBe(vectors.step_seed_1_0)
    expect(bytesToHex(stepSeed(SEED, vectors.client_seed, 1, 2))).toBe(vectors.step_seed_1_2)
  })

  it('accepts only client seeds the server accepts', () => {
    expect(clientSeedIsValid('lucky-seven')).toBe(true)
    expect(clientSeedIsValid('')).toBe(false)
    expect(clientSeedIsValid('a:b')).toBe(false)
    expect(clientSeedIsValid('has space')).toBe(false)
    expect(clientSeedIsValid('x'.repeat(65))).toBe(false)
  })
})

describe('protocol bytes', () => {
  it.each(sessions.map((s) => [s.ticket.game, s] as const))('%s: ticket message and signature', (_, s) => {
    expect(bytesToHex(ticketMessage(s.ticket))).toBe(s.ticketMessage)
    expect(verifyTicket(PUBLIC_KEY, s.ticket, s.ticketSignature)).toBe(true)
    expect(verifyTicket(PUBLIC_KEY, { ...s.ticket, rake_bp: s.ticket.rake_bp + 1 }, s.ticketSignature)).toBe(false)
  })

  it.each(sessions.map((s) => [s.ticket.game, s] as const))('%s: round borsh', (_, s) => {
    s.rounds.forEach((round, i) => expect(bytesToHex(roundBorsh(round))).toBe(s.states[i + 1].roundBorsh))
  })
})

describe('checkNextState (live, before the reveal)', () => {
  it.each(sessions.map((s) => [s.ticket.game, s] as const))('%s: accepts every honest state', (_, s) => {
    s.rounds.forEach((round, i) => expect(checkNextState(PUBLIC_KEY, s.states[i], round, s.states[i + 1])).toBeNull())
  })

  const [dice] = sessions
  const [first] = dice.rounds
  const [start, next] = dice.states

  it('refuses a forged signature', () => {
    const forged = { ...next, signature: '00'.repeat(64) }
    expect(checkNextState(PUBLIC_KEY, start, first, forged)).toBe('bad server signature')
  })

  it('refuses a round that is not the one the chain commits to', () => {
    const swapped: CompactRound = { ...first, payout: '0' }
    expect(checkNextState(PUBLIC_KEY, start, swapped, next)).toBe('hash chain does not extend with this round')
  })

  it('refuses a skipped nonce', () => {
    expect(checkNextState(PUBLIC_KEY, next, first, next)).toMatch(/expected round 2/)
  })
})

describe('verifySession (after the reveal)', () => {
  it.each(sessions.map((s) => [s.ticket.game, s] as const))('%s: replays every round', (_, s) => {
    const result = verifySession(vectors.server_seed, s.ticket, s.rounds, s.states[s.states.length - 1])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.summary.rounds).toBe(s.rounds.length)
      expect(result.summary.balance.toString()).toBe(s.states[s.states.length - 1].balance)
    }
  })

  const [dice, , blackjack] = sessions
  const last = dice.states[dice.states.length - 1]

  it('refuses a seed that does not match the commitment', () => {
    const other = '01'.repeat(32)
    expect(verifySession(other, dice.ticket, dice.rounds, last)).toMatchObject({ ok: false, error: 'server seed does not match its hash' })
  })

  it('catches a rewritten outcome', () => {
    const rounds = dice.rounds.map((r, i) => (i === 1 ? { ...r, outcome: { dice: { roll: 0 } } } : r))
    expect(verifySession(vectors.server_seed, dice.ticket, rounds, last)).toMatchObject({ ok: false, nonce: 2 })
  })

  it('catches a rewritten blackjack move list', () => {
    const rounds = blackjack.rounds.map((r, i) => (i === 0 ? { ...r, actions: [] } : r))
    const end = blackjack.states[blackjack.states.length - 1]
    expect(verifySession(vectors.server_seed, blackjack.ticket, rounds, end)).toMatchObject({ ok: false, nonce: 1 })
  })

  // Session 4: every inside bet, then two spins of several chips each.
  const inside = sessions[3]

  it('replays a multi-spot spin as the sum of its spots played alone on that nonce', () => {
    const spins = inside.rounds.filter((r) => typeof r.bet === 'object' && 'roulette_spots' in r.bet)
    expect(spins).toHaveLength(2)
    for (const round of spins) {
      if (typeof round.bet !== 'object' || !('roulette_spots' in round.bet)) continue
      const alone = round.bet.roulette_spots.map((spot) =>
        replayRound(SEED, inside.ticket, round.nonce, { roulette: spot.bet }, BigInt(spot.stake), []),
      )
      expect(alone.every((r) => JSON.stringify(r.outcome) === JSON.stringify(round.outcome))).toBe(true)
      expect(alone.reduce((sum, r) => sum + BigInt(r.payout), 0n).toString()).toBe(round.payout)
    }
  })

  it('refuses spots that do not add up to the stake, and a moved chip', () => {
    const [spin] = inside.rounds.filter((r) => typeof r.bet === 'object' && 'roulette_spots' in r.bet)
    expect(() => replayRound(SEED, inside.ticket, spin.nonce, spin.bet, BigInt(spin.stake) + 1n, [])).toThrow()
    const end = inside.states[inside.states.length - 1]
    const rounds = inside.rounds.map((r) => (r.nonce !== spin.nonce || typeof r.bet !== 'object' || !('roulette_spots' in r.bet) ? r : {
      ...r,
      bet: { roulette_spots: r.bet.roulette_spots.map((spot, i) => (i === 0 ? { ...spot, stake: (BigInt(spot.stake) + 1n).toString() } : spot)) },
    }))
    expect(verifySession(vectors.server_seed, inside.ticket, rounds, end)).toMatchObject({ ok: false, nonce: spin.nonce })
  })

  it('refuses an inside bet that is not adjacent on the layout', () => {
    expect(() => replayRound(SEED, inside.ticket, 1, { roulette: { split: [7, 9] } }, 100_000n, [])).toThrow()
    expect(() => replayRound(SEED, inside.ticket, 1, { roulette: { corner: 3 } }, 100_000n, [])).toThrow()
  })

  it('catches a dropped round', () => {
    expect(verifySession(vectors.server_seed, dice.ticket, dice.rounds.slice(1), last)).toMatchObject({ ok: false, nonce: 2 })
  })
})
