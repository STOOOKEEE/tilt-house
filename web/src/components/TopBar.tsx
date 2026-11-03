import { useLogin, useLogout, usePrivy } from '@privy-io/react-auth'
import { NavLink } from 'react-router'
import { formatUsdc } from '../format'
import { useNear, type GameKeyStatus } from '../near/useNear'
import { usePlayer } from '../near/usePoll'

const NAV = [
  { to: '/', label: 'Lobby' },
  { to: '/pools', label: 'Pools' },
  { to: '/dealers', label: 'Dealers' },
  { to: '/sim', label: 'Fast-forward' },
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

export function TopBar() {
  const { ready, authenticated } = usePrivy()
  const { login } = useLogin()
  const { logout } = useLogout()
  const { walletId, gameKey } = useNear()
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
        <button type="button" disabled={!ready} onClick={() => (authenticated ? void logout() : login())}>
          {authenticated ? 'Logout' : 'Login'}
        </button>
      </div>
    </header>
  )
}
