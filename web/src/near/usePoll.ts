import { useCallback, useEffect, useState } from 'react'
import { getLobby, getPlayer, type DealerView, type PlayerView } from './views'
import { useNear } from './useNear'

/** The table page follows the round closely; other pages only need to stay roughly fresh. */
export const TABLE_POLL_MS = 2_000
/** While the player's own move is being drawn: the result shows within a poll of landing. */
export const PENDING_POLL_MS = 400
export const PAGE_POLL_MS = 5_000

export interface Polled<T> {
  data: T | null
  error: string
  refresh: () => void
}

/**
 * Calls `load` now and then every `intervalMs` after the previous call finished (never two in
 * flight). `load` must be stable (useCallback); `null` pauses polling and clears the data.
 * The last good data stays on screen while an error is shown.
 */
export function usePoll<T>(load: (() => Promise<T>) | null, intervalMs: number): Polled<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!load) {
      setData(null)
      return
    }
    let stopped = false
    let timer: number | undefined
    const run = async () => {
      try {
        const value = await load()
        if (stopped) return
        setData(value)
        setError('')
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : String(err))
      }
      if (!stopped) timer = window.setTimeout(() => void run(), intervalMs)
    }
    void run()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [load, intervalMs, tick])

  const refresh = useCallback(() => setTick((n) => n + 1), [])
  return { data, error, refresh }
}

export function useLobby(intervalMs = PAGE_POLL_MS): Polled<DealerView[]> {
  const { config } = useNear()
  const load = useCallback(() => getLobby(config), [config])
  return usePoll(load, intervalMs)
}

/** The logged-in player's house account; paused (null) while logged out. */
export function usePlayer(intervalMs = PAGE_POLL_MS): Polled<PlayerView> {
  const { config, walletId } = useNear()
  const load = useCallback(() => getPlayer(config, walletId), [config, walletId])
  return usePoll(walletId ? load : null, intervalMs)
}
