import { describe, it, expect } from 'vitest'
import { isDirectApiToken, extractBearerToken, buildAuthProps } from './api-token-mode'

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
