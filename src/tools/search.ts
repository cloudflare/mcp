import { z } from 'zod'
import { withCachedJsonSchema } from '../lib/isolate-json-schema'
import { env } from 'cloudflare:workers'
import type { McpServer } from '@modelcontextprotocol/server'
import { SPEC_TYPES } from '../openapi'
import { getProducts, getSpec } from '../isolate-cache'
import type { FormatToolResult } from '../truncate'
import { formatError } from '../utils/errors'

interface SearchExecutorEntrypoint {
  evaluate(): Promise<{ result: unknown; err?: string; stack?: string }>
}

/**
 * Run sandboxed read-only JavaScript against the pre-resolved OpenAPI spec.
 *
 * A fresh isolate runs each call (dynamic-worker isolates disallow eval, so
 * code cannot be passed as data into a warm isolate). It gets the spec as a
 * text module, from the in-isolate cache of what the forge tools service
 * serves, so a call neither asks the service nor copies the spec.
 */
async function runSearch(code: string): Promise<unknown> {
  const specJson = await getSpec()
  const workerId = `cloudflare-search-${crypto.randomUUID()}`

  const worker = env.LOADER.get(workerId, () => ({
    compatibilityDate: '2026-01-12',
    globalOutbound: null,
    mainModule: 'worker.js',
    modules: {
      // Its own text module, so the cached 27 MB string is handed over as is.
      // Splicing it into the module source built a new string on every call:
      // ~117 ms of main-isolate CPU per search, most of it garbage collection.
      'spec.json.txt': { text: specJson },
      'worker.js': `
import { WorkerEntrypoint } from "cloudflare:workers";
import specText from "./spec.json.txt";

const spec = JSON.parse(specText);

export default class SearchExecutor extends WorkerEntrypoint {
  async evaluate() {
    try {
      const result = await (${code})();
      return { result, err: undefined };
    } catch (err) {
      return { result: undefined, err: err.message, stack: err.stack };
    }
  }
}
      `
    }
  }))

  const entrypoint = worker.getEntrypoint() as unknown as SearchExecutorEntrypoint
  const response = await entrypoint.evaluate()

  if (response.err) {
    throw new Error(response.err)
  }

  return response.result
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
    code: z.string().describe('JavaScript async arrow function to search the OpenAPI spec')
  })
)

/**
 * Register the `search` tool: runs sandboxed JavaScript against the
 * pre-resolved OpenAPI spec (no network access). `formatResult` turns the
 * value the code returns into the tool's text output.
 */
export async function registerSearchTool(
  server: McpServer,
  formatResult: FormatToolResult
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
    async ({ code }) => {
      try {
        const result = await runSearch(code)
        return { content: [{ type: 'text', text: formatResult(result) }] }
      } catch (error) {
        return formatError(error)
      }
    }
  )
}
