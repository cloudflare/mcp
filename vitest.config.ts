import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Deterministic test secrets so tests never depend on a local .env
        // (which CI doesn't have). These are dummy values, not real secrets.
        bindings: {
          MCP_COOKIE_ENCRYPTION_KEY: 'test-cookie-encryption-key-0000000000000000',
          CLOUDFLARE_CLIENT_ID: 'test-client-id',
          CLOUDFLARE_CLIENT_SECRET: 'test-client-secret'
        }
      }
    })
  ],
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup/msw.ts']
  }
})
