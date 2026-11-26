import type { z } from 'zod'
import { isolate } from './isolate'

/**
 * Convert a module-level tool schema to JSON Schema once per isolate.
 *
 * Every request builds a fresh `McpServer`, and the SDK converts each tool's
 * zod schema to JSON Schema for every `tools/list` it serves, with no cache of
 * its own. The schemas never change, so the conversion is memoised on the
 * schema through zod's `~standard` setter. The SDK only reads the result.
 *
 * @param schema - A schema defined once at module scope, never per request.
 * @param post - Applied to each conversion once, before it is cached, such as
 *   `compactJsonSchema` for an MCP App's listed schemas. Defaults to none.
 * @returns The same schema, with its JSON Schema conversion cached.
 */
export function withCachedJsonSchema<T extends z.ZodType>(
  schema: T,
  // oxlint-disable-next-line quality/no-unsafe-dictionary-type -- A JSON Schema holds arbitrary keywords, as the SDK's converter returns it.
  post: (json: Record<string, unknown>) => Record<string, unknown> = (json) => json
): T {
  const standard = schema['~standard']
  const { jsonSchema } = standard
  // oxlint-disable-next-line quality/no-unsafe-dictionary-type -- The cache holds arbitrary schemas produced by the converter.
  const converted = isolate.map<string, Record<string, unknown>>()
  const memoise =
    (io: 'input' | 'output') =>
    // oxlint-disable-next-line quality/no-unsafe-dictionary-type -- The return value uses the converter's JSON Schema contract.
    (options: Parameters<typeof jsonSchema.input>[0]): Record<string, unknown> =>
      converted.getOrSet(
        `${io}:${options.target}:${JSON.stringify(options.libraryOptions ?? {})}`,
        () => post(jsonSchema[io](options))
      )
  schema['~standard'] = {
    ...standard,
    jsonSchema: { input: memoise('input'), output: memoise('output') }
  }
  return schema
}
