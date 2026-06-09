import { afterAll, afterEach, beforeAll } from 'vitest'
import { server } from './msw-server'

// Fail on any outbound request that isn't explicitly mocked, so an unexpected
// fetch surfaces loudly instead of hitting the network.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
