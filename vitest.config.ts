import { execFileSync } from 'node:child_process'
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// The forge tools service (wrangler.forge-tools.jsonc) runs next to the main
// Worker as an auxiliary Worker, which has to be JavaScript, so build it first.
const FORGE_TOOLS_OUT = '.wrangler/forge-tools-test'
execFileSync(
  './node_modules/.bin/wrangler',
  ['deploy', '-c', 'wrangler.forge-tools.jsonc', '--dry-run', '--outdir', FORGE_TOOLS_OUT],
  { stdio: 'ignore' }
)

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
        },
        workers: [
          {
            name: 'cloudflare-api-mcp-forge-tools-dev',
            modules: true,
            scriptPath: `${FORGE_TOOLS_OUT}/worker.js`,
            compatibilityDate: '2026-06-17'
          }
        ]
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
