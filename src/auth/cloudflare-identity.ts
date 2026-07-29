import { env as cloudflareEnv } from 'cloudflare:workers'

import { fetchWithRetry } from '../utils/fetch-retry'
import {
  AccountsSchema,
  ACCOUNTS_PROBE_PAGE_SIZE,
  MAX_STORED_ACCOUNTS,
  UserSchema,
  type AccountSchema,
  type UserSchema as UserIdentity
} from './types'
import { OAuthError } from './workers-oauth-utils'

const env = cloudflareEnv as Env

export type CloudflareTokenOwner = 'account' | 'unknown' | 'user'

function retryAfterHeaders(...responses: Response[]): Record<string, string> {
  return {
    'Retry-After':
      responses.find((response) => response.status === 429)?.headers.get('Retry-After') ?? '30'
  }
}

function throwIdentityProbeError(...responses: [Response, ...Response[]]): never {
  const statuses = responses.map((response) => response.status)

  if (statuses.some((status) => status >= 500)) {
    throw new OAuthError('server_error', 'Cloudflare API is temporarily unavailable', 502)
  }
  if (statuses.includes(429)) {
    throw new OAuthError(
      'temporarily_unavailable',
      'Rate limited, try again later',
      429,
      retryAfterHeaders(...responses)
    )
  }
  if (statuses.includes(401)) {
    throw new OAuthError('invalid_token', 'Access token is invalid or expired', 401)
  }
  if (statuses.includes(403)) {
    throw new OAuthError(
      'insufficient_scope',
      'Token lacks required user:read or account:read scope',
      403
    )
  }
  if (statuses.includes(400)) {
    throw new OAuthError(
      'invalid_token',
      'Access token appears malformed; reauthenticate and try again',
      401
    )
  }

  throw new OAuthError('invalid_token', 'Access token is invalid or expired', statuses[0])
}

async function fetchIdentityProbes(
  accessToken: string,
  caller: string,
  tokenOwner: CloudflareTokenOwner
): Promise<{ user?: Response; accounts: Response }> {
  const headers = { Authorization: `Bearer ${accessToken}` }

  try {
    // The cfat_ prefix proves this is account-owned, so /user cannot add
    // identity information and would only spend another upstream request.
    const userRequest =
      tokenOwner === 'account'
        ? Promise.resolve(undefined)
        : fetchWithRetry(`${env.CLOUDFLARE_API_BASE}/user`, { headers }, { caller })
    const [user, accounts] = await Promise.all([
      userRequest,
      fetchWithRetry(
        `${env.CLOUDFLARE_API_BASE}/accounts?per_page=${ACCOUNTS_PROBE_PAGE_SIZE}`,
        { headers },
        { caller }
      )
    ])
    return { user, accounts }
  } catch (error) {
    console.error('Cloudflare API request failed', error)
    throw new OAuthError('server_error', 'Cloudflare API is temporarily unavailable', 502)
  }
}

/** Resolve one Cloudflare credential into the identity stored in request props. */
export async function getCloudflareIdentity(
  accessToken: string,
  caller = 'oauth_callback_identity_probe',
  tokenOwner: CloudflareTokenOwner = 'unknown'
): Promise<{
  user: UserIdentity | null
  accounts: AccountSchema[]
  accountCount?: number
}> {
  const { user: userResponse, accounts: accountsResponse } = await fetchIdentityProbes(
    accessToken,
    caller,
    tokenOwner
  )

  if (!accountsResponse.ok && (!userResponse || !userResponse.ok)) {
    console.warn(
      `Cloudflare API identity probe failed: user=${userResponse?.status ?? 'skipped'}, accounts=${accountsResponse.status}`
    )
    if (userResponse) throwIdentityProbeError(userResponse, accountsResponse)
    throwIdentityProbeError(accountsResponse)
  }
  if (!accountsResponse.ok && userResponse?.ok && tokenOwner === 'user') {
    throwIdentityProbeError(accountsResponse)
  }

  let accounts: AccountSchema[] = []
  let totalAccountCount: number | undefined
  if (accountsResponse.ok) {
    try {
      const json = (await accountsResponse.json()) as {
        success?: boolean
        result?: unknown
        result_info?: { count?: unknown; total_count?: unknown }
      }
      if (json.success && json.result) {
        const parsed = AccountsSchema.safeParse(json.result)
        if (parsed.success) {
          accounts = parsed.data
          const reported = json.result_info?.total_count
          if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) {
            totalAccountCount = reported
          } else {
            const pageCount = json.result_info?.count
            totalAccountCount =
              typeof pageCount === 'number' && Number.isFinite(pageCount) && pageCount >= 0
                ? Math.max(pageCount, accounts.length)
                : accounts.length
            console.warn(
              `Cloudflare API /accounts response is missing a valid result_info.total_count; ` +
                `falling back to page count ${totalAccountCount}`
            )
          }
        } else {
          console.error(
            'Cloudflare API /accounts payload did not match expected shape',
            parsed.error
          )
        }
      }
    } catch (error) {
      console.error('Cloudflare API /accounts response is not valid JSON', error)
    }
  }

  // A prefixed account token must resolve to its one owning account. It never
  // uses response-based inference and never calls /user.
  if (!userResponse) {
    if (accounts.length === 1) return { user: null, accounts }
    throw new OAuthError(
      'invalid_token',
      'Account token must resolve to exactly one Cloudflare account',
      401
    )
  }

  let user: UserIdentity | null = null
  if (userResponse.ok) {
    try {
      const json = (await userResponse.json()) as { success?: boolean; result?: unknown }
      if (json.success && json.result) {
        const parsed = UserSchema.safeParse(json.result)
        if (parsed.success) {
          user = parsed.data
        } else {
          console.error('Cloudflare API /user payload did not match expected shape', parsed.error)
        }
      }
    } catch (error) {
      console.error('Cloudflare API /user response is not valid JSON', error)
    }
  } else if (tokenOwner === 'user' || userResponse.status >= 429) {
    // Known user credentials can never become account credentials. Transient
    // failures also cannot be used as evidence of account ownership.
    throwIdentityProbeError(userResponse)
  } else if (accounts.length > 0) {
    // Only unprefixed legacy credentials use response-based owner inference.
    return { user: null, accounts }
  }

  if (user) {
    if (totalAccountCount !== undefined && totalAccountCount > MAX_STORED_ACCOUNTS) {
      return { user, accounts: [], accountCount: totalAccountCount }
    }
    return { user, accounts }
  }

  if (tokenOwner === 'unknown' && accounts.length > 0) {
    return { user: null, accounts }
  }

  throw new OAuthError(
    'invalid_token',
    'Failed to verify token: no user or account information',
    401
  )
}
