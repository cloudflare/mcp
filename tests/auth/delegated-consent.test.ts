import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  canonicalScopeString,
  DELEGATED_CONSENT_JWT_TYP,
  DELEGATED_CONSENT_OPT_IN_COOKIE,
  DELEGATED_CONSENT_QUERY_PARAM,
  evaluateDelegatedConsentRollout,
  resetDelegatedConsentKeyCache,
  resolveDelegatedDefaultTemplate
} from '../../src/auth/delegated-consent'
import type { DelegatedConsentClaims } from '../../src/auth/delegated-consent'
import { REQUIRED_SCOPES, SCOPE_TEMPLATES } from '../../src/auth/scopes'
import { cfAccountsSuccess, cfSuccess } from '../helpers/cloudflare-api'
import { clearKv } from '../helpers/kv'
import { server } from '../setup/msw'

const MCP_ORIGIN = 'https://mcp.cloudflare.com'
const MCP_RESOURCE = `${MCP_ORIGIN}/mcp`
const CIMD_CLIENT_ID = 'https://claude.ai/oauth/client.json'
const CIMD_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback'
const LOOPBACK_REDIRECT_URI = 'http://127.0.0.1:8787/oauth/callback'
const DOWNSTREAM_CODE_VERIFIER = 'test-downstream-code-verifier'
const DOWNSTREAM_CODE_CHALLENGE = 'I4fhllfHqqQsgap17V2SDI0scSei8H7U0e0rZBDIcbo'

interface TestKeyPair {
  privateJwkJson: string
  publicKey: CryptoKey
  kid: string
}

async function generateSigningKeyPair(kid = 'mcp-test-2026-11'): Promise<TestKeyPair> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair
  const privateJwk = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey
  return {
    privateJwkJson: JSON.stringify({ ...privateJwk, kid }),
    publicKey: keyPair.publicKey,
    kid
  }
}

function base64urlDecodeBytes(encoded: string): Uint8Array {
  const padded = encoded.replaceAll('-', '+').replaceAll('_', '/')
  const padLen = (4 - (padded.length % 4)) % 4
  const binary = atob(padded + '='.repeat(padLen))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function base64urlEncodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function sha256Base64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return base64urlEncodeBytes(new Uint8Array(digest))
}

async function verifyCompactJws(
  token: string,
  publicKey: CryptoKey
): Promise<{
  header: { alg: string; typ: string; kid: string }
  claims: DelegatedConsentClaims
}> {
  const parts = token.split('.')
  expect(parts).toHaveLength(3)
  const [headerB64, payloadB64, sigB64] = parts

  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    base64urlDecodeBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  )
  expect(valid).toBe(true)

  const header = JSON.parse(new TextDecoder().decode(base64urlDecodeBytes(headerB64))) as {
    alg: string
    typ: string
    kid: string
  }
  const claims = JSON.parse(
    new TextDecoder().decode(base64urlDecodeBytes(payloadB64))
  ) as DelegatedConsentClaims
  return { header, claims }
}

function cookiesFrom(response: Response): string {
  const values = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? '']
  return values
    .filter(Boolean)
    .map((value) => value.split(';')[0])
    .join('; ')
}

