import { describe, it, expect } from 'vitest'
import {
  isDirectApiToken,
  extractBearerToken,
  buildAuthProps,
  isGlobalApiKey
} from '../../auth/api-token-mode'
import { buildCloudflareAuthHeaders } from '../../auth/oauth-handler'

/**
 * Helper to create a mock Request with given headers
 */
function mockRequest(authHeader?: string, extraHeaders?: Record<string, string>): Request {
  const headers = new Headers()
  if (authHeader) {
    headers.set('Authorization', authHeader)
  }
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      headers.set(key, value)
    }
  }
  return new Request('https://example.com', { headers })
}

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
      accounts: mockAccounts
    })
  })

  it('should build user_token props with empty accounts if not provided', () => {
    const props = buildAuthProps(mockToken, mockUser)

    expect(props).toEqual({
      type: 'user_token',
      accessToken: mockToken,
      user: mockUser,
      accounts: []
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

describe('isGlobalApiKey', () => {
  it('should return true when both X-Auth-Email and X-Auth-Key are present', () => {
    const request = mockRequest(undefined, {
      'X-Auth-Email': 'user@example.com',
      'X-Auth-Key': 'global-api-key-123'
    })
    expect(isGlobalApiKey(request)).toBe(true)
  })

  it('should return false when only X-Auth-Email is present', () => {
    const request = mockRequest(undefined, { 'X-Auth-Email': 'user@example.com' })
    expect(isGlobalApiKey(request)).toBe(false)
  })

  it('should return false when only X-Auth-Key is present', () => {
    const request = mockRequest(undefined, { 'X-Auth-Key': 'global-api-key-123' })
    expect(isGlobalApiKey(request)).toBe(false)
  })

  it('should return false when neither header is present', () => {
    const request = mockRequest()
    expect(isGlobalApiKey(request)).toBe(false)
  })

  it('should return true even when Authorization header is also present', () => {
    const request = mockRequest('Bearer some-token', {
      'X-Auth-Email': 'user@example.com',
      'X-Auth-Key': 'global-api-key-123'
    })
    expect(isGlobalApiKey(request)).toBe(true)
  })
})

describe('buildCloudflareAuthHeaders', () => {
  it('should return Bearer header for bearer auth', () => {
    const headers = buildCloudflareAuthHeaders({ type: 'bearer', token: 'my-token' })

    expect(headers).toEqual({ Authorization: 'Bearer my-token' })
  })

  it('should return X-Auth-Email and X-Auth-Key for global_api_key auth', () => {
    const headers = buildCloudflareAuthHeaders({
      type: 'global_api_key',
      email: 'user@example.com',
      apiKey: 'key-123'
    })

    expect(headers).toEqual({
      'X-Auth-Email': 'user@example.com',
      'X-Auth-Key': 'key-123'
    })
  })
})
