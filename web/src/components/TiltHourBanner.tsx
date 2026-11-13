import { useCallback } from 'react'
import { Link } from 'react-router'
import { formatCountdown } from '../format'
import { getTiltHourUntil } from '../near/tilt'
import { useNear } from '../near/useNear'
import { usePoll } from '../near/usePoll'
import { useNow } from '../useNow'

/** A Tilt Hour starts at most once per burn window: a slow poll is enough. */
const TILT_HOUR_POLL_MS = 15_000

/** Lobby banner while a Tilt Hour runs on the USD floor (whatever currency this page plays in). */
export function TiltHourBanner() {
  const { config } = useNear()
  const now = useNow()
  const load = useCallback(() => getTiltHourUntil(config.rpcUrl, config.usdFloor), [config])
  const until = usePoll(load, TILT_HOUR_POLL_MS).data ?? 0
  if (until <= now) return null
  return (
    <p className="tilt-hour-banner">
      Tilt Hour: every USD table plays at its minimum edge for {formatCountdown(until - now)} more (active until{' '}
      {new Date(until * 1000).toISOString().slice(11, 16)} UTC). <Link to="/tilt">What is this?</Link>
    </p>
  )
}
