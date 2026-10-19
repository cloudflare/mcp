import { env } from 'cloudflare:workers'
import type { Catalogue, CatalogueTool } from '@cloudflare/forge-mcp'
import type { Method } from '@cloudflare/forge/plugin'
import { resetIsolateCache } from '../../src/isolate-cache'
import { cloudflareTool } from '../../src/forge-tools/cloudflare-plugin'
import { FORGE_TOOLS_KEY } from '../../src/forge-tools/policy'

/** A method as the Cloudflare plugin reads it: only its extensions. */
export function fakeMethod(extensions: Record<string, unknown> = {}): Method {
  return { extension: (name: string) => extensions[name] } as unknown as Method
}

/** A generic forge-mcp tool for `method path`, with path parameters required. */
export function genericTool(
  name: string,
  method: string,
  path: string,
  options: { query?: string[]; body?: boolean } = {}
): CatalogueTool {
  const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!)
  const properties: Record<string, unknown> = {}
  for (const key of [...pathParams, ...(options.query ?? [])]) {
    properties[key] = { type: 'string', description: 'Generic.' }
  }
  if (options.body) properties.body = { type: 'object' }
  const required = [...pathParams, ...(options.body ? ['body'] : [])]
  return {
    name,
    description: `${method} ${path}`,
    inputSchema: { type: 'object', properties, ...(required.length > 0 && { required }) },
    annotations: {
      readOnlyHint: method === 'GET',
      destructiveHint: method === 'DELETE',
      idempotentHint: method !== 'POST',
      openWorldHint: true
    },
    request: {
      method,
      path,
      params: [
        ...pathParams.map((key) => ({ key, name: key, in: 'path' as const })),
        ...(options.query ?? []).map((key) => ({
          key,
          name: key,
          in: 'query' as const,
          explode: true
        }))
      ],
      ...(options.body && { body: { key: 'body', mediaType: 'application/json' } })
    }
  }
}

/** Seed R2 with a catalogue of `tools`, each passed through the Cloudflare plugin's policy. */
export async function seedForgeTools(
  tools: Array<{ tool: CatalogueTool; permissions?: string[] }>
): Promise<void> {
  const catalogue: Catalogue = {
    format: 'forge-mcp/1',
    api: { version: '4.0.0', baseUrl: 'https://api.cloudflare.com/client/v4' },
    tools: tools.map(({ tool, permissions }) =>
      cloudflareTool(tool, fakeMethod(permissions ? { 'x-api-token-group': permissions } : {}))
    ),
    skipped: []
  }
  await env.SPEC_BUCKET.put(FORGE_TOOLS_KEY, JSON.stringify(catalogue))
  resetIsolateCache()
}
