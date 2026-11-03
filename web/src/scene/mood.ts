import type { DealerView } from '../near/views'
import type { Mood } from './types'

/** Every dealer launches with a 2,000 tUSDC pool; moods compare against it. */
export const LAUNCH_BANKROLL = 2_000_000_000n
// Thresholds in percent of the launch pool, compared in integers (amounts are bigint strings).
const NERVOUS_BELOW_PCT = 90n
const HAPPY_ABOVE_PCT = 105n

const NERVOUS_REASONS: Record<string, true> = { losing_streak: true, low_bankroll: true }
const HAPPY_REASONS: Record<string, true> = { winning_streak: true, hot_table: true }

/** Broke when closed; otherwise the pool size, then the dealer's own reason, decide. */
export function dealerMood(dealer: Pick<DealerView, 'open' | 'bankroll' | 'reason'>): Mood {
  if (!dealer.open) return 'broke'
  const scaled = BigInt(dealer.bankroll) * 100n
  if (scaled < LAUNCH_BANKROLL * NERVOUS_BELOW_PCT || NERVOUS_REASONS[dealer.reason]) return 'nervous'
  if (scaled > LAUNCH_BANKROLL * HAPPY_ABOVE_PCT || HAPPY_REASONS[dealer.reason]) return 'happy'
  return 'neutral'
}
