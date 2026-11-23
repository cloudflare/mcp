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
    'quality/no-chained-type-assertions': 'off',
    'quality/no-conditional-empty-object-spread': 'off',
    'quality/no-known-value-widening': 'off',
    'quality/no-unknown-returns': 'off',
    'quality/no-unsafe-dictionary-type': 'off',
    'typescript/no-unsafe-argument': 'off',
    'typescript/no-unsafe-member-access': 'off',
    'typescript/no-unsafe-return': 'off',
    'typescript/no-unsafe-type-assertion': 'off',
    'unicorn/consistent-function-scoping': 'off',
  },
})
