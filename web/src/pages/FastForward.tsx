import { useEffect, useMemo, useRef, useState } from 'react'
import { LineChart, type Series } from '../components/LineChart'
import { formatBp, formatPrice, formatSimTime, formatUsdc } from '../format'
import { advance, dealerSeries, eventsUpTo, parseSim, type SimData, type SimEventKind } from '../sim/sim'

const COLORS = ['#ec6fae', '#f0c26a', '#7ccf8f', '#6fb7ec', '#b58cf0']
const SPEEDS = [0.25, 0.5, 1, 2, 4] as const
const NOTABLE: readonly SimEventKind[] = ['bust', 'reopen', 'boost']
const EVENT_COLOR: Record<string, string> = { bust: 'var(--loss)', reopen: 'var(--win)', boost: 'var(--gold)' }

/** `core_rules::base_edge_bp`: the sim reports the rake, the lobby shows base edge + rake. */
const BASE_EDGE_BP: Record<string, number> = { dice: 0, roulette: 270, blackjack: 117 }

export function FastForward() {
  const [sim, setSim] = useState<SimData | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/sim.json')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<unknown>
      })
      .then((json) => setSim(parseSim(json)))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  return (
    <>
      <h1>Fast-forward</h1>
      <p className="muted">
        A simulated week of the house, run with the same Rust rules as the contract (games, rake, pools, dealer pricing):
        price-hunting, loyal and whale players, and LPs moving liquidity and rescuing busted dealers.
      </p>
      {error ? <p className="loss">Could not load sim.json: {error}</p> : null}
      {sim ? <Player sim={sim} /> : !error ? <p className="muted">loading the week…</p> : null}
    </>
  )
}

