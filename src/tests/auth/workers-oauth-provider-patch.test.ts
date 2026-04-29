import type {
  OAuthProvider as OAuthProviderClass,
  OAuthProviderOptions
} from '@cloudflare/workers-oauth-provider'
import { describe, expect, it, vi } from 'vitest'

import { OAuthError } from '../../auth/workers-oauth-utils'

type TestEnv = {
  OAUTH_KV: KVNamespace
}

class MemoryKV {
  values = new Map<string, string>()

  async get(key: string, options?: { type?: string }): Promise<unknown> {
    const value = this.values.get(key)
    if (value === undefined) return null
    if (options?.type === 'json') return JSON.parse(value)
    return value
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }

  async list(options?: { prefix?: string }): Promise<{
    keys: Array<{ name: string }>
    list_complete: boolean
    cursor?: string
  }> {
    const prefix = options?.prefix ?? ''
    return {
      keys: Array.from(this.values.keys())
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true
    }
  }
}

function createProvider(
  tokenExchangeCallback: OAuthProviderOptions<TestEnv>['tokenExchangeCallback']
): Promise<{
  env: TestEnv
  provider: OAuthProviderClass<TestEnv>
  options: OAuthProviderOptions<TestEnv>
}> {
  vi.stubGlobal('Cloudflare', {
    compatibilityFlags: { global_fetch_strictly_public: true }
  })
  const env = { OAUTH_KV: new MemoryKV() as unknown as KVNamespace }
  const options: OAuthProviderOptions<TestEnv> = {
    apiHandlers: {
      '/api': {
        fetch: async () => new Response('ok')
      }
    },
    defaultHandler: {
      fetch: async () => new Response('not found', { status: 404 })
    },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    tokenExchangeCallback
  }
  return import('@cloudflare/workers-oauth-provider').then(({ default: OAuthProvider }) => ({
    env,
    provider: new OAuthProvider(options),
    options
  }))
}

async function createRefreshToken(
  provider: OAuthProviderClass<TestEnv>,
  options: OAuthProviderOptions<TestEnv>,
  env: TestEnv
): Promise<{ clientId: string; refreshToken: string }> {
  const { getOAuthApi } = await import('@cloudflare/workers-oauth-provider')
  const helpers = getOAuthApi(options, env)
  const client = await helpers.createClient({
    redirectUris: ['https://client.example/callback'],
    tokenEndpointAuthMethod: 'none'
  })
  const { redirectTo } = await helpers.completeAuthorization({
    request: {
      responseType: 'code',
      clientId: client.clientId,
      redirectUri: 'https://client.example/callback',
      scope: ['read'],
      state: 'state'
    },
    userId: 'user-1',
    metadata: { label: 'user@example.com' },
    scope: ['read'],
    props: { upstream: 'refresh-token' }
  })
  const code = new URL(redirectTo).searchParams.get('code')
  expect(code).toBeTruthy()

  const response = await provider.fetch(
    new Request('https://server.example/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.clientId,
        redirect_uri: 'https://client.example/callback',
        code: code!
      })
    }),
    env,
    { waitUntil: vi.fn() } as unknown as ExecutionContext
  )
  expect(response.status).toBe(200)
  const tokenResponse = (await response.json()) as { refresh_token?: string }
  expect(tokenResponse.refresh_token).toBeTruthy()
  return {
    clientId: client.clientId,
    refreshToken: tokenResponse.refresh_token!
  }
}

async function refreshWithToken(
  provider: OAuthProviderClass<TestEnv>,
  env: TestEnv,
  clientId: string,
  refreshToken: string
): Promise<Response> {
  return provider.fetch(
    new Request('https://server.example/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken
      })
    }),
    env,
    { waitUntil: vi.fn() } as unknown as ExecutionContext
  )
}

describe('workers-oauth-provider patch', () => {
  it('preserves successful refresh token exchanges', async () => {
    const callback = vi.fn(async (options) => {
      if (options.grantType === 'refresh_token') {
        return {
          newProps: { upstream: 'rotated-refresh-token' },
          accessTokenTTL: 1234
        }
      }
      return undefined
    })
    const { env, provider, options } = await createProvider(callback)
    const { clientId, refreshToken } = await createRefreshToken(provider, options, env)

    const response = await refreshWithToken(provider, env, clientId, refreshToken)

    expect(response.status).toBe(200)
    const tokenResponse = (await response.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      token_type?: string
      scope?: string
    }
    expect(tokenResponse.access_token).toEqual(expect.any(String))
    expect(tokenResponse.refresh_token).toEqual(expect.any(String))
    expect(tokenResponse.access_token).not.toBe(refreshToken)
    expect(tokenResponse.refresh_token).not.toBe(refreshToken)
    expect(tokenResponse.expires_in).toBe(1234)
    expect(tokenResponse.token_type).toBe('bearer')
    expect(tokenResponse.scope).toBe('read')
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ grantType: 'refresh_token' }))
  })

  it('turns callback OAuth errors into token endpoint JSON responses', async () => {
    const callback = vi.fn(async (options) => {
      if (options.grantType === 'refresh_token') {
        throw new OAuthError('invalid_grant', 'upstream refresh token is invalid', 400)
      }
      return undefined
    })
    const { env, provider, options } = await createProvider(callback)
    const { clientId, refreshToken } = await createRefreshToken(provider, options, env)

    const response = await refreshWithToken(provider, env, clientId, refreshToken)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_grant',
      error_description: 'upstream refresh token is invalid'
    })
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ grantType: 'refresh_token' }))
  })

  it('adds Retry-After when callback asks clients to retry later', async () => {
    const callback = vi.fn(async (options) => {
      if (options.grantType === 'refresh_token') {
        throw new OAuthError('temporarily_unavailable', 'refresh already in progress', 429)
      }
      return undefined
    })
    const { env, provider, options } = await createProvider(callback)
    const { clientId, refreshToken } = await createRefreshToken(provider, options, env)

    const response = await refreshWithToken(provider, env, clientId, refreshToken)

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('30')
    await expect(response.json()).resolves.toEqual({
      error: 'temporarily_unavailable',
      error_description: 'refresh already in progress'
    })
  })

  it('still lets non-OAuth callback errors surface', async () => {
    const callback = vi.fn(async (options) => {
      if (options.grantType === 'refresh_token') {
        throw new Error('unexpected failure')
      }
      return undefined
    })
    const { env, provider, options } = await createProvider(callback)
    const { clientId, refreshToken } = await createRefreshToken(provider, options, env)

    await expect(refreshWithToken(provider, env, clientId, refreshToken)).rejects.toThrow(
      'unexpected failure'
    )
  })
})
