import { setupServer } from 'msw/node'

/**
 * Shared MSW server for e2e tests. Handlers are registered per-test with
 * `server.use(...)`. Lifecycle (listen/reset/close) is wired in `msw-setup.ts`.
 */
export const server = setupServer()
