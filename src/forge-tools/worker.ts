/**
 * The forge tools service: the Worker that holds the generated direct tools
 * (`src/generated/forge-mcp`) and serves them to the main Worker over RPC, so
 * isolates serving Code Mode never compile them.
 *
 * It holds no credentials and makes no requests. `list` returns the tools as
 * `tools/list` sends them; `plan` builds the request a call makes, which the
 * main Worker sends with the session's token; `checkResponse` checks a
 * response against the generated response schemas. It has no public route:
 * the main Worker reaches it through its `FORGE_TOOLS` service binding.
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import {
  buildRequest,
  InvalidArguments,
  listTools,
  tools as generatedTools,
  toolsByName,
  type Args
} from '../generated/forge-mcp'
import { cloudflareTool } from './cloudflare'
import { planCall, type CallPlan, type PlanOptions } from './plan'
import { findMismatch, type Mismatch, type TrimmedResponse } from '../response-schema-check'
import { concretePaths } from '../spec-processor'

/** The generated tools with the Cloudflare policy, built once per isolate. */
const tools = generatedTools.map(cloudflareTool)

let listing: string | undefined
let byOperation: Map<string, (typeof tools)[number]> | undefined

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
   * cost the caller hundreds of milliseconds of CPU to decode.
   */
  listJson(): string {
    listing ??= JSON.stringify(listTools(tools))
    return listing
  }

  /** The request calling the tool `name` with `args` makes, or why it can't be made. */
  plan(name: string, args: Args, options: PlanOptions): Promise<CallPlan> {
    const tool = toolsByName(tools).get(name)
    if (!tool) return Promise.resolve({ kind: 'unknown' })
    return planCall(tool, args, options, buildRequest, (error) => error instanceof InvalidArguments)
  }

  /**
   * Check a trimmed response body against the response schemas of the
   * generated tool for its operation. Returns `null` when it matches or there
   * is no schema to check against.
   */
  checkResponse(check: ResponseCheck): CheckedMismatch | null {
    const tool = toolsByOperation().get(`${check.method} ${check.pathTemplate}`)
    if (!tool?.responses) return null
    const mismatch = findMismatch(tool.responses, check, tool.name)
    return mismatch ? { forgeTool: tool.name, ...mismatch } : null
  }

  override fetch(): Response {
    return new Response('Not found', { status: 404 })
  }
}
