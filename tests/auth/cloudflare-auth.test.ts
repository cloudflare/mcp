import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { refreshAuthToken } from '../../src/auth/cloudflare-auth'
import { OAuthError } from '../../src/auth/workers-oauth-utils'
import { server } from '../setup/msw'

const OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token'

const refreshParams = {
  client_id: 'client-id',
  client_secret: 'client-secret',
  refresh_token: 'refresh-token',
  oauthDomain: 'https://dash.cloudflare.com'
}

/** Run the REAL refreshAuthToken against an MSW-mocked upstream `response`. */
async function expectRefreshOAuthError(response: Response): Promise<OAuthError> {
  server.use(http.post(OAUTH_TOKEN_URL, () => response))

  try {
    await refreshAuthToken(refreshParams)
    throw new Error('Expected refreshAuthToken to throw')
  } catch (error) {
    expect(error).toBeInstanceOf(OAuthError)
    return error as OAuthError
  }
}

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
