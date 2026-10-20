/** The Cloudflare policy for the tools forge generates (`src/generated/forge-mcp`). */

/** The generated tool that lists the caller's accounts. */
export const ACCOUNTS_TOOL = 'accounts_list'

/** Points callers at the generated account listing tool. */
export const FORGE_ACCOUNT_DISCOVERY_GUIDANCE = `Call the ${ACCOUNTS_TOOL} tool to discover available accounts.`

/**
 * The `account_id` schema on every account-scoped tool: optional, with the same
 * description for every session, because clients cache tool lists and may
 * share them. The server fills it in when the session has one account.
 */
export const FORGE_ACCOUNT_ID_DESCRIPTION = `Cloudflare account ID. Optional when the session is authorized for exactly one account; otherwise required. ${FORGE_ACCOUNT_DISCOVERY_GUIDANCE}`

/** The values of the `account_or_zone` path parameter Forge adds to methods it merged. */
export const ACCOUNT_OR_ZONE_VALUES = ['accounts', 'zones'] as const

export const ACCOUNT_OR_ZONE_DESCRIPTION =
  'Whether account_or_zone_id is an account ID (`accounts`) or a zone ID (`zones`).'

export const ACCOUNT_OR_ZONE_ID_DESCRIPTION = `The account or zone ID that account_or_zone names. Optional for \`accounts\` when the session is authorized for exactly one account. ${FORGE_ACCOUNT_DISCOVERY_GUIDANCE}`

/** The extension a tool's accepted API token permissions are kept under. */
export const PERMISSIONS_EXTENSION = 'x-api-token-group'
