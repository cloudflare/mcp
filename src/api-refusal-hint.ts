import {
  acceptedPermissions,
  explainRefusal,
  findOperation,
  scopeToRequest,
  type Connection
} from './api-permissions'
import { getSpecPaths } from './isolate-cache'

/**
 * Header `GlobalOutbound` sets on a refused response so the `execute` sandbox
 * can put the explanation in the error it throws. URI-encoded.
 */
export const REFUSAL_HINT_HEADER = 'X-Cloudflare-MCP-Refusal-Hint'

/** Header `GlobalOutbound` sets on a refused response naming the OAuth scope to challenge for. */
export const MISSING_SCOPE_HEADER = 'X-Cloudflare-MCP-Missing-Scope'

/** What a refused Cloudflare API request tells the agent and the client. */
export interface Refusal {
  /** Guidance for the agent. */
  readonly hint: string
  /** The OAuth scope that would let the request through, when one can be named. */
  readonly scope: string | undefined
}

/**
 * Explain a 401 or 403 for an endpoint whose permissions are already known.
 *
 * @param status - The HTTP status Cloudflare returned.
 * @param connection - The credential that made the request.
 * @param method - The request method.
 * @param template - The endpoint's path template, such as `/zones/{zone_id}/dns_records`.
 * @param operation - Where the endpoint's `x-api-token-group` comes from.
 * @returns The refusal, or `undefined` for other statuses.
 */
export function explainRefusalFor(
  status: number,
  connection: Connection,
  method: string,
  template: string,
  operation: { readonly 'x-api-token-group'?: unknown } | undefined
): Refusal | undefined {
  const permissions = acceptedPermissions(operation)
  const hint = explainRefusal(status, connection, permissions)
  if (!hint) return undefined
  return { hint, scope: scopeToRequest(status, connection, method, template, permissions) }
}

/**
 * Explain a 401 or 403 from the Cloudflare API for the request that got it,
 * looking the endpoint up in `spec.json`. For `execute`, which sends arbitrary paths.
 *
 * Reads `spec.json` only for refused requests, to look up the permissions the
 * endpoint accepts. Without the spec it still explains the status.
 *
 * @param status - The HTTP status Cloudflare returned.
 * @param connection - The credential that made the request.
 * @param method - The request method.
 * @param path - The request path below the API base.
 * @returns The refusal, or `undefined` for other statuses.
 */
export async function explainRefusedRequest(
  status: number,
  connection: Connection,
  method: string,
  path: string
): Promise<Refusal | undefined> {
  if (status !== 401 && status !== 403) return undefined
  const paths = await getSpecPaths().catch(() => undefined)
  const match = paths ? findOperation(paths, method, path) : undefined
  return explainRefusalFor(status, connection, method, match?.template ?? path, match?.operation)
}
