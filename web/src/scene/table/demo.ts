// Dev-only (`?demo=1` on a table page): scripted rounds that loop, to check the animations of a
// game nobody is playing live (no bot plays blackjack). Never used for real rounds.
import type { BlackjackHand, Game, RoundView } from '../../near/views'

const STAKE = '2000000'
/** Dev `?latency=1`: when the mock move's round shows up (relayer answers at inclusion), then when
 *  its VRF answer lands (OutLayer takes about 6 s), in ms after the click. */
export const LATENCY_INCLUDED_MS = 1_500
export const LATENCY_DRAW_MS = 6_000

/** Hands in the order the contract would reveal them: the deal, each hit, the dealer's play. */
const BLACKJACK_SCRIPTS: { snapshots: BlackjackHand[]; doubled?: boolean; payout: string }[] = [
  {
    snapshots: [
      { player: [10, 6], dealer: [9], doubled: false, done: false },
      { player: [10, 6, 3], dealer: [9], doubled: false, done: false },
      { player: [10, 6, 3], dealer: [9, 7, 5], doubled: false, done: true },
    ],
    payout: '0',
  },
  {
    snapshots: [
      { player: [5, 6], dealer: [6], doubled: false, done: false },
      { player: [5, 6, 13], dealer: [6, 10, 8], doubled: true, done: true },
    ],
    payout: '7880000',
  },
  {
    snapshots: [
      { player: [9, 7], dealer: [10], doubled: false, done: false },
      { player: [9, 7, 12], dealer: [10], doubled: false, done: true },
    ],
    payout: '0',
  },
]

function base(game: Game, dealerId: string, id: number): RoundView {
  const bet: RoundView['bet'] =
    game === 'blackjack' ? 'blackjack' : game === 'dice' ? { dice: { chance_bp: 5000, over: true } } : { roulette: 'red' }
  return {
    id,
    player: 'demo.testnet',
    dealer_id: dealerId,
    game,
    bet,
    stake: STAKE,
    wager: STAKE,
    rake_bp: 300,
    status: 'waiting_vrf',
    step: 0,
    created_at: 0,
    updated_at: 0,
    roll: null,
    pocket: null,
    bj: null,
    payout: null,
    proofs: [],
    error: null,
  }
}

/** Every snapshot of demo round `id`, as polling would see them (waiting for each VRF draw in between). */
export function demoRound(game: Game, dealerId: string, id: number): RoundView[] {
  const start = base(game, dealerId, id)
  if (game === 'dice') {
    const roll = (id * 3637) % 10_000
    return [start, { ...start, status: 'settled', roll, payout: roll >= 5000 ? '3880000' : '0' }]
  }
  if (game === 'roulette') {
    const pocket = (id * 17) % 37
    const red = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36].includes(pocket)
    return [start, { ...start, status: 'settled', pocket, payout: red ? '3880000' : '0' }]
  }
  const script = BLACKJACK_SCRIPTS[id % BLACKJACK_SCRIPTS.length]
  const rounds: RoundView[] = [start]
  script.snapshots.forEach((bj, i) => {
    const last = i === script.snapshots.length - 1
    const wager = bj.doubled ? String(BigInt(STAKE) * 2n) : STAKE
    const snapshot = { ...start, step: i + 1, bj, wager }
    if (i > 0) rounds.push({ ...rounds[rounds.length - 1], status: 'waiting_vrf' })
    rounds.push(last ? { ...snapshot, status: 'settled', payout: script.payout } : { ...snapshot, status: 'player_turn' })
  })
  return rounds
}