function Player({ sim }: { sim: SimData }) {
  const [position, setPosition] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  // The animation loop reads the play head from a ref: a state updater may run later than the frame.
  const positionRef = useRef(0)
  positionRef.current = position
  const frameCount = sim.frames.length
  const frameIndex = Math.floor(position)
  const frame = sim.frames[frameIndex]

  useEffect(() => {
    if (!playing) return
    let handle = 0
    let lastTime: number | null = null
    const tick = (time: number) => {
      const next = advance(positionRef.current, lastTime === null ? 0 : time - lastTime, speed, frameCount)
      lastTime = time
      positionRef.current = next.position
      setPosition(next.position)
      if (next.ended) setPlaying(false)
      else handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [playing, speed, frameCount])

  const charts = useMemo(() => buildCharts(sim), [sim])
  const events = useMemo(() => eventsUpTo(sim, frameIndex, NOTABLE), [sim, frameIndex])
  const names = useMemo(() => new Map(sim.dealers.map((d) => [d.id, d.name])), [sim])

  const togglePlay = () => {
    if (!playing && frameIndex >= frameCount - 1) setPosition(0)
    setPlaying(!playing)
  }

  return (
    <>
      <div className="sim-controls">
        <button type="button" onClick={togglePlay}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          min={0}
          max={frameCount - 1}
          value={frameIndex}
          onChange={(event) => setPosition(Number(event.target.value))}
          aria-label="scrub"
        />
        <span>{formatSimTime(frame.t)}</span>
        <label>
          speed{' '}
          <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}× {s === 1 ? '(a week in ~1 min)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th>dealer</th>
            <th>bankroll</th>
            <th>LP price</th>
            <th>edge</th>
            <th>max bet</th>
            <th>status</th>
            <th>why</th>
          </tr>
        </thead>
        <tbody>
          {frame.dealers.map((d, i) => {
            const info = sim.dealers.find((s) => s.id === d.id)
            return (
              <tr key={d.id}>
                <td style={{ color: COLORS[i % COLORS.length] }}>
                  {info?.name ?? d.id} <span className="muted">{info ? `${info.temperament} · ${info.game}` : ''}</span>
                </td>
                <td className="money">{formatUsdc(d.bankroll)}</td>
                <td>{formatPrice(d.share_price)}</td>
                <td>{formatBp((BASE_EDGE_BP[info?.game ?? ''] ?? 0) + d.rake_bp)}</td>
                <td>{formatUsdc(d.max_bet)}</td>
                <td className={d.open ? (d.boost ? 'win' : '') : 'loss'}>{d.open ? (d.boost ? 'boost' : 'open') : 'closed'}</td>
                <td className="muted">{d.reason.replace(/_/g, ' ')}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div className="charts">
        <LineChart title="bankroll (tUSDC)" series={charts.bankroll} upTo={frameIndex} format={(v) => v.toFixed(0)} />
        <LineChart title="LP price (× launch)" series={charts.price} upTo={frameIndex} format={(v) => v.toFixed(3)} />
        <LineChart title="edge (%)" series={charts.edge} upTo={frameIndex} format={(v) => v.toFixed(2)} />
      </div>

      <Timeline sim={sim} upTo={frameIndex} />
      <ul className="events">
        {events.slice(0, 12).map((event, i) => (
          <li key={`${event.t}-${event.dealer}-${i}`}>
            <span className="muted">{formatSimTime(event.t)}</span>{' '}
            <span style={{ color: EVENT_COLOR[event.kind] }}>{event.kind}</span> {names.get(event.dealer) ?? event.dealer}:{' '}
            {event.text}
          </li>
        ))}
      </ul>
    </>
  )
}

/** Chart values are for drawing only (floats are fine here: no money is computed from them). */
function buildCharts(sim: SimData): Record<'bankroll' | 'price' | 'edge', Series[]> {
  const gameOf = new Map(sim.dealers.map((d) => [d.id, d.game]))
  const bankroll = dealerSeries(sim, (d) => Number(d.bankroll) / 1e6)
  const price = dealerSeries(sim, (d) => Number(d.share_price) / 1e6)
  const edge = dealerSeries(sim, (d) => ((BASE_EDGE_BP[gameOf.get(d.id) ?? ''] ?? 0) + d.rake_bp) / 100)
  const toSeries = (values: Map<string, number[]>) =>
    sim.dealers.map((d, i) => ({ id: d.id, label: d.name, color: COLORS[i % COLORS.length], values: values.get(d.id) ?? [] }))
  return { bankroll: toSeries(bankroll), price: toSeries(price), edge: toSeries(edge) }
}

/** Busts, reopenings and boosts as ticks on one strip per dealer. */
function Timeline({ sim, upTo }: { sim: SimData; upTo: number }) {
  const width = 600
  const row = 14
  const last = sim.frames.length - 1
  const rowOf = new Map(sim.dealers.map((d, i) => [d.id, i]))
  const ticks = useMemo(
    () => sim.frames.flatMap((frame, i) => frame.events.filter((e) => NOTABLE.includes(e.kind)).map((e) => ({ i, e }))),
    [sim],
  )
  return (
    <figure className="chart">
      <figcaption>
        events: <span style={{ color: EVENT_COLOR.bust }}>bust</span> <span style={{ color: EVENT_COLOR.reopen }}>reopen</span>{' '}
        <span style={{ color: EVENT_COLOR.boost }}>boost</span>
      </figcaption>
      <svg viewBox={`0 0 ${width} ${row * sim.dealers.length}`} preserveAspectRatio="none" role="img" aria-label="events timeline">
        {ticks
          .filter(({ i }) => i <= upTo)
          .map(({ i, e }, n) => {
            const x = (i / last) * width
            const y = (rowOf.get(e.dealer) ?? 0) * row
            const tall = e.kind !== 'boost'
            return (
              <rect key={n} x={x} y={y + (tall ? 1 : 4)} width={tall ? 3 : 1.5} height={tall ? row - 2 : row - 8} fill={EVENT_COLOR[e.kind]} />
            )
          })}
        <line x1={(upTo / last) * width} x2={(upTo / last) * width} y1={0} y2={row * sim.dealers.length} className="cursor" />
      </svg>
    </figure>
  )
}
