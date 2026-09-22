import { http, passthrough } from 'msw'
import { beforeEach } from 'vitest'
import { server } from '../../tests/setup/msw'

/**
 * The shared MSW server (`tests/setup/msw.ts`) fails any outbound request that
 * isn't explicitly mocked — the right default for the regular suite, which
 * only ever talks to the Cloudflare API. Evals additionally make real calls to
 * model provider APIs, so let those specific hosts through to the real network
 * while every other host (in particular the Cloudflare API) stays strictly
 * mocked per test.
 *
 * Re-registered in `beforeEach` because the shared setup's `afterEach` resets
 * all handlers, including these, after every test.
 */
const MODEL_PROVIDER_HOSTS = [
  'https://api.openai.com/*',
  'https://api.anthropic.com/*',
  'https://generativelanguage.googleapis.com/*'
]

beforeEach(() => {
  server.use(...MODEL_PROVIDER_HOSTS.map((pattern) => http.all(pattern, () => passthrough())))
})
