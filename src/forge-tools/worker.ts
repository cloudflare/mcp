/**
 * The forge tools service: the Worker that holds the generated direct tools
 * (`src/generated/forge-mcp`) and serves them to the main Worker over RPC, so
 * isolates serving Code Mode never compile them.
 *
 * It holds no credentials and makes no requests. `listJson` returns the tools
 * as `tools/list` sends them, optionally with their output schemas; `plan` builds the request a call makes, which the
 * main Worker sends with the session's token; `checkResponse` checks a
 * response against the generated response schemas. It has no public route:
 * the main Worker reaches it through its `FORGE_TOOLS` service binding.
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import { listTools, tools as generatedTools, toolsByName, type Args } from '../generated/forge-mcp'
import { cloudflareTool } from './cloudflare'
import { planCall, type CallPlan, type PlanOptions } from './plan'
import {
  findMismatch,
  responseKeyFor,
  type Mismatch,
  type TrimmedResponse
} from '../response-schema-check'
import { declaresResult, payloadOf, type PayloadKind } from './envelope'
import { concretePaths } from '../spec-processor'

/** The generated tools with the Cloudflare policy, built once per isolate. */
const tools = generatedTools.map(cloudflareTool)

let listing: string | undefined
let listingWithOutput: string | undefined
let byOperation: Map<string, (typeof tools)[number]> | undefined
const payloadKinds = new Map<string, PayloadKind>()

type ForgeTool = (typeof tools)[number]

/**
 * What a tool's success schema describes of Cloudflare's envelope
 * (`./envelope`): the schema of response `key`, or with no key the output
 * schema. Decided once per tool and key per isolate.
 */
function payloadKind(tool: ForgeTool, key?: string): PayloadKind {
  const cacheKey = `${tool.name} ${key ?? 'output'}`
  let kind = payloadKinds.get(cacheKey)
  if (!kind) {
    const schema = key ? tool.responses?.schemas[key] : tool.outputSchema
    const defs = key ? tool.responses?.$defs : (tool.outputSchema?.$defs as Record<string, unknown>)
    kind = declaresResult(schema, defs ?? {}) ? 'listing' : 'result'
    payloadKinds.set(cacheKey, kind)
  }
  return kind
}

/**
 * The part of a trimmed success response the schema of response `key`
 * describes, with the trimmed arrays' locations moved to match, and where that
 * part sits in the body.
 */
function checkedPayload(
  tool: ForgeTool,
  key: string,
  response: TrimmedResponse
): { response: TrimmedResponse; at: '' | '/result' } {
  if (!key.startsWith('2')) return { response, at: '' }
  const { payload, at } = payloadOf(response.body, payloadKind(tool, key))
  if (!at) return { response: { ...response, body: payload }, at }
  const trimmed = response.trimmed
    .filter((location) => location === `#${at}` || location.startsWith(`#${at}/`))
    .map((location) => `#${location.slice(at.length + 1)}`)
  return { response: { ...response, body: payload, trimmed }, at }
}

/**
 * The generated tools by `METHOD template`. A tool on a merged
 * `/{account_or_zone}/…` path is also found by the account and zone routes
 * `processSpec` splits it into, which the endpoint tools (`?codemode=false`)
 * use; a route the spec lists on its own keeps its own tool.
 */
function toolsByOperation() {
  if (!byOperation) {
    byOperation = new Map(tools.map((tool) => [`${tool.method} ${tool.path}`, tool]))
    for (const tool of tools) {
      for (const { path } of concretePaths(tool.path)) {
        const key = `${tool.method} ${path}`
        if (!byOperation.has(key)) byOperation.set(key, tool)
      }
    }
  }
  return byOperation
}

/**
 * A call plan, with, for a request to a tool that has an output schema, what
 * of a successful response the output schema describes.
 */
export type ToolCallPlan =
  | Exclude<CallPlan, { kind: 'request' }>
  | (Extract<CallPlan, { kind: 'request' }> & { readonly payload?: PayloadKind })

/** A direct-tool response to check against the generated response schemas. */
export interface ResponseCheck extends TrimmedResponse {
  /** HTTP method, upper case. */
  method: string
  /** The path template of the tool that made the request. */
  pathTemplate: string
}

/** A mismatch, with the generated tool whose response schema it broke. */
export interface CheckedMismatch extends Mismatch {
  forgeTool: string
}

export default class ForgeTools extends WorkerEntrypoint {
  /**
   * The generated tools as `tools/list` sends them, as one JSON string built
   * once per isolate. A string crosses RPC as bytes; ~3,000 nested objects
   * cost the caller hundreds of milliseconds of CPU to decode. With
   * `outputSchema`, each tool carries its generated output schema.
   */
  listJson({ outputSchema = false }: { outputSchema?: boolean } = {}): string {
    if (outputSchema) {
      listingWithOutput ??= JSON.stringify(listTools(tools, { outputSchema: true }))
      return listingWithOutput
    }
    listing ??= JSON.stringify(listTools(tools))
    return listing
  }

  /**
   * The request calling the tool `name` with `args` makes, or why it can't be
   * made, and what of a successful response its output schema describes.
   */
  plan(name: string, args: Args, options: PlanOptions): ToolCallPlan {
    const tool = toolsByName(tools).get(name)
    if (!tool) return { kind: 'unknown' }
    const plan = planCall(tool, args, options)
    return plan.kind === 'request' && tool.outputSchema
      ? { ...plan, payload: payloadKind(tool) }
      : plan
  }

  /**
   * Check a trimmed response body against the response schemas of the
   * generated tool for its operation. Returns `null` when it matches or there
   * is no schema to check against.
   */
  checkResponse(check: ResponseCheck): CheckedMismatch | null {
    const tool = toolsByOperation().get(`${check.method} ${check.pathTemplate}`)
    if (!tool?.responses) return null
    const key = responseKeyFor(tool.responses.schemas, check.status)
    if (!key) return null
    // A success schema describes the envelope's payload (./envelope).
    const { response, at } = checkedPayload(tool, key, check)
    const mismatch = findMismatch(tool.responses, response, tool.name)
    if (!mismatch) return null
    // Name each violation where it is in the response, not in the payload.
    const errors = mismatch.errors.map((error) => ({
      ...error,
      instancePath: at + (error.instancePath === '/' ? '' : error.instancePath) || '/'
    }))
    return { forgeTool: tool.name, ...mismatch, errors }
  }

  override fetch(): Response {
    return new Response('Not found', { status: 404 })
  }
}
