import { describe, expect, it } from 'vitest'
import {
  actionProblem,
  expectedRound,
  parseHandHistory,
  parseLegal,
  parseTableState,
  raiseAction,
  raisePresets,
  roundMatchesHand,
  verifyHand,
  type LastHand,
} from './poker-client'
import type { Legal } from './poker-rules'
import { parseCompactRound } from './session-client'
import vectors from './poker-vectors.json'

/** A finished hand as the table publishes it, built from a Rust vector. */
function lastHand(index: number): LastHand {
  const v = vectors.hands[index]
  const history = parseHandHistory(v.history, 'history')
  return {
    number: history.start.hand,
    commitment: history.start.hand_seed_hash,
    history,
    history_hash: v.history_hash,
    result: {
      board: v.result.board,
      showdown: v.result.showdown,
      pots: v.result.pots,
      rake: v.result.rake,
      seats: v.result.seats.map((s) => ({ ...s, shown: s.shown ?? null, value: s.value ?? null })),
    },
    deck: v.deck,
    players: v.result.seats.map((s, i) => ({
      seat: s.seat,
      player: s.player,
      name: s.player,
      npc: false,
      session_id: `s${s.seat}`,
      hole: v.holes[i],
      stake: s.put_in,
      payout: s.won,
      nonce: 7,
    })),
    ended_at: 0,
  }
}

const legal = (raise: [bigint, bigint] | null, call = 0n): Legal => ({
  seat: 0,
  can_check: call === 0n,
  call,
  raise: raise && { min_to: raise[0], max_to: raise[1] },
  stack: raise ? raise[1] : call * 10n,
})

describe('verifyHand', () => {
  it('passes every published vector hand, with the player seed check', () => {
    vectors.hands.forEach((_, i) => {
      const hand = lastHand(i)
      const first = hand.history.start.seats[0]
      const check = verifyHand(hand, { seat: first.seat, clientSeed: first.client_seed })
      expect(check, vectors.hands[i].name).toMatchObject({ ok: true })
      if (check.ok) expect(check.checks.some((c) => c.startsWith('deck verified'))).toBe(true)
    })
  })

  it('catches a swapped seed, deck, board, payout, hole card, action or hash', () => {
    const fails = (mutate: (h: LastHand) => void, why: RegExp) => {
      const hand = lastHand(2)
      mutate(hand)
      const check = verifyHand(hand)
      expect(check.ok).toBe(false)
      if (!check.ok) expect(check.error).toMatch(why)
    }
    fails((h) => (h.history.hand_seed = '11'.repeat(32)), /commitment/)
    fails((h) => (h.commitment = '22'.repeat(32)), /commitment/)
    fails((h) => (h.deck = [...h.deck.slice(1), h.deck[0]]), /deck/)
    fails((h) => (h.result.board = [...h.result.board].reverse()), /board/)
    fails((h) => (h.result.seats[0].won = (BigInt(h.result.seats[0].won) + 1n).toString()), /rules/)
    fails((h) => (h.players[1].payout = '0'), /replay/)
    fails((h) => (h.players[0].hole = [h.players[0].hole[1], h.players[0].hole[0]]), /replay/)
    fails((h) => (h.result.rake = '0'), /rake/)
    fails((h) => (h.history.actions = h.history.actions.slice(0, 3)), /not finished/)
    fails((h) => (h.history_hash = '33'.repeat(32)), /history hash/)
  })

  it('refuses when my client seed was replaced', () => {
    const hand = lastHand(1)
    const seat = hand.history.start.seats[1]
    expect(verifyHand(hand, { seat: seat.seat, clientSeed: 'not-mine' })).toEqual({ ok: false, error: 'your client seed is not the one in the deck' })
  })
})

describe('session rounds of a hand', () => {
  it('rebuilds each seat round exactly as core round_for', () => {
    vectors.hands.forEach((v, i) => {
      const hand = lastHand(i)
      for (const { round } of v.rounds) {
        const parsed = parseCompactRound(round)
        const seat = 'poker' in parsed.outcome ? parsed.outcome.poker.seat : -1
        expect(roundMatchesHand(parsed, hand, seat)).toBe(true)
        expect(expectedRound(hand, seat, 7)).toEqual(parsed)
      }
    })
  })

  it('refuses a round with another payout or seat', () => {
    const hand = lastHand(2)
    const round = parseCompactRound(vectors.hands[2].rounds[0].round)
    expect(roundMatchesHand({ ...round, payout: '1' }, hand, 0)).toBe(false)
    expect(roundMatchesHand(round, hand, 2)).toBe(false)
  })
})

