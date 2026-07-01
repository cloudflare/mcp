import { z } from 'zod'
import { env } from 'cloudflare:workers'
import type { McpServer } from '@modelcontextprotocol/server'
import { SPEC_TYPES } from '../openapi'
import { getProducts, getSpec } from '../isolate-cache'
import { truncateResponse } from '../truncate'
import { formatError } from '../utils/errors'

interface SearchExecutorEntrypoint {
  evaluate(): Promise<{ result: unknown; err?: string; stack?: string }>
}

/**
 * Run sandboxed read-only JavaScript against the pre-resolved OpenAPI spec.
 *
 * The spec is embedded into a fresh isolate per call (dynamic-worker isolates
 * disallow eval, so code cannot be passed as data into a warm isolate). The
 * spec text itself is served from the in-isolate cache, so this avoids an R2
 * round-trip on every call.
 */
async function runSearch(code: string): Promise<unknown> {
  const { text: specJson } = await getSpec()
  const workerId = `cloudflare-search-${crypto.randomUUID()}`

  const worker = env.LOADER.get(workerId, () => ({
    compatibilityDate: '2026-01-12',
    globalOutbound: null,
    mainModule: 'worker.js',
    modules: {
      'worker.js': `
import { WorkerEntrypoint } from "cloudflare:workers";

const spec = ${specJson};

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
  return `Search the Cloudflare OpenAPI spec. All $refs are pre-resolved inline.

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

/**
 * Register the `search` tool: runs sandboxed JavaScript against the
 * pre-resolved OpenAPI spec (no network access).
 */
export async function registerSearchTool(server: McpServer): Promise<void> {
  const products = await getProducts()

  server.registerTool(
    'search',
    {
      description: searchToolDescription(products),
      inputSchema: z.object({
        code: z.string().describe('JavaScript async arrow function to search the OpenAPI spec')
      })
    },
    async ({ code }) => {
      try {
        const result = await runSearch(code)
        return { content: [{ type: 'text', text: truncateResponse(result) }] }
      } catch (error) {
        return formatError(error)
      }
    }
  )
}
