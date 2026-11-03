import { PrivyProvider } from '@privy-io/react-auth'
import { BrowserRouter, Route, Routes } from 'react-router'
import type { Config } from './config'
import { NearPrivyProvider } from './near/provider'
import { TopBar } from './components/TopBar'
import { Dealers } from './pages/Dealers'
import { FastForward } from './pages/FastForward'
import { Lobby } from './pages/Lobby'
import { Pools } from './pages/Pools'

export default function App({ config }: { config: Config }) {
  return (
    <PrivyProvider
      appId={config.privyAppId}
      config={{
        appearance: { theme: 'dark', accentColor: '#ec6fae', showWalletLoginFirst: false },
        loginMethods: ['email', 'google', 'twitter'],
      }}
    >
      <NearPrivyProvider config={config}>
        <BrowserRouter>
          <TopBar />
          <main className="page">
            <Routes>
              <Route path="/" element={<Lobby />} />
              <Route path="/pools" element={<Pools />} />
              <Route path="/dealers" element={<Dealers />} />
              <Route path="/sim" element={<FastForward />} />
            </Routes>
          </main>
        </BrowserRouter>
      </NearPrivyProvider>
    </PrivyProvider>
  )
}
