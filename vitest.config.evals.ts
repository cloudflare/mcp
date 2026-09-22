import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Load provider API keys from a local .env for `npm run eval` outside CI; in
// CI these come from real repo secrets already present in process.env, and
// there is no .env file to load.
try {
  process.loadEnvFile('.env')
} catch {
  // no local .env — fine, evals for unconfigured providers just skip
}

/**
 * Separate config for the LLM eval suite (`npm run eval`): same worker runtime
 * as vitest.config.ts, but a distinct `include` glob and a much longer test
 * timeout since each case makes a real model call. Kept out of `vitest.config.ts`
 * / `npm run test` so the regular suite stays fast and never needs API keys.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          MCP_COOKIE_ENCRYPTION_KEY: 'test-cookie-encryption-key-0000000000000000',
          CLOUDFLARE_CLIENT_ID: 'test-client-id',
          CLOUDFLARE_CLIENT_SECRET: 'test-client-secret',
          MCP_RESOURCE: 'https://mcp.cloudflare.com/mcp',
          // Forwarded from the host process into the workerd runtime, which
          // does not inherit process.env on its own (see evals/models.ts).
          OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
          GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? ''
        }
      }
    })
  ],
  test: {
    globals: true,
    include: ['evals/**/*.eval.ts'],
    setupFiles: ['./tests/setup/msw.ts', './evals/setup/msw-passthrough.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000
  }
})
