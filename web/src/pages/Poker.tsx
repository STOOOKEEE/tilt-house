// Poker: the list of tables (`/poker`), one live table (`/poker/:table`) or the practice table
// against local bots (`/poker?demo=1`, no login, nothing on chain).
import { useCallback } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { formatBp, formatUsdc } from '../format'
import { pokerClient } from '../near/poker-client'
import { useNear } from '../near/useNear'
import { usePokerDemo, usePokerLive } from '../near/usePokerTable'
import { PAGE_POLL_MS, TABLE_POLL_MS, useLobby, usePlayer, usePoll } from '../near/usePoll'
import { useSession } from '../near/useSession'
import { PokerRoom } from './PokerRoom'

export function Poker() {
  const { table = '' } = useParams()
  const [searchParams] = useSearchParams()
  if (searchParams.get('demo') === '1') return <PracticeTable />
  return table ? <LiveTable tableId={table} /> : <PokerTables />
}

function PracticeTable() {
  const api = usePokerDemo()
  return <PokerRoom api={api} demo loggedIn={false} wallet={null} />
}

function LiveTable({ tableId }: { tableId: string }) {
  const { config, provider, walletId, gameKey } = useNear()
  const lobby = useLobby(TABLE_POLL_MS)
  const player = usePlayer(TABLE_POLL_MS)
  const dealer = lobby.data?.find((d) => d.id === tableId)
  const session = useSession(config, provider, walletId, gameKey.state === 'ready', dealer, player.data)
  const api = usePokerLive(config, tableId, session)
  if (!config.sessionUrl) return <p className="muted">Poker is offline: no session server configured.</p>
  const elsewhere = session.session && session.session.ticket.dealer_id !== tableId && session.phase === 'playing' ? session.session.ticket.dealer_id : null
  if (elsewhere) {
    return (
      <p>
        You are seated at <Link to={`/table/${elsewhere}`}>{elsewhere}</Link>: leave that table first.
      </p>
    )
  }
  return <PokerRoom api={api} demo={false} loggedIn={walletId !== ''} wallet={player.data ? BigInt(player.data.balance) : null} />
}

function PokerTables() {
  const { config } = useNear()
  const load = useCallback(() => pokerClient(config.sessionUrl).tables(), [config.sessionUrl])
  const tables = usePoll(config.sessionUrl ? load : null, PAGE_POLL_MS)
  return (
    <section className="poker-lobby">
      <h1>Poker</h1>
      <p className="muted">
        No-limit hold'em, 2 to 6 seats, play money. Every deck is committed before your seed goes in and revealed after
        the hand; your browser replays it. House bots are labeled BOT and only fill empty seats.
      </p>
      <p>
        <Link to="/poker?demo=1">Practice table</Link> <span className="muted">· against two local bots, no login</span>
      </p>
      {tables.error ? <p className="loss">Could not load the tables: {tables.error}</p> : null}
      {tables.data ? (
        <table className="poker-tables">
          <thead>
            <tr>
              <th>table</th>
              <th>blinds</th>
              <th>buy-in</th>
              <th>players</th>
              <th>rake</th>
            </tr>
          </thead>
          <tbody>
            {tables.data.map((t) => (
              <tr key={t.table_id}>
                <td>
                  <Link to={`/poker/${encodeURIComponent(t.table_id)}`}>{t.name}</Link>
                </td>
                <td>
                  {formatUsdc(t.small_blind)}/{formatUsdc(t.big_blind)}
                </td>
                <td>
                  {formatUsdc(t.min_buy_in)}–{formatUsdc(t.max_buy_in)}
                </td>
                <td>
                  {t.humans} + {t.npcs} bot{t.npcs === 1 ? '' : 's'} / {t.seats}
                </td>
                <td>{formatBp(t.rake_bp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : config.sessionUrl ? (
        <p className="muted">loading tables…</p>
      ) : (
        <p className="muted">No session server configured: only the practice table is available.</p>
      )}
    </section>
  )
}
