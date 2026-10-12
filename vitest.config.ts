import { cloudflareTest } from '@cloudflare/vitest-plugin'
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
          CLOUDFLARE_CLIENT_SECRET: 'test-client-secret',
          MCP_RESOURCE: 'https://mcp.cloudflare.com/mcp'
        }
      }
    })
  ],
  test: {
    globals: true,
    // The first request to the worker in each test file loads the whole worker
    // into a fresh isolate: about 1s alone, but 4-5s when every file runs in
    // parallel, which is too close to Vitest's 5s default.
    testTimeout: 15_000,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup/msw.ts']
  }
})
