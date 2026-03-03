import { afterEach, describe, expect, it, vi } from 'vitest'

import { getUserAndAccounts } from '../../auth/oauth-handler'
import { OAuthError } from '../../auth/workers-oauth-utils'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

afterEach(() => {
  vi.restoreAllMocks()
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

    await expect(getUserAndAccounts('test-token')).rejects.toEqual(
      new OAuthError('insufficient_scope', 'Insufficient permissions', 403)
    )
  })
})
