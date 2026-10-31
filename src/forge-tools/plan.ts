import {
  buildRequest,
  InvalidArguments,
  param,
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
  /**
   * The tool takes an account, the caller left it out, and the session has
   * more than one. `argument` is where it goes, such as `path.account_id`.
   */
  | { readonly kind: 'needs_account'; readonly argument: string }
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
  const unknown = unknownArguments(tool, given)
  if (unknown) return { kind: 'invalid', message: unknown }

  let request: HttpRequest
  let accountId: string | undefined
  try {
    const key = accountKey(tool, given)
    let args = given
    if (key && param(given, 'path', key) === undefined) {
      if (!options.sessionAccountId) return { kind: 'needs_account', argument: `path.${key}` }
      args = withPathParam(given, key, options.sessionAccountId)
    }
    request = buildRequest(tool, args, options.baseUrl)
    accountId = accountIdOf(args)
  } catch (error) {
    if (error instanceof InvalidArguments) return { kind: 'invalid', message: error.message }
    throw error
  }
  const permissions = permissionsOf(tool)
  return {
    kind: 'request',
    ...request,
    template: tool.path,
    ...(permissions && { permissions }),
    ...(accountId && { accountId })
  }
}

/** The path parameter that names the account, when the tool takes one for these arguments. */
function accountKey(tool: Tool, args: Args): string | undefined {
  if (tool.path.includes('{account_id}')) return 'account_id'
  if (
    tool.path.startsWith(ACCOUNT_OR_ZONE_PREFIX) &&
    param(args, 'path', 'account_or_zone') === 'accounts'
  ) {
    return 'account_or_zone_id'
  }
  return undefined
}

/**
 * Why `args` can't be used if it has arguments the tool doesn't take, else
 * `undefined`. A tool takes only `path`, `query`, `headers` and `body`, so a
 * parameter passed at the top level, such as `account_id`, would otherwise be
 * ignored; the message names the place it belongs in.
 */
function unknownArguments(tool: Tool, args: Args): string | undefined {
  const properties = tool.inputSchema.properties ?? {}
  const unknown = Object.keys(args).filter((key) => !Object.hasOwn(properties, key))
  if (unknown.length === 0) return undefined
  const hints = unknown.map((key) => {
    const place = Object.keys(properties).find((p) =>
      Object.hasOwn((properties[p] as { properties?: object }).properties ?? {}, key)
    )
    return place
      ? `${key} goes in ${place}: { "${place}": { "${key}": … } }`
      : `${key} is not an argument`
  })
  const takes = Object.keys(properties)
  return `Unknown arguments for ${tool.name}: ${hints.join('; ')}. It takes ${takes.length > 0 ? takes.join(', ') : 'no arguments'}.`
}

/** Returns `args` with the path parameter `key` set to `value`. */
function withPathParam(args: Args, key: string, value: string): Args {
  const path = (args.path ?? {}) as Readonly<Record<string, unknown>>
  return { ...args, path: { ...path, [key]: value } }
}

function accountIdOf(args: Args): string | undefined {
  const id =
    param(args, 'path', 'account_or_zone') === 'accounts'
      ? param(args, 'path', 'account_or_zone_id')
      : param(args, 'path', 'account_id')
  return typeof id === 'string' ? id : undefined
}
