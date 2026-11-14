// Season 1: every table on the USD floor ranked by its LPs' profit, NPC dealers and player-owned
// tables on one board. The lobby shows the top 3 (`SeasonPodium`).
import { useCallback, useMemo } from 'react'
import { Link } from 'react-router'
import { TOKEN_SYMBOLS } from '../config'
import { formatPrice, formatPriceChange, formatUsdc, shortAccount } from '../format'
import { getFloorState, type FloorState } from '../near/floor'
import { useNear } from '../near/useNear'
import { PAGE_POLL_MS, usePoll } from '../near/usePoll'
import { SEASON_START, seasonRanking, tableTag, type SeasonRow } from '../season'
import './Season.css'

const PODIUM_SIZE = 3
const USD = TOKEN_SYMBOLS.usd

/**
 * The USD floor's ranking, whatever the currency. `reuse`: the page already polls the USD floor
 * (`sameFloor`), so no second poll.
 */
export function useSeasonRanking(sameFloor: FloorState | null, reuse: boolean): { rows: SeasonRow[] | null; error: string } {
  const { config } = useNear()
  const load = useCallback(() => getFloorState({ rpcUrl: config.rpcUrl, houseContract: config.usdFloor }), [config])
  const polled = usePoll(reuse ? null : load, PAGE_POLL_MS)
  const state = reuse ? sameFloor : polled.data
  const rows = useMemo(() => (state ? seasonRanking(state, config.testAccounts) : null), [state, config.testAccounts])
  return { rows, error: reuse ? '' : polled.error }
}

export function Season() {
  const { config } = useNear()
  const { rows, error } = useSeasonRanking(null, false)
  return (
    <>
      <h1>Season 1 · leaderboard</h1>
      <p className="muted">
        Season 1 runs from {SEASON_START} (UTC). Every table on the USD floor ({config.usdFloor}) ranked by what it made for
        its LPs: the change of its LP share price since it opened. The house&apos;s NPC dealers and the players&apos; tables
        are on the same board: <Link to="/open">open a table</Link> and beat them.
      </p>
      {error ? <p className="loss">Could not load the floor: {error}</p> : null}
      {rows === null && !error ? <p className="muted">loading tables…</p> : null}
      {rows ? <SeasonTable rows={rows} /> : null}
    </>
  )
}

function SeasonTable({ rows }: { rows: SeasonRow[] }) {
  return (
    <table className="grid season-table">
      <caption className="muted">LP result since each table opened · seats and rent in {USD}</caption>
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">table</th>
          <th scope="col">owner</th>
          <th scope="col">seat · rent</th>
          <th scope="col">LP price</th>
          <th scope="col">LP profit</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.dealerId} className={row.open ? undefined : 'closed'}>
            <td className={row.rank <= PODIUM_SIZE ? 'season-rank top' : 'season-rank'}>{row.rank}</td>
            <th scope="row">
              {row.name} <span className="muted">· {row.game}</span>
              <span className={row.playerOwned ? 'badge' : 'badge npc'}>{tableTag(row)}</span>
            </th>
            <td>{row.owner ? <span title={row.owner}>{shortAccount(row.owner)}</span> : <span className="muted">the house</span>}</td>
            <td>{row.seat === null ? <span className="muted">off the floor</span> : `seat ${row.seat} · ${formatUsdc(row.rent ?? '0')}/h`}</td>
            <td>{formatPrice(row.price)}</td>
            <td className={row.changeBp >= 0 ? 'win' : 'loss'}>{formatPriceChange(row.price)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The lobby's compact top 3. */
export function SeasonPodium({ rows }: { rows: SeasonRow[] }) {
  if (rows.length === 0) return null
  return (
    <section className="season-podium" aria-label="Season 1 top 3">
      <span className="season-title">Season 1 · top {PODIUM_SIZE}</span>
      <ol>
        {rows.slice(0, PODIUM_SIZE).map((row) => (
          <li key={row.dealerId}>
            <strong>{row.name}</strong>{' '}
            <span className="muted">
              · {row.playerOwned && !row.houseTest ? (row.owner ? shortAccount(row.owner) : 'a player') : tableTag(row)}
            </span>{' '}
            <span className={row.changeBp >= 0 ? 'win' : 'loss'}>{formatPriceChange(row.price)}</span>
          </li>
        ))}
      </ol>
      <Link to="/season">Full leaderboard →</Link>
    </section>
  )
}
