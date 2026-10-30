const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

/**
 * Extract product from path - the segment after {account_id} or {zone_id}
 * e.g. /accounts/{account_id}/workers/scripts → "workers"
 * e.g. /zones/{zone_id}/dns_records → "dns_records"
 */
export function extractProduct(path: string): string | undefined {
  const accountMatch = path.match(/\/accounts\/\{[^}]+\}\/([^/]+)/)
  if (accountMatch) return accountMatch[1]

  const zoneMatch = path.match(/\/zones\/\{[^}]+\}\/([^/]+)/)
  if (zoneMatch) return zoneMatch[1]

  return undefined
}

/**
 * Forge merges operations that exist under both `/accounts/{account_id}` and
 * `/zones/{zone_id}` into one `/{account_or_zone}/{account_or_zone_id}` path,
 * whose `account_or_zone` is `accounts` or `zones` (cloudflare/forge#59). Each
 * merged path is split back into its account and zone routes, so Code Mode
 * sees paths it can call as written and the direct tools fill in `account_id`
 * as they do for any account route.
 */
const ACCOUNT_OR_ZONE_PREFIX = '/{account_or_zone}/{account_or_zone_id}'

const SCOPES = [
  { segment: 'accounts', idParam: 'account_id' },
  { segment: 'zones', idParam: 'zone_id' }
] as const

type Scope = (typeof SCOPES)[number]

/** The concrete paths a spec path stands for, with the scope it was split into. */
export function concretePaths(path: string): Array<{ path: string; scope?: Scope }> {
  if (!path.startsWith(ACCOUNT_OR_ZONE_PREFIX)) return [{ path }]
  const rest = path.slice(ACCOUNT_OR_ZONE_PREFIX.length)
  return SCOPES.map((scope) => ({ path: `/${scope.segment}/{${scope.idParam}}${rest}`, scope }))
}

/** Rewrite a split operation's resolved parameters for its scope. */
function scopeParameters(parameters: unknown, scope: Scope | undefined): unknown {
  if (!scope || !Array.isArray(parameters)) return parameters
  return parameters.flatMap((parameter: unknown) => {
    const { name, in: location } = (parameter ?? {}) as { name?: unknown; in?: unknown }
    if (location !== 'path') return [parameter]
    if (name === 'account_or_zone') return []
    if (name === 'account_or_zone_id') {
      return [{ ...(parameter as Record<string, unknown>), name: scope.idParam }]
    }
    return [parameter]
  })
}

export function resolveRefs(
  obj: unknown,
  spec: Record<string, unknown>,
  seen = new Set<string>()
): unknown {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map((item) => resolveRefs(item, spec, seen))

  const record = obj as Record<string, unknown>

  if ('$ref' in record && typeof record.$ref === 'string') {
    const ref = record.$ref
    if (seen.has(ref)) return { $circular: ref }
    seen.add(ref)

    const parts = ref.replace('#/', '').split('/')
    let resolved: unknown = spec
    for (const part of parts) {
      resolved = (resolved as Record<string, unknown>)?.[part]
    }
    return resolveRefs(resolved, spec, seen)
  }

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    result[key] = resolveRefs(value, spec, seen)
  }
  return result
}

interface OperationObject {
  summary?: string
  description?: string
  tags?: string[]
  parameters?: unknown
  requestBody?: unknown
  responses?: unknown
  'x-api-token-group'?: unknown
}

/** Keep `x-api-token-group` only when it is a list of permission names. */
function permissionLabels(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.length > 0)
    ? value
    : undefined
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The root properties of an enveloped success schema; any other root property keeps the schema as it is. */
const ENVELOPE_PROPERTIES = new Set(['result', 'result_info', 'success', 'errors', 'messages'])

/** Every `properties` map at a resolved schema's root: its own and its `allOf` members', recursively. */
function rootPropertyMaps(schema: unknown): JsonObject[] {
  if (!isObject(schema)) return []
  return [
    ...(isObject(schema.properties) ? [schema.properties] : []),
    ...(Array.isArray(schema.allOf) ? schema.allOf.flatMap(rootPropertyMaps) : [])
  ]
}

