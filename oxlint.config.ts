import cloudflare from '@cloudflare/oxlint-config'
import { defineConfig } from 'oxlint'

export default defineConfig({
  ...cloudflare,
  categories: { ...cloudflare.categories, correctness: 'warn' },
  rules: {
    ...cloudflare.rules,
    // The Worker writes operational logs at these levels.
    'no-console': ['error', { allow: ['error', 'log', 'warn'] }],
    // Temporarily disabled during preset migration.
    '@nkzw/no-instanceof': 'off',
    'quality/no-unknown-returns': 'off',
    'quality/no-unsafe-dictionary-type': 'off',
    'typescript/no-unsafe-type-assertion': 'off',
  },
  overrides: [
    ...(cloudflare.overrides ?? []),
    // These modules intentionally expose stable contracts for dynamic schemas and routing tables.
    {
      files: ['src/api-refusals.ts', 'src/auth/cloudflare-identity.ts', 'src/auth/scopes.ts', 'src/auth/workers-oauth-utils.ts', 'src/events/ans-bridge.ts', 'src/forge-tools/cloudflare.ts', 'src/response-schema-check.ts', 'src/skills/bundle.ts', 'src/spec-processor.ts', 'src/tools/response-body.ts', 'src/tools/submit-feedback.ts'],
      rules: { 'quality/no-known-value-widening': 'off' },
    },
  ],
})
