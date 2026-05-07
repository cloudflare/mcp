import { afterEach, describe, expect, it, vi } from 'vitest'

import { refreshAuthToken } from '../../auth/cloudflare-auth'
import { OAuthError } from '../../auth/workers-oauth-utils'

const refreshParams = {
  client_id: 'client-id',
  client_secret: 'client-secret',
  refresh_token: 'refresh-token',
  oauthDomain: 'https://dash.cloudflare.com'
}

async function expectRefreshOAuthError(response: Response): Promise<OAuthError> {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(response))

  try {
    await refreshAuthToken(refreshParams)
    throw new Error('Expected refreshAuthToken to throw')
  } catch (error) {
    expect(error).toBeInstanceOf(OAuthError)
    return error as OAuthError
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('refreshAuthToken', () => {
  it('preserves Retry-After from upstream OAuth 429 responses', async () => {
    const error = await expectRefreshOAuthError(
      new Response('rate limited', { status: 429, headers: { 'Retry-After': '42' } })
    )

    expect(error).toMatchObject({
      code: 'temporarily_unavailable',
      statusCode: 429,
      headers: { 'Retry-After': '42' }
    })
  })

  it('defaults Retry-After when upstream OAuth 429 responses omit it', async () => {
    const error = await expectRefreshOAuthError(new Response('rate limited', { status: 429 }))

    expect(error).toMatchObject({
      code: 'temporarily_unavailable',
      statusCode: 429,
      headers: { 'Retry-After': '30' }
    })
  })
})
