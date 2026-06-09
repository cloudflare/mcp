import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API_BASE, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { clearR2 } from './helpers/r2'
import { mcpToolCallRequest, parseMcpResult, toolText } from './helpers/mcp'
import { server } from './setup/msw'

/**
 * Worker-seam tests for non-codemode mode (one MCP tool per OpenAPI endpoint),
 * driven through the REAL worker at /mcp?codemode=false. Unlike the direct
 * tool.handler() tests, these go through MCP argument validation — which is
 * where the account_id-required regression actually bit.
 *
 * The Cloudflare API is the only mocked boundary (MSW); auth, the transport,
 * tool registration and request building are all real.
 */

const ACCOUNT_ID = '00000000000000000000000000000001'
const ACCOUNT_TOKEN = 'acct-token-noncodemode'

// Minimal spec with one account-scoped GET tool.
const SPEC = {
  paths: {
    '/accounts/{account_id}/workers/scripts': {
      get: {
        summary: 'List Workers',
        tags: ['Workers'],
        parameters: [{ name: 'account_id', in: 'path', required: true }],
        responses: {}
      }
    }
  }
}

/** POST a non-codemode tools/call to the real worker. */
async function callNonCodemodeTool(
  token: string,
  name: string,
  args: Record<string, unknown>
) {
  const base = mcpToolCallRequest(token, name, args)
  const req = new Request('https://mcp.example.com/mcp?codemode=false', base)
  return parseMcpResult(await exports.default.fetch(req))
}

beforeEach(async () => {
  await env.SPEC_BUCKET.put('spec.json', JSON.stringify(SPEC))
  await env.SPEC_BUCKET.put('products.json', JSON.stringify(['workers']))
})

afterEach(async () => {
  await clearR2(env.SPEC_BUCKET)
  await clearKv(env.OAUTH_KV)
})

describe('non-codemode: account_id auto-resolution through real MCP validation', () => {
  it('lets an account-token call an account-scoped tool WITHOUT account_id', async () => {
    // Regression guard: account_id must be optional in the schema for
    // auto-resolvable sessions, else MCP validation rejects before the handler.
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    let calledUrl = ''
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/workers/scripts`, ({ request }) => {
        calledUrl = request.url
        return HttpResponse.json(cfSuccess([{ id: 'worker-a' }]))
      })
    )

    const result = await callNonCodemodeTool(ACCOUNT_TOKEN, 'get_accounts_workers_scripts', {})

    expect(result.result?.isError).toBeFalsy()
    expect(toolText(result)).toContain('worker-a')
    // account_id was auto-resolved into the upstream URL.
    expect(calledUrl).toContain(`/accounts/${ACCOUNT_ID}/workers/scripts`)
  })

  it('forwards an explicitly-passed account_id', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/workers/scripts`, () =>
        HttpResponse.json(cfSuccess([{ id: 'worker-b' }]))
      )
    )

    const result = await callNonCodemodeTool(ACCOUNT_TOKEN, 'get_accounts_workers_scripts', {
      account_id: ACCOUNT_ID
    })

    expect(result.result?.isError).toBeFalsy()
    expect(toolText(result)).toContain('worker-b')
  })

  it('sends the bearer token and correct method to the Cloudflare API', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    let auth: string | null = null
    let method = ''
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/workers/scripts`, ({ request }) => {
        auth = request.headers.get('Authorization')
        method = request.method
        return HttpResponse.json(cfSuccess([]))
      })
    )

    await callNonCodemodeTool(ACCOUNT_TOKEN, 'get_accounts_workers_scripts', {})

    expect(auth).toBe(`Bearer ${ACCOUNT_TOKEN}`)
    expect(method).toBe('GET')
  })

  it('surfaces a Cloudflare API failure as an isError result', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/workers/scripts`, () =>
        HttpResponse.json(
          { success: false, errors: [{ code: 1000, message: 'nope' }], messages: [], result: null },
          { status: 403 }
        )
      )
    )

    const result = await callNonCodemodeTool(ACCOUNT_TOKEN, 'get_accounts_workers_scripts', {})

    expect(result.result?.isError).toBe(true)
  })
})
