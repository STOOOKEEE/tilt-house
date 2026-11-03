// Keeps a table alive for visitors: follows other players' rounds at one dealer. Round ids are
// global and gapless (get_config `next_round_id`), so each poll fetches the ids created since the
// last one and keeps those at this dealer, plus the unfinished rounds it already follows.
import { getConfig, getRound, type RoundView, type ViewTarget } from '../../near/views'

/** How far back the first poll looks for a round to show right away. */
export const FIRST_LOOK = 8
/** Most new ids fetched per poll: a burst of rounds elsewhere must not flood the RPC. */
export const MAX_SCAN = 20
/** Most rounds followed until they finish: failed draws can sit unrefunded for a long time. */
const MAX_FOLLOWED = 8
/** After failures the poll waits up to 2^4 intervals: a rate-limited RPC (HTTP 429) needs room to recover. */
const MAX_BACKOFF_POW = 4

/** Ids to fetch this poll: after `scanned` (the last id already seen), or the last `firstLook` ids on the first
 *  poll; at most the newest `max`; nothing before round 1. */
export function idsToScan(scanned: number | null, nextRoundId: number, firstLook = FIRST_LOOK, max = MAX_SCAN): number[] {
  const last = nextRoundId - 1
  const from = Math.max(scanned === null ? last - firstLook + 1 : scanned + 1, last - max + 1, 1)
  const ids: number[] = []
  for (let id = from; id <= last; id++) ids.push(id)
  return ids
}

/** This dealer's rounds among `fetched`, oldest first; the first poll keeps only the latest, not a replay. */
export function roundsToShow(fetched: readonly (RoundView | null)[], dealerId: string, firstPoll: boolean): RoundView[] {
  const mine = fetched
    .filter((r): r is RoundView => r !== null && r.dealer_id === dealerId)
    .sort((a, b) => a.id - b.id)
  return firstPoll ? mine.slice(-1) : mine
}

export interface SpectatorOptions {
  target: ViewTarget
  dealerId: string
  intervalMs: number
  /** Same shape as TableSceneApi.showRound: the snapshot already shown (null for a new round) and the new one. */
  onRound: (previous: RoundView | null, next: RoundView) => void
  /** A poll failed (it is retried from the same id); '' once a poll succeeds again. */
  onError: (message: string) => void
}

/** Starts polling; returns the function that stops it. */
export function watchTable({ target, dealerId, intervalMs, onRound, onError }: SpectatorOptions): () => void {
  let scanned: number | null = null
  const followed = new Map<number, RoundView>()
  let stopped = false
  let timer: number | undefined
  let failures = 0

  const poll = async (): Promise<void> => {
    const { next_round_id } = await getConfig(target)
    const refetched = await fetchInTurn(target, [...followed.keys()])
    const fetchedNew = await fetchInTurn(target, idsToScan(scanned, next_round_id))
    if (stopped) return
    const updates = [...roundsToShow(refetched, dealerId, false), ...roundsToShow(fetchedNew, dealerId, scanned === null)]
    scanned = next_round_id - 1
    for (const round of updates) {
      const shown = followed.get(round.id) ?? null
      if (shown === null || round.updated_at !== shown.updated_at || round.status !== shown.status) onRound(shown, round)
      followed.set(round.id, round)
      if (round.status === 'settled' || round.status === 'refunded') followed.delete(round.id)
    }
    for (const id of [...followed.keys()].slice(0, Math.max(0, followed.size - MAX_FOLLOWED))) followed.delete(id)
  }

  const run = async (): Promise<void> => {
    try {
      await poll()
      failures = 0
      if (!stopped) onError('')
    } catch (error) {
      // The next poll retries from the same id: nothing is skipped.
      failures += 1
      if (!stopped) onError(error instanceof Error ? error.message : String(error))
    }
    const delay = intervalMs * 2 ** Math.min(failures, MAX_BACKOFF_POW)
    if (!stopped) timer = window.setTimeout(() => void run(), delay)
  }
  void run()
  return () => {
    stopped = true
    window.clearTimeout(timer)
  }
}

/** One request at a time: public RPCs refuse bursts, and a spectator view is never in a hurry. */
async function fetchInTurn(target: ViewTarget, ids: readonly number[]): Promise<(RoundView | null)[]> {
  const rounds: (RoundView | null)[] = []
  for (const id of ids) rounds.push(await getRound(target, id))
  return rounds
}
