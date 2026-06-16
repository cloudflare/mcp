import { z } from 'zod'
import { env } from 'cloudflare:workers'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createSearchExecutor } from '../executor'
import { SPEC_TYPES } from '../openapi'
import { truncateResponse } from '../truncate'
import { formatError } from '../utils/errors'

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
  const executeSearch = createSearchExecutor()

  const obj = await env.SPEC_BUCKET.get('products.json')
  const products: string[] = obj ? await obj.json() : []

  server.registerTool(
    'search',
    {
      description: searchToolDescription(products),
      inputSchema: {
        code: z.string().describe('JavaScript async arrow function to search the OpenAPI spec')
      }
    },
    async ({ code }) => {
      try {
        const result = await executeSearch(code)
        return { content: [{ type: 'text', text: truncateResponse(result) }] }
      } catch (error) {
        return formatError(error)
      }
    }
  )
}
