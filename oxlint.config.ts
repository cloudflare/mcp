import cloudflare from '@cloudflare/oxlint-config'
import { defineConfig } from 'oxlint'

export default defineConfig({
  ...cloudflare,
  categories: { ...cloudflare.categories, correctness: 'warn' },
  rules: {
    ...cloudflare.rules,
    // Temporarily disabled during preset migration.
    '@nkzw/no-instanceof': 'off',
    'import/consistent-type-specifier-style': 'off',
    'no-console': 'off',
    'no-promise-executor-return': 'off',
    'quality/no-chained-type-assertions': 'off',
    'quality/no-conditional-empty-object-spread': 'off',
    'quality/no-known-value-widening': 'off',
    'quality/no-unknown-returns': 'off',
    'quality/no-unsafe-dictionary-type': 'off',
    'typescript/no-misused-promises': 'off',
    'typescript/no-non-null-assertion': 'off',
    'typescript/no-unnecessary-type-assertion': 'off',
    'typescript/no-unsafe-argument': 'off',
    'typescript/no-unsafe-member-access': 'off',
    'typescript/no-unsafe-return': 'off',
    'typescript/no-unsafe-type-assertion': 'off',
    'unicorn/consistent-function-scoping': 'off',
    'unicorn/prefer-at': 'off',
    'unicorn/prefer-number-properties': 'off',
    'unicorn/prefer-set-has': 'off',
    'unicorn/prefer-string-raw': 'off',
    'unicorn/prefer-structured-clone': 'off',
  },
})
