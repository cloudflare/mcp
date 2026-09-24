import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'

import { resolveCloudflareCredential } from '../../src/auth/cloudflare-identity'
import { API_BASE, cfError } from '../helpers/cloudflare-api'
import { clearKv } from '../helpers/kv'
import { server } from '../setup/msw'

// No fetch-retry mock here: this proves the real fetchWithRetry makes one attempt per identity probe.
afterEach(() => clearKv(env.OAUTH_KV))

describe('identity probes', () => {
  it('make one attempt per endpoint on a 429 instead of retrying against the same quota', async () => {
    let userCalls = 0
    let accountCalls = 0
    server.use(
      http.get(`${API_BASE}/user`, () => {
        userCalls++
        return HttpResponse.json(cfError([], null), {
          status: 429,
          headers: { 'Retry-After': '1' }
        })
      }),
      http.get(`${API_BASE}/accounts`, () => {
        accountCalls++
        return HttpResponse.json(cfError([], null), {
          status: 429,
          headers: { 'Retry-After': '1' }
        })
      })
    )

    await expect(resolveCloudflareCredential('cfut_quota-token', 'user')).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      statusCode: 429
    })
    expect([userCalls, accountCalls]).toEqual([1, 1])
  })
})
