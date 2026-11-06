import { fromJsonSchema, type CallToolRequestParams } from '@modelcontextprotocol/server'
import { buildRequest, operation, type Tool } from '../generated/forge-mcp/_/tool'
import { permissionsOf } from './cloudflare'
import { isolate } from '../lib/isolate'

/** The arguments of a tool call, as the client sent them. */
export type Args = NonNullable<CallToolRequestParams['arguments']>

/** An HTTP request as plain data, which crosses RPC as it is. */
type HttpRequest = ReturnType<typeof buildRequest>

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
 * Plans calling `tool` with `given`: validates them against the tool's input
 * schema, fills in the session's account where the tool takes one and the
 * caller left it out, then builds the request from the tool's operation. The
 * request is plain data, so the plan crosses RPC as it is.
 */
export async function planCall(tool: Tool, given: Args, options: PlanOptions): Promise<CallPlan> {
  // Before filling in the account, so a misplaced account_id is reported as such.
  const invalid = await invalidArguments(tool, given)
  if (invalid) return { kind: 'invalid', message: invalid }
  const template = operation(tool).path
  const key = accountKey(template, given)
  let args = given
  if (key && param(given, key) === undefined) {
    if (!options.sessionAccountId) return { kind: 'needs_account', argument: `path.${key}` }
    args = withPathParam(given, key, options.sessionAccountId)
  }
  let request: HttpRequest
  try {
    request = buildRequest(tool, args, options.baseUrl)
  } catch (error) {
    // An empty path parameter, or a value a query parameter or header can't be.
    return { kind: 'invalid', message: error instanceof Error ? error.message : String(error) }
  }
  const accountId = accountIdOf(args)
  const permissions = permissionsOf(tool)
  return {
    kind: 'request',
    ...request,
    template,
    ...(permissions && { permissions }),
    ...(accountId && { accountId })
  }
}

/** Each tool's argument validator, compiled on its first call, as forge's `registerTools` does. */
const validators = isolate.map<string, ReturnType<typeof fromJsonSchema>>()

/**
 * Why `args` don't fit the tool's input schema, by the MCP SDK's JSON Schema
 * validator, as `McpServer` reports it, or `undefined` when they do. A
 * parameter sent at the top level, as the endpoint tools took it, also gets
 * where it goes.
 */
async function invalidArguments(tool: Tool, args: Args): Promise<string | undefined> {
  const validator = validators.getOrSet(tool.name, () => {
    const schema: Readonly<Record<string, unknown>> = tool.inputSchema
    return fromJsonSchema(schema)
  })
  const result = await validator['~standard'].validate(args)
  if (!result.issues) return undefined
  const issues = result.issues.map((issue) => issue.message).join(', ')
  const hints = misplaced(tool, args)
    .map((hint) => ` ${hint}`)
    .join('')
  return `Input validation error: Invalid arguments for tool ${tool.name}: ${issues}${hints}`
}

/**
 * Where each top-level argument the tool doesn't take goes, when it is a
 * parameter of `path`, `query` or `headers`: `per_page goes in query`.
 */
function misplaced(tool: Tool, args: Args): string[] {
  const properties = (tool.inputSchema.properties ?? {}) as Readonly<
    Record<string, { properties?: Readonly<Record<string, unknown>> }>
  >
  return Object.keys(args).flatMap((name) => {
    if (Object.hasOwn(properties, name)) return []
    const place = ['path', 'query', 'headers'].find((key) =>
      Object.hasOwn(properties[key]?.properties ?? {}, name)
    )
    return place ? [`${name} goes in ${place}: { "${place}": { "${name}": … } }.`] : []
  })
}

/** The path parameter `key` in `args`, if any. */
function param(args: Args, key: string): unknown {
  return (args.path as Readonly<Record<string, unknown>> | undefined)?.[key]
}

/** The path parameter that names the account, when the tool takes one for these arguments. */
function accountKey(template: string, args: Args): string | undefined {
  if (template.includes('{account_id}')) return 'account_id'
  if (
    template.startsWith(ACCOUNT_OR_ZONE_PREFIX) &&
    param(args, 'account_or_zone') === 'accounts'
  ) {
    return 'account_or_zone_id'
  }
  return undefined
}

/** Returns `args` with the path parameter `key` set to `value`. */
function withPathParam(args: Args, key: string, value: string): Args {
  const path = (args.path ?? {}) as Readonly<Record<string, unknown>>
  return { ...args, path: { ...path, [key]: value } }
}

function accountIdOf(args: Args): string | undefined {
  const id =
    param(args, 'account_or_zone') === 'accounts'
      ? param(args, 'account_or_zone_id')
      : param(args, 'account_id')
  return typeof id === 'string' ? id : undefined
}
