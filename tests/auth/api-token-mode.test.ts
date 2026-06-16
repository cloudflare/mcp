import { env } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  isDirectApiToken,
  extractBearerToken,
  buildAuthProps,
  handleApiTokenRequest
} from '../../src/auth/api-token-mode'
import { AUTH_PROPS_VERSION } from '../../src/auth/types'
import { API_BASE, cfAccountsSuccess, cfError, cfSuccess } from '../helpers/cloudflare-api'
import { clearKv } from '../helpers/kv'
import { server } from '../setup/msw'

/**
 * Helper to create a mock Request with given Authorization header
 */
function mockRequest(authHeader?: string): Request {
  const headers = new Headers()
  if (authHeader) {
    headers.set('Authorization', authHeader)
  }
  return new Request('https://example.com', { headers })
}

afterEach(() => clearKv(env.OAUTH_KV))

describe('isDirectApiToken', () => {
  it('should return false for requests without Authorization header', () => {
    const request = mockRequest()
    expect(isDirectApiToken(request)).toBe(false)
  })

  it('should return false for non-Bearer auth schemes', () => {
    const request = mockRequest('Basic dXNlcjpwYXNz')
    expect(isDirectApiToken(request)).toBe(false)
  })

  it('should return false for OAuth tokens (3 colon-separated parts)', () => {
    // OAuth tokens from workers-oauth-provider have format: userId:grantId:secret
    const request = mockRequest('Bearer user123:grant456:secretabc')
    expect(isDirectApiToken(request)).toBe(false)
  })

  it('should return true for Cloudflare API tokens (no colons)', () => {
    // Cloudflare API tokens are typically long alphanumeric strings
    const request = mockRequest('Bearer abcdef1234567890abcdef1234567890')
    expect(isDirectApiToken(request)).toBe(true)
  })

  it('should return true for tokens with 1 colon (not OAuth format)', () => {
    const request = mockRequest('Bearer part1:part2')
    expect(isDirectApiToken(request)).toBe(true)
  })

  it('should return true for tokens with 4+ colons (not OAuth format)', () => {
    const request = mockRequest('Bearer a:b:c:d:e')
    expect(isDirectApiToken(request)).toBe(true)
  })
})

describe('extractBearerToken', () => {
  it('should return null for requests without Authorization header', () => {
    const request = mockRequest()
    expect(extractBearerToken(request)).toBeNull()
  })

  it('should return null for non-Bearer auth schemes', () => {
    const request = mockRequest('Basic dXNlcjpwYXNz')
    expect(extractBearerToken(request)).toBeNull()
  })

  it('should extract token from valid Bearer header', () => {
    const request = mockRequest('Bearer my-secret-token')
    expect(extractBearerToken(request)).toBe('my-secret-token')
  })

  it('should handle tokens with special characters', () => {
    const request = mockRequest('Bearer abc:def:ghi')
    expect(extractBearerToken(request)).toBe('abc:def:ghi')
  })

  it('should handle tokens with spaces after Bearer', () => {
    // "Bearer  token" - double space, should return " token"
    const request = mockRequest('Bearer  token-with-leading-space')
    expect(extractBearerToken(request)).toBe(' token-with-leading-space')
  })
})

describe('buildAuthProps', () => {
  const mockToken = 'test-token-123'
  const mockUser = { id: 'user-1', email: 'test@example.com' }
  const mockAccounts = [
    { id: 'acc-1', name: 'Account One' },
    { id: 'acc-2', name: 'Account Two' }
  ]

  it('should build user_token props when user is provided', () => {
    const props = buildAuthProps(mockToken, mockUser, mockAccounts)

    expect(props).toEqual({
      type: 'user_token',
      accessToken: mockToken,
      user: mockUser,
      accounts: mockAccounts,
      accountCount: undefined,
      version: AUTH_PROPS_VERSION
    })
  })

  it('should build user_token props with empty accounts if not provided', () => {
    const props = buildAuthProps(mockToken, mockUser)

    expect(props).toEqual({
      type: 'user_token',
      accessToken: mockToken,
      user: mockUser,
      accounts: [],
      accountCount: undefined,
      version: AUTH_PROPS_VERSION
    })
  })

  it('should build account_token props when no user but has accounts', () => {
    const props = buildAuthProps(mockToken, null, mockAccounts)

    expect(props).toEqual({
      type: 'account_token',
      accessToken: mockToken,
      account: mockAccounts[0] // Uses first account
    })
  })

  it('should throw error when no user and no accounts', () => {
    expect(() => buildAuthProps(mockToken, null, [])).toThrow(
      'Cannot build auth props: no user or account information'
    )
  })

  it('should throw error when no user and accounts undefined', () => {
    expect(() => buildAuthProps(mockToken, null, undefined)).toThrow(
      'Cannot build auth props: no user or account information'
    )
  })

  it('should treat undefined user same as null', () => {
    const props = buildAuthProps(mockToken, undefined, mockAccounts)

    expect(props.type).toBe('account_token')
  })
})

describe('handleApiTokenRequest identity probe caching', () => {
  const token = 'api-token-123'
  const tokenHash = '9bdb81d121b42d1c7819c816fa3cfbb6ee109726f9ed2475edb169374881d7b3'
  const cacheKey = `api-token-identity:v2:${tokenHash}`
  const user = { id: 'user-1', email: 'test@example.com' }
  const accounts = [{ id: 'acc-1', name: 'Account One' }]

  // Count upstream identity probes so we can assert cache hits/misses without
  // mocking our own getUserAndAccounts — the REAL function runs against MSW.
  function mockUserProbe(): () => number {
    let calls = 0
    server.use(
      http.get(`${API_BASE}/user`, () => {
        calls++
        return HttpResponse.json(cfSuccess(user))
      }),
      http.get(`${API_BASE}/accounts`, () => HttpResponse.json(cfAccountsSuccess(accounts)))
    )
    return () => calls
  }

  it('stores API token identity lookups in KV by token hash', async () => {
    const probeCalls = mockUserProbe()
    const createMcpResponse = vi.fn().mockResolvedValue(new Response('ok'))

    await handleApiTokenRequest(mockRequest(`Bearer ${token}`), createMcpResponse)

    // The real probe ran once and the identity was written to real KV.
    expect(probeCalls()).toBe(1)
    expect(await env.OAUTH_KV.get(cacheKey, 'json')).toEqual({ user, accounts })
    expect(createMcpResponse).toHaveBeenCalledWith(buildAuthProps(token, user, accounts))
  })

  it('uses cached API token identity from KV without probing upstream', async () => {
    // Seed the real cache; any upstream /user hit would throw (unhandled).
    await env.OAUTH_KV.put(cacheKey, JSON.stringify({ user, accounts }))
    let probed = false
    server.use(
      http.get(`${API_BASE}/user`, () => {
        probed = true
        return HttpResponse.json(cfError([], null))
      })
    )
    const createMcpResponse = vi.fn().mockResolvedValue(new Response('ok'))

    await handleApiTokenRequest(mockRequest(`Bearer ${token}`), createMcpResponse)

    expect(probed).toBe(false)
    expect(createMcpResponse).toHaveBeenCalledWith(buildAuthProps(token, user, accounts))
  })
})
