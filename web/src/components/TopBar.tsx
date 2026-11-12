import { Link, NavLink } from 'react-router'
import { saveNetworkChoice, type NetworkId } from '../config'
import { formatUsdc } from '../format'
import { useNear, type GameKeyStatus } from '../near/useNear'
import { usePlayer } from '../near/usePoll'

const NAV = [
  { to: '/', label: 'Lobby' },
  { to: '/my-table', label: 'My table' },
  { to: '/pools', label: 'Pools' },
] as const

function shortAccount(accountId: string): string {
  return accountId.length > 20 ? `${accountId.slice(0, 6)}…${accountId.slice(-6)}` : accountId
}

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

const NETWORKS: readonly { id: NetworkId; label: string }[] = [
  { id: 'testnet', label: 'Testnet' },
  { id: 'mainnet', label: 'Mainnet' },
]

/**
 * Testnet / mainnet toggle. Every provider, poll and game key derives from the config, so a
 * switch stores the choice and reloads the page. Mainnet stays disabled until it is configured.
 */
function NetworkSwitch() {
  const { config } = useNear()
  const pick = (network: NetworkId) => {
    if (network === config.network) return
    saveNetworkChoice(localStorage, network)
    window.location.reload()
  }
  return (
    <div className="network-switch" role="group" aria-label="Network">
      {NETWORKS.map(({ id, label }) => {
        const soon = id === 'mainnet' && !config.mainnetReady
        return (
          <button
            key={id}
            type="button"
            className={config.network === id ? 'active' : 'ghost'}
            aria-pressed={config.network === id}
            disabled={soon}
            title={soon ? 'Mainnet: coming soon' : id === 'mainnet' ? 'NEAR mainnet, play money (no value)' : 'NEAR testnet'}
            onClick={() => pick(id)}
          >
            {soon ? `${label} · soon` : label}
          </button>
        )
      })}
    </div>
  )
}

export function TopBar() {
  const { auth, walletId, gameKey } = useNear()
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
      <NetworkSwitch />
      <div className="account">
        {authenticated && walletId ? (
          <>
            <span title={walletId}>{shortAccount(walletId)}</span>
            <span className="money" title="your balance in the house (deposit and withdraw in Pools)">
              {player.data ? `${formatUsdc(player.data.balance)} tUSDC` : '— tUSDC'}
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
