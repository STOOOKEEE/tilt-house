import { Link } from 'react-router'
import { formatBp, formatCountdown, formatPrice, formatPriceChange, formatUsdc } from '../format'
import { freeBankroll, reopenNeeds } from '../house'
import { useLobby } from '../near/usePoll'
import type { DealerView } from '../near/views'
import { useNow } from '../useNow'

export function Lobby() {
  const lobby = useLobby()
  return (
    <>
      <h1>Lobby</h1>
      <p className="muted">
        Every dealer is a liquidity pool. Pick the table with the offer you like, or back a dealer in Pools.
      </p>
      {lobby.error ? <p className="loss">Could not load the lobby: {lobby.error}</p> : null}
      {lobby.data === null && !lobby.error ? <p className="muted">loading tables…</p> : null}
      <div className="cards">
        {lobby.data?.map((dealer) => <DealerCard key={dealer.id} dealer={dealer} />)}
      </div>
    </>
  )
}

function DealerCard({ dealer }: { dealer: DealerView }) {
  const now = useNow()
  const boostLeft = formatCountdown(dealer.boost_until - now)
  const price = dealer.share_price_buy
  return (
    <article className={dealer.open ? 'card' : 'card closed'}>
      <header>
        <strong>{dealer.name}</strong>
        <span className="muted"> · {dealer.temperament}</span>
        <span className="tag">{dealer.game}</span>
      </header>
      <dl>
        <dt>edge</dt>
        <dd title={dealer.reason_text}>
          {formatBp(dealer.total_edge_bp)} <span className="reason">ⓘ {dealer.reason_text}</span>
        </dd>
        <dt>max bet</dt>
        <dd className="money">{formatUsdc(dealer.max_bet)} tUSDC</dd>
        <dt>boost</dt>
        <dd className={boostLeft ? 'win' : 'muted'}>{boostLeft ? `on · ${boostLeft} left` : 'none'}</dd>
        <dt>pool</dt>
        <dd className="money">{formatUsdc(freeBankroll(dealer))} tUSDC</dd>
        <dt>LP price</dt>
        <dd>
          {formatPrice(price)}{' '}
          <span className={BigInt(price) >= 1_000_000n ? 'win' : 'loss'}>{formatPriceChange(price)} vs launch</span>
        </dd>
      </dl>
      <footer>
        {dealer.open ? (
          <>
            <span className="badge open">open</span>
            <Link className="button" to={`/table/${dealer.id}`}>
              Play
            </Link>
          </>
        ) : (
          <>
            <span className="badge">closed · needs {formatUsdc(reopenNeeds(dealer))} tUSDC</span>
            <Link className="button" to={`/pools?dealer=${dealer.id}`}>
              Rescue
            </Link>
          </>
        )}
      </footer>
    </article>
  )
}
