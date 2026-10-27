/**
 * Cloudflare wraps most response bodies in an envelope,
 * `{ success, errors, messages, result }`, but `openapi.forge.json` describes
 * a success body without it: most 2xx schemas drop `success`, `errors` and
 * `messages`, and an operation that isn't a paginated list gives only the
 * schema of its `result`. Paginated lists keep `{ result, result_info }`, a
 * few operations keep the whole envelope, and error schemas keep it too.
 *
 * The direct tools read the part of a success body that the generated schemas
 * describe, its payload, to check it and to send it as `structuredContent`.
 * The forge tools service decides from the schemas, once per isolate, which
 * kind each tool's success schema is; this module imports no validator, so the
 * main Worker can use it too.
 */

/**
 * What a success schema describes of an envelope: only its `result`, or the
 * envelope itself, as `{ result, result_info }` or, for some operations, the
 * whole envelope.
 */
export type PayloadKind = 'result' | 'listing'

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether `body` is Cloudflare's response envelope. APIs that don't wrap their responses never match. */
export function isEnvelope(body: unknown): body is JsonObject & { result: unknown } {
  return isObject(body) && typeof body.success === 'boolean' && 'result' in body
}

/**
 * Whether `schema` describes an envelope's `{ result, … }` rather than the
 * `result` itself: it declares a `result` property at its root, directly,
 * through a `$ref` into `defs` or `allOf`, or in every branch of a `oneOf` or
 * `anyOf`.
 */
export function declaresResult(
  schema: unknown,
  defs: Readonly<Record<string, unknown>> = {},
  seen: Set<string> = new Set()
): boolean {
  if (!isObject(schema)) return false
  if (typeof schema.$ref === 'string') {
    const key = schema.$ref.replace(/^#\/\$defs\//, '')
    if (seen.has(key)) return false
    seen.add(key)
    return declaresResult(defs[key], defs, seen)
  }
  if (isObject(schema.properties) && 'result' in schema.properties) return true
  if (Array.isArray(schema.allOf) && schema.allOf.some((s) => declaresResult(s, defs, seen))) {
    return true
  }
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const branches = schema[keyword]
    if (Array.isArray(branches) && branches.length > 0) {
      return branches.every((s) => declaresResult(s, defs, new Set(seen)))
    }
  }
  return false
}

/**
 * The part of a success body the generated schemas describe, and where it sits
 * in the body (`/result` or the root): an envelope's `result` when the schema
 * describes only that, else the whole body. A schema that declares `result`
 * leaves the envelope's other keys undeclared, which it allows, and some keep
 * the envelope and require `success`, so the body stays whole.
 */
export function payloadOf(
  body: unknown,
  kind: PayloadKind
): { payload: unknown; at: '' | '/result' } {
  return kind === 'result' && isEnvelope(body)
    ? { payload: body.result, at: '/result' }
    : { payload: body, at: '' }
}
