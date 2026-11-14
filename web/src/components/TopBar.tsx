import { Link, NavLink } from 'react-router'
import { TOKEN_SYMBOLS, saveCurrencyChoice, saveNetworkChoice, type Currency, type NetworkId } from '../config'
import { formatAmount, shortAccount, tokenSymbol } from '../format'
import { useNear, type GameKeyStatus } from '../near/useNear'
import { usePlayer } from '../near/usePoll'

// The player is the house: its table comes first, playing at others' tables after.
const NAV = [
  { to: '/my-table', label: 'My table' },
  { to: '/', label: 'Lobby' },
  { to: '/season', label: 'Season 1' },
  { to: '/pools', label: 'Pools' },
  { to: '/poker', label: 'Poker' },
  { to: '/tilt', label: '$TILT' },
] as const

function keyLabel(status: GameKeyStatus): string {
  switch (status.state) {
    case 'pending':
      return 'setting up game key…'
    case 'ready':
      return 'game key ready'
    case 'error':
      return `game key error: ${status.message}`
    case 'none':
      return ''
  }
}

const NETWORKS: readonly { id: NetworkId; label: string; title: string }[] = [
  { id: 'testnet', label: 'Testnet', title: 'NEAR testnet' },
  { id: 'mainnet', label: 'Mainnet', title: 'NEAR mainnet, play money (no value)' },
]

const CURRENCIES: readonly { id: Currency; label: string; title: string }[] = [
  { id: 'usd', label: 'USD', title: `tables play in ${TOKEN_SYMBOLS.usd} (test USDC)` },
  { id: 'tilt', label: 'TILT', title: `tables play in ${TOKEN_SYMBOLS.tilt}, the house memecoin` },
]

/**
 * A two-way toggle. Every provider, poll and game key derives from the config, so a switch
 * stores the choice and reloads the page.
 */
function Switch<T extends string>({
  label,
  options,
  active,
  save,
}: {
  label: string
  options: readonly { id: T; label: string; title: string }[]
  active: T
  save: (choice: T) => void
}) {
  const pick = (choice: T) => {
    if (choice === active) return
    save(choice)
    window.location.reload()
  }
  return (
    <div className="network-switch" role="group" aria-label={label}>
      {options.map(({ id, label, title }) => (
        <button
          key={id}
          type="button"
          className={active === id ? 'active' : 'ghost'}
          aria-pressed={active === id}
          title={title}
          onClick={() => pick(id)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export function TopBar() {
  const { auth, config, walletId, gameKey } = useNear()
  const authenticated = auth.available && auth.authenticated
  const player = usePlayer()

  return (
    <header className="topbar">
      <span className="brand">TILT HOUSE</span>
      <nav>
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <Link className="button ghost tour-link" to="/?tour=1">
        How the house works
      </Link>
      {/* Hidden, not "soon", until the other side is configured. */}
      {config.tiltReady ? (
        <Switch label="Currency" options={CURRENCIES} active={config.currency} save={(c) => saveCurrencyChoice(localStorage, c)} />
      ) : null}
      {config.mainnetReady ? (
        <Switch label="Network" options={NETWORKS} active={config.network} save={(n) => saveNetworkChoice(localStorage, n)} />
      ) : null}
      <div className="account">
        {authenticated && walletId ? (
          <>
            <span title={walletId}>{shortAccount(walletId)}</span>
            <span className="money" title="your balance in the house (deposit and withdraw in Pools)">
              {player.data ? formatAmount(player.data.balance) : `— ${tokenSymbol()}`}
            </span>
            <span className={gameKey.state === 'error' ? 'loss' : 'key'}>{keyLabel(gameKey)}</span>
          </>
        ) : null}
        {auth.available ? (
          <button type="button" disabled={!auth.ready} onClick={authenticated ? auth.logout : auth.login}>
            {authenticated ? 'Logout' : 'Login'}
          </button>
        ) : (
          <button type="button" disabled>
            login unavailable: {auth.reason}
          </button>
        )}
      </div>
    </header>
  )
}
