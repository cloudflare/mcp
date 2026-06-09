import { http, HttpResponse } from 'msw'
import { server } from '../setup/msw'

/** Default API base used by the worker in tests (see wrangler.jsonc vars). */
export const API_BASE = 'https://api.cloudflare.com/client/v4'

/** Wrap a result in the standard Cloudflare API success envelope. */
export function cfSuccess(result: unknown) {
  return { success: true, errors: [], messages: [], result }
}

/** The standard Cloudflare API failure envelope. */
export function cfError(errors: Array<{ code: number; message: string }>, result: unknown = null) {
  return { success: false, errors, messages: [], result }
}

/**
 * Register MSW handlers for the API-token identity probe (`/user` + `/accounts`)
 * so a direct token resolves through the REAL `getUserAndAccounts` code path.
 *
 * - `user: null` (default) -> account-scoped token (single account pinned)
 * - `user` provided        -> user token
 */
export function mockIdentityProbe(opts: {
  user?: { id: string; email: string } | null
  accounts: Array<{ id: string; name: string }>
}) {
  const { user = null, accounts } = opts
  server.use(
    http.get(`${API_BASE}/user`, () =>
      user ? HttpResponse.json(cfSuccess(user)) : HttpResponse.json(cfError([], null))
    ),
    http.get(`${API_BASE}/accounts`, () => HttpResponse.json(cfSuccess(accounts)))
  )
}
