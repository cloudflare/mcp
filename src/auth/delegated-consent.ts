import { z } from 'zod'
import type { AuthRequest, ConsentDescription } from '@cloudflare/workers-oauth-provider'
import type { TemplateName } from './scopes'

const SigningJwkSchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  kid: z.string().trim().min(1),
  x: z.string().min(1),
  y: z.string().min(1),
  d: z.string().min(1)
})

export const DELEGATED_CONSENT_QUERY_PARAM = 'delegated_client'
export const DELEGATED_CONSENT_JWT_TYP = 'cf-delegated-consent+jwt'
export const DELEGATED_CONSENT_TTL_SECONDS = 600
export const DELEGATED_CONSENT_MAX_TOKEN_LEN = 7500
export const DELEGATED_CONSENT_OPT_IN_COOKIE = '__Host-cf-mcp-delegated-consent'
export const DELEGATED_CONSENT_DEV_COOKIE = 'cf-mcp-delegated-consent'

const MAX_CLIENT_ID_LEN = 2048
const MAX_CLIENT_NAME_LEN = 256
const MAX_URI_LEN = 2048
const MAX_REDIRECT_HOST_LEN = 512

export type DelegatedConsentMode = 'off' | 'opt-in' | 'percent' | 'on'

export interface DelegatedConsentEnv {
  readonly DELEGATED_CONSENT_MODE?: string
  readonly DELEGATED_CONSENT_ROLLOUT_PERCENT?: string
  readonly DELEGATED_CONSENT_CLIENT_ALLOWLIST?: string
  readonly DELEGATED_CONSENT_CLIENT_DENYLIST?: string
  readonly DELEGATED_CONSENT_DEFAULT_SCOPES?: string
  readonly DELEGATED_CONSENT_SIGNING_KEY?: string
}

export type DelegatedConsentDecision =
  | { enabled: true; reason: 'allowlist' | 'cookie_opt_in' | 'percent' | 'on' }
  | {
      enabled: false
      reason: 'mode_off' | 'denylist' | 'cookie_opt_out' | 'opt_in_not_matched' | 'percent_excluded'
    }

export interface DelegatedConsentSigningKey {
  kid: string
  key: CryptoKey
}

export interface DelegatedConsentClaims {
  iss: string
  aud: string
  iat: number
  exp: number
  jti: string
  state_hash: string
  code_challenge: string
  scope_hash: string
  client_id: string
  client_name: string
  client_domain?: string
  client_uri?: string
  logo_uri?: string
  redirect_uri: string
  redirect_host: string
  redirect_is_loopback: boolean
  required_scopes?: Array<string>
  initial_scopes?: Array<string>
}

export interface SignDelegatedConsentInput {
  issuer: string
  oauthDomain: string
  stateToken: string
  codeChallenge: string
  scopes: ReadonlyArray<string>
  consent: ConsentDescription
  requiredScopes: ReadonlyArray<string>
  initialScopes?: ReadonlyArray<string>
  nowSeconds?: number
}

interface ParsedSigningKeyCache {
  raw: string
  signingKey: DelegatedConsentSigningKey
}

let cachedSigningKey: ParsedSigningKeyCache | null = null

function base64urlEncodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64urlEncodeJson(value: unknown): string {
  return base64urlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)))
}

async function sha256Base64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return base64urlEncodeBytes(new Uint8Array(digest))
}

/**
 * Canonicalize scope list identically to Gauss (`canonicalScopeString`):
 * trim, discard empties, deduplicate, and sort lexicographically by code point.
 */
export function canonicalScopeString(scopes: ReadonlyArray<string>): string {
  const seen = new Set<string>()
  for (const raw of scopes) {
    const trimmed = raw.trim()
    if (trimmed.length > 0) {
      seen.add(trimmed)
    }
  }
  return Array.from(seen)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join(' ')
}

