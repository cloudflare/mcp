import { OAuthError as ProviderOAuthError } from '@cloudflare/workers-oauth-provider'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getCloudflareIdentity } from '../../src/auth/cloudflare-identity'
import { OAuthError } from '../../src/auth/workers-oauth-utils'
import { API_BASE, cfAccountsSuccess, cfSuccess } from '../helpers/cloudflare-api'
import { server } from '../setup/msw'

/** Register MSW handlers for the identity-probe endpoints by path. */
function mockProbes(opts: { user?: () => Response; accounts?: () => Response }) {
  if (opts.user) server.use(http.get(`${API_BASE}/user`, opts.user))
  if (opts.accounts) server.use(http.get(`${API_BASE}/accounts`, opts.accounts))
}

vi.mock('../../src/utils/fetch-retry', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/fetch-retry')>()
  return {
    ...original,
    fetchWithRetry: (input: RequestInfo, init?: RequestInit) =>
      original.fetchWithRetry(input, init, { maxRetries: 0 })
  }
})

async function expectOAuthError(
  promise: Promise<unknown>,
  code: string,
  statusCode: number
): Promise<OAuthError> {
  try {
    await promise
    throw new Error('Expected OAuthError to be thrown')
  } catch (error) {
    expect(error).toBeInstanceOf(OAuthError)
    expect(error).toBeInstanceOf(ProviderOAuthError)
    expect(error).toMatchObject({ code, statusCode })
    return error as OAuthError
  }
}

afterEach(() => vi.restoreAllMocks())

