import { describe, expect, it } from 'vitest'
import type { BlackjackHand, RoundView } from '../../near/views'
import { continues, endsDrawing, outcomeOf, planRound, type Step } from './director'

function round(overrides: Partial<RoundView>): RoundView {
  return {
    id: 7,
    player: 'bob.testnet',
    dealer_id: 'eve',
    game: 'blackjack',
    bet: 'blackjack',
    stake: '1000000',
    wager: '1000000',
    rake_bp: 300,
    status: 'waiting_vrf',
    step: 0,
    created_at: 1,
    updated_at: 1,
    roll: null,
    pocket: null,
    bj: null,
    payout: null,
    proofs: [],
    error: null,
    ...overrides,
  }
}

function bj(player: number[], dealer: number[], extra: Partial<BlackjackHand> = {}): BlackjackHand {
  return { player, dealer, doubled: false, done: false, ...extra }
}

const kinds = (steps: Step[]) => steps.map((s) => s.kind)

describe('planRound: blackjack', () => {
  const placed = round({})
  const dealt = round({ status: 'player_turn', step: 1, bj: bj([10, 6], [9]) })

  it('places the bet and thinks while the deal is drawn', () => {
    expect(kinds(planRound(null, placed))).toEqual(['clear', 'bet', 'think'])
  })

  it('deals player, dealer, player, then a face-down dealer card', () => {
    expect(planRound(placed, dealt)).toEqual([
      { kind: 'deal', to: 'player', index: 0, rank: 10 },
      { kind: 'deal', to: 'dealer', index: 0, rank: 9 },
      { kind: 'deal', to: 'player', index: 1, rank: 6 },
      { kind: 'deal', to: 'dealer', index: 1, rank: null },
    ])
  })

  it('a hit deals one card, after the thinking loop', () => {
    const asked = round({ ...dealt, status: 'waiting_vrf' })
    const hit = round({ ...dealt, bj: bj([10, 6, 3], [9]) })
    expect(kinds(planRound(dealt, asked))).toEqual(['think'])
    expect(planRound(asked, hit)).toEqual([{ kind: 'deal', to: 'player', index: 2, rank: 3 }])
  })

  it('a stand reveals the face-down card, draws the dealer out, then settles', () => {
    const asked = round({ ...dealt, status: 'waiting_vrf' })
    const stood = round({ ...dealt, status: 'settled', payout: '2000000', bj: bj([10, 6], [9, 7, 5], { done: true }) })
    expect(planRound(asked, stood)).toEqual([
      { kind: 'reveal', rank: 7 },
      { kind: 'deal', to: 'dealer', index: 2, rank: 5 },
      { kind: 'settle', outcome: 'win', payout: '2000000', wager: '1000000' },
    ])
  })

  it('a double adds the chips before its card', () => {
    const doubled = round({
      ...dealt,
      status: 'settled',
      wager: '2000000',
      payout: '0',
      bj: bj([10, 6, 2], [9, 10], { doubled: true, done: true }),
    })
    expect(kinds(planRound(dealt, doubled))).toEqual(['double', 'deal', 'reveal', 'settle'])
    expect(planRound(dealt, doubled).at(-1)).toMatchObject({ outcome: 'lose' })
  })

  it('a bust keeps the face-down card down and settles', () => {
    const bust = round({ ...dealt, status: 'settled', payout: '0', bj: bj([10, 6, 9], [9], { done: true }) })
    expect(kinds(planRound(dealt, bust))).toEqual(['deal', 'settle'])
  })

  it('a round first seen settled is replayed whole, in draw order', () => {
    const natural = round({ status: 'settled', payout: '2500000', bj: bj([1, 13], [10, 4], { done: true }) })
    expect(kinds(planRound(null, natural))).toEqual(['clear', 'bet', 'deal', 'deal', 'deal', 'deal', 'reveal', 'settle'])
  })

  it('plays nothing when the round did not change', () => {
    expect(planRound(dealt, dealt)).toEqual([])
  })
})

