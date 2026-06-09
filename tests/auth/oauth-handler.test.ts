import {
  OAuthError as ProviderOAuthError,
  type OAuthHelpers
} from '@cloudflare/workers-oauth-provider'
import { env } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getUserAndAccounts,
  guardRefreshTokenExchange,
  handleTokenExchangeCallback
} from '../../src/auth/oauth-handler'
import { OAuthError } from '../../src/auth/workers-oauth-utils'
import { API_BASE, cfSuccess } from '../helpers/cloudflare-api'
import { server } from '../setup/msw'

/** Register MSW handlers for the two identity-probe endpoints by path. */
function mockProbes(opts: {
  user?: () => Response
  accounts?: () => Response
}) {
  if (opts.user) server.use(http.get(`${API_BASE}/user`, opts.user))
  if (opts.accounts) server.use(http.get(`${API_BASE}/accounts`, opts.accounts))
}

// Use minimal retry config so tests don't wait for real backoff delays. This is
// the only mock of our own modules left here: it just tightens retry timing for
// the identity-probe tests; the actual fetch boundary is mocked with MSW.
vi.mock('../../src/utils/fetch-retry', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/fetch-retry')>()
  return {
    ...original,
    fetchWithRetry: (input: RequestInfo, init?: RequestInit) =>
      original.fetchWithRetry(input, init, { maxRetries: 0 })
  }
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface MockGrant {
  id: string
  clientId: string
  userId: string
}

/**
 * Minimal OAuthHelpers mock backing the revoke-on-invalid_grant path. Only
 * listUserGrants/revokeGrant are exercised; cast to the full type since the
 * guard never touches the other members.
 */
function mockOAuthHelpers(grants: MockGrant[]) {
  return {
    listUserGrants: vi.fn(async () => ({ items: grants as never[], cursor: undefined })),
    revokeGrant: vi.fn(async () => undefined)
  } as unknown as OAuthHelpers & {
    listUserGrants: ReturnType<typeof vi.fn>
    revokeGrant: ReturnType<typeof vi.fn>
  }
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function refreshGuardKey(
  refreshToken: string,
  suffix: 'in-flight' | 'failure'
): Promise<string> {
  return `oauth:refresh-guard:${await sha256Hex(refreshToken)}:${suffix}`
}

async function expectOAuthError(
  promise: Promise<unknown>,
  code: string,
  statusCode: number
): Promise<OAuthError> {
  try {
    await promise
    throw new Error('Expected OAuthError to be thrown')
  } catch (e) {
    expect(e).toBeInstanceOf(OAuthError)
    expect(e).toBeInstanceOf(ProviderOAuthError)
    expect(e).toMatchObject({ code, statusCode })
    return e as OAuthError
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  // Storage isolation in vitest-pool-workers is per test FILE, not per test, so
  // the real OAUTH_KV persists across tests here. Some refresh-guard tests reuse
  // the same refresh token and would otherwise hit a cached failure written by
  // an earlier test. Clear it between tests to restore per-test isolation.
  const kv = env.OAUTH_KV as KVNamespace
  const { keys } = await kv.list()
  await Promise.all(keys.map((k) => kv.delete(k.name)))
})

describe('getUserAndAccounts', () => {
  it('accepts account-scoped token when /user fails but /accounts succeeds', async () => {
    mockProbes({
      user: () => new HttpResponse('Forbidden', { status: 403 }),
      accounts: () => HttpResponse.json(cfSuccess([{ id: 'acc-1', name: 'Primary Account' }]))
    })

    await expect(getUserAndAccounts('test-token')).resolves.toEqual({
      user: null,
      accounts: [{ id: 'acc-1', name: 'Primary Account' }]
    })
  })

  it('accepts user tokens when /accounts fails but /user succeeds', async () => {
    mockProbes({
      user: () => HttpResponse.json(cfSuccess({ id: 'user-1', email: 'user@example.com' })),
      accounts: () => new HttpResponse('Forbidden', { status: 403 })
    })

    await expect(getUserAndAccounts('test-token')).resolves.toEqual({
      user: { id: 'user-1', email: 'user@example.com' },
      accounts: []
    })
  })

  it('throws insufficient_scope when both endpoints fail with 403', async () => {
    mockProbes({
      user: () => new HttpResponse('Forbidden', { status: 403 }),
      accounts: () => new HttpResponse('Forbidden', { status: 403 })
    })

    await expectOAuthError(getUserAndAccounts('test-token'), 'insufficient_scope', 403)
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

      await expectOAuthError(getUserAndAccounts('test-token'), code, statusCode)
    }
  )

  it('preserves Retry-After from Cloudflare API 429 responses', async () => {
    mockProbes({
      user: () => new HttpResponse('rate limited', { status: 429, headers: { 'Retry-After': '17' } }),
      accounts: () => new HttpResponse('rate limited', { status: 429 })
    })

    const error = await expectOAuthError(
      getUserAndAccounts('test-token'),
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
      getUserAndAccounts('test-token'),
      'temporarily_unavailable',
      429
    )
    expect(error.headers).toEqual({ 'Retry-After': '30' })
  })

  it('falls back to account-scoped auth when /user is 200 but invalid JSON', async () => {
    mockProbes({
      user: () => new HttpResponse('not-json', { status: 200 }),
      accounts: () => HttpResponse.json(cfSuccess([{ id: 'acc-1', name: 'Primary Account' }]))
    })

    await expect(getUserAndAccounts('test-token')).resolves.toEqual({
      user: null,
      accounts: [{ id: 'acc-1', name: 'Primary Account' }]
    })
  })

  it('falls back to account-scoped auth when /user is 200 with success=false', async () => {
    mockProbes({
      user: () => HttpResponse.json({ success: false }),
      accounts: () => HttpResponse.json(cfSuccess([{ id: 'acc-1', name: 'Primary Account' }]))
    })

    await expect(getUserAndAccounts('test-token')).resolves.toEqual({
      user: null,
      accounts: [{ id: 'acc-1', name: 'Primary Account' }]
    })
  })

  it('keeps user auth when /accounts is 200 but invalid JSON', async () => {
    mockProbes({
      user: () => HttpResponse.json(cfSuccess({ id: 'user-1', email: 'user@example.com' })),
      accounts: () => new HttpResponse('not-json', { status: 200 })
    })

    await expect(getUserAndAccounts('test-token')).resolves.toEqual({
      user: { id: 'user-1', email: 'user@example.com' },
      accounts: []
    })
  })

  it('rejects when /accounts returns empty result and /user fails', async () => {
    mockProbes({
      user: () => new HttpResponse('Forbidden', { status: 403 }),
      accounts: () => HttpResponse.json(cfSuccess([]))
    })

    await expectOAuthError(getUserAndAccounts('test-token'), 'invalid_token', 401)
  })

  it('rejects when /accounts payload shape is invalid and /user fails', async () => {
    mockProbes({
      user: () => new HttpResponse('Forbidden', { status: 403 }),
      accounts: () => HttpResponse.json(cfSuccess([{ id: 'acc-1' }]))
    })

    await expectOAuthError(getUserAndAccounts('test-token'), 'invalid_token', 401)
  })

  it('maps a network failure to server_error', async () => {
    // A transport-level failure (fetch rejecting) is BELOW MSW's HTTP
    // abstraction — HttpResponse.error() leaks an unhandled rejection through
    // @mswjs/interceptors. The fetch primitive is the correct seam for a
    // network error, so spy it here. (vi.spyOn restored in afterEach.)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network failed'))

    await expectOAuthError(getUserAndAccounts('test-token'), 'server_error', 502)
  })
})

describe('guardRefreshTokenExchange', () => {
  it('singleflights concurrent refreshes for the same upstream token in one isolate', async () => {
    const kv = env.OAUTH_KV
    const putSpy = vi.spyOn(kv, 'put')
    const deleteSpy = vi.spyOn(kv, 'delete')
    const refresh = deferred<{ accessTokenTTL: number }>()
    const refreshFn = vi.fn(() => refresh.promise)

    const first = guardRefreshTokenExchange(kv, 'upstream-refresh-token', refreshFn)
    const second = guardRefreshTokenExchange(kv, 'upstream-refresh-token', refreshFn)

    await vi.waitFor(() => expect(refreshFn).toHaveBeenCalledTimes(1))

    refresh.resolve({ accessTokenTTL: 3600 })

    await expect(first).resolves.toEqual({ accessTokenTTL: 3600 })
    await expect(second).resolves.toEqual({ accessTokenTTL: 3600 })
    expect(putSpy).toHaveBeenCalledTimes(1)
    expect(deleteSpy).toHaveBeenCalledTimes(1)
    // The in-flight marker was really written then cleared in real KV.
    expect(await kv.get(await refreshGuardKey('upstream-refresh-token', 'in-flight'))).toBeNull()
  })

  it('caches terminal refresh failures so retries do not call upstream again', async () => {
    const kv = env.OAUTH_KV
    const refreshFn = vi
      .fn()
      .mockRejectedValueOnce(new OAuthError('invalid_grant', 'refresh token reused', 400))

    await expectOAuthError(
      guardRefreshTokenExchange(kv, 'reused-refresh-token', refreshFn),
      'invalid_grant',
      400
    )
    await expectOAuthError(
      guardRefreshTokenExchange(kv, 'reused-refresh-token', refreshFn),
      'invalid_grant',
      400
    )

    // Upstream was hit once; the second call short-circuited on the cached
    // failure that the first call wrote to real KV.
    expect(refreshFn).toHaveBeenCalledTimes(1)
    expect(await kv.get(await refreshGuardKey('reused-refresh-token', 'failure'))).not.toBeNull()
  })

  it('replays a cached failure with its original status code (not a flat 400)', async () => {
    const kv = env.OAUTH_KV
    // invalid_client is a 401; the cached replay must preserve that, not 400.
    const refreshFn = vi
      .fn()
      .mockRejectedValueOnce(new OAuthError('invalid_client', 'bad client creds', 401))

    await expectOAuthError(
      guardRefreshTokenExchange(kv, 'client-fail-token', refreshFn),
      'invalid_client',
      401
    )
    // Second call replays from cache and must still be a 401.
    await expectOAuthError(
      guardRefreshTokenExchange(kv, 'client-fail-token', refreshFn),
      'invalid_client',
      401
    )
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('preserves Retry-After headers across a cached failure replay', async () => {
    const kv = env.OAUTH_KV
    // A terminal failure carrying a Retry-After header must replay with it.
    const refreshFn = vi
      .fn()
      .mockRejectedValueOnce(
        new OAuthError('unauthorized_client', 'slow down', 403, { 'Retry-After': '120' })
      )

    const first = await expectOAuthError(
      guardRefreshTokenExchange(kv, 'retry-after-token', refreshFn),
      'unauthorized_client',
      403
    )
    expect(first.headers).toEqual({ 'Retry-After': '120' })

    const replay = await expectOAuthError(
      guardRefreshTokenExchange(kv, 'retry-after-token', refreshFn),
      'unauthorized_client',
      403
    )
    expect(replay.headers).toEqual({ 'Retry-After': '120' })
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('suppresses upstream refresh when another isolate has an in-flight marker', async () => {
    const refreshToken = 'cross-isolate-refresh-token'
    const kv = env.OAUTH_KV
    // Seed a real in-flight marker, as another isolate mid-refresh would.
    await kv.put(
      await refreshGuardKey(refreshToken, 'in-flight'),
      JSON.stringify({ startedAt: Date.now() })
    )
    const refreshFn = vi.fn()

    await expectOAuthError(
      guardRefreshTokenExchange(kv, refreshToken, refreshFn),
      'temporarily_unavailable',
      429
    )

    expect(refreshFn).not.toHaveBeenCalled()
  })

  it('does not fail a successful refresh when clearing the in-flight marker fails', async () => {
    const kv = env.OAUTH_KV
    const refreshFn = vi.fn().mockResolvedValue({ accessTokenTTL: 3600 })
    // Inject a one-shot failure on the real binding; later calls pass through.
    vi.spyOn(kv, 'delete').mockRejectedValueOnce(new Error('KV delete failed'))

    await expect(
      guardRefreshTokenExchange(kv, 'cleanup-failure-token', refreshFn)
    ).resolves.toEqual({
      accessTokenTTL: 3600
    })
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('preserves the original terminal error when caching the failure fails', async () => {
    const kv = env.OAUTH_KV
    const refreshFn = vi
      .fn()
      .mockRejectedValueOnce(new OAuthError('invalid_grant', 'refresh token reused', 400))
    // First put (in-flight marker) succeeds, second put (cache failure) throws.
    vi.spyOn(kv, 'put')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('KV put failed'))

    await expectOAuthError(
      guardRefreshTokenExchange(kv, 'failure-cache-error-token', refreshFn),
      'invalid_grant',
      400
    )
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('revokes the grant for this user+client on upstream invalid_grant', async () => {
    const kv = env.OAUTH_KV
    const refreshFn = vi
      .fn()
      .mockRejectedValueOnce(new OAuthError('invalid_grant', 'refresh token reused', 400))
    const helpers = mockOAuthHelpers([
      { id: 'grant-keep', clientId: 'other-client', userId: 'user-1' },
      { id: 'grant-kill', clientId: 'mcp-client', userId: 'user-1' }
    ])
    const getHelpers = vi.fn(() => helpers)

    await expectOAuthError(
      guardRefreshTokenExchange(kv, 'dead-token', refreshFn, {
        userId: 'user-1',
        clientId: 'mcp-client',
        getHelpers
      }),
      'invalid_grant',
      400
    )

    // Only the matching user+client grant is killed; other clients untouched.
    expect(helpers.listUserGrants).toHaveBeenCalledWith('user-1', undefined)
    expect(helpers.revokeGrant).toHaveBeenCalledTimes(1)
    expect(helpers.revokeGrant).toHaveBeenCalledWith('grant-kill', 'user-1')
  })

  it('does NOT revoke the grant on transient (429/500) refresh errors', async () => {
    const kv = env.OAUTH_KV
    const refreshFn = vi
      .fn()
      .mockRejectedValueOnce(
        new OAuthError('temporarily_unavailable', 'rate limited', 429, { 'Retry-After': '30' })
      )
    const helpers = mockOAuthHelpers([{ id: 'grant-1', clientId: 'mcp-client', userId: 'user-1' }])
    const getHelpers = vi.fn(() => helpers)

    await expectOAuthError(
      guardRefreshTokenExchange(kv, 'transient-token', refreshFn, {
        userId: 'user-1',
        clientId: 'mcp-client',
        getHelpers
      }),
      'temporarily_unavailable',
      429
    )

    expect(getHelpers).not.toHaveBeenCalled()
    expect(helpers.revokeGrant).not.toHaveBeenCalled()
  })

  it('does NOT revoke the grant on server-side invalid_client', async () => {
    const kv = env.OAUTH_KV
    const refreshFn = vi
      .fn()
      .mockRejectedValueOnce(new OAuthError('invalid_client', 'bad client creds', 401))
    const helpers = mockOAuthHelpers([{ id: 'grant-1', clientId: 'mcp-client', userId: 'user-1' }])
    const getHelpers = vi.fn(() => helpers)

    await expectOAuthError(
      guardRefreshTokenExchange(kv, 'bad-client-token', refreshFn, {
        userId: 'user-1',
        clientId: 'mcp-client',
        getHelpers
      }),
      'invalid_client',
      401
    )

    // invalid_client still caches the failure, but the user's grant survives.
    expect(helpers.revokeGrant).not.toHaveBeenCalled()
  })

  it('still throws invalid_grant even if revoking the grant fails', async () => {
    const kv = env.OAUTH_KV
    const refreshFn = vi
      .fn()
      .mockRejectedValueOnce(new OAuthError('invalid_grant', 'refresh token reused', 400))
    const helpers = mockOAuthHelpers([
      { id: 'grant-kill', clientId: 'mcp-client', userId: 'user-1' }
    ])
    vi.mocked(helpers.revokeGrant).mockRejectedValueOnce(new Error('KV unavailable'))

    await expectOAuthError(
      guardRefreshTokenExchange(kv, 'dead-token-revoke-fails', refreshFn, {
        userId: 'user-1',
        clientId: 'mcp-client',
        getHelpers: () => helpers
      }),
      'invalid_grant',
      400
    )
  })

  it('paginates listUserGrants when revoking', async () => {
    const kv = env.OAUTH_KV
    const refreshFn = vi
      .fn()
      .mockRejectedValueOnce(new OAuthError('invalid_grant', 'refresh token reused', 400))
    const helpers = mockOAuthHelpers([])
    vi.mocked(helpers.listUserGrants)
      .mockResolvedValueOnce({
        items: [{ id: 'grant-a', clientId: 'mcp-client', userId: 'user-1' } as never],
        cursor: 'next'
      } as never)
      .mockResolvedValueOnce({
        items: [{ id: 'grant-b', clientId: 'mcp-client', userId: 'user-1' } as never],
        cursor: undefined
      } as never)

    await expectOAuthError(
      guardRefreshTokenExchange(kv, 'paginated-token', refreshFn, {
        userId: 'user-1',
        clientId: 'mcp-client',
        getHelpers: () => helpers
      }),
      'invalid_grant',
      400
    )

    expect(helpers.listUserGrants).toHaveBeenCalledTimes(2)
    expect(helpers.revokeGrant).toHaveBeenCalledWith('grant-a', 'user-1')
    expect(helpers.revokeGrant).toHaveBeenCalledWith('grant-b', 'user-1')
  })

  it('never revokes another user grant for the same client (defense-in-depth)', async () => {
    const kv = env.OAUTH_KV
    const refreshFn = vi
      .fn()
      .mockRejectedValueOnce(new OAuthError('invalid_grant', 'refresh token reused', 400))
    // listUserGrants is supposed to scope by userId, but simulate a provider
    // returning a same-client grant belonging to a DIFFERENT user. We must not
    // revoke it — only the calling user's matching grant.
    const helpers = mockOAuthHelpers([
      { id: 'grant-mine', clientId: 'mcp-client', userId: 'user-1' },
      { id: 'grant-other-user', clientId: 'mcp-client', userId: 'user-2' }
    ])

    await expectOAuthError(
      guardRefreshTokenExchange(kv, 'cross-user-token', refreshFn, {
        userId: 'user-1',
        clientId: 'mcp-client',
        getHelpers: () => helpers
      }),
      'invalid_grant',
      400
    )

    expect(helpers.revokeGrant).toHaveBeenCalledTimes(1)
    expect(helpers.revokeGrant).toHaveBeenCalledWith('grant-mine', 'user-1')
    expect(helpers.revokeGrant).not.toHaveBeenCalledWith('grant-other-user', 'user-1')
  })
})

describe('handleTokenExchangeCallback', () => {
  const OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token'

  const refreshCallback = (refreshToken = 'old-refresh-token') =>
    handleTokenExchangeCallback(
      {
        grantType: 'refresh_token',
        props: {
          type: 'user_token',
          accessToken: 'old-access-token',
          user: { id: 'user-1', email: 'user@example.com' },
          accounts: [{ id: 'account-1', name: 'Account 1' }],
          refreshToken
        }
      } as never,
      'client-id',
      'client-secret'
    )

  it('refreshes upstream tokens and returns updated auth props', async () => {
    // Real refreshAuthToken runs against the mocked upstream OAuth endpoint.
    let body: string | undefined
    server.use(
      http.post(OAUTH_TOKEN_URL, async ({ request }) => {
        body = await request.text()
        return HttpResponse.json({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 1234,
          scope: 'read',
          token_type: 'bearer'
        })
      })
    )

    await expect(refreshCallback()).resolves.toEqual({
      newProps: {
        type: 'user_token',
        accessToken: 'new-access-token',
        user: { id: 'user-1', email: 'user@example.com' },
        accounts: [{ id: 'account-1', name: 'Account 1' }],
        refreshToken: 'new-refresh-token'
      },
      accessTokenTTL: 1234
    })

    // The real grant_type=refresh_token request hit the upstream endpoint.
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('refresh_token=old-refresh-token')
  })

  it('throws the local OAuthError that extends the provider OAuthError', async () => {
    // Upstream 400 -> real refreshAuthToken maps it to invalid_grant.
    server.use(
      http.post(OAUTH_TOKEN_URL, () => HttpResponse.text('invalid grant', { status: 400 }))
    )

    await expect(refreshCallback()).rejects.toMatchObject({
      name: 'OAuthError',
      code: 'invalid_grant',
      statusCode: 400
    })
  })

  it('preserves Retry-After on a local in-flight collision (429)', async () => {
    // Seed a real in-flight marker so the guard short-circuits with 429 before
    // any upstream call — the local/provider 429 path.
    await env.OAUTH_KV.put(
      await refreshGuardKey('old-refresh-token', 'in-flight'),
      JSON.stringify({ startedAt: Date.now() })
    )

    await expect(refreshCallback()).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      statusCode: 429,
      headers: { 'Retry-After': '30' }
    })
  })

  it('lets non-OAuth thrown errors propagate (surfaces as 500)', async () => {
    // Upstream 200 with a malformed token body -> real refreshAuthToken throws a
    // ZodError (non-OAuth), which must propagate untouched.
    server.use(
      http.post(OAUTH_TOKEN_URL, () => HttpResponse.json({ not: 'a token' }))
    )

    // Not an OAuthError: a ZodError from parsing the malformed token response.
    await expect(refreshCallback()).rejects.not.toBeInstanceOf(OAuthError)
  })
})