describe('getCloudflareIdentity', () => {
  it('requests enough accounts for the prompt-list cutoff to be detected', async () => {
    let accountsUrl = ''
    mockProbes({
      user: () => HttpResponse.json(cfSuccess({ id: 'user-1', email: 'user@example.com' }))
    })
    server.use(
      http.get(`${API_BASE}/accounts`, ({ request }) => {
        accountsUrl = request.url
        return HttpResponse.json(cfAccountsSuccess([]))
      })
    )

    await getCloudflareIdentity('test-token')

    expect(new URL(accountsUrl).searchParams.get('per_page')).toBe('31')
  })

  it('records the count but omits the records when a user has too many accounts', async () => {
    const accounts = Array.from({ length: 31 }, (_, index) => ({
      id: `account-${index + 1}`,
      name: `Account ${index + 1}`
    }))
    mockProbes({
      user: () => HttpResponse.json(cfSuccess({ id: 'user-1', email: 'user@example.com' })),
      accounts: () =>
        HttpResponse.json({
          ...cfSuccess(accounts),
          result_info: { page: 1, per_page: 31, count: 31, total_count: 137 }
        })
    })

    await expect(getCloudflareIdentity('test-token')).resolves.toEqual({
      user: { id: 'user-1', email: 'user@example.com' },
      accounts: [],
      accountCount: 137
    })
  })

  it('warns and falls back to page count when total_count is missing', async () => {
    const accounts = Array.from({ length: 31 }, (_, index) => ({
      id: `account-${index + 1}`,
      name: `Account ${index + 1}`
    }))
    mockProbes({
      user: () => HttpResponse.json(cfSuccess({ id: 'user-1', email: 'user@example.com' })),
      accounts: () =>
        HttpResponse.json({
          ...cfSuccess(accounts),
          result_info: { page: 1, per_page: 31, count: 31 }
        })
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(getCloudflareIdentity('test-token')).resolves.toEqual({
      user: { id: 'user-1', email: 'user@example.com' },
      accounts: [],
      accountCount: 31
    })
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('missing a valid result_info.total_count')
    )
  })

  it('keeps the full list when a user is under the cutoff', async () => {
    const accounts = Array.from({ length: 25 }, (_, index) => ({
      id: `account-${index + 1}`,
      name: `Account ${index + 1}`
    }))
    mockProbes({
      user: () => HttpResponse.json(cfSuccess({ id: 'user-1', email: 'user@example.com' })),
      accounts: () =>
        HttpResponse.json({
          ...cfSuccess(accounts),
          result_info: { page: 1, per_page: 31, count: 25, total_count: 25 }
        })
    })

    await expect(getCloudflareIdentity('test-token')).resolves.toEqual({
      user: { id: 'user-1', email: 'user@example.com' },
      accounts
    })
  })

  it('accepts account-scoped token when /user fails but /accounts succeeds', async () => {
    mockProbes({
      user: () => new HttpResponse('Forbidden', { status: 403 }),
      accounts: () =>
        HttpResponse.json(cfAccountsSuccess([{ id: 'acc-1', name: 'Primary Account' }]))
    })

    await expect(getCloudflareIdentity('test-token')).resolves.toEqual({
      user: null,
      accounts: [{ id: 'acc-1', name: 'Primary Account' }]
    })
  })

  it('accepts user tokens when /accounts fails but /user succeeds', async () => {
    mockProbes({
      user: () => HttpResponse.json(cfSuccess({ id: 'user-1', email: 'user@example.com' })),
      accounts: () => new HttpResponse('Forbidden', { status: 403 })
    })

    await expect(getCloudflareIdentity('test-token')).resolves.toEqual({
      user: { id: 'user-1', email: 'user@example.com' },
      accounts: []
    })
  })

  it('throws insufficient_scope when both endpoints fail with 403', async () => {
    mockProbes({
      user: () => new HttpResponse('Forbidden', { status: 403 }),
      accounts: () => new HttpResponse('Forbidden', { status: 403 })
    })

    await expectOAuthError(getCloudflareIdentity('test-token'), 'insufficient_scope', 403)
  })

  it.each([
    {
      userStatus: 401,
      accountsStatus: 401,
      code: 'invalid_token',
      statusCode: 401
    },
    {
      userStatus: 429,
      accountsStatus: 429,
      code: 'temporarily_unavailable',
      statusCode: 429
    },
    {
      userStatus: 500,
      accountsStatus: 500,
      code: 'server_error',
      statusCode: 502
    },
    {
      userStatus: 418,
      accountsStatus: 418,
      code: 'invalid_token',
      statusCode: 418
    },
    {
      userStatus: 403,
      accountsStatus: 500,
      code: 'server_error',
      statusCode: 502
    }
  ])(
    'maps dual endpoint failures to OAuthError for /user=$userStatus /accounts=$accountsStatus',
    async ({ userStatus, accountsStatus, code, statusCode }) => {
      mockProbes({
        user: () => new HttpResponse('upstream error', { status: userStatus }),
        accounts: () => new HttpResponse('upstream error', { status: accountsStatus })
      })

      await expectOAuthError(getCloudflareIdentity('test-token'), code, statusCode)
    }
  )

  it('preserves Retry-After from Cloudflare API 429 responses', async () => {
    mockProbes({
      user: () =>
        new HttpResponse('rate limited', { status: 429, headers: { 'Retry-After': '17' } }),
      accounts: () => new HttpResponse('rate limited', { status: 429 })
    })

    const error = await expectOAuthError(
      getCloudflareIdentity('test-token'),
      'temporarily_unavailable',
      429
    )
    expect(error.headers).toEqual({ 'Retry-After': '17' })
  })

  it('defaults Retry-After when Cloudflare API 429 responses omit it', async () => {
    mockProbes({
      user: () => new HttpResponse('rate limited', { status: 429 }),
      accounts: () => new HttpResponse('rate limited', { status: 429 })
    })

    const error = await expectOAuthError(
      getCloudflareIdentity('test-token'),
      'temporarily_unavailable',
      429
    )
    expect(error.headers).toEqual({ 'Retry-After': '30' })
  })

  it('falls back to account-scoped auth when /user is 200 but invalid JSON', async () => {
    mockProbes({
      user: () => new HttpResponse('not-json', { status: 200 }),
      accounts: () =>
        HttpResponse.json(cfAccountsSuccess([{ id: 'acc-1', name: 'Primary Account' }]))
    })

    await expect(getCloudflareIdentity('test-token')).resolves.toEqual({
      user: null,
      accounts: [{ id: 'acc-1', name: 'Primary Account' }]
    })
  })

  it('falls back to account-scoped auth when /user is 200 with success=false', async () => {
    mockProbes({
      user: () => HttpResponse.json({ success: false }),
      accounts: () =>
        HttpResponse.json(cfAccountsSuccess([{ id: 'acc-1', name: 'Primary Account' }]))
    })

    await expect(getCloudflareIdentity('test-token')).resolves.toEqual({
      user: null,
      accounts: [{ id: 'acc-1', name: 'Primary Account' }]
    })
  })

  it('keeps user auth when /accounts is 200 but invalid JSON', async () => {
    mockProbes({
      user: () => HttpResponse.json(cfSuccess({ id: 'user-1', email: 'user@example.com' })),
      accounts: () => new HttpResponse('not-json', { status: 200 })
    })

    await expect(getCloudflareIdentity('test-token')).resolves.toEqual({
      user: { id: 'user-1', email: 'user@example.com' },
      accounts: []
    })
  })

  it('rejects when /accounts returns empty result and /user fails', async () => {
    mockProbes({
      user: () => new HttpResponse('Forbidden', { status: 403 }),
      accounts: () => HttpResponse.json(cfAccountsSuccess([]))
    })

    await expectOAuthError(getCloudflareIdentity('test-token'), 'invalid_token', 401)
  })

  it('rejects when /accounts payload shape is invalid and /user fails', async () => {
    mockProbes({
      user: () => new HttpResponse('Forbidden', { status: 403 }),
      accounts: () => HttpResponse.json(cfSuccess([{ id: 'acc-1' }]))
    })

    await expectOAuthError(getCloudflareIdentity('test-token'), 'invalid_token', 401)
  })

  it('maps a network failure to server_error', async () => {
    // A transport-level failure (fetch rejecting) is BELOW MSW's HTTP
    // abstraction — HttpResponse.error() leaks an unhandled rejection through
    // @mswjs/interceptors. The fetch primitive is the correct seam for a
    // network error, so spy it here. (vi.spyOn restored in afterEach.)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network failed'))

    await expectOAuthError(getCloudflareIdentity('test-token'), 'server_error', 502)
  })
})
