import {
  acceptedPermissions,
  explainRefusal,
  findOperation,
  type Connection
} from './api-permissions'
import { getSpecPaths } from './isolate-cache'

/**
 * Header `GlobalOutbound` sets on a refused response so the `execute` sandbox
 * can put the explanation in the error it throws. URI-encoded.
 */
export const REFUSAL_HINT_HEADER = 'X-Cloudflare-MCP-Refusal-Hint'

/**
 * Explain a 401 or 403 from the Cloudflare API for the request that got it.
 *
 * Reads `spec.json` only for refused requests, to look up the permissions the
 * endpoint accepts. Without the spec it still explains the status.
 *
 * @param status - The HTTP status Cloudflare returned.
 * @param connection - The credential that made the request.
 * @param method - The request method.
 * @param path - The request path below the API base.
 * @returns Guidance for the agent, or `undefined` for other statuses.
 */
export async function explainRefusedRequest(
  status: number,
  connection: Connection,
  method: string,
  path: string
): Promise<string | undefined> {
  if (status !== 401 && status !== 403) return undefined
  const paths = await getSpecPaths().catch(() => undefined)
  const operation = paths ? findOperation(paths, method, path) : undefined
  return explainRefusal(status, connection, acceptedPermissions(operation))
}