function mockCimdClient(): void {
  server.use(
    http.get(CIMD_CLIENT_ID, () =>
      HttpResponse.json({
        client_id: CIMD_CLIENT_ID,
        client_name: 'Claude',
        client_uri: 'https://claude.ai',
        logo_uri: 'https://claude.ai/logo.png',
        redirect_uris: [CIMD_REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      })
    )
  )
}

async function registerLoopbackClient(): Promise<string> {
  const res = await exports.default.fetch(
    new Request(`${MCP_ORIGIN}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Local MCP CLI',
        redirect_uris: [LOOPBACK_REDIRECT_URI],
        token_endpoint_auth_method: 'none'
      })
    })
  )
  expect(res.status).toBe(201)
  return ((await res.json()) as { client_id: string }).client_id
}

function authorizeUrl(params: Record<string, string>): string {
  const url = new URL(`${MCP_ORIGIN}/authorize`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('resource', MCP_RESOURCE)
  url.searchParams.set('code_challenge', DOWNSTREAM_CODE_CHALLENGE)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', 'downstream-state-123')
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  return url.href
}

const DEFAULT_ENV_OVERRIDES = {
  DELEGATED_CONSENT_MODE: 'off',
  DELEGATED_CONSENT_ROLLOUT_PERCENT: '0',
  DELEGATED_CONSENT_CLIENT_ALLOWLIST: '',
  DELEGATED_CONSENT_CLIENT_DENYLIST: '',
  DELEGATED_CONSENT_DEFAULT_SCOPES: 'full-access',
  DELEGATED_CONSENT_SIGNING_KEY: ''
}

beforeEach(() => {
  resetDelegatedConsentKeyCache()
  Object.assign(env, DEFAULT_ENV_OVERRIDES)
})

afterEach(async () => {
  Object.assign(env, DEFAULT_ENV_OVERRIDES)
  resetDelegatedConsentKeyCache()
  vi.restoreAllMocks()
  await clearKv(env.OAUTH_KV)
})

describe('delegated consent rollout gating', () => {
  const baseAuthReq = {
    responseType: 'code',
    clientId: CIMD_CLIENT_ID,
    redirectUri: CIMD_REDIRECT_URI,
    scope: ['user:read'],
    state: 'downstream-state',
    codeChallenge: DOWNSTREAM_CODE_CHALLENGE,
    codeChallengeMethod: 'S256'
  }
  const baseConsent = {
    clientId: CIMD_CLIENT_ID,
    clientName: 'Claude',
    clientDomain: 'claude.ai',
    redirectUri: CIMD_REDIRECT_URI,
    redirectHost: 'claude.ai',
    redirectIsLoopback: false,
    scope: ['user:read']
  }

  it('acts as a hard kill switch when DELEGATED_CONSENT_MODE=off', async () => {
    const req = new Request(`${MCP_ORIGIN}/authorize`, {
      headers: { Cookie: `${DELEGATED_CONSENT_OPT_IN_COOKIE}=1` }
    })
    const decision = await evaluateDelegatedConsentRollout(req, baseAuthReq, baseConsent, {
      DELEGATED_CONSENT_MODE: 'off',
      DELEGATED_CONSENT_CLIENT_ALLOWLIST: `domain:claude.ai,${CIMD_CLIENT_ID}`
    })
    expect(decision).toEqual({ enabled: false, reason: 'mode_off' })
  })

  it('supports opt-in via exact client_id, CIMD domain, and canary browser cookie', async () => {
    const plainReq = new Request(`${MCP_ORIGIN}/authorize`)
    expect(
      await evaluateDelegatedConsentRollout(plainReq, baseAuthReq, baseConsent, {
        DELEGATED_CONSENT_MODE: 'opt-in'
      })
    ).toEqual({ enabled: false, reason: 'opt_in_not_matched' })

    expect(
      await evaluateDelegatedConsentRollout(plainReq, baseAuthReq, baseConsent, {
        DELEGATED_CONSENT_MODE: 'opt-in',
        DELEGATED_CONSENT_CLIENT_ALLOWLIST: CIMD_CLIENT_ID
      })
    ).toEqual({ enabled: true, reason: 'allowlist' })

    expect(
      await evaluateDelegatedConsentRollout(plainReq, baseAuthReq, baseConsent, {
        DELEGATED_CONSENT_MODE: 'opt-in',
        DELEGATED_CONSENT_CLIENT_ALLOWLIST: 'domain:claude.ai'
      })
    ).toEqual({ enabled: true, reason: 'allowlist' })

    const cookieReq = new Request(`${MCP_ORIGIN}/authorize`, {
      headers: { Cookie: `${DELEGATED_CONSENT_OPT_IN_COOKIE}=1` }
    })
    expect(
      await evaluateDelegatedConsentRollout(cookieReq, baseAuthReq, baseConsent, {
        DELEGATED_CONSENT_MODE: 'opt-in'
      })
    ).toEqual({ enabled: true, reason: 'cookie_opt_in' })
  })

  it('enforces denylist and cookie opt-out above mode=on', async () => {
    const cookieOptInReq = new Request(`${MCP_ORIGIN}/authorize`, {
      headers: { Cookie: `${DELEGATED_CONSENT_OPT_IN_COOKIE}=1` }
    })
    expect(
      await evaluateDelegatedConsentRollout(cookieOptInReq, baseAuthReq, baseConsent, {
        DELEGATED_CONSENT_MODE: 'on',
        DELEGATED_CONSENT_CLIENT_DENYLIST: 'domain:claude.ai'
      })
    ).toEqual({ enabled: false, reason: 'denylist' })

    const cookieOptOutReq = new Request(`${MCP_ORIGIN}/authorize`, {
      headers: { Cookie: `${DELEGATED_CONSENT_OPT_IN_COOKIE}=0` }
    })
    expect(
      await evaluateDelegatedConsentRollout(cookieOptOutReq, baseAuthReq, baseConsent, {
        DELEGATED_CONSENT_MODE: 'on'
      })
    ).toEqual({ enabled: false, reason: 'cookie_opt_out' })
  })

  it('buckets percent rollouts deterministically by codeChallenge', async () => {
    const req = new Request(`${MCP_ORIGIN}/authorize`)
    let enabledCount = 0
    for (let i = 0; i < 100; i++) {
      const decision = await evaluateDelegatedConsentRollout(
        req,
        { ...baseAuthReq, codeChallenge: `challenge-${i}` },
        baseConsent,
        {
          DELEGATED_CONSENT_MODE: 'percent',
          DELEGATED_CONSENT_ROLLOUT_PERCENT: '50'
        }
      )
      if (decision.enabled) enabledCount++
    }
    expect(enabledCount).toBeGreaterThan(25)
    expect(enabledCount).toBeLessThan(75)
  })

  it('defaults DELEGATED_CONSENT_DEFAULT_SCOPES safely', () => {
    expect(resolveDelegatedDefaultTemplate(undefined)).toBe('full-access')
    expect(resolveDelegatedDefaultTemplate('read-only')).toBe('read-only')
    expect(resolveDelegatedDefaultTemplate('minimal')).toBe('minimal')
    expect(resolveDelegatedDefaultTemplate('unexpected')).toBe('full-access')
  })
})

describe('delegated consent end-to-end OAuth route behavior', () => {
  it('redirects CIMD clients directly to dash.cloudflare.com with a valid signed delegated_client JWS and Minimal initial_scopes', async () => {
    const keyPair = await generateSigningKeyPair('mcp-cimd-key-1')
    mockCimdClient()
    Object.assign(env, {
      DELEGATED_CONSENT_MODE: 'opt-in',
      DELEGATED_CONSENT_CLIENT_ALLOWLIST: 'domain:claude.ai',
      DELEGATED_CONSENT_DEFAULT_SCOPES: 'read-only',
      DELEGATED_CONSENT_SIGNING_KEY: keyPair.privateJwkJson
    })

    const res = await exports.default.fetch(
      new Request(
        authorizeUrl({
          client_id: CIMD_CLIENT_ID,
          redirect_uri: CIMD_REDIRECT_URI,
          scope: 'user:read'
        }),
        { redirect: 'manual' }
      )
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const upstreamCookie = cookiesFrom(res)
    expect(upstreamCookie).toContain('=')

    const location = new URL(res.headers.get('location')!)
    expect(location.origin).toBe('https://dash.cloudflare.com')
    expect(location.pathname).toBe('/oauth2/auth')
    expect(location.searchParams.get('client_id')).toBe('test-client-id')

    const upstreamState = location.searchParams.get('state')!
    const upstreamCodeChallenge = location.searchParams.get('code_challenge')!
    const upstreamScopes = location.searchParams.get('scope')!.split(' ')
    const delegatedToken = location.searchParams.get(DELEGATED_CONSENT_QUERY_PARAM)!
    expect(delegatedToken).toBeTruthy()
    expect(upstreamScopes).toEqual(
      Array.from(new Set([...SCOPE_TEMPLATES['read-only'].scopes, ...REQUIRED_SCOPES]))
    )

    const { header, claims } = await verifyCompactJws(delegatedToken, keyPair.publicKey)
    expect(header).toEqual({
      alg: 'ES256',
      typ: DELEGATED_CONSENT_JWT_TYP,
      kid: 'mcp-cimd-key-1'
    })
    expect(claims.iss).toBe('test-client-id')
    expect(claims.aud).toBe('https://dash.cloudflare.com/oauth/consent')
    expect(claims.exp - claims.iat).toBe(600)
    expect(claims.state_hash).toBe(await sha256Base64url(upstreamState))
    expect(claims.code_challenge).toBe(upstreamCodeChallenge)
    expect(claims.scope_hash).toBe(await sha256Base64url(canonicalScopeString(upstreamScopes)))
    expect(claims.client_id).toBe(CIMD_CLIENT_ID)
    expect(claims.client_name).toBe('Claude')
    expect(claims.client_domain).toBe('claude.ai')
    expect(claims.client_uri).toBe('https://claude.ai/')
    expect(claims.logo_uri).toBe('https://claude.ai/logo.png')
    expect(claims.redirect_uri).toBe(CIMD_REDIRECT_URI)
    expect(claims.redirect_host).toBe('claude.ai')
    expect(claims.redirect_is_loopback).toBe(false)
    expect(claims.required_scopes).toEqual([...REQUIRED_SCOPES])
    expect(claims.initial_scopes).toEqual([...SCOPE_TEMPLATES.minimal.scopes])

    // Complete /oauth/callback with narrowed Minimal scopes granted by dash.cloudflare.com.
    server.use(
      http.post('https://dash.cloudflare.com/oauth2/token', () =>
        HttpResponse.json({
          access_token: 'upstream-access-token',
          expires_in: 3600,
          refresh_token: 'upstream-refresh-token',
          scope: 'user:read account:read offline_access',
          token_type: 'bearer'
        })
      ),
      http.get('https://api.cloudflare.com/client/v4/user', () =>
        HttpResponse.json(cfSuccess({ id: 'user-1', email: 'user@example.com' }))
      ),
      http.get('https://api.cloudflare.com/client/v4/accounts', () =>
        HttpResponse.json(cfAccountsSuccess([{ id: 'acc-1', name: 'Account One' }]))
      )
    )

    const callbackRes = await exports.default.fetch(
      new Request(
        `${MCP_ORIGIN}/oauth/callback?code=hydra-code&state=${encodeURIComponent(upstreamState)}`,
        { headers: { Cookie: upstreamCookie }, redirect: 'manual' }
      )
    )
    expect(callbackRes.status).toBe(302)
    const clientRedirect = new URL(callbackRes.headers.get('location')!)
    expect(clientRedirect.origin + clientRedirect.pathname).toBe(CIMD_REDIRECT_URI)
    expect(clientRedirect.searchParams.get('state')).toBe('downstream-state-123')
    const mcpCode = clientRedirect.searchParams.get('code')!
    expect(mcpCode).toBeTruthy()

    // Exchange downstream code and confirm token scope matches narrowed Minimal grant, not full pool.
    const tokenRes = await exports.default.fetch(
      new Request(`${MCP_ORIGIN}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: mcpCode,
          client_id: CIMD_CLIENT_ID,
          redirect_uri: CIMD_REDIRECT_URI,
          code_verifier: DOWNSTREAM_CODE_VERIFIER,
          resource: MCP_RESOURCE
        }).toString()
      })
    )
    expect(tokenRes.status).toBe(200)
    const tokenBody = (await tokenRes.json()) as { scope: string }
    expect(tokenBody.scope.split(' ').sort()).toEqual([
      'account:read',
      'offline_access',
      'user:read'
    ])
  })

  it('marks local DCR loopback clients with redirect_is_loopback=true and omits client_domain', async () => {
    const keyPair = await generateSigningKeyPair('mcp-dcr-key-1')
    const dcrClientId = await registerLoopbackClient()
    Object.assign(env, {
      DELEGATED_CONSENT_MODE: 'opt-in',
      DELEGATED_CONSENT_SIGNING_KEY: keyPair.privateJwkJson
    })

    const res = await exports.default.fetch(
      new Request(
        authorizeUrl({
          client_id: dcrClientId,
          redirect_uri: LOOPBACK_REDIRECT_URI,
          scope: 'workers-scripts.write zone.read'
        }),
        {
          headers: { Cookie: `${DELEGATED_CONSENT_OPT_IN_COOKIE}=1` },
          redirect: 'manual'
        }
      )
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    const delegatedToken = location.searchParams.get(DELEGATED_CONSENT_QUERY_PARAM)!
    const { claims } = await verifyCompactJws(delegatedToken, keyPair.publicKey)

    expect(claims.client_id).toBe(dcrClientId)
    expect(claims.client_name).toBe('Local MCP CLI')
    expect(claims.client_domain).toBeUndefined()
    expect(claims.redirect_uri).toBe(LOOPBACK_REDIRECT_URI)
    expect(claims.redirect_host).toBe('127.0.0.1')
    expect(claims.redirect_is_loopback).toBe(true)
    // Explicit scopes were requested, so initial_scopes is omitted (all requested pre-selected).
    expect(claims.initial_scopes).toBeUndefined()
    expect(location.searchParams.get('scope')!.split(' ').sort()).toEqual([
      'account:read',
      'offline_access',
      'user:read',
      'workers-scripts.write',
      'zone.read'
    ])
  })

  it('falls back safely to Screen 1 when DELEGATED_CONSENT_SIGNING_KEY is missing or invalid', async () => {
    mockCimdClient()
    Object.assign(env, {
      DELEGATED_CONSENT_MODE: 'on',
      DELEGATED_CONSENT_SIGNING_KEY: ''
    })

    const res = await exports.default.fetch(
      new Request(
        authorizeUrl({
          client_id: CIMD_CLIENT_ID,
          redirect_uri: CIMD_REDIRECT_URI,
          scope: 'user:read'
        }),
        { redirect: 'manual' }
      )
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('Claude')
    expect(html).toContain('name="handle"')
  })

  it('propagates upstream deny back to the MCP client with access_denied, state, and iss', async () => {
    const keyPair = await generateSigningKeyPair('mcp-deny-key-1')
    mockCimdClient()
    Object.assign(env, {
      DELEGATED_CONSENT_MODE: 'on',
      DELEGATED_CONSENT_SIGNING_KEY: keyPair.privateJwkJson
    })

    const authRes = await exports.default.fetch(
      new Request(
        authorizeUrl({
          client_id: CIMD_CLIENT_ID,
          redirect_uri: CIMD_REDIRECT_URI,
          scope: 'user:read'
        }),
        { redirect: 'manual' }
      )
    )
    expect(authRes.status).toBe(302)
    const upstreamState = new URL(authRes.headers.get('location')!).searchParams.get('state')!

    const callbackRes = await exports.default.fetch(
      new Request(
        `${MCP_ORIGIN}/oauth/callback?error=access_denied&state=${encodeURIComponent(upstreamState)}`,
        { headers: { Cookie: cookiesFrom(authRes) }, redirect: 'manual' }
      )
    )

    expect(callbackRes.status).toBe(302)
    const clientRedirect = new URL(callbackRes.headers.get('location')!)
    expect(clientRedirect.origin + clientRedirect.pathname).toBe(CIMD_REDIRECT_URI)
    expect(clientRedirect.searchParams.get('error')).toBe('access_denied')
    expect(clientRedirect.searchParams.get('state')).toBe('downstream-state-123')
    expect(clientRedirect.searchParams.get('iss')).toBe(MCP_ORIGIN)
  })

  it('fails closed on callback if upstream omits granted scopes during delegated consent', async () => {
    const keyPair = await generateSigningKeyPair('mcp-empty-scope-key')
    mockCimdClient()
    Object.assign(env, {
      DELEGATED_CONSENT_MODE: 'on',
      DELEGATED_CONSENT_DEFAULT_SCOPES: 'full-access',
      DELEGATED_CONSENT_SIGNING_KEY: keyPair.privateJwkJson
    })

    const authRes = await exports.default.fetch(
      new Request(
        authorizeUrl({
          client_id: CIMD_CLIENT_ID,
          redirect_uri: CIMD_REDIRECT_URI,
          scope: 'user:read'
        }),
        { redirect: 'manual' }
      )
    )
    const upstreamState = new URL(authRes.headers.get('location')!).searchParams.get('state')!

    server.use(
      http.post('https://dash.cloudflare.com/oauth2/token', () =>
        HttpResponse.json({
          access_token: 'upstream-access-token',
          expires_in: 3600,
          refresh_token: 'upstream-refresh-token',
          scope: '',
          token_type: 'bearer'
        })
      )
    )

    const callbackRes = await exports.default.fetch(
      new Request(
        `${MCP_ORIGIN}/oauth/callback?code=hydra-code&state=${encodeURIComponent(upstreamState)}`,
        { headers: { Cookie: cookiesFrom(authRes) }, redirect: 'manual' }
      )
    )
    expect(callbackRes.status).toBe(502)
  })
})
