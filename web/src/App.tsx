import { PrivyProvider } from '@privy-io/react-auth'
import { Component, type ReactNode } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router'
import type { Config } from './config'
import { NearPrivyProvider, ReadOnlyNearProvider } from './near/provider'
import { TopBar } from './components/TopBar'
import { Dealers } from './pages/Dealers'
import { FastForward } from './pages/FastForward'
import { Lobby } from './pages/Lobby'
import { Pools } from './pages/Pools'
import { Table } from './pages/Table'

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
          <Route path="/pools" element={<Pools />} />
          <Route path="/dealers" element={<Dealers />} />
          <Route path="/sim" element={<FastForward />} />
        </Routes>
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
