import {
  buildRequest,
  InvalidArguments,
  type Args,
  type HttpRequest,
  type Tool
} from '../generated/forge-mcp/_/tool'
import { permissionsOf } from './cloudflare'

const ACCOUNT_OR_ZONE_PREFIX = '/{account_or_zone}/{account_or_zone_id}'

/** What the main Worker passes with each call: nothing secret. */
export interface PlanOptions {
  /** The Cloudflare API base URL, such as `https://api.cloudflare.com/client/v4`. */
  readonly baseUrl: string
  /** The session's account when it has exactly one, to fill in an omitted account. */
  readonly sessionAccountId?: string
}

/**
 * What calling a generated tool takes. The tools service plans the call; the
 * main Worker adds the session's token, sends the request, and explains a
 * refusal. The plan carries no credentials.
 */
export type CallPlan =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'invalid'; readonly message: string }
  /** The tool takes an account, the caller left it out, and the session has more than one. */
  | { readonly kind: 'needs_account' }
  | (HttpRequest & {
      readonly kind: 'request'
      /** The tool's path template, such as `/accounts/{account_id}/d1/database`. */
      readonly template: string
      /** The API token permissions the method accepts. */
      readonly permissions?: readonly string[]
      /** The account the request names, if any, for explaining a refusal. */
      readonly accountId?: string
    })

/**
 * Plans calling `tool` with `given`: fills in the session's account where the
 * tool takes one and the caller left it out, then builds the request with the
 * tool's generated code. The request is plain data, so the plan crosses RPC
 * as it is.
 */
export function planCall(tool: Tool, given: Args, options: PlanOptions): CallPlan {
  const key = accountKey(tool, given)
  let args = given
  if (key && given[key] === undefined) {
    if (!options.sessionAccountId) return { kind: 'needs_account' }
    args = { ...given, [key]: options.sessionAccountId }
  }

  let request: HttpRequest
  try {
    request = buildRequest(tool, args, options.baseUrl)
  } catch (error) {
    if (error instanceof InvalidArguments) return { kind: 'invalid', message: error.message }
    throw error
  }
  const permissions = permissionsOf(tool)
  const accountId = accountIdOf(args)
  return {
    kind: 'request',
    ...request,
    template: tool.path,
    ...(permissions && { permissions }),
    ...(accountId && { accountId })
  }
}

/** The argument that names the account, when the tool takes one for these arguments. */
function accountKey(tool: Tool, args: Args): string | undefined {
  if (tool.path.includes('{account_id}')) return 'account_id'
  if (tool.path.startsWith(ACCOUNT_OR_ZONE_PREFIX) && args.account_or_zone === 'accounts') {
    return 'account_or_zone_id'
  }
  return undefined
}

function accountIdOf(args: Args): string | undefined {
  const id = args.account_or_zone === 'accounts' ? args.account_or_zone_id : args.account_id
  return typeof id === 'string' ? id : undefined
}
