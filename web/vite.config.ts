import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Public deployment: the site is static (Vercel); this preview server is the API gateway, the
// only thing published (outbound Cloudflare Tunnel). It proxies the relayer under /relayer and the
// session server under /session, both on loopback. Build the site with VITE_RELAYER_URL and
// VITE_SESSION_URL set to <gateway>/relayer and <gateway>/session.
const api = (prefix: string, port: number) => ({
  target: `http://127.0.0.1:${port}`,
  rewrite: (path: string) => path.slice(prefix.length) || '/',
})

// Same setup as near-examples/hello-privy: near-api-js and Privy expect Node globals (Buffer).
export default defineConfig({
  plugins: [nodePolyfills(), react()],
  resolve: { alias: { buffer: 'buffer' } },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    // The public hostname reaches this server through the HTTPS proxy.
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/relayer': api('/relayer', 8788),
      '/session': api('/session', 8791),
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
