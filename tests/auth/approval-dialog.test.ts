import { describe, expect, it } from 'vitest'

import { REQUIRED_SCOPES, SCOPE_DEFINITIONS, SCOPE_TEMPLATES } from '../../src/auth/scopes'
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
    requiredScopes: [],
    initialScopes: [],
    ...options
  })

  return response.text()
}

/**
 * Text inside `<main>` as a person reads it, with whitespace collapsed. The
 * page's script and styles sit outside `<main>`, so skipping everything
 * between `<` and `>` leaves only the visible text.
 */
function visibleText(html: string): string {
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'))
  let text = ''
  let inTag = false
  for (const char of main) {
    if (char === '<') inTag = true
    else if (char === '>') inTag = false
    else if (!inTag) text += char
  }
  return text.replace(/\s+/g, ' ')
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

describe('OAuth approval dialog templates', () => {
  const templates = {
    scopeTemplates: SCOPE_TEMPLATES,
    scopeDefinitions: SCOPE_DEFINITIONS,
    requiredScopes: REQUIRED_SCOPES
  }

  it('lists the scopes a client asked for when they match no template', async () => {
    const body = await render({
      ...templates,
      initialScopes: ['zone.write', 'dns.read', ...REQUIRED_SCOPES]
    })

    const text = visibleText(body)
    expect(text).toContain('This client asked for:')
    expect(text).toContain('Zone Write')
    expect(text).toContain('DNS Read')
    // Identity scopes are part of every template, so they are not listed.
    expect(text).not.toContain('User Read')
    expect(body).toContain('const INITIAL_TEMPLATE = "__requested__";')
  })

  it('preselects a matching template without listing requested scopes', async () => {
    const body = await render({
      ...templates,
      initialScopes: [...SCOPE_TEMPLATES['read-only'].scopes, ...REQUIRED_SCOPES]
    })

    expect(visibleText(body)).not.toContain('This client asked for')
    expect(body).toContain('const INITIAL_TEMPLATE = "read-only";')
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
