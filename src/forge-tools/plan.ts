import { dereference, validate, type Schema } from '@cfworker/json-schema'
import {
  buildRequest,
  InvalidArguments,
  param,
  type Args,
  type HttpRequest,
  type Tool
} from '../generated/forge-mcp/_/tool'
import { permissionsOf } from './cloudflare'
import { isolate } from '../lib/isolate'

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
    const invalid = argumentErrors(tool, args)
    if (invalid) return { kind: 'invalid', message: invalid }
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

/** Each tool's input schema, compiled once per isolate. */
const inputSchemas = isolate.map<string, { root: Schema; lookup: ReturnType<typeof dereference> }>()

/** Keywords whose errors only say that a nested error happened. */
const NESTING_KEYWORDS = new Set(['properties', 'items', 'allOf', 'anyOf', 'oneOf', '$ref'])

/**
 * Why `args` don't match `tool`'s input schema, or `undefined` when they do,
 * so a wrong type such as `query.per_page: "two"` is refused here with the
 * argument's name rather than by the API. `buildRequest` has already refused
 * unknown and missing arguments.
 */
function argumentErrors(tool: Tool, args: Args): string | undefined {
  const { root, lookup } = inputSchemas.getOrSet(tool.name, () => {
    // The validator annotates the schemas it indexes, so it gets a copy.
    const root = structuredClone(tool.inputSchema) as Schema
    return { root, lookup: dereference(root) }
  })
  const result = validate(args, root, '2020-12', lookup, false)
  if (result.valid) return undefined
  const leaves = result.errors.filter((error) => !NESTING_KEYWORDS.has(error.keyword))
  const shown = (leaves.length > 0 ? leaves : result.errors).slice(0, 3).map((error) => {
    const at = error.instanceLocation.replace(/^#\/?/, '').split('/').join('.')
    return `${at || 'arguments'}: ${error.error}`
  })
  return `Invalid arguments for ${tool.name}: ${shown.join('; ')}`
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
