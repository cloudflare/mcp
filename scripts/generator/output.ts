import { record, resolve, schemaCompiler, type JsonSchema } from './json-schema.ts'

const SUCCESS = /^(2\d\d|2XX)$/

/** A direct tool's structured output: its JSON Schema and where the data sits in the response. */
export interface ToolOutput {
  schema: JsonSchema
  /**
   * The schema describes the envelope's `result`, not the whole response. Forge
   * documents most operations this way (the SDKs unwrap `result`), and lists
   * with `result_info` with the envelope; nothing in the document says which.
   */
  unwrapResult: boolean
}

function jsonMedia(content: Record<string, unknown>): unknown {
  const type =
    Object.keys(content).find((name) => name === 'application/json') ??
    Object.keys(content).find((name) => name.endsWith('+json'))
  return type ? record(content[type]).schema : undefined
}

/**
 * The tool's structured output from every documented success response with a
 * JSON body, as a self-contained JSON Schema 2020-12 document. `undefined`
 * when no success response documents a JSON body (the tool returns text only).
 */
export function outputFor(
  document: unknown,
  operation: Record<string, unknown>
): ToolOutput | undefined {
  const compiler = schemaCompiler(document, 'output')
  const variants: JsonSchema[] = []
  for (const [status, value] of Object.entries(record(operation.responses))) {
    if (!SUCCESS.test(status)) continue
    const schema = jsonMedia(record(resolve(value, document).content))
    if (schema !== undefined) variants.push(compiler.convert(schema))
  }
  if (variants.length === 0) return undefined
  const distinct = [...new Map(variants.map((v) => [JSON.stringify(v), v])).values()]
  const root: JsonSchema = distinct.length === 1 ? distinct[0]! : { anyOf: distinct }
  const definitions = compiler.definitions()

  const lookup = (schema: JsonSchema): Record<string, unknown> => {
    let current = record(schema)
    for (let depth = 0; typeof current.$ref === 'string' && depth < 8; depth++) {
      current = record(definitions[String(current.$ref).split('/').pop()!])
    }
    return current
  }
  // The schema describes the whole response when it, or any branch it is
  // composed of (allOf/anyOf/oneOf, through $refs), declares an envelope
  // field. Forge's generic success envelopes (e.g. for deletes) declare
  // success/errors/messages and no result.
  const declaresEnvelope = (schema: JsonSchema, depth = 0): boolean => {
    const node = lookup(schema)
    const properties = record(node.properties)
    if ('result' in properties || 'success' in properties) return true
    if (depth > 4) return false
    return [node.allOf, node.anyOf, node.oneOf].some(
      (list) =>
        Array.isArray(list) &&
        list.some((branch) => declaresEnvelope(branch as JsonSchema, depth + 1))
    )
  }
  const unwrapResult = !declaresEnvelope(root)

  return {
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      ...record(root),
      ...(Object.keys(definitions).length ? { $defs: definitions } : {})
    },
    unwrapResult
  }
}
