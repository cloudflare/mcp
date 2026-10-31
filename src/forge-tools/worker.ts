/**
 * The forge tools service: the Worker that holds the generated direct tools
 * (`src/generated/forge-mcp`) and serves them to the main Worker over RPC, so
 * isolates serving Code Mode never compile them.
 *
 * It holds no credentials and makes no requests. `search` runs Code Mode's
 * search code against the pinned spec in a sandbox with no network access, so
 * the spec stays in this Worker. `listJson` returns the tools
 * as `tools/list` sends them, optionally with their output schemas; `plan` builds the request a call makes, which the
 * main Worker sends with the session's token; `checkResponse` checks a
 * response against the generated response schemas; `specArtifact` streams
 * one of the pinned release's spec artifacts (`./spec`). It has no public route:
 * the main Worker reaches it through its `FORGE_TOOLS` service binding.
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import { listTools, tools as generatedTools, toolsByName, type Args } from '../generated/forge-mcp'
import { cloudflareTool } from './cloudflare'
import { planCall, type CallPlan, type PlanOptions } from './plan'
import { findMismatch, type Mismatch, type TrimmedResponse } from '../response-schema-check'
import type { SpecArtifactName } from '../spec-release'
import { SPEC_ARTIFACTS, isSpecArtifactName } from './spec'
import { runSearch, type SearchOutcome } from './search'
import { isolate } from '../lib/isolate'

/** The generated tools with the Cloudflare policy, built once per isolate. */
const tools = generatedTools.map(cloudflareTool)

/** `tools/list` as one JSON string, with and without output schemas. */
const listing = isolate.lazy(() => JSON.stringify(listTools(tools)))
const listingWithOutput = isolate.lazy(() =>
  JSON.stringify(listTools(tools, { outputSchema: true }))
)

/** The generated tools by `METHOD template`, the key a direct tool's response check names. */
const toolsByOperation = isolate.lazy(
  () => new Map(tools.map((tool) => [`${tool.method} ${tool.path}`, tool]))
)

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
    return outputSchema ? listingWithOutput() : listing()
  }

  /** The request calling the tool `name` with `args` makes, or why it can't be made. */
  plan(name: string, args: Args, options: PlanOptions): CallPlan {
    const tool = toolsByName(tools).get(name)
    return tool ? planCall(tool, args, options) : { kind: 'unknown' }
  }

  /**
   * Check a trimmed response body against the response schemas of the
   * generated tool for its operation. Each schema describes the whole body as
   * the API sends it, Cloudflare's envelope included. Returns `null` when it
   * matches or there is no schema to check against.
   */
  checkResponse(check: ResponseCheck): CheckedMismatch | null {
    const tool = toolsByOperation().get(`${check.method} ${check.pathTemplate}`)
    const mismatch = tool?.responses && findMismatch(tool.responses, check, tool.name)
    return mismatch ? { forgeTool: tool.name, ...mismatch } : null
  }

  /** Runs `code`, an async arrow function, against the pinned spec (`./search`). */
  search(code: string): Promise<SearchOutcome> {
    return runSearch(this.env.LOADER, code)
  }

  /**
   * One of the pinned release's spec artifacts, as UTF-8 bytes. A stream, since
   * `spec.json` is close to RPC's 32 MiB message limit and streams have none.
   */
  specArtifact(name: SpecArtifactName): ReadableStream<Uint8Array> {
    if (!isSpecArtifactName(name)) throw new TypeError(`Unknown spec artifact: ${String(name)}`)
    return new Blob([SPEC_ARTIFACTS[name]]).stream()
  }

  override fetch(): Response {
    return new Response('Not found', { status: 404 })
  }
}
