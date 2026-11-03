export interface Series {
  id: string
  label: string
  color: string
  values: number[]
}

interface Props {
  title: string
  series: Series[]
  /** Frames drawn: 0..=upTo. The y range covers the whole run so the axis never jumps. */
  upTo: number
  format: (value: number) => string
}

const WIDTH = 600
const HEIGHT = 160
const PAD = 4

/** Plain SVG line chart; no chart library on purpose (a few polylines is all we need). */
export function LineChart({ title, series, upTo, format }: Props) {
  const all = series.flatMap((s) => s.values)
  const min = Math.min(...all)
  const max = Math.max(...all)
  const span = max - min || 1
  const frames = Math.max(1, ...series.map((s) => s.values.length - 1))
  const x = (i: number) => PAD + (i / frames) * (WIDTH - 2 * PAD)
  const y = (v: number) => HEIGHT - PAD - ((v - min) / span) * (HEIGHT - 2 * PAD)

  return (
    <figure className="chart">
      <figcaption>
        {title}{' '}
        {series.map((s) => (
          <span key={s.id} style={{ color: s.color }}>
            {s.label} {format(s.values[Math.min(upTo, s.values.length - 1)] ?? 0)}{' '}
          </span>
        ))}
      </figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={title}>
        <text x={PAD} y={12} className="axis">
          {format(max)}
        </text>
        <text x={PAD} y={HEIGHT - PAD} className="axis">
          {format(min)}
        </text>
        {series.map((s) => (
          <polyline
            key={s.id}
            fill="none"
            stroke={s.color}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            points={s.values
              .slice(0, upTo + 1)
              .map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
              .join(' ')}
          />
        ))}
        <line x1={x(upTo)} x2={x(upTo)} y1={0} y2={HEIGHT} className="cursor" />
      </svg>
    </figure>
  )
}
