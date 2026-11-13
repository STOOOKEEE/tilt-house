import { useCallback, useEffect, useState } from 'react'
import { ActionStatus, type ActionState } from '../components/ActionStatus'
import { LineChart, type Series } from '../components/LineChart'
import { LoginPrompt } from '../components/LoginPrompt'
import { TOKEN_SYMBOLS } from '../config'
import { formatAmount, formatCountdown, formatUsdc, parseUsdc, shortAccount } from '../format'
import { fullAccessCall } from '../near/session'
import {
  PARAM_LABELS,
  SECS_PER_DAY,
  dayLabel,
  formatParam,
  getFloorDay,
  getTiltSnapshot,
  loadTiltSim,
  nsToSecs,
  paramAmount,
  paramInt,
  tiltHourProgressBp,
  windowSecsLeft,
  type DayView,
  type TiltLogEntry,
  type TiltSim,
  type TiltSnapshot,
} from '../near/tilt'
import { useNear } from '../near/useNear'
import { PAGE_POLL_MS, usePoll } from '../near/usePoll'
import { getTokenBalance } from '../near/views'
import { useNow } from '../useNow'

const TILT = TOKEN_SYMBOLS.tilt
const USD = TOKEN_SYMBOLS.usd
/** NEAR asks 1 yocto on `burn_for_tilt_hour` so only a full-access (Privy) signature can burn. */
const ONE_YOCTO = 1n
const UNIT = 1_000_000

export function Tilt() {
  const { config } = useNear()
  const now = useNow()
  const loadTilt = useCallback(() => getTiltSnapshot(config.rpcUrl, config.tiltToken), [config])
  const loadDay = useCallback(() => getFloorDay(config.rpcUrl, config.usdFloor), [config])
  const tilt = usePoll(config.tiltToken ? loadTilt : null, PAGE_POLL_MS)
  const day = usePoll(config.tiltToken ? loadDay : null, PAGE_POLL_MS)

  return (
    <>
      <h1>$TILT</h1>
      <ul className="tilt-pitch">
        <li>The house is on tilt: every UTC day the players beat the USD floor, TILT is minted to them by chips wagered.</li>
        <li>Every day the house wins, a fixed share of the TILT treasury burns and the streak resets.</li>
        <li>Burn TILT together to start Tilt Hour: every USD table plays at its minimum edge for an hour.</li>
      </ul>
      {!config.tiltToken ? <p className="muted">$TILT lives on testnet: switch the network to testnet.</p> : null}
      {tilt.error ? <p className="loss">Could not load {config.tiltToken}: {tilt.error}</p> : null}
      {day.error ? <p className="loss">Could not load today on {config.usdFloor}: {day.error}</p> : null}
      {tilt.data?.mock ? (
        <p className="loss">
          {config.tiltToken} is not deployed yet: the numbers below are a mock of what the page will show.
        </p>
      ) : null}
      {tilt.data ? (
        <>
          <Supply snapshot={tilt.data} />
          <Streak snapshot={tilt.data} />
        </>
      ) : null}
      {day.data ? <Today today={day.data.today} mock={day.data.mock} snapshot={tilt.data} now={now} /> : null}
      {tilt.data ? (
        <TiltHour snapshot={tilt.data} activeUntil={day.data?.tiltHourUntil ?? 0} now={now} refresh={tilt.refresh} />
      ) : null}
      {tilt.data ? <Log entries={tilt.data.log} /> : null}
      {tilt.data ? <Params params={tilt.data.params} /> : null}
      <Simulation />
    </>
  )
}

function Supply({ snapshot }: { snapshot: TiltSnapshot }) {
  const s = snapshot.state
  return (
    <section className="panel">
      <h2>Supply</h2>
      <dl className="tilt-stats">
        <Stat label="total supply" value={formatAmount(s.total_supply, TILT)} />
        <Stat label="treasury (the only thing that burns daily)" value={formatAmount(s.treasury, TILT)} />
        <Stat label="circulating (held by players)" value={formatAmount(s.circulating, TILT)} />
        <Stat label="welcome pool left" value={`${formatAmount(s.welcome_remaining, TILT)} · ${s.welcome_claims} claimed`} />
        <Stat label="minted since launch" value={formatAmount(s.minted_total, TILT)} />
        <Stat label="burned since launch" value={formatAmount(s.burned_total, TILT)} />
      </dl>
    </section>
  )
}

