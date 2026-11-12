import {
  ExternalTokenError,
  type ResolveExternalTokenInput,
  type ResolveExternalTokenResult
} from '@cloudflare/workers-oauth-provider'

import {
  CloudflareIdentitySchema,
  resolveCloudflareCredential,
  type CloudflareIdentity,
  type CloudflareTokenOwner
} from './cloudflare-identity'
import { AUTH_PROPS_VERSION, type AuthProps } from './types'
import { OAuthError } from './workers-oauth-utils'
import { z } from 'zod'

const API_TOKEN_IDENTITY_CACHE_TTL_SECONDS = 2_592_000

/** Prefixes are ownership hints; unprefixed legacy credentials remain supported. */
export function cloudflareTokenOwner(token: string): CloudflareTokenOwner {
  if (token.startsWith('cfat_')) return 'account'
  if (token.startsWith('cfut_') || token.startsWith('cfoat_')) return 'user'
  return 'unknown'
}

async function hashApiToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** KV's shortest expiry. A shorter hold ends at its own `until`. */
const KV_MIN_TTL_SECONDS = 60

const RateLimitHoldSchema = z.object({ until: z.number() })

function rateLimited(retryAfterSeconds: number): OAuthError {
  return new OAuthError('temporarily_unavailable', 'Rate limited, try again later', 429, {
    'Retry-After': String(retryAfterSeconds)
  })
}

/**
 * Refuse a credential Cloudflare rate limited until the wait it gave is over,
 * without asking Cloudflare again.
 *
 * A credential is probed whenever a request carries it uncached, and a
 * rate-limited probe caches nothing. A client that keeps calling with one
 * therefore cost two refused API requests per MCP request, for as long as it
 * kept calling: 1.2 to 2.4 million a day in production, about 98% of this
 * server's 429s, and requests that kept the credential's limit from clearing.
 *
 * The hold is in `OAUTH_KV` by token hash, like the identity cache, and holds
 * only the time it ends. KV is eventually consistent, so a request elsewhere
 * may still probe once; that is load shedding, not a lock.
 */
async function heldForRateLimit(holdKey: string, kv: KVNamespace): Promise<OAuthError | undefined> {
  try {
    const hold = RateLimitHoldSchema.safeParse(await kv.get(holdKey, 'json'))
    const remainingMs = hold.success ? hold.data.until - Date.now() : 0
    if (remainingMs <= 0) return undefined
    console.log(
      `api_token_identity_probe held: not probing a rate-limited credential for another ${Math.ceil(remainingMs / 1000)}s`
    )
    return rateLimited(Math.ceil(remainingMs / 1000))
  } catch (error) {
    console.warn('api_token_identity_probe rate-limit hold read failed', error)
    return undefined
  }
}

/** Hold the credential for the wait a rate-limited probe's `Retry-After` gives. */
async function holdForRateLimit(
  holdKey: string,
  error: OAuthError,
  kv: KVNamespace
): Promise<void> {
  const seconds = Number(error.headers?.['Retry-After'])
  if (!(seconds > 0)) return
  try {
    await kv.put(holdKey, JSON.stringify({ until: Date.now() + seconds * 1000 }), {
      expirationTtl: Math.max(KV_MIN_TTL_SECONDS, seconds)
    })
  } catch (putError) {
    console.warn('api_token_identity_probe rate-limit hold write failed', putError)
  }
}

