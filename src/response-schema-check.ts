import { dereference, validate, type OutputUnit, type Schema } from '@cfworker/json-schema'
import type { ToolResponses } from './generated/forge-mcp'
import { isolate } from './lib/isolate'

/**
 * Validates a response body against a generated tool's response schemas
 * (`responses` in `src/generated/forge-mcp`) and describes the violations
 * without response values. Runs in the forge tools service, which holds the
 * schemas; the main Worker trims the body first with `trimForCheck`, which
 * imports nothing from the validator, so the main Worker doesn't bundle it.
 */

/** Violations kept per mismatch, for the log line. */
const MAX_REPORTED_ERRORS = 5
/** Compiled validators kept per isolate; the cache is dropped when full. */
const MAX_VALIDATORS = 256
/**
 * Most JSON values whose violations are all counted. Counting validates again
 * without stopping at the first error, and the validator spreads every child
 * error into its parent's list, so a body with very many violations can
 * overflow the stack.
 */
const MAX_COUNTED_VALUES = 20_000
const DEFS_PREFIX = '#/$defs/'

/** A response body trimmed for checking (`trimForCheck`). */
export interface TrimmedResponse {
  status: number
  /** The parsed JSON body, with arrays cut to their first items. */
  body: unknown
  /** Instance locations, as the validator writes them, of the arrays that were cut. */
  trimmed: string[]
  /** How many JSON values the trimmed body holds. */
  values: number
}

/** One schema violation, with no response values. */
export interface MismatchError {
  keyword: string
  /** Schema location, through `$ref`s to the innermost component schema. */
  schemaLocation: string
  /** Instance path with array indices and undeclared keys replaced by `*`. */
  instancePath: string
}

export interface Mismatch {
  /** Response key the schema came from: the status, its class (`4XX`) or `default`. */
  responseKey: string
  /**
   * Violations found: every one when `counted`; otherwise a lower bound,
   * because arrays were trimmed or the body was too large to count them all.
   */
  errorCount: number
  /** Whether the whole body was checked and every violation counted. */
  counted: boolean
  errors: MismatchError[]
}

interface CompiledSchema {
  /** The response schema plus the component schemas it reaches. */
  root: Schema
  /** The validator's index of `root`'s subschemas. */
  lookup: Record<string, Schema | boolean>
  /** Every property name the schema declares; other instance keys are `*`. */
  propertyNames: Set<string>
}

const compiled = isolate.map<string, CompiledSchema | null>({ maxEntries: MAX_VALIDATORS })

/**
 * Validate a trimmed body against `responses`. Returns `undefined` when it
 * matches or there is nothing to check against. `cacheKey` names the tool, so
 * its compiled validators are reused.
 */
export function findMismatch(
  responses: ToolResponses,
  response: TrimmedResponse,
  cacheKey: string
): Mismatch | undefined {
  const responseKey = responseKeyFor(responses.schemas, response.status)
  if (!responseKey) return undefined
  const schema = compile(responses, `${cacheKey} ${responseKey}`, responseKey)
  if (!schema) return undefined
  const { root, lookup, propertyNames } = schema
  const trimmed = new Set(response.trimmed)

  // Stopping at the first violation costs the same as a full pass for a valid
  // body and almost nothing for an invalid one.
  const first = validate(response.body, root, '2020-12', lookup, true)
  if (first.valid) return undefined

  let leaves = leafErrors(root, first.errors, trimmed)
  let counted = false
  if (response.values <= MAX_COUNTED_VALUES) {
    try {
      leaves = leafErrors(
        root,
        validate(response.body, root, '2020-12', lookup, false).errors,
        trimmed
      )
      counted = trimmed.size === 0
    } catch {
      // Too many violations to collect; keep the ones found before stopping.
    }
  }
  // Every violation was an artefact of trimming.
  if (leaves.length === 0) return undefined

  return {
    responseKey,
    errorCount: leaves.length,
    counted,
    errors: leaves.slice(0, MAX_REPORTED_ERRORS).map((error) => ({
      keyword: error.keyword,
      schemaLocation: schemaLocation(root, error.keywordLocation, responseKey),
      instancePath: joinPath(
        safeInstancePath(error.instanceLocation, propertyNames),
        missingProperty(root, error)
      )
    }))
  }
}

/** The status's own response, then its class (`4XX`), then `default`. */
export function responseKeyFor(
  schemas: ToolResponses['schemas'],
  status: number
): string | undefined {
  const key = [String(status), `${Math.floor(status / 100)}XX`, 'default'].find(
    (candidate) => candidate in schemas
  )
  // A documented response without a JSON body: nothing to check against.
  return key !== undefined && schemas[key] !== null ? key : undefined
}