function sanitizeDisplayString(value: string, maxLen: number): string {
  // Strip ASCII control characters (including CR/LF/TAB) to satisfy Gauss's
  // strict display-string validator without rejecting legitimate DCR clients.
  let cleaned = ''
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    cleaned += code < 0x20 || code === 0x7f ? ' ' : value[i]
  }
  cleaned = cleaned.replaceAll(/\s+/g, ' ').trim()
  if (cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, maxLen).trim()
  }
  return cleaned
}

function sanitizeOptionalUrl(value: string | undefined, httpsOnly: boolean): string | undefined {
  if (!value) {
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_URI_LEN) {
    return undefined
  }
  try {
    const parsed = new URL(trimmed)
    if (!parsed.hostname) {
      return undefined
    }
    if (httpsOnly && parsed.protocol !== 'https:') {
      return undefined
    }
    if (!httpsOnly && parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return undefined
    }
    return parsed.href.length <= MAX_URI_LEN ? parsed.href : undefined
  } catch {
    return undefined
  }
}

function validatedClientDomain(
  clientId: string,
  clientDomain: string | undefined
): string | undefined {
  if (!clientDomain) {
    return undefined
  }
  const domain = clientDomain.trim()
  if (domain.length === 0 || /[\s/:@?#\\]/.test(domain)) {
    return undefined
  }
  try {
    const parsed = new URL(clientId)
    if (parsed.protocol !== 'https:') {
      return undefined
    }
    if (!parsed.pathname || parsed.pathname === '/') {
      return undefined
    }
    if (parsed.hostname.toLowerCase() !== domain.toLowerCase()) {
      return undefined
    }
    return parsed.hostname
  } catch {
    return undefined
  }
}

function parseMode(raw: string | undefined): DelegatedConsentMode {
  switch (raw?.trim().toLowerCase()) {
    case 'opt-in':
      return 'opt-in'
    case 'percent':
      return 'percent'
    case 'on':
      return 'on'
    default:
      return 'off'
  }
}

function parseClientMatcherList(raw: string | undefined): Array<string> {
  if (!raw) {
    return []
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function matchesClientList(
  entries: ReadonlyArray<string>,
  clientId: string,
  clientDomain: string | undefined
): boolean {
  const normalizedDomain = clientDomain?.toLowerCase()
  for (const entry of entries) {
    if (entry.toLowerCase().startsWith('domain:')) {
      const targetDomain = entry.slice('domain:'.length).trim().toLowerCase()
      if (targetDomain.length > 0 && normalizedDomain === targetDomain) {
        return true
      }
      continue
    }
    if (entry === clientId) {
      return true
    }
  }
  return false
}

function parseCookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined
  }
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) {
      continue
    }
    const key = part.slice(0, idx).trim()
    if (key === name) {
      return part.slice(idx + 1).trim()
    }
  }
  return undefined
}

function readCanaryCookie(request: Request): string | undefined {
  const cookieHeader = request.headers.get('Cookie')
  if (!cookieHeader) {
    return undefined
  }
  const hostValue = parseCookieValue(cookieHeader, DELEGATED_CONSENT_OPT_IN_COOKIE)
  if (hostValue !== undefined) {
    return hostValue
  }
  // Allow non-__Host- cookie only on localhost HTTP during local development.
  try {
    const url = new URL(request.url)
    if (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    ) {
      return parseCookieValue(cookieHeader, DELEGATED_CONSENT_DEV_COOKIE)
    }
  } catch {
    // Ignore unparseable URL.
  }
  return undefined
}

