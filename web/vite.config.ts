import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// The public deployment (`vite build --mode public`, then `pnpm preview`) is one origin: the built site, plus the relayer under
// /relayer and the session server under /session. Both stay on loopback; only this server is
// published. Build with VITE_RELAYER_URL=/relayer and VITE_SESSION_URL=/session.
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
    allowedHosts: ['.ts.net'],
    proxy: {
      '/relayer': api('/relayer', 8788),
      '/session': api('/session', 8791),
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
