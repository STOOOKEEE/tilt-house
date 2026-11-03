import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Same setup as near-examples/hello-privy: near-api-js and Privy expect Node globals (Buffer).
export default defineConfig({
  plugins: [nodePolyfills(), react()],
  resolve: { alias: { buffer: 'buffer' } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
