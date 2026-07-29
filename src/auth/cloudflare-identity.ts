import { env as cloudflareEnv } from 'cloudflare:workers'
import { z } from 'zod'

import { fetchWithRetry } from '../utils/fetch-retry'
import {
  AccountSchema,
  AccountsSchema,
  ACCOUNTS_PROBE_PAGE_SIZE,
  MAX_STORED_ACCOUNTS,
  UserSchema
} from './types'
import { OAuthError } from './workers-oauth-utils'

const env = cloudflareEnv as Env
const API_TOKEN_IDENTITY_CALLER = 'api_token_identity_probe'
const OAUTH_IDENTITY_CALLER = 'oauth_callback_identity_probe'
// /accounts enforces a minimum page size of five. That is still enough to
// prove the account-token invariant without fetching the 31-record user page.
const ACCOUNT_TOKEN_PROBE_PAGE_SIZE = 5

export type CloudflareTokenOwner = 'account' | 'unknown' | 'user'

const AccountIdentitySchema = z.object({
  type: z.literal('account'),
  account: AccountSchema
})

const UserIdentitySchema = z.object({
  type: z.literal('user'),
  user: UserSchema,
  accounts: AccountsSchema,
  accountCount: z.number().int().nonnegative().optional()
})

export const CloudflareIdentitySchema = z.discriminatedUnion('type', [
  AccountIdentitySchema,
  UserIdentitySchema
])

export type CloudflareIdentity = z.infer<typeof CloudflareIdentitySchema>
export type CloudflareUserIdentity = z.infer<typeof UserIdentitySchema>

type AccountPage = {
  accounts: z.infer<typeof AccountsSchema>
  totalCount?: number
}

const UserResponseSchema = z.object({
  success: z.boolean().optional(),
  result: UserSchema.nullable().optional()
})

const AccountsResponseSchema = z.object({
  success: z.boolean().optional(),
  result: AccountsSchema.optional(),
  result_info: z
    .object({
      count: z.number().optional(),
      total_count: z.number().optional()
    })
    .optional()
})

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

async function fetchProbe(url: string, accessToken: string, caller: string): Promise<Response> {
  try {
    return await fetchWithRetry(
      url,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      { caller }
    )
  } catch (error) {
    console.error('Cloudflare API request failed', error)
    throw new OAuthError('server_error', 'Cloudflare API is temporarily unavailable', 502)
  }
}

function fetchUser(accessToken: string, caller: string): Promise<Response> {
  return fetchProbe(`${env.CLOUDFLARE_API_BASE}/user`, accessToken, caller)
}

function fetchAccounts(
  accessToken: string,
  caller: string,
  pageSize = ACCOUNTS_PROBE_PAGE_SIZE
): Promise<Response> {
  return fetchProbe(`${env.CLOUDFLARE_API_BASE}/accounts?per_page=${pageSize}`, accessToken, caller)
}

async function parseUser(response: Response): Promise<CloudflareUserIdentity['user'] | null> {
  try {
    const parsed = UserResponseSchema.safeParse(await response.json())
    if (parsed.success && parsed.data.success && parsed.data.result) return parsed.data.result
    if (!parsed.success) {
      console.error('Cloudflare API /user payload did not match expected shape', parsed.error)
    }
  } catch (error) {
    console.error('Cloudflare API /user response is not valid JSON', error)
  }
  return null
}

async function parseAccounts(response: Response): Promise<AccountPage> {
  try {
    const parsed = AccountsResponseSchema.safeParse(await response.json())
    if (!parsed.success) {
      console.error('Cloudflare API /accounts payload did not match expected shape', parsed.error)
      return { accounts: [] }
    }
    if (!parsed.data.success || !parsed.data.result) return { accounts: [] }

    const accounts = parsed.data.result
    const reported = parsed.data.result_info?.total_count
    if (reported !== undefined && Number.isFinite(reported) && reported >= 0) {
      return { accounts, totalCount: reported }
    }

    const pageCount = parsed.data.result_info?.count
    const totalCount =
      pageCount !== undefined && Number.isFinite(pageCount) && pageCount >= 0
        ? Math.max(pageCount, accounts.length)
        : accounts.length
    console.warn(
      `Cloudflare API /accounts response is missing a valid result_info.total_count; ` +
        `falling back to page count ${totalCount}`
    )
    return { accounts, totalCount }
  } catch (error) {
    console.error('Cloudflare API /accounts response is not valid JSON', error)
    return { accounts: [] }
  }
}