function Stat({ label, value, className = 'money' }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <dt className="muted">{label}</dt>
      <dd className={className}>{value}</dd>
    </div>
  )
}

function Streak({ snapshot }: { snapshot: TiltSnapshot }) {
  const s = snapshot.state
  return (
    <section className="panel">
      <h2>House on tilt</h2>
      <dl className="tilt-stats">
        <Stat label="current streak (days the players won in a row)" value={String(s.streak)} className="tilt-big" />
        <Stat label="longest streak (high score)" value={String(s.longest_streak)} className="tilt-big" />
        <Stat label="high score set" value={s.longest_streak_day === null ? '—' : dayLabel(s.longest_streak_day)} className="" />
        <Stat
          label="last day reported"
          value={s.last_reported_day === null ? 'none yet' : dayLabel(s.last_reported_day)}
          className=""
        />
      </dl>
    </section>
  )
}

function Today({ today, mock, snapshot, now }: { today: DayView | null; mock: boolean; snapshot: TiltSnapshot | null; now: number }) {
  const net = today ? BigInt(today.players_net) : 0n
  const burnBp = snapshot ? paramInt(snapshot.params, 'burn_bp') : null
  const endsIn = formatCountdown(SECS_PER_DAY - (now % SECS_PER_DAY))
  return (
    <section className="panel">
      <h2>Today on the USD floor</h2>
      {mock ? <p className="loss">The USD floor does not count days yet (no get_day): mock numbers.</p> : null}
      {today ? (
        <>
          <p>
            players vs the house:{' '}
            <span className={net > 0n ? 'win' : net < 0n ? 'loss' : 'money'}>
              {net > 0n ? '+' : ''}
              {formatAmount(net, USD)}
            </span>{' '}
            · {today.players.length} player{today.players.length === 1 ? '' : 's'} counted · {formatAmount(today.wagered, USD)}{' '}
            wagered
          </p>
          <p className="muted">
            {net > 0n
              ? `If it ends like this, TILT is minted to these players pro rata to chips wagered and the streak grows.`
              : `If it ends like this, ${burnBp === null ? 'a share' : `${(burnBp / 100).toFixed(2)}%`} of the treasury burns and the streak resets.`}{' '}
            The day closes in {endsIn} (UTC midnight); NPC gamblers are not counted.
          </p>
          {today.players.length > 0 ? (
            <table className="grid">
              <thead>
                <tr>
                  <th scope="col">player</th>
                  <th scope="col">wagered</th>
                  <th scope="col">net</th>
                </tr>
              </thead>
              <tbody>
                {today.players.map((p) => (
                  <tr key={p.account_id}>
                    <th scope="row">{shortAccount(p.account_id)}</th>
                    <td className="money">{formatUsdc(p.wagered)}</td>
                    <td className={BigInt(p.net) >= 0n ? 'win' : 'loss'}>{formatUsdc(BigInt(p.net))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      ) : (
        <p className="muted">No human player has bet on the USD floor today yet. The day closes in {endsIn}.</p>
      )}
    </section>
  )
}

interface TiltHourProps {
  snapshot: TiltSnapshot
  activeUntil: number
  now: number
  refresh: () => void
}

function TiltHour({ snapshot, activeUntil, now, refresh }: TiltHourProps) {
  const hour = snapshot.state.tilt_hour
  const threshold = paramAmount(snapshot.params, 'tilt_hour_amount')
  const minBurners = paramInt(snapshot.params, 'tilt_hour_min_burners')
  const windowLeft = windowSecsLeft(hour, now)
  const progressBp = threshold === null ? 0 : tiltHourProgressBp(hour, threshold, now)
  const active = activeUntil > now
  return (
    <section className="panel">
      <h2>Tilt Hour</h2>
      {active ? (
        <p className="tilt-hour-banner">
          Tilt Hour is on: every USD table plays at its minimum edge for {formatCountdown(activeUntil - now)} more (until{' '}
          {new Date(activeUntil * 1000).toISOString().slice(11, 16)} UTC).
        </p>
      ) : null}
      <p>
        burned{' '}
        <span className="money">
          {windowLeft > 0 ? formatAmount(hour.burned, TILT) : `0 ${TILT}`} / {threshold === null ? '—' : formatAmount(threshold, TILT)}
        </span>{' '}
        · {windowLeft > 0 ? hour.burners : 0} / {minBurners ?? '—'} distinct burners ·{' '}
        {windowLeft > 0 ? `window closes in ${formatCountdown(windowLeft)}` : 'no window open: the next burn opens one'}
      </p>
      <progress max={10_000} value={progressBp} aria-label="Tilt Hour progress" />
      <p className="muted">
        Tilt Hours so far: {hour.triggers}
        {hour.last_started_ns ? ` · last started ${new Date(nsToSecs(hour.last_started_ns) * 1000).toISOString().slice(11, 16)} UTC` : ''}. When the window
        closes short of the goal, the counter resets (the burned TILT stays burned).
      </p>
      <BurnForm snapshot={snapshot} refresh={refresh} />
    </section>
  )
}

function BurnForm({ snapshot, refresh }: { snapshot: TiltSnapshot; refresh: () => void }) {
  const { config, walletId, nearAccount } = useNear()
  const loadBalance = useCallback(() => getTokenBalance(config.rpcUrl, config.tiltToken, walletId), [config, walletId])
  const balance = usePoll(walletId && !snapshot.mock ? loadBalance : null, PAGE_POLL_MS)
  const [text, setText] = useState('')
  const [action, setAction] = useState<ActionState>({ state: 'idle' })
  if (!walletId || !nearAccount) return <LoginPrompt action="burn TILT for Tilt Hour" />

  const amount = parseUsdc(text)
  const minBurn = paramAmount(snapshot.params, 'tilt_hour_min_burn') ?? 1n
  const held = balance.data === null ? null : BigInt(balance.data)
  const problem =
    amount === null || amount === 0n
      ? ''
      : amount < minBurn
        ? `the smallest burn that counts is ${formatAmount(minBurn, TILT)}`
        : held !== null && amount > held
          ? `you hold ${formatAmount(held, TILT)}`
          : ''
  const valid = amount !== null && amount > 0n && problem === '' && !snapshot.mock
  const burn = (value: bigint) => {
    const label = `Burn ${formatAmount(value, TILT)}`
    setAction({ state: 'busy', label })
    fullAccessCall(nearAccount, config, config.tiltToken, 'burn_for_tilt_hour', { amount: value.toString() }, ONE_YOCTO)
      .then(({ txHash }) => {
        setAction({ state: 'done', label, txHash })
        setText('')
      })
      .catch((error: unknown) => setAction({ state: 'error', message: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        refresh()
        balance.refresh()
      })
  }
  return (
    <>
      <form
        className="amount-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) burn(amount)
        }}
      >
        <input placeholder={TILT} inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)} />
        <button type="submit" disabled={!valid || action.state === 'busy'}>
          Burn for Tilt Hour
        </button>
        <span className="muted">you hold {held === null ? '—' : formatAmount(held, TILT)}</span>
      </form>
      {problem ? <p className="loss">{problem}</p> : null}
      <ActionStatus action={action} />
    </>
  )
}

const LOG_TEXT: Record<string, string> = {
  'mint:launch': 'minted at launch',
  'mint:daily': 'minted: players beat the house',
  'mint:welcome': 'welcome',
  'burn:daily': 'treasury burned: the house won',
  'burn:tilt_hour': 'burned for Tilt Hour',
  'streak:grow': 'streak grew to',
  'streak:reset': 'streak reset',
  'tilt_hour:triggered': 'Tilt Hour goal reached',
  'tilt_hour:started': 'Tilt Hour started',
  'tilt_hour:failed': 'the floor refused Tilt Hour',
}

function logAmount(entry: TiltLogEntry): string {
  if (entry.kind === 'streak') return entry.reason === 'grow' ? entry.amount : ''
  return formatAmount(entry.amount, TILT)
}

function Log({ entries }: { entries: TiltLogEntry[] }) {
  return (
    <section className="panel">
      <h2>Every mint and burn</h2>
      <p className="muted">From the contract's on-chain log (NEP-297 events, newest first).</p>
      <table className="grid">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">when (UTC)</th>
            <th scope="col">what</th>
            <th scope="col">account</th>
            <th scope="col">amount</th>
          </tr>
        </thead>
        <tbody>
          {[...entries].reverse().map((e) => (
            <tr key={e.seq}>
              <td className="muted">{e.seq}</td>
              <td>{new Date(nsToSecs(e.timestamp_ns) * 1000).toISOString().slice(0, 16).replace('T', ' ')}</td>
              <td className={e.kind === 'mint' ? 'win' : e.kind === 'burn' ? 'loss' : undefined}>
                {LOG_TEXT[`${e.kind}:${e.reason}`] ?? `${e.kind} ${e.reason}`}
              </td>
              <td>{e.account ? shortAccount(e.account) : <span className="muted">—</span>}</td>
              <td className="money">{logAmount(e)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Params({ params }: { params: TiltSnapshot['params'] }) {
  return (
    <section className="panel">
      <h2>Launch parameters</h2>
      <p className="muted">Set once at launch, readable by anyone (get_params); no admin key can change them.</p>
      <table className="grid">
        <tbody>
          {Object.entries(params).map(([key, value]) => (
            <tr key={key}>
              <th scope="row">{PARAM_LABELS[key] ?? key}</th>
              <td className="muted">{key}</td>
              <td className="money">{formatParam(key, value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

const SIM_COLORS = { supply: '#ec6fae', treasury: '#f0c26a', minted: '#6fcf97', burned: '#eb5757', streak: '#56ccf2' }

function Simulation() {
  const [sim, setSim] = useState<TiltSim | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState('')
  useEffect(() => {
    loadTiltSim()
      .then(setSim)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [])
  const scenario = sim?.scenarios.find((s) => s.id === picked) ?? sim?.scenarios[0] ?? null
  const tilts = (key: 'supply' | 'treasury' | 'minted' | 'burned'): Series => ({
    id: key,
    label: key,
    color: SIM_COLORS[key],
    values: scenario?.series.map((d) => Number(BigInt(d[key]) / BigInt(UNIT))) ?? [],
  })
  const last = (scenario?.series.length ?? 1) - 1
  return (
    <section className="panel">
      <h2>60 days, simulated</h2>
      {error ? <p className="loss">Could not load tilt-sim.json: {error}</p> : null}
      {sim === null ? <p className="muted">The simulation has not been generated yet (web/public/tilt-sim.json).</p> : null}
      {sim && scenario ? (
        <>
          <div className="network-switch" role="group" aria-label="Scenario">
            {sim.scenarios.map((s) => (
              <button
                key={s.id}
                type="button"
                className={s.id === scenario.id ? 'active' : 'ghost'}
                aria-pressed={s.id === scenario.id}
                onClick={() => setPicked(s.id)}
              >
                {s.id}
              </button>
            ))}
          </div>
          <p className="muted">{scenario.description}</p>
          <div className="charts">
            <LineChart title={`supply (${TILT})`} series={[tilts('supply'), tilts('treasury')]} upTo={last} format={compact} />
            <LineChart title={`per day (${TILT})`} series={[tilts('minted'), tilts('burned')]} upTo={last} format={compact} />
            <LineChart
              title="streak (days)"
              series={[{ id: 'streak', label: 'streak', color: SIM_COLORS.streak, values: scenario.series.map((d) => d.streak) }]}
              upTo={last}
              format={(v) => v.toFixed(0)}
            />
          </div>
        </>
      ) : null}
    </section>
  )
}

function compact(value: number): string {
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return value.toFixed(0)
}
