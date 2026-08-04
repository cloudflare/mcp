import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { withRefreshAdmission } from '../../src/auth/refresh-admission-gate'
import { OAuthError } from '../../src/auth/workers-oauth-utils'
import { clearKv } from '../helpers/kv'

let grantSequence = 0

function grant() {
  return { userId: 'user-1', grantId: `grant-${++grantSequence}` }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await clearKv(env.OAUTH_KV)
})

describe('withRefreshAdmission', () => {
  it('allows different grants to proceed independently', async () => {
    const refresh = vi.fn(async (value: string) => value)

    const results = await Promise.all([
      withRefreshAdmission(env.OAUTH_KV, grant(), () => refresh('first')),
      withRefreshAdmission(env.OAUTH_KV, grant(), () => refresh('second'))
    ])

    expect(results).toEqual(['first', 'second'])
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('ignores malformed external KV state and replaces it with a valid claim', async () => {
    const identity = grant()
    await env.OAUTH_KV.put(
      `oauth:refresh-admission:v1:${identity.userId}:${identity.grantId}`,
      JSON.stringify({ owner: 42, blockedUntil: 'never' })
    )

    await expect(
      withRefreshAdmission(env.OAUTH_KV, identity, async () => 'refreshed')
    ).resolves.toBe('refreshed')
  })

  it('fails closed when a KV claim cannot be written', async () => {
    vi.spyOn(env.OAUTH_KV, 'put').mockRejectedValueOnce(new Error('KV unavailable'))

    await expect(
      withRefreshAdmission(env.OAUTH_KV, grant(), async () => 'must not run')
    ).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      statusCode: 429,
      headers: { 'Retry-After': '30' }
    })
  })

  it('releases admission after any callback error', async () => {
    const identity = grant()

    await expect(
      withRefreshAdmission(env.OAUTH_KV, identity, async () => {
        throw new OAuthError('invalid_grant', 'dead token', 400)
      })
    ).rejects.toMatchObject({ code: 'invalid_grant' })

    await expect(
      withRefreshAdmission(env.OAUTH_KV, identity, async () => 'retry succeeded')
    ).resolves.toBe('retry succeeded')
  })
})
