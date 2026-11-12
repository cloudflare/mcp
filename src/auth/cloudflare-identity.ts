import { env as cloudflareEnv } from 'cloudflare:workers'
import { z } from 'zod'

import { fetchWithRetry, serverRetryDelayMs } from '../utils/fetch-retry'
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
/**
 * Retries per probe request by caller. A direct credential is probed whenever a request
 * carries it uncached, and its client retries on our 429 anyway: retrying here spent up
 * to four calls per probe on a token Cloudflare had already rate-limited, which kept it
 * limited. The OAuth callback probes once while a person waits to sign in, so a short
 * retry there still helps.
 */
const PROBE_RETRY_OPTIONS: Record<string, { maxRetries: number }> = {
  [API_TOKEN_IDENTITY_CALLER]: { maxRetries: 0 }
}
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

/** The wait for a client when Cloudflare gives none. */
const DEFAULT_RETRY_AFTER_SECONDS = 30

/**
 * The `Retry-After` for rate-limited probes: the longest wait any of them gives.
 *
 * Measured in production: about a third of rate-limited probes carry the API
 * gateway's `Retry-After: 1` with `Ratelimit: "default";r=0;t=300`, and the rest
 * carry no rate-limit header at all, from something in front of the gateway.
 * When `/user` and `/accounts` are both refused, either may be the one with the
 * wait, so every refused response is read, not only the first.
 */
function retryAfterHeaders(...responses: Response[]): Record<string, string> {
  const waits = responses
    .filter((response) => response.status === 429)
    .map((response) => serverRetryDelayMs(response.headers))
    .filter((waitMs) => waitMs !== undefined)
  const seconds =
    waits.length === 0 ? DEFAULT_RETRY_AFTER_SECONDS : Math.ceil(Math.max(...waits) / 1000)
  return { 'Retry-After': String(seconds) }
}

/**
 * Cloudflare refuses an unrecognized, expired or revoked credential with 403 and
 * `9109: Invalid access token`: the same status and code it uses when a valid
 * token lacks a permission (`9109: Unauthorized to access requested resource`).
 * Only the message tells them apart.
 */
const INVALID_CREDENTIAL_MESSAGE = /^invalid access token$/i

const CloudflareErrorsSchema = z.object({
  errors: z.array(z.object({ code: z.number().optional(), message: z.string() })).optional()
})

/**
 * The error code of the 429 Cloudflare gives a credential that has failed
 * authentication too often: `10502: Too many authentication failures`.
 *
 * Measured against the API: a well-formed token Cloudflare doesn't recognise is
 * answered `403 9109: Invalid access token` five times in a minute and with this
 * 429 after that, with no `Retry-After` and no `Ratelimit` header. It counts
 * failures of that token, so it is a verdict on the credential, not a limit on
 * a working one. About two thirds of the rate-limited probes in production were
 * this: clients calling again and again with a token that had stopped working.
 */
const TOO_MANY_AUTH_FAILURES_CODE = 10502

/** Whether a 429 refuses the credential for repeated authentication failures. */
async function rejectsCredentialForFailures(response: Response): Promise<boolean> {
  if (response.status !== 429) return false
  try {
    const parsed = CloudflareErrorsSchema.safeParse(await response.clone().json())
    return (
      parsed.success &&
      (parsed.data.errors ?? []).some((error) => error.code === TOO_MANY_AUTH_FAILURES_CODE)
    )
  } catch {
    return false
  }
}

/** Whether Cloudflare refused the credential itself, rather than a permission it lacks. */
async function rejectsCredential(response: Response): Promise<boolean> {
  if (response.status !== 401 && response.status !== 403) return false
  try {
    const parsed = CloudflareErrorsSchema.safeParse(await response.clone().json())
    return (
      parsed.success &&
      (parsed.data.errors ?? []).some((error) =>
        INVALID_CREDENTIAL_MESSAGE.test(error.message.trim())
      )
    )
  } catch {
    return false
  }
}

/**
 * Classify failed identity probes by priority. The MCP authorization spec
 * requires 401 for invalid or expired tokens and reserves 403 with
 * `insufficient_scope` for a valid token that lacks scope.
 */
async function identityProbeError(...responses: [Response, ...Response[]]): Promise<OAuthError> {
  const statuses = responses.map((response) => response.status)

  if (statuses.some((status) => status >= 500)) {
    return new OAuthError('server_error', 'Cloudflare API is temporarily unavailable', 502)
  }
  // A 429 for repeated authentication failures says the token is bad. Answering it as a
  // rate limit told clients to try again later, which they did, for ever.
  const failedTooOften = await Promise.all(responses.map(rejectsCredentialForFailures))
  if (failedTooOften.includes(true)) {
    return new OAuthError('invalid_token', 'Access token is invalid or expired', 401)
  }
  if (statuses.includes(429)) {
    return new OAuthError(
      'temporarily_unavailable',
      'Rate limited, try again later',
      429,
      retryAfterHeaders(...responses)
    )
  }
  const rejected = await Promise.all(responses.map(rejectsCredential))
  if (statuses.includes(401) || rejected.includes(true)) {
    return new OAuthError('invalid_token', 'Access token is invalid or expired', 401)
  }
  if (statuses.includes(403)) {
    return new OAuthError(
      'insufficient_scope',
      'Token lacks required user:read or account:read scope',
      403
    )
  }
  if (statuses.includes(400)) {
    return new OAuthError(
      'invalid_token',
      'Access token appears malformed; reauthenticate and try again',
      401
    )
  }

  return new OAuthError('invalid_token', 'Access token is invalid or expired', statuses[0])
}

async function fetchProbe(url: string, accessToken: string, caller: string): Promise<Response> {
  try {
    return await fetchWithRetry(
      url,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      { caller, ...PROBE_RETRY_OPTIONS[caller] }
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
  if (!accountsResponse.ok) throw await identityProbeError(accountsResponse)
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
    throw await identityProbeError(failures[0], ...failures.slice(1))
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
    if (!userResponse.ok) throw await identityProbeError(userResponse, accountsResponse)
    throw await identityProbeError(accountsResponse)
  }

  const [user, accounts] = await Promise.all([
    userResponse.ok ? parseUser(userResponse) : Promise.resolve(null),
    accountsResponse.ok ? parseAccounts(accountsResponse) : Promise.resolve({ accounts: [] })
  ])
  if (user) return userIdentity(user, accounts)

  // A transient /user failure cannot prove account ownership.
  if (!userResponse.ok && userResponse.status >= 429) throw await identityProbeError(userResponse)
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
    throw await identityProbeError(userResponse, accountsResponse)
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
