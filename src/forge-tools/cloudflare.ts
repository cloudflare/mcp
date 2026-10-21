import type { InputSchema, JsonSchema, Tool } from '../generated/forge-mcp'
import {
  ACCOUNT_OR_ZONE_ID_DESCRIPTION,
  FORGE_ACCOUNT_ID_DESCRIPTION,
  PERMISSIONS_EXTENSION
} from './policy'

/**
 * The Cloudflare policy on top of a generated tool:
 *
 * - `account_id` is optional with one description, so tool lists don't depend
 *   on the session; the server fills it in when the session has one account.
 * - Forge merges methods that exist under both accounts and zones into
 *   `/{account_or_zone}/{account_or_zone_id}/…`. The document gives
 *   `account_or_zone` its two values (cloudflare/forge#59);
 *   `account_or_zone_id` is optional here like `account_id`, since the server
 *   fills in the session's account for `accounts`.
 *
 * The tool's request code is kept, so calls build the same requests.
 */
export function cloudflareTool(tool: Tool): Tool {
  const properties = tool.inputSchema.properties
  if (!properties || !('account_id' in properties || 'account_or_zone_id' in properties))
    return tool

  const changed: Record<string, JsonSchema> = { ...properties }
  const optional = new Set<string>()
  if ('account_id' in changed) {
    changed.account_id = { type: 'string', description: FORGE_ACCOUNT_ID_DESCRIPTION }
    optional.add('account_id')
  }
  if ('account_or_zone_id' in changed) {
    changed.account_or_zone_id = { type: 'string', description: ACCOUNT_OR_ZONE_ID_DESCRIPTION }
    optional.add('account_or_zone_id')
  }
  const required = (tool.inputSchema.required ?? []).filter((key) => !optional.has(key))
  const { required: _required, ...schema } = tool.inputSchema
  const inputSchema: InputSchema = {
    ...schema,
    properties: changed,
    ...(required.length > 0 && { required })
  }
  return { ...tool, inputSchema }
}

/** The API token permissions `tool` accepts, if its method lists them. */
export function permissionsOf(tool: Tool): string[] | undefined {
  const value = tool.extensions?.[PERMISSIONS_EXTENSION]
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.length > 0)
    ? value
    : undefined
}
