import type { InputSchema, JsonSchema, Tool } from '../generated/forge-mcp'
import {
  ACCOUNT_OR_ZONE_DESCRIPTION,
  ACCOUNT_OR_ZONE_ID_DESCRIPTION,
  ACCOUNT_OR_ZONE_VALUES,
  FORGE_ACCOUNT_ID_DESCRIPTION,
  PERMISSIONS_EXTENSION
} from './policy'

/**
 * The Cloudflare policy on top of a generated tool:
 *
 * - `account_id` is optional with one description, so tool lists don't depend
 *   on the session; the server fills it in when the session has one account.
 * - Forge merges methods that exist under both accounts and zones into
 *   `/{account_or_zone}/{account_or_zone_id}/…`. `account_or_zone` gets its
 *   two values, and `account_or_zone_id` is optional like `account_id`.
 *
 * The tool's request code is kept, so calls build the same requests.
 */
export function cloudflareTool(tool: Tool): Tool {
  const properties = tool.inputSchema.properties
  if (!properties || !('account_id' in properties || 'account_or_zone' in properties)) return tool

  const changed: Record<string, JsonSchema> = { ...properties }
  const optional = new Set<string>()
  if ('account_id' in changed) {
    changed.account_id = { type: 'string', description: FORGE_ACCOUNT_ID_DESCRIPTION }
    optional.add('account_id')
  }
  if ('account_or_zone' in changed) {
    changed.account_or_zone = {
      type: 'string',
      enum: [...ACCOUNT_OR_ZONE_VALUES],
      description: ACCOUNT_OR_ZONE_DESCRIPTION
    }
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
