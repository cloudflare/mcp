import {
  GrantType,
  OAuthError as ProviderOAuthError,
  type OAuthHelpers
} from '@cloudflare/workers-oauth-provider'
import { env } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { handleTokenExchangeCallback } from '../../src/auth/oauth-handler'
import { clearRefreshAdmissionsForTesting } from '../../src/auth/refresh-admission-gate'
import { OAuthError } from '../../src/auth/workers-oauth-utils'
import { clearKv } from '../helpers/kv'
import { server } from '../setup/msw'

/** Minimal OAuthHelpers mock backing the revoke-on-invalid_grant path. */
function mockOAuthHelpers() {
  return {
    revokeGrant: vi.fn(async () => undefined)
  } as unknown as OAuthHelpers & {
    revokeGrant: ReturnType<typeof vi.fn>
  }
}

function refreshCallback(refreshToken = 'old-refresh-token', getHelpers?: () => OAuthHelpers) {
  return handleTokenExchangeCallback(
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
}

const expectedRefreshResult = {
  newProps: {
    type: 'user_token',
    accessToken: 'new-access-token',
    user: { id: 'user-1', email: 'user@example.com' },
    accounts: [{ id: 'account-1', name: 'Account 1' }],
    refreshToken: 'new-refresh-token'
  },
  accessTokenTTL: 1234
}

const OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token'

afterEach(async () => {
  vi.restoreAllMocks()
  clearRefreshAdmissionsForTesting()
  await clearKv(env.OAUTH_KV)
})

describe('handleTokenExchangeCallback', () => {
  it('refreshes upstream tokens and returns updated auth props', async () => {
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

    await expect(refreshCallback()).resolves.toEqual(expectedRefreshResult)
    expect(form?.get('grant_type')).toBe('refresh_token')
    expect(form?.get('refresh_token')).toBe('old-refresh-token')
  })

  it('admits one concurrent refresh per grant and rejects competitors as retryable', async () => {
    let calls = 0
    server.use(
      http.post(OAUTH_TOKEN_URL, async ({ request }) => {
        calls++
        const form = await request.formData()
        expect(form.get('refresh_token')).toBe('old-refresh-token')
        await new Promise((resolve) => setTimeout(resolve, 50))
        return HttpResponse.json({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 1234,
          scope: 'read',
          token_type: 'bearer'
        })
      })
    )

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => refreshCallback()))
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')

    expect(calls).toBe(1)
    expect(fulfilled).toEqual([{ status: 'fulfilled', value: expectedRefreshResult }])
    expect(rejected).toHaveLength(9)
    for (const result of rejected) {
      expect(result.reason).toMatchObject({
        code: 'temporarily_unavailable',
        statusCode: 429,
        headers: { 'Retry-After': expect.any(String) }
      })
    }
  })

  it('retains a successful admission tombstone for immediate grant retries', async () => {
    server.use(
      http.post(OAUTH_TOKEN_URL, () =>
        HttpResponse.json({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 1234,
          scope: 'read',
          token_type: 'bearer'
        })
      )
    )

    await expect(refreshCallback()).resolves.toEqual(expectedRefreshResult)
    await expect(refreshCallback()).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      statusCode: 429
    })
  })

  it('releases admission after a transient upstream failure', async () => {
    let calls = 0
    server.use(
      http.post(OAUTH_TOKEN_URL, () => {
        calls++
        if (calls === 1) {
          return HttpResponse.text('rate limited', {
            status: 429,
            headers: { 'Retry-After': '1' }
          })
        }
        return HttpResponse.json({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 1234,
          scope: 'read',
          token_type: 'bearer'
        })
      })
    )

    await expect(refreshCallback()).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      statusCode: 429
    })
    await expect(refreshCallback()).resolves.toEqual(expectedRefreshResult)
    expect(calls).toBe(2)
  })

  it('revokes the exact callback grant when upstream returns invalid_grant', async () => {
    server.use(
      http.post(OAUTH_TOKEN_URL, () => HttpResponse.text('invalid grant', { status: 400 }))
    )
    const helpers = mockOAuthHelpers()

    await expect(refreshCallback('old-refresh-token', () => helpers)).rejects.toMatchObject({
      name: 'OAuthError',
      code: 'invalid_grant',
      statusCode: 400
    })
    expect(helpers.revokeGrant).toHaveBeenCalledOnce()
    expect(helpers.revokeGrant).toHaveBeenCalledWith('grant-exact', 'user-1')
  })

  it('does not revoke the grant for transient upstream failures', async () => {
    server.use(
      http.post(OAUTH_TOKEN_URL, () =>
        HttpResponse.text('rate limited', { status: 429, headers: { 'Retry-After': '17' } })
      )
    )
    const helpers = mockOAuthHelpers()

    await expect(refreshCallback('old-refresh-token', () => helpers)).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      statusCode: 429,
      headers: { 'Retry-After': '17' }
    })
    expect(helpers.revokeGrant).not.toHaveBeenCalled()
  })

  it('still throws invalid_grant when revoking the grant fails', async () => {
    server.use(
      http.post(OAUTH_TOKEN_URL, () => HttpResponse.text('invalid grant', { status: 400 }))
    )
    const helpers = mockOAuthHelpers()
    vi.mocked(helpers.revokeGrant).mockRejectedValueOnce(new Error('KV unavailable'))

    await expect(refreshCallback('old-refresh-token', () => helpers)).rejects.toMatchObject({
      code: 'invalid_grant',
      statusCode: 400
    })
  })

  it('returns the provider-compatible OAuth error from upstream', async () => {
    server.use(
      http.post(OAUTH_TOKEN_URL, () =>
        HttpResponse.text('rate limited', { status: 429, headers: { 'Retry-After': '17' } })
      )
    )

    try {
      await refreshCallback()
      throw new Error('Expected refresh to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthError)
      expect(error).toBeInstanceOf(ProviderOAuthError)
    }
  })

  it('lets non-OAuth thrown errors propagate', async () => {
    server.use(http.post(OAUTH_TOKEN_URL, () => HttpResponse.json({ not: 'a token' })))

    await expect(refreshCallback()).rejects.not.toBeInstanceOf(OAuthError)
  })
})