/** One schema, or `allOf` several: every one of them applies. */
function allOf(schemas: unknown[]): unknown {
  return schemas.length === 1 ? schemas[0] : { allOf: schemas }
}

/**
 * A resolved success schema's `result` and `result_info` when it describes the
 * envelope: it declares `result`, and nothing at its root but envelope keys.
 * Each is every declaration of it combined, since an `allOf` of a generic
 * envelope and an operation's own `result` declares `result` twice.
 */
function listingParts(schema: unknown): { result: unknown; resultInfo?: unknown } | undefined {
  const maps = rootPropertyMaps(schema)
  if (!maps.some((map) => 'result' in map)) return undefined
  if (maps.some((map) => Object.keys(map).some((key) => !ENVELOPE_PROPERTIES.has(key)))) {
    return undefined
  }
  const result = allOf(maps.filter((map) => 'result' in map).map((map) => map.result))
  const infos = maps.filter((map) => 'result_info' in map).map((map) => map.result_info)
  return infos.length > 0 ? { result, resultInfo: allOf(infos) } : { result }
}

/**
 * Present each 2xx JSON response schema as the schema of `result`, where
 * `cloudflare.request()` returns the payload. `openapi.forge.json` leaves
 * Cloudflare's envelope out of success schemas: a paginated list is
 * `{ result, result_info }`, anything else is the result itself, or the whole
 * body of an API without the envelope, which `cloudflare.request()` also
 * returns as `result`. So a list's schema becomes its `result`, and its
 * `result_info` schema moves to the response's `x-result-info`.
 */
function resultResponses(responses: unknown): unknown {
  if (!isObject(responses)) return responses
  const out: JsonObject = {}
  for (const [status, response] of Object.entries(responses)) {
    const media = isObject(response) && isObject(response.content) ? response.content : undefined
    const json = media?.['application/json']
    const parts = status.startsWith('2') && isObject(json) ? listingParts(json.schema) : undefined
    out[status] = parts
      ? {
          ...(response as JsonObject),
          content: {
            ...media,
            'application/json': { ...(json as JsonObject), schema: parts.result }
          },
          ...(parts.resultInfo !== undefined && { 'x-result-info': parts.resultInfo })
        }
      : response
  }
  return out
}

/**
 * Process a raw OpenAPI spec into the simplified format used by the search tool.
 * Resolves all $refs inline and extracts only the fields needed for search.
 */
export function processSpec(spec: Record<string, unknown>): {
  paths: Record<string, Record<string, unknown>>
} {
  const rawPaths = (spec.paths || {}) as Record<string, Record<string, OperationObject>>
  const paths: Record<string, Record<string, unknown>> = {}

  for (const [rawPath, pathItem] of Object.entries(rawPaths)) {
    if (!pathItem) continue

    for (const { path, scope } of concretePaths(rawPath)) {
      // A concrete path the spec also lists on its own keeps that entry.
      if (scope && rawPaths[path]) continue
      paths[path] = {}

      for (const method of HTTP_METHODS) {
        const op = pathItem[method]
        if (op) {
          const product = extractProduct(path)
          const tags = op.tags ? [...op.tags] : []
          if (product && !tags.some((t) => t.toLowerCase() === product.toLowerCase())) {
            tags.unshift(product)
          }
          paths[path][method] = {
            summary: op.summary,
            'x-api-token-group': permissionLabels(op['x-api-token-group']),
            description: op.description,
            tags,
            parameters: scopeParameters(resolveRefs(op.parameters, spec), scope),
            requestBody: resolveRefs(op.requestBody, spec),
            responses: resultResponses(resolveRefs(op.responses, spec))
          }
        }
      }
    }
  }

  return { paths }
}

/**
 * Extract sorted product list from the spec paths.
 */
export function extractProducts(spec: Record<string, unknown>): string[] {
  const rawPaths = spec.paths as Record<string, unknown> | undefined
  if (!rawPaths) return []

  const products = new Map<string, number>()
  const concrete = new Set(
    Object.keys(rawPaths).flatMap((path) => concretePaths(path).map((item) => item.path))
  )
  for (const path of [...concrete].sort()) {
    const product = extractProduct(path)
    if (product) {
      products.set(product, (products.get(product) || 0) + 1)
    }
  }

  return [...products.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p)
}
