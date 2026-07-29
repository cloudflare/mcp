import {
  GrantType,
  OAuthError as ProviderOAuthError,
  type OAuthHelpers
} from '@cloudflare/workers-oauth-provider'
import { env } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  guardRefreshTokenExchange,
  handleTokenExchangeCallback
} from '../../src/auth/oauth-handler'
import { OAuthError } from '../../src/auth/workers-oauth-utils'
import { server } from '../setup/msw'

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

/** Minimal OAuthHelpers mock backing the revoke-on-invalid_grant path. */
function mockOAuthHelpers() {
  return {
    listUserGrants: vi.fn(),
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

  it('revokes the exact grant on upstream invalid_grant', async () => {
    const kv = env.OAUTH_KV
    const refreshFn = vi
      .fn()
      .mockRejectedValueOnce(new OAuthError('invalid_grant', 'refresh token reused', 400))
    const helpers = mockOAuthHelpers()
    const getHelpers = vi.fn(() => helpers)

    await expectOAuthError(
      guardRefreshTokenExchange(kv, 'dead-token', refreshFn, {
        userId: 'user-1',
        clientId: 'mcp-client',
        grantId: 'grant-kill',
        getHelpers
      }),
      'invalid_grant',
      400
    )

    expect(helpers.listUserGrants).not.toHaveBeenCalled()
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
    const helpers = mockOAuthHelpers()
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
    const helpers = mockOAuthHelpers()
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
    const helpers = mockOAuthHelpers()
    vi.mocked(helpers.revokeGrant).mockRejectedValueOnce(new Error('KV unavailable'))

    await expectOAuthError(
      guardRefreshTokenExchange(kv, 'dead-token-revoke-fails', refreshFn, {
        userId: 'user-1',
        clientId: 'mcp-client',
        grantId: 'grant-kill',
        getHelpers: () => helpers
      }),
      'invalid_grant',
      400
    )
  })
})

describe('handleTokenExchangeCallback', () => {
  const OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token'

  const refreshCallback = (refreshToken = 'old-refresh-token', getHelpers?: () => OAuthHelpers) =>
    handleTokenExchangeCallback(
      {
        grantType: GrantType.REFRESH_TOKEN,
        clientId: 'mcp-client',
        userId: 'user-1',
        grantId: 'grant-exact',
        scope: [],
        requestedScope: [],
        props: {
          type: 'user_token',
          accessToken: 'old-access-token',
          user: { id: 'user-1', email: 'user@example.com' },
          accounts: [{ id: 'account-1', name: 'Account 1' }],
          refreshToken
        }
      },
      'client-id',
      'client-secret',
      getHelpers
    )

  it('refreshes upstream tokens and returns updated auth props', async () => {
    // Real refreshAuthToken runs against the mocked upstream OAuth endpoint.
    let form: FormData | undefined
    server.use(
      http.post(OAUTH_TOKEN_URL, async ({ request }) => {
        form = await request.formData()
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
    expect(form?.get('grant_type')).toBe('refresh_token')
    expect(form?.get('refresh_token')).toBe('old-refresh-token')
  })

  it('revokes the callback grant when upstream returns invalid_grant', async () => {
    // Upstream 400 -> real refreshAuthToken maps it to invalid_grant.
    server.use(
      http.post(OAUTH_TOKEN_URL, () => HttpResponse.text('invalid grant', { status: 400 }))
    )
    const helpers = mockOAuthHelpers()

    await expect(refreshCallback('old-refresh-token', () => helpers)).rejects.toMatchObject({
      name: 'OAuthError',
      code: 'invalid_grant',
      statusCode: 400
    })
    expect(helpers.listUserGrants).not.toHaveBeenCalled()
    expect(helpers.revokeGrant).toHaveBeenCalledWith('grant-exact', 'user-1')
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
    server.use(http.post(OAUTH_TOKEN_URL, () => HttpResponse.json({ not: 'a token' })))

    // Not an OAuthError: a ZodError from parsing the malformed token response.
    await expect(refreshCallback()).rejects.not.toBeInstanceOf(OAuthError)
  })
})