describe('action checks', () => {
  it('follows core Legal::allows', () => {
    const open = legal([200n, 1_000n])
    expect(actionProblem(open, 'check')).toBeNull()
    expect(actionProblem(open, 'call')).toMatch(/check/)
    expect(actionProblem(open, { raise_to: 200n })).toBeNull()
    expect(actionProblem(open, { raise_to: 199n })).toMatch(/minimum is 200/)
    expect(actionProblem(open, { raise_to: 1_001n })).toMatch(/maximum is 1000/)
    expect(actionProblem(open, 'all_in')).toBeNull()
    const facing = legal(null, 300n)
    expect(actionProblem(facing, 'check')).toMatch(/bet to call/)
    expect(actionProblem(facing, 'call')).toBeNull()
    expect(actionProblem(facing, 'fold')).toBeNull()
    expect(actionProblem(facing, { raise_to: 900n })).toMatch(/closed/)
    expect(actionProblem(facing, 'all_in')).toMatch(/closed/)
    // Facing a bet bigger than the stack: all in is the call of everything.
    expect(actionProblem({ ...legal(null, 300n), stack: 300n, call: 300n }, 'all_in')).toBeNull()
    expect(actionProblem(null, 'fold')).toBe('not your turn')
  })

  it('pot presets stay in the legal range, the max is all in', () => {
    const l = legal([400n, 1_500n], 200n)
    // Pot 600 with 200 to call: after calling 800; current bet 200.
    expect(raisePresets(l, 600n, 200n)).toEqual([
      { label: '½ pot', to: 600n },
      { label: '¾ pot', to: 800n },
      { label: 'pot', to: 1_000n },
    ])
    expect(raisePresets(legal([400n, 700n], 200n), 600n, 200n).map((p) => p.to)).toEqual([600n, 700n])
    expect(raisePresets(legal(null, 200n), 600n, 200n)).toEqual([])
    expect(raiseAction(l, 1_500n)).toBe('all_in')
    expect(raiseAction(l, 900n)).toEqual({ raise_to: 900n })
  })
})

describe('parseTableState', () => {
  const state = {
    table_id: 'poker-demo',
    name: 'Ada',
    version: 3,
    seats: [
      { seat: 0, player: 'a.testnet', name: 'a', npc: false, stack: '100', bet: '0', total_in: '0', folded: false, all_in: false, in_hand: true, waiting: false, leaving: false, last_action: { raise_to: '50' }, cards: null },
      null,
    ],
    config: { small_blind: '5', big_blind: '10', rake_cap: '30', min_buy_in: '200', max_buy_in: '1000', rake_bp: 300, action_ms: 20000, seed_ms: 3000 },
    hand: null,
    last_hand: null,
    you: { seat: 0, session_id: 'x', hole: ['As', 'Kd'], legal: { seat: 0, can_check: true, call: '0', raise: null, stack: '100' }, state: null, last_round: null },
  }

  it('reads a table and the private view', () => {
    const t = parseTableState(state)
    expect(t.seats[0]?.last_action).toEqual({ raise_to: 50n })
    expect(t.you?.legal).toEqual(parseLegal(state.you.legal, 'legal'))
    expect(t.you?.hole).toEqual(['As', 'Kd'])
  })

  it('fails closed on numbers for amounts, bad cards and unknown actions', () => {
    expect(() => parseTableState({ ...state, config: { ...state.config, big_blind: 10 } })).toThrow(/big_blind/)
    expect(() => parseTableState({ ...state, you: { ...state.you, hole: ['Ax', 'Kd'] } })).toThrow(/hole/)
    const seat = { ...state.seats[0], last_action: 'shove' }
    expect(() => parseTableState({ ...state, seats: [seat] })).toThrow(/last_action/)
  })
})
