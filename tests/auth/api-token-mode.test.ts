import { env, exports } from 'cloudflare:workers'
import { ExternalTokenError } from '@cloudflare/workers-oauth-provider'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildAuthProps,
  cloudflareTokenOwner,
  resolveCloudflareToken
} from '../../src/auth/api-token-mode'
import { AUTH_PROPS_VERSION } from '../../src/auth/types'
import { API_BASE, cfAccountsSuccess, cfError, cfSuccess } from '../helpers/cloudflare-api'
import { clearKv } from '../helpers/kv'
import { MCP_URL, modernMcpRequest } from '../helpers/mcp'
import { server } from '../setup/msw'

vi.mock('../../src/utils/fetch-retry', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/fetch-retry')>()
  return {
    ...original,
    fetchWithRetry: (input: RequestInfo, init?: RequestInit) =>
      original.fetchWithRetry(input, init, { maxRetries: 0 })
  }
})

const USER = { id: 'user-1', email: 'user@example.com' }
const ACCOUNT = { id: 'account-1', name: 'Account One' }

function resolverInput(token: string) {
  return {
    token,
    request: new Request(MCP_URL),
    env
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function mockIdentity(opts: { user?: () => Response; accounts?: () => Response }): {
  userCalls: () => number
  accountCalls: () => number
} {
  let userCalls = 0
  let accountCalls = 0
  if (opts.user) {
    server.use(
      http.get(`${API_BASE}/user`, () => {
        userCalls++
        return opts.user!()
      })
    )
  }
  if (opts.accounts) {
    server.use(
      http.get(`${API_BASE}/accounts`, () => {
        accountCalls++
        return opts.accounts!()
      })
    )
  }
  return { userCalls: () => userCalls, accountCalls: () => accountCalls }
}

async function expectExternalTokenError(
  promise: Promise<unknown>,
  code: string,
  statusCode: number
): Promise<ExternalTokenError> {
  try {
    await promise
    throw new Error('Expected ExternalTokenError')
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalTokenError)
    expect(error).toMatchObject({ code, statusCode })
    return error as ExternalTokenError
  }
}

afterEach(() => clearKv(env.OAUTH_KV))

describe('Cloudflare token ownership', () => {
  it.each([
    ['cfat_account-token', 'account'],
    ['cfut_user-token', 'user'],
    ['cfoat_wrangler-token', 'user'],
    ['legacy-unprefixed-token', 'unknown']
  ] as const)('classifies %s as %s', (token, owner) => {
    expect(cloudflareTokenOwner(token)).toBe(owner)
  })
})

describe('buildAuthProps', () => {
  it('builds versioned user props', () => {
    expect(buildAuthProps('token', USER, [ACCOUNT], 1)).toEqual({
      type: 'user_token',
      accessToken: 'token',
      user: USER,
      accounts: [ACCOUNT],
      accountCount: 1,
      version: AUTH_PROPS_VERSION
    })
  })

  it('builds account props only for exactly one account', () => {
    expect(buildAuthProps('token', null, [ACCOUNT])).toEqual({
      type: 'account_token',
      accessToken: 'token',
      account: ACCOUNT
    })
    expect(() => buildAuthProps('token', null, [])).toThrow(
      'Account token must resolve to exactly one Cloudflare account'
    )
    expect(() =>
      buildAuthProps('token', null, [ACCOUNT, { id: 'account-2', name: 'Two' }])
    ).toThrow('Account token must resolve to exactly one Cloudflare account')
  })
})

describe('resolveCloudflareToken', () => {
  it('uses only /accounts for prefixed account tokens', async () => {
    const calls = mockIdentity({
      user: () => HttpResponse.json(cfSuccess(USER)),
      accounts: () => HttpResponse.json(cfAccountsSuccess([ACCOUNT]))
    })

    await expect(resolveCloudflareToken(resolverInput('cfat_account-token'))).resolves.toEqual({
      props: {
        type: 'account_token',
        accessToken: 'cfat_account-token',
        account: ACCOUNT
      }
    })
    expect(calls.userCalls()).toBe(0)
    expect(calls.accountCalls()).toBe(1)
  })

  it.each(['cfut_user-token', 'cfoat_wrangler-token'])(
    'uses /user and /accounts for prefixed user credential %s',
    async (token) => {
      const calls = mockIdentity({
        user: () => HttpResponse.json(cfSuccess(USER)),
        accounts: () => HttpResponse.json(cfAccountsSuccess([ACCOUNT]))
      })

      await expect(resolveCloudflareToken(resolverInput(token))).resolves.toMatchObject({
        props: { type: 'user_token', accessToken: token, user: USER, accounts: [ACCOUNT] }
      })
      expect(calls.userCalls()).toBe(1)
      expect(calls.accountCalls()).toBe(1)
    }
  )

  it('retains response-based account inference for legacy credentials', async () => {
    const calls = mockIdentity({
      user: () => HttpResponse.json(cfError([], null), { status: 403 }),
      accounts: () => HttpResponse.json(cfAccountsSuccess([ACCOUNT]))
    })

    await expect(
      resolveCloudflareToken(resolverInput('legacy-account-token'))
    ).resolves.toMatchObject({
      props: { type: 'account_token', account: ACCOUNT }
    })
    expect(calls.userCalls()).toBe(1)
    expect(calls.accountCalls()).toBe(1)
  })

  it('does not infer account ownership for a known user token', async () => {
    mockIdentity({
      user: () => HttpResponse.json(cfError([], null), { status: 403 }),
      accounts: () => HttpResponse.json(cfAccountsSuccess([ACCOUNT]))
    })

    const error = await expectExternalTokenError(
      resolveCloudflareToken(resolverInput('cfut_user-token-no-user-scope')),
      'insufficient_scope',
      403
    )
    expect(error.requiredScopes).toEqual(['user:read', 'account:read'])
  })

  it('uses account-only scope guidance for account token failures', async () => {
    const calls = mockIdentity({
      user: () => HttpResponse.json(cfSuccess(USER)),
      accounts: () => HttpResponse.json(cfError([], null), { status: 403 })
    })

    const error = await expectExternalTokenError(
      resolveCloudflareToken(resolverInput('cfat_account-token-no-read-scope')),
      'insufficient_scope',
      403
    )
    expect(error.requiredScopes).toEqual(['account:read'])
    expect(calls.userCalls()).toBe(0)
    expect(calls.accountCalls()).toBe(1)
  })

  it('caches a verified identity by token hash', async () => {
    const calls = mockIdentity({
      user: () => HttpResponse.json(cfSuccess(USER)),
      accounts: () => HttpResponse.json(cfAccountsSuccess([ACCOUNT]))
    })
    const input = resolverInput('cfut_cached-user-token')

    await resolveCloudflareToken(input)
    await resolveCloudflareToken(input)

    expect(calls.userCalls()).toBe(1)
    expect(calls.accountCalls()).toBe(1)
  })

  it('ignores malformed cached identity data and revalidates upstream', async () => {
    const token = 'cfut_invalid-cache-token'
    await env.OAUTH_KV.put(
      `api-token-identity:v3:${await sha256Hex(token)}`,
      JSON.stringify({ user: 'not-an-object', accounts: [] })
    )
    const calls = mockIdentity({
      user: () => HttpResponse.json(cfSuccess(USER)),
      accounts: () => HttpResponse.json(cfAccountsSuccess([ACCOUNT]))
    })

    await expect(resolveCloudflareToken(resolverInput(token))).resolves.toMatchObject({
      props: { type: 'user_token', user: USER, accounts: [ACCOUNT] }
    })
    expect(calls.userCalls()).toBe(1)
    expect(calls.accountCalls()).toBe(1)
  })

  it('maps malformed credentials to invalid_token', async () => {
    mockIdentity({
      user: () => HttpResponse.json(cfError([], null), { status: 400 }),
      accounts: () => HttpResponse.json(cfError([], null), { status: 400 })
    })

    const error = await expectExternalTokenError(
      resolveCloudflareToken(resolverInput('malformed-token')),
      'invalid_token',
      401
    )
    expect(error.description).toContain('appears malformed')
  })

  it('preserves rate-limit backoff', async () => {
    mockIdentity({
      user: () =>
        HttpResponse.json(cfError([], null), {
          status: 429,
          headers: { 'Retry-After': '17' }
        }),
      accounts: () => HttpResponse.json(cfError([], null), { status: 429 })
    })

    const error = await expectExternalTokenError(
      resolveCloudflareToken(resolverInput('cfoat_rate-limited-token')),
      'temporarily_unavailable',
      429
    )
    expect(error.headers).toEqual({ 'Retry-After': '17' })
  })

  it('maps upstream failures to server_error', async () => {
    mockIdentity({
      user: () => HttpResponse.json(cfError([], null), { status: 502 }),
      accounts: () => HttpResponse.json(cfError([], null), { status: 401 })
    })

    await expectExternalTokenError(
      resolveCloudflareToken(resolverInput('legacy-upstream-failure')),
      'server_error',
      502
    )
  })
})

describe('external token resource responses', () => {
  it('lets the provider construct the RFC 6750/9728 invalid-token response', async () => {
    mockIdentity({
      user: () => HttpResponse.json(cfError([], null), { status: 400 }),
      accounts: () => HttpResponse.json(cfError([], null), { status: 400 })
    })

    const response = await exports.default.fetch(
      modernMcpRequest('malformed-provider-token', 'server/discover')
    )

    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"')
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${new URL(MCP_URL).origin}/.well-known/oauth-protected-resource/mcp"`
    )
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_token',
      error_description: 'Access token appears malformed; reauthenticate and try again'
    })
  })

  it('lets the provider construct an insufficient-scope challenge', async () => {
    mockIdentity({
      user: () => HttpResponse.json(cfError([], null), { status: 403 }),
      accounts: () => HttpResponse.json(cfAccountsSuccess([ACCOUNT]))
    })

    const response = await exports.default.fetch(
      modernMcpRequest('cfut_provider-insufficient-scope', 'server/discover')
    )

    expect(response.status).toBe(403)
    expect(response.headers.get('www-authenticate')).toContain('error="insufficient_scope"')
    expect(response.headers.get('www-authenticate')).toContain('scope="user:read account:read"')
    await expect(response.json()).resolves.toEqual({
      error: 'insufficient_scope',
      error_description: 'Token lacks required user:read or account:read scope'
    })
  })

  it('lets the provider preserve a retryable rate-limit response', async () => {
    mockIdentity({
      user: () =>
        HttpResponse.json(cfError([], null), {
          status: 429,
          headers: { 'Retry-After': '23' }
        }),
      accounts: () => HttpResponse.json(cfError([], null), { status: 429 })
    })

    const response = await exports.default.fetch(
      modernMcpRequest('cfoat_provider-rate-limit', 'server/discover')
    )

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('23')
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Rate limited, try again later'
    })
  })
})
