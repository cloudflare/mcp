import { describe, expect, it } from 'vitest'

import { REQUIRED_SCOPES, SCOPE_DEFINITIONS, SCOPE_TEMPLATES } from '../../src/auth/scopes'
import {
  renderApprovalDialog,
  renderErrorPage,
  type ApprovalDialogOptions
} from '../../src/auth/workers-oauth-utils'

function renderResponse(options: Partial<ApprovalDialogOptions> = {}): Response {
  return renderApprovalDialog(new Request('https://mcp.cloudflare.com/authorize'), {
    consent: {
      clientId: 'opaque-client-id',
      clientName: 'Test client',
      redirectUri: 'https://callback.example/oauth/callback',
      redirectHost: 'callback.example',
      redirectIsLoopback: false,
      scope: []
    },
    server: { name: 'Cloudflare API MCP' },
    handle: 'test-consent-handle',
    headers: new Headers({ 'Set-Cookie': '__Host-oauth-consent-0123456789abcdef=test' }),
    scopeTemplates: {},
    scopeDefinitions: {},
    requiredScopes: [],
    initialScopes: [],
    ...options
  })
}

function render(options: Partial<ApprovalDialogOptions> = {}): Promise<string> {
  return renderResponse(options).text()
}

function consentRedirectingTo(redirectUri: string): ApprovalDialogOptions['consent'] {
  const { hostname } = new URL(redirectUri)
  return {
    clientId: 'opaque-client-id',
    clientName: 'Test client',
    redirectUri,
    redirectHost: hostname,
    redirectIsLoopback: hostname !== 'callback.example',
    scope: []
  }
}

/** The nonce a page's policy lets scripts run with. */
function policyNonce(policy: string | null): string {
  const nonce = policy?.match(/script-src 'nonce-([^']+)'/)?.[1]
  if (!nonce) throw new Error(`No script nonce in the policy: ${policy}`)
  return nonce
}

/**
 * Every script and style tag carries the nonce, and no tag relies on what a nonce can't allow:
 * inline event handlers, `javascript:` URLs and style attributes. Tags built by the page's
 * script sit inside it as strings, so they are checked too.
 */
function expectOnlyNoncedInlineCode(body: string, nonce: string): void {
  const tags = body.match(/<[a-z][^>]*>/gi) ?? []
  const code = tags.filter((tag) => /^<(script|style)\b/i.test(tag))
  expect(code.length).toBeGreaterThan(0)
  for (const tag of code) expect(tag).toContain(`nonce="${nonce}"`)
  for (const tag of tags) {
    expect(tag).not.toMatch(/\son[a-z]+\s*=|javascript:|\sstyle\s*=/i)
  }
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

describe('OAuth page colour scheme', () => {
  // Cloudflare's authorization screen, which follows the consent page, is always light.
  it('renders the consent page in light mode regardless of the system preference', async () => {
    const body = await render()
    expect(body).toContain('color-scheme: light;')
    expect(body).not.toContain('color-scheme: light dark')
  })

  it('renders the error page in light mode regardless of the system preference', async () => {
    const body = await renderErrorPage('Server Error', 'Try again.').text()
    expect(body).toContain('color-scheme: light;')
    expect(body).not.toContain('color-scheme: light dark')
  })
})

describe('OAuth approval dialog identity details', () => {
  it('posts back only the consent handle, escaped, with an Allow and a Deny', async () => {
    const body = await render({ handle: 'handle"><script>' })
    expect(body).toContain('name="handle" value="handle&quot;&gt;&lt;script&gt;"')
    expect(body).not.toContain('name="state"')
    expect(body).not.toContain('name="csrf_token"')
    expect(body).toContain('name="decision" value="deny"')
    expect(body).toContain('name="decision" value="approve"')
  })

  it('shows the full CIMD client ID and redirect URLs without credentials', async () => {
    const body = await render({
      consent: {
        clientId: 'https://identity.example/oauth/client.json?sensitive=client-query',
        clientDomain: 'identity.example',
        clientName: 'CIMD client',
        redirectUri: 'https://user@callback.example:8443/oauth/callback?sensitive=redirect-query',
        redirectHost: 'callback.example',
        redirectIsLoopback: false,
        scope: []
      }
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

  it('does not present a registered client ID as a trusted identity', async () => {
    // describeConsent() sets clientDomain only for a Client ID Metadata Document client.
    const body = await render({
      consent: {
        clientId: 'http://untrusted.example/client.json',
        clientName: '<img src=x onerror=alert(1)>',
        redirectUri: 'https://callback.example/oauth/callback',
        redirectHost: 'callback.example',
        redirectIsLoopback: false,
        scope: []
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
      consent: {
        clientId: 'https://client.example/oauth/client.json',
        clientDomain: 'client.example',
        clientName: 'Native client',
        redirectUri: 'http://localhost:3210/callback',
        redirectHost: 'localhost',
        redirectIsLoopback: true,
        scope: []
      }
    })

    const text = visibleText(body)
    expect(text).toContain('Redirect URI http://localhost:3210/callback')
    expect(text).toContain(
      'Local redirect: this client will receive the authorization code on this device.'
    )
  })
})

describe('OAuth page Content-Security-Policy', () => {
  it('runs only the script and styles the consent page ships', async () => {
    const response = renderResponse()
    const policy = response.headers.get('Content-Security-Policy')
    const nonce = policyNonce(policy)

    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain(`style-src 'nonce-${nonce}' https://fonts.googleapis.com`)
    expect(policy).toContain('font-src https://fonts.gstatic.com')
    expect(policy).toContain("base-uri 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).not.toContain('unsafe-inline')
    expectOnlyNoncedInlineCode(await response.text(), nonce)
    // beginConsent()'s binding cookie survives the new policy.
    expect(response.headers.get('Set-Cookie')).toContain('__Host-oauth-consent-')
  })

  it('uses a fresh nonce for every page', () => {
    const first = policyNonce(renderResponse().headers.get('Content-Security-Policy'))
    const second = policyNonce(renderResponse().headers.get('Content-Security-Policy'))
    expect(first).not.toBe(second)
  })

  it('gives every client the same policy, with no form-action to stop Continue or Cancel redirecting', () => {
    // Chrome applies form-action to the redirect after a submission: to Cloudflare on Continue,
    // to the client on Cancel. CSP can't name an IPv6 literal, and the client picks its origin.
    const policies = [
      'https://callback.example/oauth/callback',
      'http://127.0.0.1:6274/oauth/callback',
      'http://[::1]:6274/oauth/callback'
    ].map((redirectUri) =>
      renderResponse({ consent: consentRedirectingTo(redirectUri) })
        .headers.get('Content-Security-Policy')
        ?.replaceAll(/'nonce-[^']+'/g, "'nonce'")
    )

    expect(new Set(policies).size).toBe(1)
    expect(policies[0]).not.toContain('form-action')
  })

  it('escapes the client name in the title bar', async () => {
    const body = await render({
      consent: {
        ...consentRedirectingTo('https://callback.example/cb'),
        clientName: '</title><b>x'
      }
    })

    expect(body).toContain('<title>Authorize &lt;/title&gt;&lt;b&gt;x | Cloudflare</title>')
  })

  it('runs only the script and styles the error page ships', async () => {
    const response = renderErrorPage('Server Error', 'Try again.')
    const policy = response.headers.get('Content-Security-Policy')
    const nonce = policyNonce(policy)

    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("form-action 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).not.toContain('unsafe-inline')
    const body = await response.text()
    expectOnlyNoncedInlineCode(body, nonce)
    expect(body).toContain('id="closeWindow"')
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
