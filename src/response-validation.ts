import { env, waitUntil } from 'cloudflare:workers'
import type { AuthProps } from './auth/types'
import { SPEC_RELEASE } from './spec-release'
import { recordResponseSchemaMismatch } from './metrics'
import { trimForCheck, type MismatchError } from './response-schema-check'
import { concretePaths, extractProduct } from './spec-processor'

/**
 * Checks direct-tool responses against the response schemas forge generates
 * (`src/generated/forge-mcp`) and records each mismatch, so product teams can
 * fix their schemas before tools advertise an `outputSchema`.
 *
 * The schemas live in the forge tools service with the generated tools, so
 * the check runs there: this Worker trims the body and sends it over RPC, and
 * records what comes back. Nothing here may change or fail a tool result:
 * `checkResponse` returns immediately, the work runs in `waitUntil` after the
 * result is built, and every error is caught. Nothing recorded or logged
 * contains response values, which are customer data.
 */

/** Bodies larger than this are not checked, which bounds the cost of trimming and sending them. */
const MAX_BODY_CHARS = 1_000_000
/** Items checked per array; a schema mismatch almost always repeats in every item. */
const MAX_CHECKED_ITEMS = 25
/** Longest string written to one Analytics Engine blob. */
const MAX_BLOB_CHARS = 512

export interface ResponseCheck {
  /** The MCP tool that made the request. */
  toolName: string
  /** HTTP method, any case. */
  method: string
  /** The path template the tool was built from, e.g. `/zones/{zone_id}/dns_records`. */
  pathTemplate: string
  status: number
  /** The parsed JSON body. */
  body: unknown
  /** Length of the raw body text. */
  bodyChars: number
  props: AuthProps
}

/**
 * Check a direct-tool response against its generated response schema in the
 * background and record any mismatch. Call it for JSON responses only. The
 * endpoint tools and the forge tools both call it. Never throws.
 */
export function checkResponse(check: ResponseCheck): void {
  try {
    const sampleRate = sampleRateFrom(env.RESPONSE_VALIDATION_SAMPLE_RATE)
    if (sampleRate <= 0 || Math.random() >= sampleRate) return
    if (check.bodyChars > MAX_BODY_CHARS) return
    waitUntil(run(check, sampleRate))
  } catch (error) {
    logFailure(check, error)
  }
}

async function run(check: ResponseCheck, sampleRate: number): Promise<void> {
  try {
    // Yield a macrotask so the tool result is serialized and sent first.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const method = check.method.toUpperCase()
    const mismatch = await env.FORGE_TOOLS.checkResponse({
      method,
      pathTemplate: check.pathTemplate,
      ...trimForCheck(check.status, check.body, MAX_CHECKED_ITEMS)
    })
    if (!mismatch) return
    const { errors, ...summary } = mismatch
    const event = {
      toolName: check.toolName,
      method,
      pathTemplate: check.pathTemplate,
      product: productOf(check.pathTemplate),
      status: check.status,
      sampleInterval: 1 / sampleRate,
      // Ties the mismatch to the exact schema after the spec moves on.
      specRelease: SPEC_RELEASE,
      ...summary
    }
    recordResponseSchemaMismatch(check.props, { ...event, first: clip(errors[0]) })
    console.warn(JSON.stringify({ message: 'response_schema_mismatch', ...event, errors }))
  } catch (error) {
    logFailure(check, error)
  }
}

/** `RESPONSE_VALIDATION_SAMPLE_RATE` as a fraction in [0, 1]. Unset or invalid means 1. */
export function sampleRateFrom(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 1
  const rate = Number(value)
  if (!Number.isFinite(rate)) return 1
  return Math.min(1, Math.max(0, rate))
}

/**
 * The product a template belongs to, to route a mismatch to its team: the
 * segment after `{account_id}`/`{zone_id}` (also in a merged
 * `/{account_or_zone}/…` template), else the first segment.
 */
export function productOf(pathTemplate: string): string {
  const [{ path }] = concretePaths(pathTemplate)
  return extractProduct(path) ?? path.split('/')[1] ?? 'unknown'
}

/** A violation's fields cut to fit an Analytics Engine blob. */
function clip({ keyword, schemaLocation, instancePath }: MismatchError): MismatchError {
  return {
    keyword: keyword.slice(0, MAX_BLOB_CHARS),
    schemaLocation: schemaLocation.slice(0, MAX_BLOB_CHARS),
    instancePath: instancePath.slice(0, MAX_BLOB_CHARS)
  }
}

function logFailure(check: ResponseCheck, error: unknown): void {
  try {
    console.warn(
      JSON.stringify({
        message: 'response_validation_failed',
        toolName: check.toolName,
        method: check.method,
        pathTemplate: check.pathTemplate,
        status: check.status,
        // Validator and RPC errors name schemas, never response values.
        error: String(error instanceof Error ? error.message : error).slice(0, 300)
      })
    )
  } catch {
    // Logging must not throw either.
  }
}
