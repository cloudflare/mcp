import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { emailAllowed, selectTenant } from '../../src/auth/ema/provider-options'
import type { EmaTenant } from '../../src/auth/ema/tenant-store'
import { API_BASE, cfAccountsSuccess, cfSuccess } from '../helpers/cloudflare-api'
import { clearKv } from '../helpers/kv'
import { mcpToolCallRequest, MCP_URL, parseMcpResult, toolText } from '../helpers/mcp'
import { server } from '../setup/msw'

/**
 * Enterprise-Managed Authorization through the real Worker: an admin registers an IdP at /ema,
 * a client redeems an ID-JAG at /token, and the resulting MCP token runs tools with the admin's
 * account token. Only outbound fetch (Cloudflare API, IdP metadata and JWKS) is mocked.
 */

const ORIGIN = 'https://mcp.cloudflare.com'
const IDP = 'https://idp.example.com'
const ACCOUNT_ID = '0000000000000000000000000000ea01'
const ACCOUNT_TOKEN = 'cfat_ema-admin-account-token'
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

let signingKey: CryptoKey
// One IdP key for the file: the provider caches the IdP's JWKS per isolate and refetches at most
// every 30 seconds, so a key per test would outrun it.
const keyId = 'idp-key'
let publicJwk: JsonWebKey

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function json64(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)))
}

async function signIdJag(claims: Record<string, unknown>): Promise<string> {
  const input = `${json64({ alg: 'RS256', typ: 'oauth-id-jag+jwt', kid: keyId })}.${json64(claims)}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKey,
    new TextEncoder().encode(input)
  )
  return `${input}.${base64Url(new Uint8Array(signature))}`
}

function idJagClaims(clientId: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: IDP,
    sub: 'employee-42',
    email: 'ada@example.com',
    aud: ORIGIN,
    resource: MCP_URL,
    client_id: clientId,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + 300,
    ...overrides
  }
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair
  signingKey = pair.privateKey
  publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
})

beforeEach(() => {
  server.use(
    // The admin's account token proves which account it belongs to.
    http.get(`${API_BASE}/accounts`, ({ request }) =>
      request.headers.get('Authorization') === `Bearer ${ACCOUNT_TOKEN}`
        ? HttpResponse.json(cfAccountsSuccess([{ id: ACCOUNT_ID, name: 'Acme' }]))
        : HttpResponse.json(
            { success: false, errors: [{ code: 10000, message: 'no' }] },
            { status: 403 }
          )
    ),
    // The IdP publishes OIDC discovery only, like Okta's playground.
    http.get(
      `${IDP}/.well-known/oauth-authorization-server`,
      () => new HttpResponse(null, { status: 404 })
    ),
    http.get(`${IDP}/.well-known/openid-configuration`, () =>
      HttpResponse.json({ issuer: IDP, jwks_uri: `${IDP}/jwks` })
    ),
    http.get(`${IDP}/jwks`, () =>
      HttpResponse.json({ keys: [{ ...publicJwk, kid: keyId, alg: 'RS256', use: 'sig' }] })
    )
  )
})

afterEach(() => clearKv(env.OAUTH_KV))

function form(path: string, fields: Record<string, string>): Promise<Response> {
  return exports.default.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString()
    })
  )
}

/** Register the IdP and return the tenant client the page shows once. */
async function register(fields: Record<string, string> = {}) {
  const response = await form('/ema/register', {
    account_token: ACCOUNT_TOKEN,
    issuer: IDP,
    ...fields
  })
  const html = await response.text()
  expect(response.status, html).toBe(200)
  const value = (label: string) =>
    html.match(new RegExp(`<th>${label}</th><td><code>([^<]+)</code>`))?.[1] ?? ''
  return { clientId: value('Client ID'), clientSecret: value('Client secret'), html }
}

function redeem(client: { clientId: string; clientSecret: string }, assertion: string) {
  return exports.default.fetch(
    new Request(`${ORIGIN}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: JWT_BEARER,
        assertion,
        client_id: client.clientId,
        client_secret: client.clientSecret
      }).toString()
    })
  )
}

