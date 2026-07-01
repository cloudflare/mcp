import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll } from 'vitest'

/**
 * Global MSW server. Outbound `fetch()` is the only thing tests mock — every
 * other layer (auth, KV, MCP transport, Worker Loader, GlobalOutbound) runs for
 * real in the workerd pool. Register per-test handlers with `server.use(...)`.
 *
 * This file is wired in as a `setupFiles` entry, so the lifecycle hooks below
 * apply to every test file. Tests import `{ server }` from here to add handlers.
 */
export const server = setupServer()

// Fail on any outbound request that isn't explicitly mocked, so an unexpected
// fetch surfaces loudly instead of hitting the network.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
