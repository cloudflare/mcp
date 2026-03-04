import { afterEach, describe, expect, it, vi } from 'vitest'

import { getUserAndAccounts } from '../../auth/oauth-handler'
import { OAuthError } from '../../auth/workers-oauth-utils'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

async function expectOAuthError(
  promise: Promise<unknown>,
  code: string,
  statusCode: number
): Promise<void> {
  try {
    await promise
    throw new Error('Expected OAuthError to be thrown')
  } catch (e) {
    expect(e).toBeInstanceOf(OAuthError)
    expect(e).toMatchObject({ code, statusCode })
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
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network failed'))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [] }))

    vi.stubGlobal('fetch', fetchMock)

    await expectOAuthError(getUserAndAccounts('test-token'), 'server_error', 502)
  })
})
