import {
  ExternalTokenError,
  type OAuthTokenErrorCode,
  type ResolveExternalTokenInput,
  type ResolveExternalTokenResult
} from '@cloudflare/workers-oauth-provider'
import { z } from 'zod'

import { getUserAndAccounts, type CloudflareTokenOwner } from './oauth-handler'
import { OAuthError } from './workers-oauth-utils'

import {
  AccountsSchema,
  AUTH_PROPS_VERSION,
  UserSchema,
  type AccountSchema,
  type AuthProps,
  type UserSchema as UserIdentity
} from './types'

const API_TOKEN_IDENTITY_CACHE_TTL_SECONDS = 2_592_000

const ApiTokenIdentitySchema = z.object({
  user: UserSchema.nullable(),
  accounts: AccountsSchema,
  accountCount: z.number().int().nonnegative().optional()
})

type ApiTokenIdentity = z.infer<typeof ApiTokenIdentitySchema>

/** Prefixes are trusted only as owner hints; unprefixed legacy credentials remain supported. */
export function cloudflareTokenOwner(token: string): CloudflareTokenOwner {
  if (token.startsWith('cfat_')) return 'account'
  if (token.startsWith('cfut_') || token.startsWith('cfoat_')) return 'user'
  return 'unknown'
}

async function hashApiToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function getCachedApiTokenIdentity(
  token: string,
  tokenOwner: CloudflareTokenOwner,
  kv: KVNamespace
): Promise<ApiTokenIdentity> {
  const tokenHash = await hashApiToken(token)
  const cacheKey = `api-token-identity:v3:${tokenHash}`

  try {
    const cachedValue = await kv.get(cacheKey, 'json')
    if (cachedValue !== null) {
      const cached = ApiTokenIdentitySchema.safeParse(cachedValue)
      if (cached.success) return cached.data
      console.warn('api_token_identity_probe ignored invalid cache entry')
    }
  } catch (error) {
    console.warn('api_token_identity_probe kv-cache read failed', error)
  }

  const identity = await getUserAndAccounts(token, 'api_token_identity_probe', tokenOwner)

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
): {
  code: OAuthTokenErrorCode
  statusCode: number
  requiredScopes?: string[]
} {
  switch (error.code) {
    case 'invalid_token':
      return { code: 'invalid_token', statusCode: 401 }
    case 'insufficient_scope':
      return {
        code: 'insufficient_scope',
        statusCode: 403,
        requiredScopes: tokenOwner === 'account' ? ['account:read'] : ['user:read', 'account:read']
      }
    case 'temporarily_unavailable':
      return { code: 'temporarily_unavailable', statusCode: error.statusCode }
    case 'server_error':
      return { code: 'server_error', statusCode: error.statusCode }
    default:
      return error.statusCode >= 500
        ? { code: 'server_error', statusCode: 502 }
        : { code: 'invalid_token', statusCode: 401 }
  }
}

/** Build the request props consumed by the MCP tool layer from a verified Cloudflare credential. */
export function buildAuthProps(
  token: string,
  user: UserIdentity | null,
  accounts: AccountSchema[],
  accountCount?: number
): AuthProps {
  if (user) {
    return {
      type: 'user_token',
      accessToken: token,
      user,
      accounts,
      accountCount,
      version: AUTH_PROPS_VERSION
    }
  }

  if (accounts.length !== 1) {
    throw new OAuthError(
      'invalid_token',
      'Account token must resolve to exactly one Cloudflare account',
      401
    )
  }

  return {
    type: 'account_token',
    accessToken: token,
    account: accounts[0]
  }
}

/**
 * Resolve direct Cloudflare API and OAuth credentials after the provider's own
 * access-token lookup misses. workers-oauth-provider owns bearer parsing,
 * standards-compliant error responses, and injection of the returned props.
 */
export async function resolveCloudflareToken({
  token,
  env
}: ResolveExternalTokenInput<Env>): Promise<ResolveExternalTokenResult> {
  const tokenOwner = cloudflareTokenOwner(token)
  try {
    const { user, accounts, accountCount } = await getCachedApiTokenIdentity(
      token,
      tokenOwner,
      env.OAUTH_KV
    )

    return { props: buildAuthProps(token, user, accounts, accountCount) }
  } catch (error) {
    if (error instanceof OAuthError) {
      const { code, statusCode, requiredScopes } = externalTokenError(error, tokenOwner)
      throw new ExternalTokenError(code, {
        description: error.description,
        statusCode,
        headers: error.headers,
        requiredScopes
      })
    }
    throw error
  }
}
