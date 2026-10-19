import type { Method } from '@cloudflare/forge/plugin'
import type { CatalogueTool } from '@cloudflare/forge-mcp/plugin'
import {
  ACCOUNT_OR_ZONE_DESCRIPTION,
  ACCOUNT_OR_ZONE_ID_DESCRIPTION,
  ACCOUNT_OR_ZONE_VALUES,
  FORGE_ACCOUNT_ID_DESCRIPTION,
  PERMISSIONS_EXTENSION
} from './policy'

type Properties = Record<string, unknown>

/**
 * The Cloudflare policy on top of the generic forge-mcp tool:
 *
 * - `account_id` is optional with one description, so tool lists don't depend
 *   on the session; the server fills it in when the session has one account.
 * - Forge merges methods that exist under both accounts and zones into
 *   `/{account_or_zone}/{account_or_zone_id}/…`. `account_or_zone` gets its
 *   two values, and `account_or_zone_id` is optional like `account_id`.
 * - The API token permissions a method accepts (`x-api-token-group`) are kept
 *   in the tool's extensions, for explaining a refused call. Clients never see
 *   them.
 */
export function cloudflareTool(tool: CatalogueTool, method: Method): CatalogueTool {
  const { required: currentRequired, properties: currentProperties, ...schema } = tool.inputSchema
  const properties: Properties = { ...(currentProperties as Properties) }
  const optional = new Set<string>()

  if ('account_id' in properties) {
    properties.account_id = { type: 'string', description: FORGE_ACCOUNT_ID_DESCRIPTION }
    optional.add('account_id')
  }
  if ('account_or_zone' in properties) {
    properties.account_or_zone = {
      type: 'string',
      enum: [...ACCOUNT_OR_ZONE_VALUES],
      description: ACCOUNT_OR_ZONE_DESCRIPTION
    }
  }
  if ('account_or_zone_id' in properties) {
    properties.account_or_zone_id = { type: 'string', description: ACCOUNT_OR_ZONE_ID_DESCRIPTION }
    optional.add('account_or_zone_id')
  }

  const required = (Array.isArray(currentRequired) ? (currentRequired as string[]) : []).filter(
    (key) => !optional.has(key)
  )
  const permissions = permissionLabels(method.extension(PERMISSIONS_EXTENSION))

  return {
    ...tool,
    inputSchema: {
      ...schema,
      type: 'object',
      properties,
      ...(required.length > 0 && { required })
    },
    ...(permissions && { extensions: { ...tool.extensions, [PERMISSIONS_EXTENSION]: permissions } })
  }
}

/** A list of permission names, or undefined for anything else. */
function permissionLabels(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.length > 0)
    ? value
    : undefined
}
