/** JSON Schema value emitted in a tool's inputSchema. */
export type JsonSchema = boolean | Record<string, unknown>

/** Narrow an OpenAPI object without changing its contents. */
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  // SAFETY: non-null, non-array JSON objects have string keys and unknown values.
  return value as Record<string, unknown>
}

/** Resolve a local JSON Pointer against a bundled OpenAPI document. */
function lookup(document: unknown, ref: string): unknown {
  if (!ref.startsWith('#/'))
    throw new Error(`MCP generation requires bundled local references: ${ref}`)
  let target = document
  for (const segment of ref.slice(2).split('/')) {
    target = record(target)[decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~')]
  }
  if (target === undefined) throw new Error(`Missing MCP reference: ${ref}`)
  return target
}

/** Resolve parameter and request-body references, keeping reference siblings. */
export function resolve(value: unknown, document: unknown): Record<string, unknown> {
  let current = record(value)
  const visited = new Set<string>()
  while (typeof current.$ref === 'string') {
    const ref = current.$ref
    if (visited.has(ref)) throw new Error(`Cyclic MCP parameter or request-body reference: ${ref}`)
    visited.add(ref)
    current = {
      ...record(lookup(document, ref)),
      ...Object.fromEntries(Object.entries(current).filter(([key]) => key !== '$ref'))
    }
  }
  return current
}

/** Explicit Forge exclusion, including exclusions on referenced components. */
export function ignored(value: unknown, document: unknown): boolean {
  return resolve(value, document)['x-fern-ignore'] === true
}

/** Apply the schema-related Forge parameter overrides without flattening fields. */
export function applyOverride(schema: JsonSchema, override: Record<string, unknown>): JsonSchema {
  if (schema === false) return false
  let result = { ...record(schema) }
  if (override.array === true && result.type !== 'array') result = { type: 'array', items: result }
  if (Array.isArray(override.choices)) {
    if (result.type === 'array') result.items = { ...record(result.items), enum: override.choices }
    else result.enum = override.choices
  }
  if (override.default === null) delete result.default
  else if (override.default !== undefined) result.default = override.default
  if (typeof override.description === 'string') result.description = override.description
  return result
}

const MAPS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas'
])
const LISTS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const SINGLE = new Set([
  'items',
  'additionalProperties',
  'additionalItems',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems'
])

/**
 * Copy request schemas into a self-contained JSON Schema 2020-12 tool schema.
 * Only reachable references are copied, into local $defs. Reserving a definition
 * before visiting it preserves recursive schemas without expansion or truncation.
 */
export function schemaCompiler(document: unknown) {
  const definitions = new Map<string, JsonSchema>()
  const refs = new Map<string, string>()
  const openapi30 =
    typeof record(document).openapi === 'string' &&
    String(record(document).openapi).startsWith('3.0.')

  function convert(
    value: unknown,
    overrides: Record<string, unknown> = {},
    path: string[] = []
  ): JsonSchema {
    if (typeof value === 'boolean') return value
    const source = record(value)
    if (source['x-fern-ignore'] === true) return false
    const out = new Map<string, unknown>()
    const omitted = new Set<string>()
    for (const [key, item] of Object.entries(source)) {
      if (key === '$ref' && typeof item === 'string') {
        // Keep the same component separate when different body paths customize it.
        const scope = Object.fromEntries(
          Object.entries(overrides).filter(
            ([key]) =>
              path.length === 0 || key === path.join('.') || key.startsWith(`${path.join('.')}.`)
          )
        )
        const identity = `${item}\0${JSON.stringify(scope)}`
        let name = refs.get(identity)
        if (!name) {
          name = `schema${refs.size}`
          refs.set(identity, name)
          definitions.set(name, {})
          definitions.set(name, convert(lookup(document, item), scope, path))
        }
        out.set('$ref', `#/$defs/${name}`)
      } else if (key === 'properties') {
        const properties = new Map<string, JsonSchema>()
        for (const [name, field] of Object.entries(record(item))) {
          const fieldPath = [...path, name]
          const override = record(overrides[fieldPath.join('.')])
          const resolved = resolve(field, document)
          if (
            resolved['x-fern-ignore'] === true ||
            resolved.readOnly === true ||
            override.hidden === true
          ) {
            omitted.add(name)
            continue
          }
          // Resolve the field root only when an override replaces its constraints.
          const customized = Object.keys(override).length ? resolved : field
          properties.set(name, applyOverride(convert(customized, overrides, fieldPath), override))
        }
        out.set(key, Object.fromEntries(properties))
      } else if (MAPS.has(key)) {
        out.set(
          key,
          Object.fromEntries(
            Object.entries(record(item)).map(([name, schema]) => [name, convert(schema)])
          )
        )
      } else if (LISTS.has(key) && Array.isArray(item)) {
        out.set(
          key,
          item.map((schema) => convert(schema, overrides, path))
        )
      } else if (SINGLE.has(key)) {
        out.set(key, convert(item, overrides, path))
      } else if (
        key === 'nullable' ||
        (openapi30 && ['exclusiveMinimum', 'exclusiveMaximum'].includes(key))
      ) {
        continue
      } else if (
        key.startsWith('x-') ||
        ['discriminator', 'xml', 'externalDocs', 'example'].includes(key)
      ) {
        // OpenAPI-only metadata is not a JSON Schema assertion.
        continue
      } else {
        out.set(key, item)
      }
    }
    const required = new Set(
      Array.isArray(source.required)
        ? source.required.filter((name): name is string => typeof name === 'string')
        : []
    )
    for (const name of Object.keys(record(source.properties))) {
      const override = record(overrides[[...path, name].join('.')])
      if (override.required === true) required.add(name)
      if (override.required === false || omitted.has(name)) required.delete(name)
    }
    if (source.required !== undefined || required.size) out.set('required', [...required])
    if (openapi30) {
      for (const [exclusive, bound] of [
        ['exclusiveMinimum', 'minimum'],
        ['exclusiveMaximum', 'maximum']
      ] as const) {
        if (source[exclusive] === true && typeof source[bound] === 'number') {
          out.set(exclusive, source[bound])
          out.delete(bound)
        }
      }
    }
    const schema = Object.fromEntries(out)
    return openapi30 && source.nullable === true ? { anyOf: [schema, { type: 'null' }] } : schema
  }

  return {
    convert,
    definitions: () => Object.fromEntries(definitions)
  }
}
