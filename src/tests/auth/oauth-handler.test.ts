import { OAuthError as ProviderOAuthError } from '@cloudflare/workers-oauth-provider'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getUserAndAccounts,
  guardRefreshTokenExchange,
  handleTokenExchangeCallback
} from '../../auth/oauth-handler'
import { OAuthError } from '../../auth/workers-oauth-utils'

import type { AuthorizationToken } from '../../auth/cloudflare-auth'

vi.mock('../../auth/cloudflare-auth', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../auth/cloudflare-auth')>()
  return {
    ...original,
    refreshAuthToken: vi.fn()
  }
})

// Use minimal retry config so tests don't wait for real backoff delays
vi.mock('../../utils/fetch-retry', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../utils/fetch-retry')>()
  return {
    ...original,
    fetchWithRetry: (input: RequestInfo, init?: RequestInit) =>
      original.fetchWithRetry(input, init, { maxRetries: 0 })
  }
})

async function mockRefreshAuthToken() {
  const { refreshAuthToken } = await import('../../auth/cloudflare-auth')
  return vi.mocked(refreshAuthToken)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

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

function mockKV(initialValues: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(initialValues))
  return {
    get: vi.fn(async (key: string, options?: { type?: string }) => {
      const value = store.get(key)
      if (value === undefined) return null
      if (options?.type === 'json') return JSON.parse(value)
      return value
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key)
    })
  } as unknown as KVNamespace
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

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('getUserAndAccounts', () => {
  it('accepts account-scoped token when /user fails but /accounts succeeds', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [{ id: 'acc-1', name: 'Primary Account' }]
        })
      )

    vi.stubGlobal('fetch', fetchMock)

    await expect(getUserAndAccounts('test-token')).resolves.toEqual({
      user: null,
      accounts: [{ id: 'acc-1', name: 'Primary Account' }]
    })
  })

  it('sets Cloudflare fetch cache options for API token identity probes', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [{ id: 'acc-1', name: 'Primary Account' }]
        })
      )

    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getUserAndAccounts('test-token', 'api_token_identity_probe', 'token-hash')
    ).resolves.toEqual({
      user: null,
      accounts: [{ id: 'acc-1', name: 'Primary Account' }]
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.cloudflare.com/client/v4/user',
      expect.objectContaining({
        cf: {
          cacheEverything: true,
          cacheKey: 'https://api.cloudflare.com/client/v4/mcp/api-token-identity/token-hash/user',
          cacheTtl: 2_592_000
        }
      })
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.cloudflare.com/client/v4/accounts',
      expect.objectContaining({
        cf: {
          cacheEverything: true,
          cacheKey:
            'https://api.cloudflare.com/client/v4/mcp/api-token-identity/token-hash/accounts',
          cacheTtl: 2_592_000
        }
      })
    )
  })

  it('accepts user tokens when /accounts fails but /user succeeds', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: { id: 'user-1', email: 'user@example.com' }
        })
      )
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))

    vi.stubGlobal('fetch', fetchMock)

    await expect(getUserAndAccounts('test-token')).resolves.toEqual({
      user: { id: 'user-1', email: 'user@example.com' },
      accounts: []
    })
  })

  it('throws insufficient_scope when both endpoints fail with 403', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))

    vi.stubGlobal('fetch', fetchMock)

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
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('upstream error', { status: userStatus }))
        .mockResolvedValueOnce(new Response('upstream error', { status: accountsStatus }))

      vi.stubGlobal('fetch', fetchMock)

      await expectOAuthError(getUserAndAccounts('test-token'), code, statusCode)
    }
  )

  it('preserves Retry-After from Cloudflare API 429 responses', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '17' } })
      )
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))

    vi.stubGlobal('fetch', fetchMock)

    const error = await expectOAuthError(
      getUserAndAccounts('test-token'),
      'temporarily_unavailable',
      429
    )
    expect(error.headers).toEqual({ 'Retry-After': '17' })
  })

  it('defaults Retry-After when Cloudflare API 429 responses omit it', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))

    vi.stubGlobal('fetch', fetchMock)

    const error = await expectOAuthError(
      getUserAndAccounts('test-token'),
      'temporarily_unavailable',
      429
    )
    expect(error.headers).toEqual({ 'Retry-After': '30' })
  })

  it('falls back to account-scoped auth when /user is 200 but invalid JSON', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('not-json', { status: 200 }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [{ id: 'acc-1', name: 'Primary Account' }]
        })
      )

    vi.stubGlobal('fetch', fetchMock)

    await expect(getUserAndAccounts('test-token')).resolves.toEqual({
      user: null,
      accounts: [{ id: 'acc-1', name: 'Primary Account' }]
    })
  })

  it('falls back to account-scoped auth when /user is 200 with success=false', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: false
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [{ id: 'acc-1', name: 'Primary Account' }]
        })
      )

    vi.stubGlobal('fetch', fetchMock)

    await expect(getUserAndAccounts('test-token')).resolves.toEqual({
      user: null,
      accounts: [{ id: 'acc-1', name: 'Primary Account' }]
    })
  })

  it('keeps user auth when /accounts is 200 but invalid JSON', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: { id: 'user-1', email: 'user@example.com' }
        })
      )
      .mockResolvedValueOnce(new Response('not-json', { status: 200 }))

    vi.stubGlobal('fetch', fetchMock)

    await expect(getUserAndAccounts('test-token')).resolves.toEqual({
      user: { id: 'user-1', email: 'user@example.com' },
      accounts: []
    })
  })

  it('rejects when /accounts returns empty result and /user fails', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: []
        })
      )

    vi.stubGlobal('fetch', fetchMock)

    await expectOAuthError(getUserAndAccounts('test-token'), 'invalid_token', 401)
  })

  it('rejects when /accounts payload shape is invalid and /user fails', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [{ id: 'acc-1' }]
        })
      )

    vi.stubGlobal('fetch', fetchMock)

    await expectOAuthError(getUserAndAccounts('test-token'), 'invalid_token', 401)
  })

  it('maps fetch rejection to server_error', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network failed'))

    vi.stubGlobal('fetch', fetchMock)

    await expectOAuthError(getUserAndAccounts('test-token'), 'server_error', 502)
  })
})