describe('planRound: dice and roulette', () => {
  const dice = round({ dealer_id: 'ada', game: 'dice', bet: { dice: { chance_bp: 5000, over: true } } })

  it('throws the dice once the roll is known', () => {
    const rolled = round({ ...dice, status: 'settled', roll: 4217, payout: '0' })
    expect(planRound(dice, rolled)).toEqual([
      { kind: 'throw', roll: 4217 },
      { kind: 'settle', outcome: 'lose', payout: '0', wager: '1000000' },
    ])
  })

  it('spins and lands on the pocket for a new roulette round', () => {
    const spun = round({ game: 'roulette', bet: { roulette: 'red' }, status: 'settled', pocket: 17, payout: '1940000' })
    expect(planRound(null, spun)).toEqual([
      { kind: 'clear' },
      { kind: 'bet', round: spun },
      { kind: 'spin', pocket: 17 },
      { kind: 'settle', outcome: 'win', payout: '1940000', wager: '1000000' },
    ])
  })

  it('a failed draw shrugs, the refund gives the chips back', () => {
    const failed = round({ ...dice, status: 'failed', error: 'bad proof' })
    const refunded = round({ ...dice, status: 'refunded' })
    expect(planRound(dice, failed)).toEqual([{ kind: 'void', refunded: false }])
    expect(planRound(failed, refunded)).toEqual([{ kind: 'void', refunded: true }])
  })

  it('starts over for another round id', () => {
    const rolled = round({ ...dice, status: 'settled', roll: 10, payout: '0' })
    expect(kinds(planRound(rolled, round({ ...dice, id: 8 })))).toEqual(['clear', 'bet', 'think'])
  })
})

describe('planRound: after the player clicked (drawing)', () => {
  const dice = round({ dealer_id: 'ada', game: 'dice', bet: { dice: { chance_bp: 5000, over: true } } })
  const rolled = round({ ...dice, status: 'settled', roll: 4217, payout: '0' })

  it('places the bet without thinking: the drawing loop runs already', () => {
    expect(kinds(planRound(null, dice, true))).toEqual(['clear', 'bet'])
  })

  it('plays only the result once the draw lands', () => {
    expect(kinds(planRound(dice, rolled, true))).toEqual(['throw', 'settle'])
    expect(kinds(planRound(null, rolled, true))).toEqual(['clear', 'bet', 'throw', 'settle'])
  })

  it('a blackjack hit only deals its card', () => {
    const dealt = round({ status: 'player_turn', step: 1, bj: bj([10, 6], [9]) })
    const asked = round({ ...dealt, status: 'waiting_vrf' })
    expect(planRound(dealt, asked, true)).toEqual([])
    expect(kinds(planRound(asked, round({ ...dealt, bj: bj([10, 6, 3], [9]) }), true))).toEqual(['deal'])
  })

  it('the first step showing the answer ends the loop', () => {
    const steps = planRound(null, rolled)
    expect(steps.map(endsDrawing)).toEqual([false, false, true, true])
    expect(endsDrawing({ kind: 'think' })).toBe(false)
    expect(endsDrawing({ kind: 'void', refunded: false })).toBe(true)
  })
})

describe('continues', () => {
  it('rejects snapshots that do not extend the cards on the table', () => {
    const a = round({ status: 'player_turn', bj: bj([10, 6], [9]) })
    expect(continues(a, round({ ...a, bj: bj([10, 7], [9]) }))).toBe(false)
    expect(continues(a, round({ ...a, bj: bj([10, 6, 2], [9]) }))).toBe(true)
  })

  it('a refund only follows a failed draw', () => {
    const settled = round({ status: 'settled', payout: '0' })
    expect(continues(settled, round({ status: 'refunded' }))).toBe(false)
    expect(continues(round({ status: 'failed' }), round({ status: 'refunded' }))).toBe(true)
  })
})

describe('outcomeOf', () => {
  it('compares the payout to the wager', () => {
    expect(outcomeOf({ payout: '1000000', wager: '1000000' })).toBe('push')
    expect(outcomeOf({ payout: null, wager: '1' })).toBe('lose')
  })
})
