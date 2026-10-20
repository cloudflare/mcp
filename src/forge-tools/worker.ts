/**
 * The forge tools service: the Worker that holds the generated direct tools
 * (`src/generated/forge-mcp`) and serves them to the main Worker over RPC, so
 * isolates serving Code Mode never compile them.
 *
 * It holds no credentials and makes no requests. `list` returns the tools as
 * `tools/list` sends them; `plan` builds the request a call makes, which the
 * main Worker sends with the session's token. It has no public route: the
 * main Worker reaches it through its `FORGE_TOOLS` service binding.
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

/** The generated tools with the Cloudflare policy, built once per isolate. */
const tools = generatedTools.map(cloudflareTool)

export default class ForgeTools extends WorkerEntrypoint {
  /**
   * The generated tools, as `tools/list` sends them. Typed as plain objects:
   * the SDK's `Tool` type is too deep for the RPC stub types.
   */
  list(): Record<string, unknown>[] {
    return listTools(tools) as unknown as Record<string, unknown>[]
  }

  /** The request calling the tool `name` with `args` makes, or why it can't be made. */
  plan(name: string, args: Args, options: PlanOptions): Promise<CallPlan> {
    const tool = toolsByName(tools).get(name)
    if (!tool) return Promise.resolve({ kind: 'unknown' })
    return planCall(tool, args, options, buildRequest, (error) => error instanceof InvalidArguments)
  }

  override fetch(): Response {
    return new Response('Not found', { status: 404 })
  }
}
