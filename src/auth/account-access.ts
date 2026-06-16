import { LEGACY_ACCOUNTS_PAGE_SIZE, type AuthProps } from './types'

type UserToken = Extract<AuthProps, { type: 'user_token' }>
type Account = UserToken['accounts'][number]

/** Concise Code-Mode guidance for unresolved multi-account execution errors. */
export const ACCOUNT_DISCOVERY_GUIDANCE = 'Call GET /accounts to discover available accounts.'

/** Detailed Code-Mode guidance for tool descriptions. */
export const ACCOUNT_DISCOVERY_DESCRIPTION = `${ACCOUNT_DISCOVERY_GUIDANCE} Paginate as needed, or filter by exact name with GET /accounts?name=<exact account name>.`

/** Non-Code-Mode guidance using the generated endpoint tool name. */
export const NON_CODEMODE_ACCOUNT_DISCOVERY_GUIDANCE =
  'Call the get_accounts tool to discover available accounts.'

/**
 * Account selection helpers — the single source of truth for how a session's
 * `props` map onto "which Cloudflare account does an API call target". Keep all
 * `props.type` / `accounts.length` reasoning here so callers read intent, not
 * shape.
 */

/** Account id fixed by an account-scoped token (pinned; no choice to make). */
export function accountTokenId(props?: AuthProps): string | undefined {
  return props?.type === 'account_token' ? props.account.id : undefined
}

/** User token bound to exactly one usable account. */
export function isSingleAccountUser(props?: AuthProps): props is UserToken {
  return props?.type === 'user_token' && props.accounts.length === 1
}

/**
 * The account id usable without asking the user: an account token's fixed
 * account, or a single-account user token's only account. `undefined` when the
 * caller must choose (or there is no account context).
 */
export function autoResolvedAccountId(props?: AuthProps): string | undefined {
  if (props?.type === 'account_token') return props.account.id
  if (isSingleAccountUser(props)) return props.accounts[0].id
  return undefined
}

/**
 * A pre-versioning grant holding exactly the old first-page size almost
 * certainly had its account list truncated, so the stored list cannot be
 * trusted as the full set and is treated like a too-many-accounts token.
 */
export function hasIncompleteLegacyAccountList(props: UserToken): boolean {
  return props.version === undefined && props.accounts.length === LEGACY_ACCOUNTS_PAGE_SIZE
}

/**
 * User token spanning multiple accounts the model must choose between: a stored
 * list, an omitted list (count only), or an incomplete legacy list.
 */
export function isMultiAccountUser(props?: AuthProps): props is UserToken {
  if (props?.type !== 'user_token') return false
  if (hasIncompleteLegacyAccountList(props)) return true
  if (props.accounts.length > 1) return true
  return props.accounts.length === 0 && (props.accountCount ?? 0) > 1
}

/**
 * The accounts safe to inline into prompt metadata, or `null` when the list
 * isn't available/trustworthy (omitted large list or incomplete legacy list).
 */
export function inlineableAccounts(props?: AuthProps): Account[] | null {
  if (props?.type !== 'user_token') return null
  if (hasIncompleteLegacyAccountList(props)) return null
  return props.accounts.length > 1 ? props.accounts : null
}
