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
            responses: resolveRefs(op.responses, spec)
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