async function getCachedIdentity(
  token: string,
  tokenOwner: CloudflareTokenOwner,
  kv: KVNamespace
): Promise<CloudflareIdentity> {
  const tokenHash = await hashApiToken(token)
  const cacheKey = `api-token-identity:v4:${tokenHash}`
  const holdKey = `api-token-rate-limited:v1:${tokenHash}`

  try {
    const cachedValue = await kv.get(cacheKey, 'json')
    if (cachedValue !== null) {
      const cached = CloudflareIdentitySchema.safeParse(cachedValue)
      if (cached.success) return cached.data
      console.warn('api_token_identity_probe ignored invalid cache entry')
    }
  } catch (error) {
    console.warn('api_token_identity_probe kv-cache read failed', error)
  }

  const held = await heldForRateLimit(holdKey, kv)
  if (held) throw held

  let identity: CloudflareIdentity
  try {
    identity = await resolveCloudflareCredential(token, tokenOwner)
  } catch (error) {
    if (error instanceof OAuthError && error.statusCode === 429) {
      await holdForRateLimit(holdKey, error, kv)
    }
    throw error
  }

  try {
    await kv.put(cacheKey, JSON.stringify(identity), {
      expirationTtl: API_TOKEN_IDENTITY_CACHE_TTL_SECONDS
    })
  } catch (error) {
    console.warn('api_token_identity_probe kv-cache write failed', error)
  }

  return identity
}

function externalTokenError(
  error: OAuthError,
  tokenOwner: CloudflareTokenOwner
): ExternalTokenError {
  const common = { description: error.description, headers: error.headers }

  switch (error.code) {
    case 'invalid_token':
      return new ExternalTokenError('invalid_token', { ...common, statusCode: 401 })
    case 'insufficient_scope':
      return new ExternalTokenError('insufficient_scope', {
        ...common,
        statusCode: 403,
        requiredScopes: tokenOwner === 'account' ? ['account:read'] : ['user:read', 'account:read']
      })
    case 'temporarily_unavailable':
      return new ExternalTokenError('temporarily_unavailable', {
        ...common,
        statusCode: error.statusCode
      })
    case 'server_error':
      return new ExternalTokenError('server_error', {
        ...common,
        statusCode: error.statusCode
      })
    default:
      return new ExternalTokenError(error.statusCode >= 500 ? 'server_error' : 'invalid_token', {
        ...common,
        statusCode: error.statusCode >= 500 ? 502 : 401
      })
  }
}

/** Convert a verified Cloudflare identity into request-local tool props. */
export function buildAuthProps(token: string, identity: CloudflareIdentity): AuthProps {
  switch (identity.type) {
    case 'account':
      return {
        type: 'account_token',
        accessToken: token,
        account: identity.account
      }
    case 'user':
      return {
        type: 'user_token',
        accessToken: token,
        user: identity.user,
        accounts: identity.accounts,
        accountCount: identity.accountCount,
        version: AUTH_PROPS_VERSION
      }
  }
}

/**
 * Whether a token has the shape workers-oauth-provider gives its own tokens,
 * `userId:grantId:secret`, matching the provider's own check in `unwrapToken`.
 * Cloudflare credentials never contain `:`.
 */
function isProviderTokenShape(token: string): boolean {
  return token.split(':').length === 3
}

/** Resolve direct Cloudflare credentials after the provider's internal token lookup misses. */
export async function resolveExternalToken({
  token,
  env
}: ResolveExternalTokenInput<Env>): Promise<ResolveExternalTokenResult> {
  // The provider only calls this after its own lookup missed, so a token of its shape
  // is one it issued that has expired or been revoked. Asking Cloudflare about it costs
  // two API calls and always ends in a 400.
  if (isProviderTokenShape(token)) {
    throw new ExternalTokenError('invalid_token', {
      description: 'Access token is invalid or expired',
      statusCode: 401
    })
  }

  const tokenOwner = cloudflareTokenOwner(token)
  try {
    const identity = await getCachedIdentity(token, tokenOwner, env.OAUTH_KV)
    return {
      props: buildAuthProps(token, identity),
      // Cloudflare API tokens are opaque credentials, so successful identity
      // validation establishes their local protected-resource audience.
      audience: env.MCP_RESOURCE
    }
  } catch (error) {
    if (error instanceof OAuthError) throw externalTokenError(error, tokenOwner)
    throw error
  }
}
