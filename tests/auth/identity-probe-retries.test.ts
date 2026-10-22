// No fetch-retry mock here, unlike cloudflare-identity.test.ts: these tests check how many
// requests the real fetchWithRetry sends for each kind of identity probe.
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import {
  getCloudflareOAuthUser,
  resolveCloudflareCredential
} from '../../src/auth/cloudflare-identity'
import { API_BASE, cfAccountsSuccess, cfSuccess } from '../helpers/cloudflare-api'
import { server } from '../setup/msw'

const USER = { id: 'user-1', email: 'user@example.com' }
const ACCOUNT = { id: 'account-1', name: 'Account One' }

function countRequests(responses: { user: () => Response; accounts: () => Response }) {
  const calls = { user: 0, accounts: 0 }
  server.use(
    http.get(`${API_BASE}/user`, () => {
      calls.user++
      return responses.user()
    }),
    http.get(`${API_BASE}/accounts`, () => {
      calls.accounts++
      return responses.accounts()
    })
  )
  return calls
}

describe('identity probe retries', () => {
  it('sends a direct credential probe once when Cloudflare rate-limits it', async () => {
    const rateLimited = () => new HttpResponse('rate limited', { status: 429 })
    const calls = countRequests({ user: rateLimited, accounts: rateLimited })

    await expect(resolveCloudflareCredential('cfut_rate-limited', 'user')).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      statusCode: 429
    })
    expect(calls).toEqual({ user: 1, accounts: 1 })
  })

  it('still retries the OAuth callback probe a person is waiting on', async () => {
    let userAttempts = 0
    const calls = countRequests({
      user: () =>
        ++userAttempts === 1
          ? new HttpResponse('rate limited', { status: 429, headers: { 'Retry-After': '0' } })
          : HttpResponse.json(cfSuccess(USER)),
      accounts: () => HttpResponse.json(cfAccountsSuccess([ACCOUNT]))
    })

    await expect(getCloudflareOAuthUser('upstream-oauth-token')).resolves.toMatchObject({
      type: 'user',
      user: USER
    })
    expect(calls).toEqual({ user: 2, accounts: 1 })
  })
})