function accountIdentity(page: AccountPage): CloudflareIdentity {
  if (page.accounts.length !== 1 || (page.totalCount !== undefined && page.totalCount !== 1)) {
    throw new OAuthError(
      'invalid_token',
      'Account token must resolve to exactly one Cloudflare account',
      401
    )
  }
  return { type: 'account', account: page.accounts[0] }
}

function userIdentity(
  user: CloudflareUserIdentity['user'],
  page: AccountPage
): CloudflareUserIdentity {
  if (page.totalCount !== undefined && page.totalCount > MAX_STORED_ACCOUNTS) {
    return { type: 'user', user, accounts: [], accountCount: page.totalCount }
  }
  return { type: 'user', user, accounts: page.accounts }
}

async function resolveAccountCredential(
  accessToken: string,
  caller: string
): Promise<CloudflareIdentity> {
  // One minimum-size page is enough to prove whether an account-owned token
  // resolves to exactly one account without fetching the larger user page.
  const accountsResponse = await fetchAccounts(accessToken, caller, ACCOUNT_TOKEN_PROBE_PAGE_SIZE)
  if (!accountsResponse.ok) throwIdentityProbeError(accountsResponse)
  return accountIdentity(await parseAccounts(accountsResponse))
}

async function resolveUserCredential(
  accessToken: string,
  caller: string
): Promise<CloudflareUserIdentity> {
  const [userResponse, accountsResponse] = await Promise.all([
    fetchUser(accessToken, caller),
    fetchAccounts(accessToken, caller)
  ])
  const failures = [userResponse, accountsResponse].filter((response) => !response.ok)
  if (failures.length > 0) {
    throwIdentityProbeError(failures[0], ...failures.slice(1))
  }

  const [user, accounts] = await Promise.all([
    parseUser(userResponse),
    parseAccounts(accountsResponse)
  ])
  if (!user) {
    throw new OAuthError('invalid_token', 'Failed to verify token: no user information', 401)
  }
  return userIdentity(user, accounts)
}

async function resolveLegacyCredential(
  accessToken: string,
  caller: string
): Promise<CloudflareIdentity> {
  const [userResponse, accountsResponse] = await Promise.all([
    fetchUser(accessToken, caller),
    fetchAccounts(accessToken, caller)
  ])
  if (!accountsResponse.ok) {
    if (!userResponse.ok) throwIdentityProbeError(userResponse, accountsResponse)
    throwIdentityProbeError(accountsResponse)
  }

  const [user, accounts] = await Promise.all([
    userResponse.ok ? parseUser(userResponse) : Promise.resolve(null),
    accountsResponse.ok ? parseAccounts(accountsResponse) : Promise.resolve({ accounts: [] })
  ])
  if (user) return userIdentity(user, accounts)

  // A transient /user failure cannot prove account ownership.
  if (!userResponse.ok && userResponse.status >= 429) throwIdentityProbeError(userResponse)
  return accountIdentity(accounts)
}

/** Resolve a direct Cloudflare API or OAuth credential using its ownership hint. */
export function resolveCloudflareCredential(
  accessToken: string,
  tokenOwner: CloudflareTokenOwner
): Promise<CloudflareIdentity> {
  switch (tokenOwner) {
    case 'account':
      return resolveAccountCredential(accessToken, API_TOKEN_IDENTITY_CALLER)
    case 'user':
      return resolveUserCredential(accessToken, API_TOKEN_IDENTITY_CALLER)
    case 'unknown':
      return resolveLegacyCredential(accessToken, API_TOKEN_IDENTITY_CALLER)
  }
}

/** Resolve the upstream Cloudflare OAuth grant used by this server's OAuth flow. */
export async function getCloudflareOAuthUser(accessToken: string): Promise<CloudflareUserIdentity> {
  const [userResponse, accountsResponse] = await Promise.all([
    fetchUser(accessToken, OAUTH_IDENTITY_CALLER),
    fetchAccounts(accessToken, OAUTH_IDENTITY_CALLER)
  ])
  if (!userResponse.ok && !accountsResponse.ok) {
    throwIdentityProbeError(userResponse, accountsResponse)
  }

  const [user, accounts] = await Promise.all([
    userResponse.ok ? parseUser(userResponse) : Promise.resolve(null),
    accountsResponse.ok ? parseAccounts(accountsResponse) : Promise.resolve({ accounts: [] })
  ])
  if (!user) {
    throw new OAuthError('server_error', 'Failed to fetch user information from Cloudflare', 500)
  }
  return userIdentity(user, accounts)
}
