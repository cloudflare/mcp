import type { JSONObject } from '@modelcontextprotocol/server'
import { operation } from '../generated/forge-mcp'
import type { Tool } from '../generated/forge-mcp/_/tool'
import {
  ACCOUNT_OR_ZONE_ID_DESCRIPTION,
  FORGE_ACCOUNT_ID_DESCRIPTION,
  PERMISSIONS_EXTENSION
} from './policy'

/** The account path parameters the server can fill in, with their descriptions. */
const OPTIONAL_PATH_PARAMS: Readonly<Record<string, string>> = {
  account_id: FORGE_ACCOUNT_ID_DESCRIPTION,
  account_or_zone_id: ACCOUNT_OR_ZONE_ID_DESCRIPTION
}

/**
 * The Cloudflare policy on top of a generated tool:
 *
 * - `path.account_id` is optional with one description, so tool lists don't
 *   depend on the session; the server fills it in when the session has one
 *   account.
 * - Forge merges methods that exist under both accounts and zones into
 *   `/{account_or_zone}/{account_or_zone_id}/…`. The document gives
 *   `account_or_zone` its two values (cloudflare/forge#59);
 *   `path.account_or_zone_id` is optional here like `path.account_id`, since
 *   the server fills in the session's account for `accounts`.
 *
 * When that leaves no path parameter required, `path` itself is optional.
 * The tool's operation is kept, so calls build the same requests.
 */
export function cloudflareTool(tool: Tool): Tool {
  const path = tool.inputSchema.properties?.path as PathSchema | undefined
  const params = path?.properties
  if (!path || !params || !Object.keys(params).some((key) => key in OPTIONAL_PATH_PARAMS)) {
    return tool
  }

  const changed: JSONObject = { ...params }
  for (const [key, description] of Object.entries(OPTIONAL_PATH_PARAMS)) {
    if (key in changed) changed[key] = { type: 'string', description }
  }
  const pathRequired = (path.required ?? []).filter((key) => !(key in OPTIONAL_PATH_PARAMS))
  const { required: _pathRequired, ...pathRest } = path
  const pathSchema: JSONObject = {
    ...pathRest,
    properties: changed,
    ...(pathRequired.length > 0 && { required: pathRequired })
  }

  const required = (tool.inputSchema.required ?? []).filter(
    (key) => key !== 'path' || pathRequired.length > 0
  )
  const { required: _required, ...schema } = tool.inputSchema
  const inputSchema: Tool['inputSchema'] = {
    ...schema,
    properties: { ...tool.inputSchema.properties, path: pathSchema },
    ...(required.length > 0 && { required })
  }
  return { ...tool, inputSchema }
}

/** The `path` argument of a generated tool: an object of its path parameters. */
type PathSchema = JSONObject & { properties?: JSONObject; required?: string[] }

/** The API token permissions `tool` accepts, if its method lists them. */
export function permissionsOf(tool: Tool): string[] | undefined {
  const value = operation(tool).extensions?.[PERMISSIONS_EXTENSION]
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((item): item is string => typeof item === 'string') &&
    value.every((item) => item.length > 0)
    ? value
    : undefined
}
