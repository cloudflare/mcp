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

const API_TOKEN_IDENTITY_CACHE_TTL_SECONDS = 2_592_000
const API_TOKEN_IDENTITY_BACKOFF_MIN_SECONDS = 60

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

async function getCachedIdentity(
  token: string,
  tokenOwner: CloudflareTokenOwner,
  kv: KVNamespace
): Promise<CloudflareIdentity> {
  const tokenHash = await hashApiToken(token)
  const cacheKey = `api-token-identity:v4:${tokenHash}`
  const backoffKey = `api-token-identity-backoff:v1:${tokenHash}`
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

  // A token Cloudflare just rate-limited backs off here instead of probing (and being limited) again.
  const now = Math.floor(Date.now() / 1000)
  try {
    const backoffUntil = Number(await kv.get(backoffKey))
    if (backoffUntil > now) {
      throw new OAuthError('temporarily_unavailable', 'Rate limited, try again later', 429, {
        'Retry-After': String(backoffUntil - now)
      })
    }
  } catch (error) {
    if (error instanceof OAuthError) throw error
    console.warn('api_token_identity_probe kv-backoff read failed', error)
  }

  let identity: CloudflareIdentity
  try {
    identity = await resolveCloudflareCredential(token, tokenOwner)
  } catch (error) {
    if (error instanceof OAuthError && error.code === 'temporarily_unavailable') {
      // KV's minimum TTL is 60 seconds, so the window is at least that long.
      const retryAfter = Math.max(
        API_TOKEN_IDENTITY_BACKOFF_MIN_SECONDS,
        Number(error.headers?.['Retry-After']) || 0
      )
      try {
        await kv.put(backoffKey, String(now + retryAfter), { expirationTtl: retryAfter })
      } catch (writeError) {
        console.warn('api_token_identity_probe kv-backoff write failed', writeError)
      }
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

/** Resolve direct Cloudflare credentials after the provider's internal token lookup misses. */
export async function resolveExternalToken({
  token,
  env
}: ResolveExternalTokenInput<Env>): Promise<ResolveExternalTokenResult> {
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
