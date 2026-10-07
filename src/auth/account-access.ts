import { LEGACY_ACCOUNTS_PAGE_SIZE, type AccountSchema, type AuthProps } from './types'
import { ACCOUNT_DISCOVERY_TOOL_GUIDANCE } from '../mcp-tools'

/** Concise Code-Mode guidance for unresolved multi-account execution errors. */
export const ACCOUNT_DISCOVERY_GUIDANCE = 'Call GET /accounts to discover available accounts.'

/** Detailed Code-Mode guidance for tool descriptions. */
export const ACCOUNT_DISCOVERY_DESCRIPTION = `${ACCOUNT_DISCOVERY_GUIDANCE} Paginate as needed, or filter by exact name with GET /accounts?name=<exact account name>.`

/** Non-Code-Mode guidance using the generated endpoint tool name. */
export const NON_CODEMODE_ACCOUNT_DISCOVERY_GUIDANCE = ACCOUNT_DISCOVERY_TOOL_GUIDANCE

/**
 * Account selection helpers — the single source of truth for how a session's
 * `props` map onto "which Cloudflare account does an API call target". Keep all
 * `props.type` / `accounts.length` reasoning here so callers read intent, not
 * shape.
 */

/**
 * The account id usable without asking the user: an account token's fixed
 * account, or a single-account user token's only account. `undefined` when the
 * caller must choose (or there is no account context).
 */
export function autoResolvedAccountId(props?: AuthProps): string | undefined {
  if (props?.type === 'account_token') return props.account.id
  if (props?.type === 'user_token' && props.accounts.length === 1) return props.accounts[0].id
  return undefined
}

/**
 * The session's complete account list, or `undefined` when it isn't known: the
 * list was omitted because it was too long (only the count was kept), or it is
 * a pre-versioning grant that was probably truncated to the old first page.
 *
 * The list is a snapshot from when the grant was issued, so it is only used to
 * explain failures, never to reject an account_id up front.
 */
function knownAccounts(props: AuthProps): AccountSchema[] | undefined {
  if (props.type === 'account_token') return [props.account]
  if (props.accounts.length === 0 && props.accountCount !== undefined) return undefined
  if (props.version === undefined && props.accounts.length === LEGACY_ACCOUNTS_PAGE_SIZE) {
    return undefined
  }
  return props.accounts
}

function formatAccount(account: AccountSchema): string {
  return `${account.id} (${account.name})`
}

function formatAccounts(accounts: AccountSchema[]): string {
  return accounts.map((account) => `- ${formatAccount(account)}`).join('\n')
}

/**
 * Error for a call that needs an account when none was passed or auto-resolved.
 * Tool results reach only the calling session, so unlike tool metadata they can
 * name its accounts. `discoveryGuidance` is used when the list isn't known.
 */
export function missingAccountMessage(props: AuthProps, discoveryGuidance: string): string {
  const accounts = knownAccounts(props)
  if (accounts?.length) {
    return `No account selected. Pass account_id with one of this session's accounts:\n${formatAccounts(accounts)}`
  }
  if (accounts)
    return 'No account selected: no Cloudflare accounts are authorized for this session.'

  const count = props.type === 'user_token' ? props.accountCount : undefined
  return `No account selected: this token has access to ${count ?? 'multiple'} accounts. ${discoveryGuidance}`
}

/**
 * Hint for a failed call whose `account_id` isn't one of the session's known
 * accounts, or `''` when it is (or the list isn't known), so the failure had
 * some other cause.
 */
export function unknownAccountHint(props: AuthProps, accountId: string): string {
  const accounts = knownAccounts(props)
  if (!accounts || accounts.some((account) => account.id === accountId)) return ''

  if (props.type === 'account_token') {
    return `account_id ${accountId} is not this token's account. This token is scoped to ${formatAccount(props.account)}; omit account_id to use it.`
  }
  return `account_id ${accountId} is not one of this session's accounts:\n${formatAccounts(accounts)}`
}