describe('guardRefreshTokenExchange', () => {
  it('singleflights concurrent refreshes for the same upstream token in one isolate', async () => {
    const kv = mockKV()
    const refresh = deferred<{ accessTokenTTL: number }>()
    const refreshFn = vi.fn(() => refresh.promise)

    const first = guardRefreshTokenExchange(kv, 'upstream-refresh-token', refreshFn)
    const second = guardRefreshTokenExchange(kv, 'upstream-refresh-token', refreshFn)

    await vi.waitFor(() => expect(refreshFn).toHaveBeenCalledTimes(1))

    refresh.resolve({ accessTokenTTL: 3600 })

    await expect(first).resolves.toEqual({ accessTokenTTL: 3600 })
    await expect(second).resolves.toEqual({ accessTokenTTL: 3600 })
    expect(kv.put).toHaveBeenCalledTimes(1)
    expect(kv.delete).toHaveBeenCalledTimes(1)
  })

  it('caches terminal refresh failures so retries do not call upstream again', async () => {
    const kv = mockKV()
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

    expect(refreshFn).toHaveBeenCalledTimes(1)
    expect(kv.put).toHaveBeenCalledTimes(2) // in-flight marker + cached failure
  })

  it('suppresses upstream refresh when another isolate has an in-flight marker', async () => {
    const refreshToken = 'cross-isolate-refresh-token'
    const kv = mockKV({
      [await refreshGuardKey(refreshToken, 'in-flight')]: JSON.stringify({ startedAt: Date.now() })
    })
    const refreshFn = vi.fn()

    await expectOAuthError(
      guardRefreshTokenExchange(kv, refreshToken, refreshFn),
      'temporarily_unavailable',
      429
    )

    expect(refreshFn).not.toHaveBeenCalled()
  })

  it('does not fail a successful refresh when clearing the in-flight marker fails', async () => {
    const kv = mockKV()
    const refreshFn = vi.fn().mockResolvedValue({ accessTokenTTL: 3600 })
    vi.mocked(kv.delete).mockRejectedValueOnce(new Error('KV delete failed'))

    await expect(
      guardRefreshTokenExchange(kv, 'cleanup-failure-token', refreshFn)
    ).resolves.toEqual({
      accessTokenTTL: 3600
    })
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('preserves the original terminal error when caching the failure fails', async () => {
    const kv = mockKV()
    const refreshFn = vi
      .fn()
      .mockRejectedValueOnce(new OAuthError('invalid_grant', 'refresh token reused', 400))
    vi.mocked(kv.put)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('KV put failed'))

    await expectOAuthError(
      guardRefreshTokenExchange(kv, 'failure-cache-error-token', refreshFn),
      'invalid_grant',
      400
    )
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })
})

describe('handleTokenExchangeCallback', () => {
  it('refreshes upstream tokens and returns updated auth props', async () => {
    const refreshAuthToken = await mockRefreshAuthToken()
    refreshAuthToken.mockResolvedValueOnce({
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expires_in: 1234,
      scope: 'read',
      token_type: 'bearer'
    } satisfies AuthorizationToken)

    await expect(
      handleTokenExchangeCallback(
        {
          grantType: 'refresh_token',
          props: {
            type: 'user_token',
            accessToken: 'old-access-token',
            user: { id: 'user-1', email: 'user@example.com' },
            accounts: [{ id: 'account-1', name: 'Account 1' }],
            refreshToken: 'old-refresh-token'
          }
        } as never,
        'client-id',
        'client-secret'
      )
    ).resolves.toEqual({
      newProps: {
        type: 'user_token',
        accessToken: 'new-access-token',
        user: { id: 'user-1', email: 'user@example.com' },
        accounts: [{ id: 'account-1', name: 'Account 1' }],
        refreshToken: 'new-refresh-token'
      },
      accessTokenTTL: 1234
    })

    expect(refreshAuthToken).toHaveBeenCalledWith({
      client_id: 'client-id',
      client_secret: 'client-secret',
      refresh_token: 'old-refresh-token',
      oauthDomain: 'https://dash.cloudflare.com'
    })
  })

  it('throws the local OAuthError that extends the provider OAuthError', async () => {
    const refreshAuthToken = await mockRefreshAuthToken()
    refreshAuthToken.mockRejectedValueOnce(
      new OAuthError('invalid_grant', 'upstream refresh token is invalid', 400)
    )

    await expect(
      handleTokenExchangeCallback(
        {
          grantType: 'refresh_token',
          props: {
            type: 'user_token',
            accessToken: 'old-access-token',
            user: { id: 'user-1', email: 'user@example.com' },
            accounts: [{ id: 'account-1', name: 'Account 1' }],
            refreshToken: 'old-refresh-token'
          }
        } as never,
        'client-id',
        'client-secret'
      )
    ).rejects.toMatchObject({
      name: 'OAuthError',
      code: 'invalid_grant',
      description: 'upstream refresh token is invalid',
      statusCode: 400
    })
  })

  it('preserves Retry-After on local/provider 429 OAuthErrors', async () => {
    const refreshAuthToken = await mockRefreshAuthToken()
    refreshAuthToken.mockRejectedValueOnce(
      new OAuthError('temporarily_unavailable', 'refresh already in progress', 429, {
        'Retry-After': '30'
      })
    )

    await expect(
      handleTokenExchangeCallback(
        {
          grantType: 'refresh_token',
          props: {
            type: 'user_token',
            accessToken: 'old-access-token',
            user: { id: 'user-1', email: 'user@example.com' },
            accounts: [{ id: 'account-1', name: 'Account 1' }],
            refreshToken: 'old-refresh-token'
          }
        } as never,
        'client-id',
        'client-secret'
      )
    ).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      statusCode: 429,
      headers: { 'Retry-After': '30' }
    })
  })

  it('lets non-OAuth thrown errors propagate (surfaces as 500)', async () => {
    const refreshAuthToken = await mockRefreshAuthToken()
    refreshAuthToken.mockRejectedValueOnce(new Error('unexpected failure'))

    await expect(
      handleTokenExchangeCallback(
        {
          grantType: 'refresh_token',
          props: {
            type: 'user_token',
            accessToken: 'old-access-token',
            user: { id: 'user-1', email: 'user@example.com' },
            accounts: [{ id: 'account-1', name: 'Account 1' }],
            refreshToken: 'old-refresh-token'
          }
        } as never,
        'client-id',
        'client-secret'
      )
    ).rejects.toThrow('unexpected failure')
  })
})
