/**
 * Cloudflare Access in front of the admin dashboard.
 *
 * Access signs every request it lets through with a JWT in
 * `Cf-Access-Jwt-Assertion`. The Worker verifies it itself (RS256 against the
 * team's published keys, issuer, audience and expiry), so a request that
 * reaches the Worker another way, such as a route without the Access
 * application, is refused. Without its configuration the Worker refuses everything.
 */
import { z } from 'zod'
import { isolate, type IsolateValue } from '../lib/isolate'

export interface AccessConfig {
  /** `https://<team>.cloudflareaccess.com` */
  readonly teamDomain: string
  /** The Access application's Application Audience (AUD) tag. */
  readonly audience: string
}

export type AccessResult =
  | { readonly ok: true; readonly email: string | undefined }
  | { readonly ok: false; readonly reason: string }

const Jwk = z.looseObject({ kid: z.string(), kty: z.literal('RSA') })
const Certs = z.object({ keys: z.array(Jwk) })
const Header = z.object({ alg: z.literal('RS256'), kid: z.string() })
const Payload = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  nbf: z.number().optional(),
  email: z.string().optional()
})

type Keys = Map<string, CryptoKey>

const KEYS_TTL_MS = 60 * 60 * 1000

/**
 * The team's signing keys by `kid`, one fetch per isolate and hour. A
 * deployment has one team domain, so the map holds one entry.
 */
const keysByTeam = isolate.map<string, IsolateValue<Keys>>({ maxEntries: 4 })

async function fetchKeys(teamDomain: string): Promise<Keys> {
  const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`)
  if (!response.ok) throw new Error(`Access certs answered ${response.status}`)
  const { keys } = Certs.parse(await response.json())
  const imported = await Promise.all(
    keys.map(
      async (jwk) =>
        [
          jwk.kid,
          await crypto.subtle.importKey(
            'jwk',
            jwk as JsonWebKey,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify']
          )
        ] as const
    )
  )
  return new Map(imported)
}

function keysFor(teamDomain: string): IsolateValue<Keys> {
  return keysByTeam.getOrSet(teamDomain, () =>
    isolate.value(() => fetchKeys(teamDomain), { ttlMs: KEYS_TTL_MS })
  )
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function decodeJson(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)))
}

/**
 * Verify the Access JWT on a request.
 *
 * @param request - The incoming request.
 * @param config - The team domain and application audience, or nothing when unconfigured.
 * @param now - The current time in seconds, for tests.
 */
export async function verifyAccess(
  request: Request,
  config: AccessConfig | undefined,
  now = Math.floor(Date.now() / 1000)
): Promise<AccessResult> {
  if (!config) return { ok: false, reason: 'Cloudflare Access is not configured' }
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token) return { ok: false, reason: 'Missing Cf-Access-Jwt-Assertion' }

  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'Malformed token' }
  const [headerPart, payloadPart, signaturePart] = parts

  let header: z.infer<typeof Header>
  let payload: z.infer<typeof Payload>
  try {
    header = Header.parse(decodeJson(headerPart))
    payload = Payload.parse(decodeJson(payloadPart))
  } catch {
    return { ok: false, reason: 'Malformed token' }
  }

  const cache = keysFor(config.teamDomain)
  let key = (await cache.get()).get(header.kid)
  if (!key) {
    // Access rotates its keys; a kid we haven't seen may be new.
    cache.reset()
    key = (await cache.get()).get(header.kid)
  }
  if (!key) return { ok: false, reason: 'Unknown signing key' }

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlDecode(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`)
  )
  if (!valid) return { ok: false, reason: 'Invalid signature' }

  if (payload.iss !== config.teamDomain) return { ok: false, reason: 'Wrong issuer' }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!audiences.includes(config.audience)) return { ok: false, reason: 'Wrong audience' }
  if (payload.exp <= now) return { ok: false, reason: 'Token expired' }
  if (payload.nbf !== undefined && payload.nbf > now)
    return { ok: false, reason: 'Token not yet valid' }

  return { ok: true, email: payload.email }
}
