import { useEffect, useState } from 'react'

/** Unix seconds, refreshed every second, for countdowns (boosts, stuck-round refunds). */
export function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}
