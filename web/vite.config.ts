import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Public deployment: the site is static (Vercel); this preview server is the API gateway, the
// only thing published (Tailscale Funnel). It proxies the testnet relayer under /relayer and
// session server under /session, and their mainnet twins under /mainnet/relayer and
// /mainnet/session, all on loopback (ports: docs/mainnet.md). Build the site with
// VITE_RELAYER_URL and VITE_SESSION_URL set to <gateway>/relayer and <gateway>/session.
const api = (prefix: string, port: number) => ({
  target: `http://127.0.0.1:${port}`,
  rewrite: (path: string) => path.slice(prefix.length) || '/',
})

// On the tailnet the gateway's name resolves to a private 100.x address, so Chrome asks a public
// page's request for Private Network Access consent first; the APIs are public, so grant it.
const allowPrivateNetwork: Plugin = {
  name: 'allow-private-network',
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.headers['access-control-request-private-network']) {
        res.setHeader('Access-Control-Allow-Private-Network', 'true')
      }
      next()
    })
  },
}

// Same setup as near-examples/hello-privy: near-api-js and Privy expect Node globals (Buffer).
export default defineConfig({
  plugins: [nodePolyfills(), react(), allowPrivateNetwork],
  resolve: { alias: { buffer: 'buffer' } },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    // CORS is the APIs' own business (they allow any origin): let preflights reach them.
    cors: false,
    // The public hostname reaches this server through the HTTPS proxy.
    allowedHosts: ['debian-docker.tail8b5861.ts.net'],
    proxy: {
      '/mainnet/relayer': api('/mainnet/relayer', 8798),
      '/mainnet/session': api('/mainnet/session', 8792),
      '/relayer': api('/relayer', 8788),
      '/session': api('/session', 8791),
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
