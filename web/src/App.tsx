import { PrivyProvider } from '@privy-io/react-auth'
import { Component, type ReactNode } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router'
import type { Config } from './config'
import { NearPrivyProvider, ReadOnlyNearProvider } from './near/provider'
import { TopBar } from './components/TopBar'
import { Dealers } from './pages/Dealers'
import { FastForward } from './pages/FastForward'
import { Lobby } from './pages/Lobby'
import { MyTable } from './pages/MyTable'
import { OpenTable } from './pages/OpenTable'
import { Poker } from './pages/Poker'
import { Pools } from './pages/Pools'
import { SeatMarket } from './pages/SeatMarket'
import { Table } from './pages/Table'
import { Tilt } from './pages/Tilt'

const NO_PRIVY_APP = 'no Privy app configured'
const PRIVY_FAILED = 'Privy failed to start'

export default function App({ config }: { config: Config }) {
  const shell = (
    <BrowserRouter>
      <TopBar />
      <main className="page">
        <Routes>
          <Route path="/" element={<Lobby />} />
          <Route path="/table/:dealer" element={<Table />} />
          <Route path="/open" element={<OpenTable />} />
          <Route path="/my-table" element={<MyTable />} />
          <Route path="/seats" element={<SeatMarket />} />
          <Route path="/pools" element={<Pools />} />
          <Route path="/dealers" element={<Dealers />} />
          <Route path="/sim" element={<FastForward />} />
          <Route path="/tilt" element={<Tilt />} />
          {/* Not in the nav until the go decision: reachable by URL only. */}
          <Route path="/poker" element={<Poker />} />
          <Route path="/poker/:table" element={<Poker />} />
        </Routes>
        <footer className="page-footer">
          <Link to="/seats">Seats</Link> · <Link to="/dealers">Dealers</Link> · <Link to="/sim">Fast-forward</Link>
        </footer>
      </main>
    </BrowserRouter>
  )
  const readOnly = (reason: string) => (
    <ReadOnlyNearProvider config={config} reason={reason}>
      {shell}
    </ReadOnlyNearProvider>
  )
  if (!config.privyAppId) return readOnly(NO_PRIVY_APP)
  return (
    <PrivyBoundary fallback={readOnly(PRIVY_FAILED)}>
      <PrivyProvider
        appId={config.privyAppId}
        config={{
          appearance: { theme: 'dark', accentColor: '#ec6fae', showWalletLoginFirst: false },
          loginMethods: ['email', 'google', 'twitter'],
        }}
      >
        <NearPrivyProvider config={config}>{shell}</NearPrivyProvider>
      </PrivyProvider>
    </PrivyBoundary>
  )
}

/** Privy throws on a bad app id (or a dashboard misconfig): keep the game watchable instead of a blank page. */
class PrivyBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error('Login disabled, running read-only:', error)
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
