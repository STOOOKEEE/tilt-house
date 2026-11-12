import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha256'
import { describe, expect, it } from 'vitest'
import { parseHandHistory, parseLegal } from './poker-client'
import {
  cardText,
  categoryOf,
  CATEGORIES,
  deckFor,
  deckSeed,
  evaluate,
  historyHash,
  parseCard,
  PokerHand,
  replayHand,
  settleHand,
  type HandStart,
  type Legal,
  type PokerAction,
} from './poker-rules'
import { parseCompactRound, roundBorsh, Rng } from './session-client'
import vectors from './poker-vectors.json'

// poker-vectors.json comes from core_rules::poker (session-server/tests/poker_vectors.rs): these
// tests prove the browser replays hands exactly as the server's Rust code plays them.
const cards = (text: string) => text.split(' ').map(parseCard)
const CORE_CATEGORY = ['high_card', 'pair', 'two_pair', 'trips', 'straight', 'flush', 'full_house', 'quads', 'straight_flush']
const legalJson = (l: Legal) => ({
  seat: l.seat,
  can_check: l.can_check,
  call: l.call.toString(),
  raise: l.raise && { min_to: l.raise.min_to.toString(), max_to: l.raise.max_to.toString() },
  stack: l.stack.toString(),
})

describe('poker deck', () => {
  it('derives the same deck seed and shuffle as core', () => {
    const v = vectors.deck_seed
    const seed = hexToBytes(v.hand_seed)
    expect(bytesToHex(deckSeed(seed, v.client_seeds))).toBe(v.deck_seed)
    expect(deckFor(seed, v.client_seeds).map(cardText)).toEqual(v.deck)
  })

  it('is a permutation of the 52 cards, and every client seed changes it', () => {
    const seed = hexToBytes(vectors.deck_seed.hand_seed)
    const deck = deckFor(seed, ['a', 'b'])
    expect([...deck].sort((x, y) => x - y)).toEqual(Array.from({ length: 52 }, (_, i) => i))
    expect(deckFor(seed, ['a', 'c'])).not.toEqual(deck)
    expect(deckFor(seed, ['b', 'a'])).not.toEqual(deck)
  })

  it('reads and writes cards as core does', () => {
    expect(parseCard('2c')).toBe(0)
    expect(parseCard('As')).toBe(51)
    expect(cardText(parseCard('Td'))).toBe('Td')
    for (const bad of ['1c', 'Ax', 'A', 'Asd', '']) expect(() => parseCard(bad)).toThrow()
  })
})

describe('poker hand values', () => {
  it('matches core for every vector', () => {
    for (const v of vectors.evaluations) {
      const value = evaluate(cards(v.cards))
      expect(value, v.cards).toBe(v.value)
      expect(CORE_CATEGORY[CATEGORIES.indexOf(categoryOf(value))], v.cards).toBe(v.category)
    }
  })

  it('orders the classic cases', () => {
    const beats = (a: string, b: string) => expect(evaluate(cards(a)), `${a} > ${b}`).toBeGreaterThan(evaluate(cards(b)))
    beats('2c 3d 4h 5s 6c Kd Qh', 'As 2d 3c 4h 5s Kd Qc') // six-high straight over the wheel
    beats('Ah Kh 2h 5h 9h 3c 4c', 'Ts Jd Qc Kh Ac 2d 3h') // flush over straight
    beats('Ac Ad Ks Kd 2c 3h 7s', 'Ac Ad Qs Qd Kc 3h 7s') // two pair: second pair decides
    expect(evaluate(cards('Ac Ad Ks Kd 2c 3h 7s'))).toBe(evaluate(cards('Ah As Kc Kh 2d 3s 7c'))) // suits never split
  })
})

describe('poker settlement', () => {
  it('matches core: side pots, rake, odd chips', () => {
    for (const v of vectors.settlements) {
      const seats = v.seats.map((s) => ({ seat: s.seat, committed: BigInt(s.committed), folded: s.folded, value: s.value }))
      const got = settleHand(seats, v.rake_bp, BigInt(v.rake_cap), v.flop_seen)
      expect({
        seats: got.seats.map((s) => ({ seat: s.seat, put_in: s.put_in.toString(), won: s.won.toString() })),
        pots: got.pots.map((p) => ({ amount: p.amount.toString(), eligible: p.eligible, winners: p.winners })),
        rake: got.rake.toString(),
      }).toEqual(v.settlement)
    }
  })
})

