import { useEffect, useRef, useState } from 'react'
import { formatUsdc, tokenSymbol } from '../format'

/** Milliseconds the counter takes to reach a new amount. */
const COUNT_MS = 1_500
/** Easing resolution: the shown amount moves in 1/1000 steps of the change, all in integers. */
const STEPS = 1_000

/** The global jackpot (docs/floor.md): rent fills it, any settled bet can win all of it. `pulse`: the tour points at it. */
export function Jackpot({ amount, oddsUnit, mock, pulse = false }: { amount: string; oddsUnit: string; mock: boolean; pulse?: boolean }) {
  const shown = useCountUp(BigInt(amount))
  return (
    <div className={pulse ? 'jackpot pulse' : 'jackpot'} aria-label={`jackpot ${formatUsdc(amount)} ${tokenSymbol()}`}>
      <span className="jackpot-label">JACKPOT</span>
      <span className="jackpot-amount" aria-hidden="true">
        {formatUsdc(shown)} <small>{tokenSymbol()}</small>
      </span>
      <span className="muted">
        filled by table rent · every settled bet can win it all · a 1 {tokenSymbol()} bet: 1 in {formatUsdc(oddsUnit, 0)}
      </span>
      {mock ? <span className="muted">preview: this contract has no seats or jackpot yet</span> : null}
    </div>
  )
}

/** Counts from the shown amount to `target` with an ease-out, starting at 0 on first paint. */
function useCountUp(target: bigint): bigint {
  const [shown, setShown] = useState(0n)
  const current = useRef(0n)

  useEffect(() => {
    const from = current.current
    if (from === target) return
    const start = performance.now()
    let frame = 0
    const tick = (now: number): void => {
      current.current = countUpValue(from, target, now - start)
      setShown(current.current)
      if (current.current !== target) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target])

  return shown
}

/**
 * The amount shown `elapsedMs` into a count from `from` to `target`, always between the two. A
 * frame's timestamp can precede the moment the count started (the browser stamps the frame when
 * it begins): a negative elapsed time must not extrapolate past `from`, which showed a negative
 * jackpot on first paint.
 */
export function countUpValue(from: bigint, target: bigint, elapsedMs: number): bigint {
  const k = Math.min(1, Math.max(0, elapsedMs / COUNT_MS))
  const eased = BigInt(Math.round((1 - (1 - k) ** 3) * STEPS))
  return from + ((target - from) * eased) / BigInt(STEPS)
}
