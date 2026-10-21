import { http, HttpResponse } from 'msw'
import { server } from '../setup/msw'

/** Default API base used by the worker in tests (see wrangler.jsonc vars). */
export const API_BASE = 'https://api.cloudflare.com/client/v4'

/** Wrap a result in the standard Cloudflare API success envelope. */
export function cfSuccess(result: unknown) {
  return { success: true, errors: [], messages: [], result }
}

/** Wrap an account page with the pagination metadata guaranteed by /accounts. */
export function cfAccountsSuccess(result: Array<{ id: string; name: string }>) {
  return {
    ...cfSuccess(result),
    result_info: {
      page: 1,
      per_page: result.length,
      count: result.length,
      total_count: result.length
    }
  }
}

/** The standard Cloudflare API failure envelope. */
export function cfError(errors: Array<{ code: number; message: string }>, result: unknown = null) {
  return { success: false, errors, messages: [], result }
}

/**
 * Register MSW handlers for legacy/user credential identity probes
 * (`/user` + `/accounts`) through the real external-token resolver.
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
    http.get(`${API_BASE}/accounts`, () => HttpResponse.json(cfAccountsSuccess(accounts)))
  )
}

/** A `/memberships` entry holding `roles` on one account through an allow policy. */
export function membership(roles: string[], overrides: Record<string, unknown> = {}) {
  return {
    id: 'membership',
    status: 'accepted',
    account: { id: 'account', name: 'Account' },
    roles,
    policies: [
      { access: 'allow', permission_groups: roles.map((name) => ({ id: 'group', name })) }
    ],
    ...overrides
  }
}

/**
 * Serve `GET /memberships` from `pages` (one array of memberships per page),
 * or answer every page with `status`. Returns the number of requests made.
 */
export function mockMemberships(pages: unknown[][] | { status: number }): { requests: number } {
  const counter = { requests: 0 }
  server.use(
    http.get(`${API_BASE}/memberships`, ({ request }) => {
      counter.requests++
      if (!Array.isArray(pages)) {
        return HttpResponse.json(cfError([{ code: 9109, message: 'Unauthorized' }]), {
          status: pages.status
        })
      }
      const page = Number(new URL(request.url).searchParams.get('page') ?? '1')
      return HttpResponse.json({
        ...cfSuccess(pages[page - 1] ?? []),
        result_info: { page, per_page: 50, total_pages: pages.length }
      })
    })
  )
  return counter
}
