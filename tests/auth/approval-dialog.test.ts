import { describe, expect, it } from 'vitest'

import {
  isAllowedOAuthRedirectUri,
  renderApprovalDialog,
  type ApprovalDialogOptions
} from '../../src/auth/workers-oauth-utils'

function render(options: Partial<ApprovalDialogOptions> = {}): Promise<string> {
  const response = renderApprovalDialog(new Request('https://mcp.cloudflare.com/authorize'), {
    client: {
      clientId: 'opaque-client-id',
      clientName: 'Test client',
      redirectUris: ['https://callback.example/oauth/callback'],
      tokenEndpointAuthMethod: 'none'
    },
    redirectUri: 'https://callback.example/oauth/callback',
    server: { name: 'Cloudflare API MCP' },
    state: {},
    csrfToken: 'test-csrf-token',
    setCookie: '__Host-CSRF_TOKEN=test-csrf-token',
    scopeTemplates: {},
    scopeDefinitions: {},
    defaultTemplate: '',
    requiredScopes: [],
    initialScopes: [],
    ...options
  })

  return response.text()
}

describe('OAuth approval dialog identity details', () => {
  it('shows parsed CIMD and redirect hostnames without exposing other URL components', async () => {
    const body = await render({
      client: {
        clientId: 'https://identity.example/oauth/client.json?sensitive=client-query',
        clientName: 'CIMD client',
        redirectUris: [
          'https://user@callback.example:8443/oauth/callback?sensitive=redirect-query'
        ],
        tokenEndpointAuthMethod: 'none'
      },
      redirectUri: 'https://user@callback.example:8443/oauth/callback?sensitive=redirect-query'
    })

    expect(body).toContain('Client ID hostname</span>')
    expect(body).toContain('>identity.example</strong>')
    expect(body).toContain('Redirect URI hostname</span>')
    expect(body).toContain('>callback.example</strong>')
    expect(body).not.toContain('client-query')
    expect(body).not.toContain('redirect-query')
    expect(body).not.toContain('user@')
    expect(body).not.toContain(':8443')
  })

  it('does not present an opaque or non-HTTPS client ID as a trusted hostname', async () => {
    const body = await render({
      client: {
        clientId: 'http://untrusted.example/client.json',
        clientName: '<img src=x onerror=alert(1)>',
        redirectUris: ['https://callback.example/oauth/callback'],
        tokenEndpointAuthMethod: 'none'
      }
    })

    expect(body).not.toContain('Client ID hostname</span>')
    expect(body).not.toContain('untrusted.example')
    expect(body).not.toContain('<img src=x onerror=alert(1)>')
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(body).toContain('>callback.example</strong>')
  })

  it('warns when a native client redirects to a loopback listener', async () => {
    const body = await render({
      client: {
        clientId: 'https://client.example/oauth/client.json',
        clientName: 'Native client',
        redirectUris: ['http://localhost:3210/callback'],
        tokenEndpointAuthMethod: 'none'
      },
      redirectUri: 'http://localhost:3210/callback'
    })

    expect(body).toContain('Local redirect:')
    expect(body).toContain('>localhost</strong>')
  })
})

describe('OAuth redirect URI policy', () => {
  it.each([
    'https://client.example/callback',
    'https://client.example:8443/callback?source=mcp',
    'http://localhost:3210/callback',
    'http://127.0.0.1:3210/callback',
    'http://127.255.255.255:3210/callback',
    'http://[::1]:3210/callback'
  ])('allows HTTPS and local loopback callbacks: %s', (redirectUri) => {
    expect(isAllowedOAuthRedirectUri(redirectUri)).toBe(true)
  })

  it.each([
    'http://client.example/callback',
    'http://localhost.example/callback',
    'ftp://client.example/callback',
    'com.example.app:/callback',
    '//client.example/callback',
    'https://user@client.example/callback',
    'https://client.example/callback#fragment',
    ' https://client.example/callback'
  ])('rejects non-HTTPS remote or ambiguous callbacks: %s', (redirectUri) => {
    expect(isAllowedOAuthRedirectUri(redirectUri)).toBe(false)
  })
})