/**
 * Cut every array in `body` to its first `maxItems` items, recording where.
 * Validation costs up to ~0.5 ms per KB (a DNS record is matched against an
 * `anyOf` of every record type), so this bounds the check and keeps the body
 * sent to the forge tools service small. The main Worker trims; locations are
 * written as the validator writes them.
 */
export function trimForCheck(status: number, body: unknown, maxItems: number): TrimmedResponse {
  const trimmed: string[] = []
  let values = 0
  const copy = (value: unknown, location: string): unknown => {
    values++
    if (Array.isArray(value)) {
      if (value.length > maxItems) trimmed.push(location)
      return value.slice(0, maxItems).map((item, index) => copy(item, `${location}/${index}`))
    }
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        out[key] = copy(item, `${location}/${encodeValidatorToken(key)}`)
      }
      return out
    }
    return value
  }
  return { status, body: copy(body, '#'), trimmed, values }
}

function compile(
  responses: ToolResponses,
  cacheKey: string,
  responseKey: string
): CompiledSchema | null {
  const hit = compiled.get(cacheKey)
  if (hit !== undefined) return hit

  let result: CompiledSchema | null = null
  try {
    const schema = responses.schemas[responseKey]
    // The validator annotates the schema objects it indexes, so give it a copy
    // rather than the generated constants.
    const root = structuredClone({ ...schema, $defs: responses.$defs ?? {} }) as Schema
    result = { root, lookup: dereference(root), propertyNames: declaredPropertyNames(root) }
  } finally {
    // A schema that fails to compile is remembered as uncheckable.
    compiled.set(cacheKey, result)
  }
  return result
}

function declaredPropertyNames(root: unknown): Set<string> {
  const names = new Set<string>()
  const queue: unknown[] = [root]
  while (queue.length > 0) {
    const node = queue.pop()
    if (Array.isArray(node)) {
      queue.push(...node)
    } else if (typeof node === 'object' && node !== null) {
      for (const [keyword, value] of Object.entries(node)) {
        if (keyword === 'enum' || keyword === 'const') continue
        if (keyword === 'properties' && typeof value === 'object' && value !== null) {
          for (const name of Object.keys(value)) names.add(name)
        }
        queue.push(value)
      }
    }
  }
  return names
}

/**
 * For a `required` violation, `/<name>` of the missing property, so the path
 * points at it. The validator names it only in its message; the name is used
 * only if the schema's `required` list holds it, so it is never response data.
 */
function missingProperty(root: Schema, error: OutputUnit): string {
  if (error.keyword !== 'required') return ''
  const name = /required property "(.*)"\.$/.exec(error.error)?.[1]
  const required = walkSchema(root, error.keywordLocation).node
  return name !== undefined && Array.isArray(required) && required.includes(name)
    ? `/${encodePointerToken(name)}`
    : ''
}

function joinPath(path: string, suffix: string): string {
  return path === '/' && suffix ? suffix : path + suffix
}

const TRIM_SENSITIVE = new Set(['minItems', 'contains'])

/**
 * Drop the `additionalProperties` errors the validator raises for declared
 * properties. It marks a property evaluated only when the property is valid,
 * so a declared property that fails its own schema is checked again against
 * `additionalProperties` and reported twice. Each such error is followed by its
 * child, whose instance location ends in the property's key.
 */
function withoutRecheckedProperties(root: Schema, errors: OutputUnit[]): OutputUnit[] {
  const kept: OutputUnit[] = []
  for (let i = 0; i < errors.length; i++) {
    const error = errors[i]
    const child = errors[i + 1]
    const prefix = `${error.instanceLocation}/`
    if (error.keyword !== 'additionalProperties' || !child?.instanceLocation.startsWith(prefix)) {
      kept.push(error)
      continue
    }
    const key = decodeValidatorToken(child.instanceLocation.slice(prefix.length).split('/')[0])
    const parent = walkSchema(root, error.keywordLocation.replace(/\/additionalProperties$/, ''))
    const properties = (parent.node as Schema | undefined)?.properties
    if (!properties || !Object.hasOwn(properties, key)) {
      kept.push(error)
      continue
    }
    const propertyLocation = `${prefix}${encodeValidatorToken(key)}`
    const inSubtree = (unit: OutputUnit) =>
      (unit.instanceLocation === propertyLocation ||
        unit.instanceLocation.startsWith(`${propertyLocation}/`)) &&
      (unit.keyword === 'false' || unit.keywordLocation.startsWith(`${error.keywordLocation}/`))
    while (i + 1 < errors.length && inSubtree(errors[i + 1])) i++
  }
  return kept
}

