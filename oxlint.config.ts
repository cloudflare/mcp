import cloudflare from '@cloudflare/oxlint-config'
import { defineConfig } from 'oxlint'

export default defineConfig({
  ...cloudflare,
  categories: { ...cloudflare.categories, correctness: 'warn' },
  rules: {
    ...cloudflare.rules,
    // The Worker writes operational logs at these levels.
    'no-console': ['error', { allow: ['error', 'log', 'warn'] }]
  },
  overrides: [
    ...(cloudflare.overrides ?? []),
    {
      // MCP App views aren't built with React Compiler, and their charts animate
      // imperatively: each frame writes transforms through refs, outside render.
      // These rules check React Compiler compatibility, so they stay off here.
      files: ['src/*/app/**', 'src/mcp-apps/app-shell/**'],
      rules: {
        'react/immutability': 'off',
        'react/preserve-manual-memoization': 'off',
        'react/purity': 'off',
        'react/refs': 'off'
      }
    }
  ]
})
