/**
 * Measures what checking a direct-tool response costs, against the response
 * schemas forge generated (`src/generated/forge-mcp`): trimming the body (the
 * main Worker), and compiling the tool's validator and validating the trimmed
 * body (the forge tools service), for bodies of growing size that match, or
 * break, the schema.
 *
 * Bodies are synthesised from each tool's own response schema, so they are
 * shaped like real responses. Runs in Node (same V8 as workerd).
 *
 *   npx tsx scripts/bench-response-validation.ts [tool_name ...]
 */
import { tools, type JsonSchema, type ToolResponses } from '../src/generated/forge-mcp'
import { findMismatch, trimForCheck } from '../src/response-schema-check'

const MAX_ITEMS = 25
const DEFAULT_TOOLS = ['zones_list', 'dns_records_list', 'workers_legacy_scripts_list', 'd1_list']

type Node = { readonly [keyword: string]: unknown }

/** A value matching `schema`, with `items` entries in each top-level array. */
function sample(
  schema: JsonSchema | undefined,
  defs: ToolResponses['$defs'],
  items: number,
  depth = 0
): unknown {
  if (!schema || depth > 12) return {}
  const node = schema as Node
  if (typeof node.$ref === 'string') {
    return sample(defs?.[node.$ref.slice('#/$defs/'.length)], defs, items, depth + 1)
  }
  if (Array.isArray(node.enum)) return node.enum.find((value) => value !== null) ?? null
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const branches = node[keyword] as JsonSchema[] | undefined
    if (branches) {
      const branch = branches.find((b) => (b as Node).type !== 'null') ?? branches[0]
      return sample(branch, defs, items, depth + 1)
    }
  }
  if (Array.isArray(node.allOf)) {
    return Object.assign(
      {},
      ...(node.allOf as JsonSchema[]).map((part) => sample(part, defs, items, depth + 1))
    )
  }
  const type = Array.isArray(node.type)
    ? (node.type as string[]).find((t) => t !== 'null')
    : node.type
  if (type === 'array') {
    return Array.from({ length: depth <= 3 ? items : 2 }, () =>
      sample(node.items as JsonSchema, defs, items, depth + 1)
    )
  }
  if (type === 'object' || node.properties) {
    const properties = (node.properties ?? {}) as Record<string, JsonSchema>
    return Object.fromEntries(
      Object.entries(properties).map(([name, value]) => [
        name,
        sample(value, defs, items, depth + 1)
      ])
    )
  }
  if (type === 'integer' || type === 'number') return 1
  if (type === 'boolean') return true
  if (type === 'null') return null
  if (node.format === 'date-time') return '2026-01-01T00:00:00Z'
  if (node.format === 'date') return '2026-01-01'
  if (node.format === 'uuid') return '00000000-0000-4000-8000-000000000000'
  return 'x'.repeat(16)
}

/** Break every item: turn each string into a number. */
function breakTypes(value: unknown): unknown {
  if (typeof value === 'string') return 12345
  if (Array.isArray(value)) return value.map(breakTypes)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, breakTypes(v)]))
  }
  return value
}

function time(run: () => void, runs: number): number {
  const begin = performance.now()
  for (let i = 0; i < runs; i++) run()
  return (performance.now() - begin) / runs
}

const names = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_TOOLS
console.log(
  '| tool | items | body | trim ms | compile ms | check ms | errors | broken check ms | broken errors |'
)
console.log('|---|---|---|---|---|---|---|---|---|')
for (const name of names) {
  const tool = tools.find((candidate) => candidate.name === name)
  const responses = tool?.responses
  if (!responses?.schemas['200']) {
    console.log(`| \`${name}\` | no 200 response schema |`)
    continue
  }
  for (const items of [10, 100, 1000, 5000]) {
    const body = sample(responses.schemas['200'], responses.$defs, items)
    const broken = breakTypes(body)
    const chars = JSON.stringify(body).length
    const trimmed = trimForCheck(200, body, MAX_ITEMS)
    const trimmedBroken = trimForCheck(200, broken, MAX_ITEMS)
    const runs = chars > 500_000 ? 3 : 20

    let compileMs = ''
    if (items === 10) {
      const begin = performance.now()
      findMismatch(responses, trimmed, name)
      compileMs = (performance.now() - begin).toFixed(1)
    }
    const result = findMismatch(responses, trimmed, name)
    const brokenResult = findMismatch(responses, trimmedBroken, name)
    const count = (mismatch: typeof result) =>
      mismatch
        ? `${mismatch.errorCount}${mismatch.counted ? '' : '+'} (${mismatch.errors[0]?.keyword})`
        : '0'
    console.log(
      `| \`${name}\` | ${items} | ${(chars / 1024).toFixed(0)} KB | ` +
        `${time(() => trimForCheck(200, body, MAX_ITEMS), runs).toFixed(2)} | ${compileMs} | ` +
        `${time(() => findMismatch(responses, trimmed, name), runs).toFixed(2)} | ${count(result)} | ` +
        `${time(() => findMismatch(responses, trimmedBroken, name), runs).toFixed(2)} | ${count(brokenResult)} |`
    )
  }
}