describe('Enterprise-Managed Authorization', () => {
  it('advertises the jwt-bearer grant and the ID-JAG profile', async () => {
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`)
    )
    const metadata = await response.json<Record<string, unknown>>()
    expect(metadata.grant_types_supported).toContain(JWT_BEARER)
    expect(metadata.authorization_grant_profiles_supported).toEqual([
      'urn:ietf:params:oauth:grant-profile:id-jag'
    ])
  })

  it('serves the admin page', async () => {
    const response = await exports.default.fetch(new Request(`${ORIGIN}/ema`))
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('Register your identity provider')
    expect(html).toContain(MCP_URL)
  })

  it('registers an IdP, redeems an ID-JAG, and runs tools with the account token', async () => {
    const client = await register()
    expect(client.clientId).not.toBe('')
    expect(client.html).toContain(`${IDP}/jwks`)
    expect(client.html).toContain(ACCOUNT_ID)
    // The account token is stored encrypted, never in the clear.
    const stored = await env.OAUTH_KV.get(`ema-tenant:${ACCOUNT_ID}`)
    expect(stored).not.toContain(ACCOUNT_TOKEN)

    const tokenResponse = await redeem(client, await signIdJag(idJagClaims(client.clientId)))
    const tokens = await tokenResponse.json<Record<string, unknown>>()
    expect(tokenResponse.status, JSON.stringify(tokens)).toBe(200)
    expect(tokens.refresh_token).toBeUndefined()
    expect(tokens.resource).toBe(MCP_URL)

    let forwardedAuthorization: string | null = null
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/tokens/verify`, ({ request }) => {
        forwardedAuthorization = request.headers.get('Authorization')
        return HttpResponse.json(cfSuccess({ id: 'token-1', status: 'active' }))
      })
    )
    const result = await parseMcpResult(
      await exports.default.fetch(
        mcpToolCallRequest(tokens.access_token as string, 'execute', {
          code: `async () => cloudflare.request({ method: "GET", path: "/accounts/${ACCOUNT_ID}/tokens/verify" })`
        })
      )
    )
    expect(result.result?.isError).toBeFalsy()
    expect(toolText(result)).toContain('token-1')
    expect(forwardedAuthorization).toBe(`Bearer ${ACCOUNT_TOKEN}`)
  })

  it('refuses a replayed ID-JAG', async () => {
    const client = await register()
    const assertion = await signIdJag(idJagClaims(client.clientId))
    expect((await redeem(client, assertion)).status).toBe(200)

    const replay = await redeem(client, assertion)
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toMatchObject({ error: 'invalid_grant' })
  })

  it('refuses an email outside the allowed domains', async () => {
    const client = await register({ email_domains: 'acme.com' })

    const response = await redeem(client, await signIdJag(idJagClaims(client.clientId)))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_grant' })
  })

  it('refuses an ID-JAG from an issuer no tenant trusts', async () => {
    const client = await register()

    const response = await redeem(
      client,
      await signIdJag(idJagClaims(client.clientId, { iss: 'https://evil.example.com' }))
    )
    expect(response.status).toBe(400)
  })

  it('refuses a user API token at registration', async () => {
    server.use(
      http.get(`${API_BASE}/user`, () =>
        HttpResponse.json(cfSuccess({ id: 'user-1', email: 'admin@acme.com' }))
      ),
      http.get(`${API_BASE}/accounts`, () =>
        HttpResponse.json(cfAccountsSuccess([{ id: ACCOUNT_ID, name: 'Acme' }]))
      )
    )

    const response = await form('/ema/register', { account_token: 'cfut_user-token', issuer: IDP })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('That is a user token')
  })

  it('disabling the tenant revokes issued tokens and refuses new ID-JAGs', async () => {
    const client = await register()
    const tokenResponse = await redeem(client, await signIdJag(idJagClaims(client.clientId)))
    const { access_token } = await tokenResponse.json<{ access_token: string }>()

    const disabled = await form('/ema/manage', { account_token: ACCOUNT_TOKEN, action: 'disable' })
    expect(await disabled.text()).toContain('1 active grant was revoked')

    const call = await exports.default.fetch(
      mcpToolCallRequest(access_token, 'search', { code: '1' })
    )
    expect(call.status).toBe(401)

    const again = await redeem(client, await signIdJag(idJagClaims(client.clientId)))
    expect(again.status).toBe(400)
  })
})

describe('tenant selection', () => {
  const tenant = (accountId: string, clientIds: string[], emailDomains: string[] = []) =>
    ({
      account: { id: accountId, name: accountId },
      clientIds,
      emailDomains
    }) as unknown as EmaTenant

  it('picks the tenant whose client redeemed the ID-JAG', () => {
    const tenants = [tenant('a', ['client-a', 'claude']), tenant('b', ['client-b', 'claude'])]
    expect(selectTenant(tenants, {}, 'client-b')).toBe(tenants[1])
  })

  it('needs aud_tenant to tell tenants apart for a shared client', () => {
    const tenants = [tenant('a', ['claude']), tenant('b', ['claude'])]
    expect(selectTenant(tenants, {}, 'claude')).toBe('ambiguous_tenant')
    expect(selectTenant(tenants, { aud_tenant: 'a' }, 'claude')).toBe(tenants[0])
    expect(selectTenant(tenants, { aud_tenant: 'c' }, 'claude')).toBe('no_tenant')
  })

  it('refuses a client no tenant allows', () => {
    expect(selectTenant([tenant('a', ['client-a'])], {}, 'other')).toBe('no_tenant')
  })

  it('checks email domains case-insensitively, only when configured', () => {
    expect(emailAllowed(tenant('a', [], []), undefined)).toBe(true)
    expect(emailAllowed(tenant('a', [], ['acme.com']), 'ada@ACME.com')).toBe(true)
    expect(emailAllowed(tenant('a', [], ['acme.com']), 'ada@evil.com')).toBe(false)
    expect(emailAllowed(tenant('a', [], ['acme.com']), undefined)).toBe(false)
  })
})

describe('extra allowed origins', () => {
  it('parses the deployment list, trimmed and lowercased', async () => {
    const { extraAllowedOrigins } = await import('../../src/mcp-handler')
    expect(extraAllowedOrigins(undefined)).toEqual([])
    expect(extraAllowedOrigins(' XAA.dev , example.com,')).toEqual(['xaa.dev', 'example.com'])
  })
})
