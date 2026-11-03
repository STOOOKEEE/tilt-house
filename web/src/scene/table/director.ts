// Turns two snapshots of a round into the animation plan that leads from one to the other.
// Pure: no three.js, so the order of draws is unit-tested; TableScene plays the steps in order.
import type { RoundView } from '../../near/views'

/** Who wins, seen from the player: drives pay/collect and the dealer's reaction. */
export type Outcome = 'win' | 'lose' | 'push'

export type Step =
  /** Clears the previous round off the felt. */
  | { kind: 'clear' }
  /** The player's chips land on the betting spot. */
  | { kind: 'bet'; round: RoundView }
  /** The VRF is drawing: the dealer waits, the table shows a "thinking" loop until the next step. */
  | { kind: 'think' }
  /** Blackjack: a second stake joins the first. */
  | { kind: 'double' }
  /** Blackjack: one card to `to`; `rank` null = the face-down placeholder in the dealer's second spot. */
  | { kind: 'deal'; to: 'player' | 'dealer'; index: number; rank: number | null }
  /** Blackjack: the dealer turns its face-down card, which is `rank`. */
  | { kind: 'reveal'; rank: number }
  | { kind: 'spin'; pocket: number }
  | { kind: 'throw'; roll: number }
  | { kind: 'settle'; outcome: Outcome; payout: string; wager: string }
  /** The draw failed (`refunded` false) or the stake came back (`refunded` true): shrug, chips back. */
  | { kind: 'void'; refunded: boolean }

/** Where the hole-card placeholder sits: the dealer's second card spot. */
const HOLE_INDEX = 1
const FIRST_DEAL = 2

/** The ordered steps from `previous` (what the table shows) to `next`. Empty when nothing changed. */
export function planRound(previous: RoundView | null, next: RoundView): Step[] {
  const from = previous !== null && continues(previous, next) ? previous : null
  const steps: Step[] = from === null ? [{ kind: 'clear' }, { kind: 'bet', round: next }] : []
  if (next.game === 'blackjack') steps.push(...blackjackSteps(from, next))
  if (next.roll !== null && from?.roll == null) steps.push({ kind: 'throw', roll: next.roll })
  if (next.pocket !== null && from?.pocket == null) steps.push({ kind: 'spin', pocket: next.pocket })
  steps.push(...endSteps(from, next))
  return steps
}

/** True when `next` is a later state of the round on the table, so only the difference is played. */
export function continues(previous: RoundView, next: RoundView): boolean {
  if (previous.id !== next.id || previous.game !== next.game) return false
  if (previous.roll !== null && previous.roll !== next.roll) return false
  if (previous.pocket !== null && previous.pocket !== next.pocket) return false
  // A finished round only moves on from `failed` (to `refunded`); anything else is a new snapshot.
  const finished = previous.status === 'settled' || previous.status === 'refunded'
  if (finished && previous.status !== next.status) return false
  const before = previous.bj
  if (before === null) return true
  const after = next.bj
  return after !== null && isPrefix(before.player, after.player) && isPrefix(before.dealer, after.dealer)
}

function blackjackSteps(from: RoundView | null, next: RoundView): Step[] {
  const hand = next.bj
  if (hand === null) return []
  const before = from?.bj ?? null
  const shownPlayer = before?.player.length ?? 0
  const shownDealer = before?.dealer.length ?? 0
  const steps: Step[] = []
  if (shownPlayer === 0) {
    // Dealt like a real shoe: player, dealer, player, then the dealer's face-down card. The contract
    // has no hole card (it draws the dealer's second card when it plays), so the face-down card is a
    // placeholder that the reveal turns into the real draw.
    steps.push(
      { kind: 'deal', to: 'player', index: 0, rank: hand.player[0] },
      { kind: 'deal', to: 'dealer', index: 0, rank: hand.dealer[0] },
      { kind: 'deal', to: 'player', index: 1, rank: hand.player[1] },
      { kind: 'deal', to: 'dealer', index: HOLE_INDEX, rank: null },
    )
  }
  if (hand.doubled && before?.doubled !== true) steps.push({ kind: 'double' })
  for (let i = Math.max(shownPlayer, FIRST_DEAL); i < hand.player.length; i++) {
    steps.push({ kind: 'deal', to: 'player', index: i, rank: hand.player[i] })
  }
  if (hand.dealer.length > HOLE_INDEX && shownDealer <= HOLE_INDEX) {
    steps.push({ kind: 'reveal', rank: hand.dealer[HOLE_INDEX] })
  }
  for (let i = Math.max(shownDealer, FIRST_DEAL); i < hand.dealer.length; i++) {
    steps.push({ kind: 'deal', to: 'dealer', index: i, rank: hand.dealer[i] })
  }
  return steps
}

function endSteps(from: RoundView | null, next: RoundView): Step[] {
  if (from?.status === next.status) return []
  switch (next.status) {
    case 'waiting_vrf':
      return [{ kind: 'think' }]
    case 'player_turn':
      return []
    case 'failed':
      return [{ kind: 'void', refunded: false }]
    case 'refunded':
      return [{ kind: 'void', refunded: true }]
    case 'settled':
      return [{ kind: 'settle', outcome: outcomeOf(next), payout: next.payout ?? '0', wager: next.wager }]
  }
}

/** Settled rounds compare the payout (after rake) to what was at risk. */
export function outcomeOf(round: Pick<RoundView, 'payout' | 'wager'>): Outcome {
  const payout = BigInt(round.payout ?? '0')
  const wager = BigInt(round.wager)
  if (payout > wager) return 'win'
  return payout === wager ? 'push' : 'lose'
}

function isPrefix(shorter: readonly number[], longer: readonly number[]): boolean {
  return shorter.length <= longer.length && shorter.every((card, i) => longer[i] === card)
}