describe('poker hands', () => {
  for (const v of vectors.hands) {
    it(`replays "${v.name}" exactly`, () => {
      const history = parseHandHistory(v.history, 'history')
      // Step by step: the legal moves before each action are core's.
      const hand = new PokerHand(history.start, hexToBytes(history.hand_seed))
      history.actions.forEach((record, i) => {
        const legal = hand.legal()
        expect(legal && legalJson(legal), `before action ${i}`).toEqual(legalJson(parseLegal(v.legals[i], 'legal')))
        hand.act(record.seat, record.action)
      })
      expect(hand.isDone()).toBe(true)
      expect(hand.deck.map(cardText)).toEqual(v.deck)
      expect(history.start.seats.map((s) => hand.hole(s.seat)?.map(cardText))).toEqual(v.holes)
      const result = hand.result
      expect(result && {
        board: result.board.map(cardText),
        showdown: result.showdown,
        pots: result.pots.map((p) => ({ amount: p.amount.toString(), eligible: p.eligible, winners: p.winners })),
        rake: result.rake.toString(),
        seats: result.seats.map((s) => ({
          player: s.player,
          put_in: s.put_in.toString(),
          seat: s.seat,
          shown: s.shown && s.shown.map(cardText),
          stack_after: s.stack_after.toString(),
          value: s.value,
          won: s.won.toString(),
        })),
      }).toEqual(v.result)
      expect(historyHash(history)).toBe(v.history_hash)
      for (const r of v.rounds) expect(bytesToHex(roundBorsh(parseCompactRound(r.round)))).toBe(r.borsh)
    })
  }

  it('refuses a seed that is not the commitment, an illegal action and an unfinished history', () => {
    const history = parseHandHistory(vectors.hands[1].history, 'history')
    expect(() => replayHand({ ...history, hand_seed: '00'.repeat(32) })).toThrow(/commitment/)
    const raised: PokerAction = { raise_to: 1n }
    expect(() => replayHand({ ...history, actions: [{ seat: history.actions[0].seat, action: raised }] })).toThrow(/illegal/)
    expect(() => replayHand({ ...history, actions: [{ seat: 5, action: 'fold' }] })).toThrow(/turn/)
    expect(() => replayHand({ ...history, actions: history.actions.slice(0, 2) })).toThrow(/not finished/)
  })
})

describe('poker invariants (random hands)', () => {
  /** A random legal action, from a deterministic generator. */
  function pick(legal: Legal, rng: Rng): PokerAction {
    const roll = rng.below(10)
    if (roll === 0) return 'fold'
    if (legal.raise && roll >= 8) {
      const { min_to, max_to } = legal.raise
      return roll === 9 ? 'all_in' : { raise_to: min_to + (BigInt(rng.below(1000)) * (max_to - min_to)) / 1000n }
    }
    return legal.can_check ? 'check' : 'call'
  }

  it('conserves chips, never goes negative, always finishes (500 hands)', () => {
    const rng = new Rng(new Uint8Array(32).fill(42))
    for (let n = 0; n < 500; n++) {
      const count = 2 + rng.below(5)
      const seed = new Uint8Array(32).fill(n % 256)
      seed[0] = n >> 8
      const start: HandStart = {
        table: 'prop',
        hand: n,
        config: { small_blind: 50n, big_blind: 100n, rake_cap: 300n },
        button: 0,
        seats: Array.from({ length: count }, (_, i) => ({
          seat: i,
          player: `p${i}`,
          stack: BigInt(1 + rng.below(5_000)),
          client_seed: `s${i}`,
          rake_bp: rng.below(501),
        })),
        hand_seed_hash: bytesToHex(sha256(seed)),
      }
      start.button = rng.below(count)
      const hand = new PokerHand(start, seed)
      for (let steps = 0; !hand.isDone(); steps++) {
        const legal = hand.legal()
        expect(legal, `hand ${n} stuck`).not.toBeNull()
        if (!legal || steps > 200) throw new Error(`hand ${n} does not finish`)
        hand.act(legal.seat, pick(legal, rng))
        for (const s of hand.publicSeats()) expect(s.stack >= 0n).toBe(true)
      }
      const result = hand.result
      if (!result) throw new Error('no result')
      const putIn = result.seats.reduce((sum, s) => sum + s.put_in, 0n)
      const won = result.seats.reduce((sum, s) => sum + s.won, 0n)
      expect(won + result.rake, `hand ${n}`).toBe(putIn)
      expect(result.rake <= 300n).toBe(true)
      for (const s of result.seats) expect(s.stack_after >= 0n).toBe(true)
      // The published history replays to the same result.
      expect(replayHand({ start, hand_seed: bytesToHex(seed), actions: hand.actions }).result).toEqual(result)
    }
  })
})
