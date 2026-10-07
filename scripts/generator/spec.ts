/**
 * Build `spec.json` and `products.json` from a Forge OpenAPI document.
 *
 * `spec.json` is what the `search` tool's sandbox queries: every operation with
 * its `$ref`s inlined and only the fields search needs. `products.json` lists
 * products by operation count for the `search` tool description. A product is
 * the first Forge SDK group (`x-fern-sdk-group-name`), the same grouping that
 * names the direct tools, e.g. `dns` for `dns_records_create`.
 */

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

interface OperationObject {
  summary?: string
  description?: string
  tags?: string[]
  parameters?: unknown
  requestBody?: unknown
  responses?: unknown
  'x-fern-sdk-group-name'?: unknown
}

export interface SearchSpec {
  paths: Record<string, Record<string, unknown>>
}

/** The operation's product: its first Forge SDK group, else the path segment after the account or zone. */
export function productOf(path: string, operation: OperationObject): string | undefined {
  const group = operation['x-fern-sdk-group-name']
  const first = Array.isArray(group) ? group[0] : group
  if (typeof first === 'string' && first) return first.split('.')[0]
  return /\/(?:accounts|zones)\/\{[^}]+\}\/([^/]+)/.exec(path)?.[1]
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

    let resolved: unknown = spec
    for (const part of ref.replace('#/', '').split('/')) {
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

/** Inline `$ref`s, tag each operation with its product, and count products. */
export function processSpec(source: Record<string, unknown>): {
  spec: SearchSpec
  products: string[]
} {
  const rawPaths = (source.paths ?? {}) as Record<string, Record<string, OperationObject>>
  const paths: SearchSpec['paths'] = {}
  const counts = new Map<string, number>()

  for (const [path, pathItem] of Object.entries(rawPaths)) {
    if (!pathItem) continue
    paths[path] = {}

    for (const method of HTTP_METHODS) {
      const op = pathItem[method]
      if (!op) continue
      const product = productOf(path, op)
      const tags = op.tags ? [...op.tags] : []
      if (product) {
        counts.set(product, (counts.get(product) ?? 0) + 1)
        if (!tags.some((tag) => tag.toLowerCase() === product.toLowerCase())) tags.unshift(product)
      }
      paths[path][method] = {
        summary: op.summary,
        description: op.description,
        tags,
        parameters: resolveRefs(op.parameters, source),
        requestBody: resolveRefs(op.requestBody, source),
        responses: resolveRefs(op.responses, source)
      }
    }
  }

  const products = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([product]) => product)
  return { spec: { paths }, products }
}
