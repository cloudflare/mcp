import { z } from 'zod'
import { withCachedJsonSchema } from '../lib/isolate-json-schema'
import { env } from 'cloudflare:workers'
import type { McpServer } from '@modelcontextprotocol/server'
import { SPEC_TYPES } from '../openapi'
import { getProducts } from '../isolate-cache'
import { formatterFor, TRUNCATE_ARGUMENT_DESCRIPTION } from '../truncate'
import { formatError } from '../utils/errors'

/**
 * Runs sandboxed read-only JavaScript against the pre-resolved OpenAPI spec.
 * The forge tools service runs it, next to the spec it ships, so this Worker
 * never holds the 27 MB spec.
 */
async function runSearch(code: string): Promise<unknown> {
  const outcome = await env.FORGE_TOOLS.search(code)
  if (outcome.error !== undefined) throw new Error(outcome.error)
  return outcome.result
}

/**
 * Description for the `search` tool, listing a sample of available products and
 * the `spec` types the sandboxed search code can use.
 */
function searchToolDescription(products: string[]): string {
  return `Search the Cloudflare OpenAPI spec. All $refs are pre-resolved inline. A 2xx response schema describes \`result\` of what cloudflare.request() returns; a paginated list's \`result_info\` schema is in the response's \`x-result-info\`.

Products: ${products.slice(0, 30).join(', ')}... (${products.length} total)

Types:
${SPEC_TYPES}

Examples:

// Find endpoints by product
async () => {
  const results = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op.tags?.some(t => t.toLowerCase() === 'workers')) {
        results.push({ method: method.toUpperCase(), path, summary: op.summary });
      }
    }
  }
  return results;
}

// Get endpoint with requestBody schema (refs are resolved)
async () => {
  const op = spec.paths['/accounts/{account_id}/d1/database']?.post;
  return { summary: op?.summary, requestBody: op?.requestBody };
}

// Get endpoint parameters
async () => {
  const op = spec.paths['/accounts/{account_id}/workers/scripts']?.get;
  return op?.parameters;
}`
}

// Built once per isolate rather than for every request's server.
const SearchInputSchema = withCachedJsonSchema(
  z.object({
    code: z.string().describe('JavaScript async arrow function to search the OpenAPI spec'),
    truncate: z.boolean().optional().describe(TRUNCATE_ARGUMENT_DESCRIPTION)
  })
)

/**
 * Register the `search` tool: runs sandboxed JavaScript against the
 * pre-resolved OpenAPI spec (no network access). The result is capped unless
 * the call's `truncate` argument, or the connection's `truncateByDefault`
 * when it is omitted, is `false`.
 */
export async function registerSearchTool(
  server: McpServer,
  truncateByDefault: boolean
): Promise<void> {
  const products = await getProducts()

  server.registerTool(
    'search',
    {
      title: 'Cloudflare API Spec Search',
      description: searchToolDescription(products),
      inputSchema: SearchInputSchema,
      annotations: {
        title: 'Cloudflare API Spec Search',
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false
      }
    },
    async ({ code, truncate }) => {
      try {
        const result = await runSearch(code)
        const text = formatterFor(truncate, truncateByDefault)(result)
        return { content: [{ type: 'text', text }] }
      } catch (error) {
        return formatError(error)
      }
    }
  )
}