/**
 * The errors that name a violation, not the wrappers (`properties`, `items`,
 * `$ref`, `allOf`) that only say a child failed. An `anyOf`/`oneOf` failure
 * counts as one violation; the reasons each alternative failed are dropped.
 *
 * The validator reports errors in pre-order, a parent directly before its
 * children, so one pass finds them.
 */
function leafErrors(root: Schema, errors: OutputUnit[], trimmed: Set<string>): OutputUnit[] {
  // `false` schemas (e.g. `additionalProperties: false`) report the instance
  // location as their keyword location; their parent names the violation.
  const units = withoutRecheckedProperties(root, errors).filter(
    (error) => error.keyword !== 'false'
  )
  const leaves: OutputUnit[] = []
  for (let i = 0; i < units.length; i++) {
    const error = units[i]
    const childPrefix = `${error.keywordLocation}/`
    const isChild = (unit: OutputUnit | undefined) =>
      unit !== undefined &&
      unit.keywordLocation.startsWith(childPrefix) &&
      unit.instanceLocation.startsWith(error.instanceLocation)
    if (error.keyword === 'anyOf' || error.keyword === 'oneOf') {
      leaves.push(error)
      while (isChild(units[i + 1])) i++
    } else if (!isChild(units[i + 1])) {
      leaves.push(error)
    }
  }
  // A trimmed array can fail `minItems` or `contains` that the whole one meets.
  return leaves.filter(
    (error) => !(TRIM_SENSITIVE.has(error.keyword) && trimmed.has(error.instanceLocation))
  )
}

/**
 * Turn the validator's keyword location (`#/properties/result/items/$ref/required`)
 * into where the keyword lives: the innermost component schema
 * (`#/components/schemas/zones_zone/required`), or the operation's response
 * schema (`#/responses/200/schema/properties/result`).
 */
function schemaLocation(root: Schema, keywordLocation: string, responseKey: string): string {
  const { defName, rest } = walkSchema(root, keywordLocation)
  const base =
    defName === undefined
      ? `#/responses/${responseKey}/schema`
      : `#/components/schemas/${encodePointerToken(defName)}`
  return rest.length > 0 ? `${base}/${rest.join('/')}` : base
}

/**
 * Follow a keyword location through `root`, jumping to the component schema at
 * each `$ref`. Returns the schema node it ends at, the innermost component
 * schema's name, and the pointer tokens after it (`*` for any not in the schema).
 */
function walkSchema(
  root: Schema,
  keywordLocation: string
): { node: unknown; defName?: string; rest: string[] } {
  let defName: string | undefined
  let rest: string[] = []
  let node: unknown = root
  for (const token of keywordLocation.replace(/^#\/?/, '').split('/')) {
    if (token === '') continue
    const current = typeof node === 'object' && node !== null ? (node as Schema) : undefined
    if (token === '$ref' && current?.$ref?.startsWith(DEFS_PREFIX)) {
      defName = decodePointerToken(current.$ref.slice(DEFS_PREFIX.length))
      rest = []
      node = (root.$defs as Record<string, unknown>)[defName]
      continue
    }
    const name = decodeValidatorToken(token)
    // Every token names a keyword or key in the schema; one that doesn't
    // could only have come from the response, so it is not copied.
    const exists = current !== undefined && Object.hasOwn(current, name)
    rest.push(exists ? encodePointerToken(name) : '*')
    node = exists ? (current as Record<string, unknown>)[name] : undefined
  }
  return { node, defName, rest }
}

/**
 * The instance path with every segment that could be customer data replaced
 * by `*`: array indices, and object keys the schema doesn't declare (map keys
 * such as hostnames or IDs).
 */
export function safeInstancePath(instanceLocation: string, propertyNames: Set<string>): string {
  const tokens = instanceLocation
    .replace(/^#\/?/, '')
    .split('/')
    .filter((token) => token !== '')
    .map((token) => {
      const name = decodeValidatorToken(token)
      return !/^\d+$/.test(name) && propertyNames.has(name) ? encodePointerToken(name) : '*'
    })
  return `/${tokens.join('/')}`
}

function encodePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1')
}

function decodePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

/** A key as the validator writes it in a location: `encodeURI` over `~0`/`~1` escaping. */
function encodeValidatorToken(key: string): string {
  return encodeURI(encodePointerToken(key))
}

/** A location token as the validator writes it, back to the key it names. */
function decodeValidatorToken(token: string): string {
  let unescaped = token
  try {
    unescaped = decodeURI(token)
  } catch {
    // Not URI-encoded after all; use it as is.
  }
  return decodePointerToken(unescaped)
}
