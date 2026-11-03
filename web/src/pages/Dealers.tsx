import { useCallback } from 'react'
import { useSearchParams } from 'react-router'
import { formatBp, formatUsdc } from '../format'
import { useNear } from '../near/useNear'
import { useLobby, usePoll, PAGE_POLL_MS } from '../near/usePoll'
import { getHistory, type HistoryEntry } from '../near/views'

export function Dealers() {
  const lobby = useLobby()
  const { config } = useNear()
  const [params, setParams] = useSearchParams()
  const dealers = lobby.data ?? []
  const selected = dealers.find((d) => d.id === params.get('dealer')) ?? dealers[0] ?? null
  const selectedId = selected?.id ?? null
  const loadHistory = useCallback(() => getHistory(config, selectedId ?? ''), [config, selectedId])
  const history = usePoll(selectedId ? loadHistory : null, PAGE_POLL_MS)

  return (
    <>
      <h1>Dealers</h1>
      <p className="muted">
        Dealers reprice their own table from on-chain rules (bankroll, recent play, liquidity). Every change comes with
        its reason.
      </p>
      {lobby.error ? <p className="loss">Could not load the dealers: {lobby.error}</p> : null}
      <div className="choices">
        {dealers.map((d) => (
          <button key={d.id} type="button" className={d.id === selectedId ? '' : 'ghost'} onClick={() => setParams({ dealer: d.id })}>
            {d.name} · {d.temperament}
          </button>
        ))}
      </div>
      {selected ? (
        <p>
          {selected.name} runs {selected.game} at {formatBp(selected.total_edge_bp)} edge, now: “{selected.reason_text}”
        </p>
      ) : null}
      {history.error ? <p className="loss">Could not load the log: {history.error}</p> : null}
      {history.data && history.data.length === 0 ? <p className="muted">Nothing logged yet.</p> : null}
      {history.data && history.data.length > 0 ? (
        <table className="grid">
          <thead>
            <tr>
              <th>when</th>
              <th>what</th>
              <th>why</th>
            </tr>
          </thead>
          <tbody>
            {[...history.data].reverse().map((entry) => (
              <tr key={entry.seq}>
                <td className="muted">{new Date(entry.t * 1000).toLocaleString()}</td>
                <td className={KIND_CLASS[entry.kind]}>{describe(entry)}</td>
                <td>{entry.reason_text ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  )
}

const KIND_CLASS: Record<HistoryEntry['kind'], string> = {
  reprice: '',
  boost: 'win',
  bust: 'loss',
  reopen: 'win',
  invest: 'money',
  divest: 'money',
}

function describe(entry: HistoryEntry): string {
  switch (entry.kind) {
    case 'reprice':
    case 'boost': {
      const rake = entry.rake_bp === null ? '' : ` rake ${formatBp(entry.rake_bp)}`
      const maxBet = entry.max_bet === null ? '' : ` · max bet ${formatUsdc(entry.max_bet)}`
      return `${entry.kind === 'boost' ? 'boost on ·' : 'reprice ·'}${rake}${maxBet}`
    }
    case 'bust':
      return 'bust: table closed'
    case 'reopen':
      return 'reopened'
    case 'invest':
    case 'divest':
      return `${entry.account_id ?? 'someone'} ${entry.kind === 'invest' ? 'added' : 'took out'} ${formatUsdc(entry.amount ?? '0')} tUSDC`
  }
}
