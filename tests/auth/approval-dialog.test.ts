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

/** Page text as a person reads it: no tags, scripts or styles, whitespace collapsed. */
function visibleText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
}

describe('OAuth approval dialog identity details', () => {
  it('shows the full CIMD client ID and redirect URLs without credentials', async () => {
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

    const text = visibleText(body)
    expect(text).toContain(
      'Client ID https://identity.example/oauth/client.json?sensitive=client-query'
    )
    expect(text).toContain(
      'Redirect URI https://callback.example:8443/oauth/callback?sensitive=redirect-query'
    )
    expect(text).not.toContain('Local redirect:')
    expect(body).not.toContain('user@')
  })

  it('does not present an opaque or non-HTTPS client ID as a trusted identity', async () => {
    const body = await render({
      client: {
        clientId: 'http://untrusted.example/client.json',
        clientName: '<img src=x onerror=alert(1)>',
        redirectUris: ['https://callback.example/oauth/callback'],
        tokenEndpointAuthMethod: 'none'
      }
    })

    const text = visibleText(body)
    expect(text).not.toContain('Client ID')
    expect(body).not.toContain('untrusted.example')
    expect(body).not.toContain('<img src=x onerror=alert(1)>')
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(text).toContain('Redirect URI https://callback.example/oauth/callback')
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

    const text = visibleText(body)
    expect(text).toContain('Redirect URI http://localhost:3210/callback')
    expect(text).toContain(
      'Local redirect: this client will receive the authorization code on this device.'
    )
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
