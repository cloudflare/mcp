import type { CallToolResult } from '@modelcontextprotocol/server'
import { authorize, type Connection } from '../api-permissions'
import { filteredListBody, refusalFor } from '../api-refusals'
import { WWW_AUTHENTICATE_META_KEY, type ScopeChallenge } from '../scope-challenge'
import type { FormatToolResult } from '../truncate'

/** One Cloudflare API request a direct tool sent, and Cloudflare's answer. */
export interface ApiCall {
  /** The request method, upper case. */
  readonly method: string
  /** The request path below the API base. It picks a scope's account or zone variant. */
  readonly path: string
  /** The endpoint's path template, such as `/zones/{zone_id}/dns_records`. */
  readonly template: string
  /** The permissions the endpoint accepts, from its tool entry. */
  readonly permissions: readonly string[] | undefined
  /** The HTTP status Cloudflare returned. */
  readonly status: number
  /** The parsed JSON body, or the text of any other body. */
  readonly body: unknown
}

/**
 * The tool result for a direct tool's Cloudflare API request, shared by the
 * endpoint tools (`?codemode=false`) and the forge tools
 * (`?codemode=false&experimentalForge=true`).
 *
 * A refusal, including a list Cloudflare emptied by permission (see
 * `refusalFor`), is an error naming the method, path and status, explained,
 * and asks for a step-up when a missing OAuth scope would let it through. One
 * refused request changed nothing, so the client can retry the call after
 * stepping up. Other failures are errors; anything else is the formatted body.
 *
 * @param call - The request and Cloudflare's answer.
 * @param notes - Extra guidance for an error, such as an unknown-account hint.
 * @returns The tool result.
 */
export function apiCallResult(
  call: ApiCall,
  notes: readonly string[],
  {
    connection,
    scopeChallenge,
    formatResult
  }: { connection: Connection; scopeChallenge: ScopeChallenge; formatResult: FormatToolResult }
): CallToolResult {
  const authorization = authorize(connection, call, call.permissions)
  const refusal = refusalFor(call.status, call.body, call.method, authorization, call.permissions)
  const ok = call.status >= 200 && call.status < 300
  if (ok && !refusal) return { content: [{ type: 'text', text: formatResult(call.body) }] }

  const text = [
    `Cloudflare API error: ${call.method} ${call.path} returned HTTP ${refusal?.status ?? call.status}.`,
    formatResult(refusal?.filtered ? filteredListBody() : call.body),
    refusal?.hint,
    ...notes
  ]
    .filter(Boolean)
    .join('\n\n')
  const failure: CallToolResult = { content: [{ type: 'text', text }], isError: true }
  const challenge = refusal?.scope ? scopeChallenge.require(refusal.scope) : undefined
  return challenge ? { ...failure, _meta: { [WWW_AUTHENTICATE_META_KEY]: [challenge] } } : failure
}
