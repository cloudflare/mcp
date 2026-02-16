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

  for (const [path, pathItem] of Object.entries(rawPaths)) {
    if (!pathItem) continue
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
          description: op.description,
          tags,
          parameters: resolveRefs(op.parameters, spec),
          requestBody: resolveRefs(op.requestBody, spec),
          responses: resolveRefs(op.responses, spec)
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
  for (const path of Object.keys(rawPaths).sort()) {
    const product = extractProduct(path)
    if (product) {
      products.set(product, (products.get(product) || 0) + 1)
    }
  }

  return [...products.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p)
}