async function rolloutBasisPoints(seed: string): Promise<number> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))
  )
  const value =
    (((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0) % 10_000
  return value
}

/**
 * Resolve which scope template populates the upstream scope pool in delegated
 * consent mode when a client does not explicitly request scopes beyond the
 * required baseline. Defaults to `full-access` so `Edit Permissions` on
 * dash.cloudflare.com exposes Minimal / Read only / Full access while still
 * starting with Minimal (`initial_scopes`) checked by default.
 */
export function resolveDelegatedDefaultTemplate(raw: string | undefined): TemplateName {
  switch (raw?.trim().toLowerCase()) {
    case 'minimal':
      return 'minimal'
    case 'read-only':
      return 'read-only'
    case 'full-access':
    case undefined:
    case '':
      return 'full-access'
    default:
      return 'full-access'
  }
}

/**
 * Evaluate progressive rollout flags, per-client allow/deny lists, and canary
 * browser cookie to decide whether this `/authorize` request should use
 * first-party delegated consent on dash.cloudflare.com or fall back to Screen 1.
 */
export async function evaluateDelegatedConsentRollout(
  request: Request,
  authRequest: AuthRequest,
  consent: ConsentDescription,
  config: DelegatedConsentEnv
): Promise<DelegatedConsentDecision> {
  const mode = parseMode(config.DELEGATED_CONSENT_MODE)
  if (mode === 'off') {
    return { enabled: false, reason: 'mode_off' }
  }

  const denylist = parseClientMatcherList(config.DELEGATED_CONSENT_CLIENT_DENYLIST)
  if (matchesClientList(denylist, consent.clientId, consent.clientDomain)) {
    return { enabled: false, reason: 'denylist' }
  }

  const cookie = readCanaryCookie(request)
  if (cookie === '0') {
    return { enabled: false, reason: 'cookie_opt_out' }
  }
  if (cookie === '1') {
    return { enabled: true, reason: 'cookie_opt_in' }
  }

  if (mode === 'on') {
    return { enabled: true, reason: 'on' }
  }

  const allowlist = parseClientMatcherList(config.DELEGATED_CONSENT_CLIENT_ALLOWLIST)
  if (matchesClientList(allowlist, consent.clientId, consent.clientDomain)) {
    return { enabled: true, reason: 'allowlist' }
  }

  if (mode === 'opt-in') {
    return { enabled: false, reason: 'opt_in_not_matched' }
  }

  // mode === 'percent'
  const parsedPercent = Number.parseFloat(config.DELEGATED_CONSENT_ROLLOUT_PERCENT ?? '0')
  if (!Number.isFinite(parsedPercent) || parsedPercent <= 0) {
    return { enabled: false, reason: 'percent_excluded' }
  }
  if (parsedPercent >= 100) {
    return { enabled: true, reason: 'percent' }
  }

  const thresholdBps = Math.round(parsedPercent * 100)
  const seed = authRequest.codeChallenge || crypto.randomUUID()
  const bucketBps = await rolloutBasisPoints(seed)
  return bucketBps < thresholdBps
    ? { enabled: true, reason: 'percent' }
    : { enabled: false, reason: 'percent_excluded' }
}

/**
 * Parse and import the ES256 private JWK stored in `DELEGATED_CONSENT_SIGNING_KEY`.
 * Returns `null` (without throwing) when unconfigured or invalid so callers can
 * safely fall back to the local Screen 1 consent dialog.
 */
export async function loadDelegatedConsentSigningKey(
  rawJwk: string | undefined
): Promise<DelegatedConsentSigningKey | null> {
  const trimmed = rawJwk?.trim()
  if (!trimmed) {
    return null
  }
  if (cachedSigningKey && cachedSigningKey.raw === trimmed) {
    return cachedSigningKey.signingKey
  }

  try {
    const parsed = SigningJwkSchema.safeParse(JSON.parse(trimmed))
    if (!parsed.success) {
      console.error('DELEGATED_CONSENT_SIGNING_KEY must be an EC P-256 private JWK with kid')
      return null
    }
    const jwk = parsed.data

    const key = await crypto.subtle.importKey(
      'jwk',
      {
        kty: jwk.kty,
        crv: jwk.crv,
        x: jwk.x,
        y: jwk.y,
        d: jwk.d
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    )

    const signingKey: DelegatedConsentSigningKey = { kid: jwk.kid, key }
    cachedSigningKey = { raw: trimmed, signingKey }
    return signingKey
  } catch (error) {
    console.error('Failed to load DELEGATED_CONSENT_SIGNING_KEY:', error)
    return null
  }
}

/** Clear cached signing key (used by tests). */
export function resetDelegatedConsentKeyCache(): void {
  cachedSigningKey = null
}

/**
 * Mint a compact ES256 JWS assertion (`typ: cf-delegated-consent+jwt`) bound to
 * this exact upstream authorization request (`state`, `code_challenge`, `scope`).
 */
export async function signDelegatedConsentAssertion(
  signingKey: DelegatedConsentSigningKey,
  input: SignDelegatedConsentInput
): Promise<string> {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const audience = `${input.oauthDomain.replace(/\/$/, '')}/oauth/consent`

  const clientId = sanitizeDisplayString(input.consent.clientId, MAX_CLIENT_ID_LEN)
  if (clientId.length === 0) {
    throw new Error('Delegated consent clientId is empty')
  }
  const clientName =
    sanitizeDisplayString(input.consent.clientName, MAX_CLIENT_NAME_LEN) ||
    sanitizeDisplayString(clientId, MAX_CLIENT_NAME_LEN)
  const redirectUri = input.consent.redirectUri.trim()
  if (redirectUri.length === 0 || redirectUri.length > MAX_URI_LEN) {
    throw new Error('Delegated consent redirectUri is invalid')
  }
  const redirectHost =
    sanitizeDisplayString(input.consent.redirectHost, MAX_REDIRECT_HOST_LEN) ||
    sanitizeDisplayString(redirectUri, MAX_REDIRECT_HOST_LEN)

  const clientDomain = validatedClientDomain(clientId, input.consent.clientDomain)
  const clientUri = sanitizeOptionalUrl(input.consent.clientUri, false)
  const logoUri = sanitizeOptionalUrl(input.consent.logoUri, true)

  const [stateHash, scopeHash] = await Promise.all([
    sha256Base64url(input.stateToken),
    sha256Base64url(canonicalScopeString(input.scopes))
  ])

  const requestedSet = new Set(input.scopes)
  const requiredScopes = Array.from(new Set(input.requiredScopes)).filter((scope) =>
    requestedSet.has(scope)
  )
  const initialScopes =
    input.initialScopes !== undefined
      ? Array.from(new Set(input.initialScopes)).filter((scope) => requestedSet.has(scope))
      : undefined

  const claims: DelegatedConsentClaims = {
    iss: input.issuer,
    aud: audience,
    iat: nowSeconds,
    exp: nowSeconds + DELEGATED_CONSENT_TTL_SECONDS,
    jti: crypto.randomUUID(),
    state_hash: stateHash,
    code_challenge: input.codeChallenge,
    scope_hash: scopeHash,
    client_id: clientId,
    client_name: clientName,
    redirect_uri: redirectUri,
    redirect_host: redirectHost,
    redirect_is_loopback: Boolean(input.consent.redirectIsLoopback)
  }
  if (clientDomain) {
    claims.client_domain = clientDomain
  }
  if (clientUri) {
    claims.client_uri = clientUri
  }
  if (logoUri) {
    claims.logo_uri = logoUri
  }
  if (requiredScopes.length > 0) {
    claims.required_scopes = requiredScopes
  }
  if (initialScopes !== undefined) {
    claims.initial_scopes = initialScopes
  }

  const headerB64 = base64urlEncodeJson({
    alg: 'ES256',
    typ: DELEGATED_CONSENT_JWT_TYP,
    kid: signingKey.kid
  })
  const payloadB64 = base64urlEncodeJson(claims)
  const signingInput = `${headerB64}.${payloadB64}`

  // Web Crypto ECDSA P-256 produces raw IEEE P1363 (r || s, 64 bytes), which
  // matches JWS ES256 (RFC 7518 §3.4) directly.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey.key,
    new TextEncoder().encode(signingInput)
  )
  const signatureB64 = base64urlEncodeBytes(new Uint8Array(signature))

  return `${signingInput}.${signatureB64}`
}
