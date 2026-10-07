import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API_BASE, cfError, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { clearSpec, seedSpec } from './helpers/spec'
import { directTool } from './helpers/direct-tools'
import {
  MCP_URL,
  mcpToolCallRequest,
  mcpToolListRequest,
  parseMcpResult,
  toolText
} from './helpers/mcp'
import { server } from './setup/msw'

/**
 * Worker-seam tests for non-codemode mode (the generated mcp-tools.json catalogue),
 * driven through the REAL worker at /mcp?codemode=false. Unlike the direct
 * tool.handler() tests, these go through MCP argument validation — which is
 * where the account_id-required regression actually bit.
 *
 * The Cloudflare API is the only mocked boundary (MSW); auth, the transport,
 * tool registration and request building are all real.
 */

const ACCOUNT_ID = '00000000000000000000000000000001'
const ACCOUNT_TOKEN = 'acct-token-noncodemode'

// Two account-scoped GET tools, shaped like generated entries.
const TOOLS = [
  directTool({ name: 'workers_scripts_list', path: '/accounts/{account_id}/workers/scripts' }),
  directTool({
    name: 'workers_scripts_get',
    path: '/accounts/{account_id}/workers/scripts/{script_name}'
  })
]

/** POST a non-codemode tools/list to the real worker. */
async function listNonCodemodeTools(token: string) {
  const base = mcpToolListRequest(token)
  const req = new Request(`${MCP_URL}?codemode=false`, base)
  const result = (await parseMcpResult(await exports.default.fetch(req))) as unknown as {
    result?: {
      tools?: Array<{
        name: string
        description?: string
        inputSchema: { properties?: Record<string, unknown>; required?: string[] }
      }>
    }
  }
  return result.result?.tools ?? []
}

/** POST a non-codemode tools/call to the real worker. */
async function callNonCodemodeTool(token: string, name: string, args: Record<string, unknown>) {
  const base = mcpToolCallRequest(token, name, args)
  const req = new Request(`${MCP_URL}?codemode=false`, base)
  return parseMcpResult(await exports.default.fetch(req))
}

beforeEach(() => seedSpec({}, ['workers'], TOOLS))

afterEach(async () => {
  await clearSpec()
  await clearKv(env.OAUTH_KV)
})

describe('non-codemode: account_id auto-resolution through real MCP validation', () => {
  it('serves the generated tool list with an optional account_id', async () => {
    const artifact = JSON.parse(await (await env.SPEC_BUCKET.get('mcp-tools.json'))!.text())
    artifact.tools[0].description = 'GENERATED ARTIFACT'
    await env.SPEC_BUCKET.put('mcp-tools.json', JSON.stringify(artifact))
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })

    const tools = await listNonCodemodeTools(ACCOUNT_TOKEN)
    const endpoint = tools.find((tool) => tool.name === 'workers_scripts_list')

    expect(endpoint?.description).toBe('GENERATED ARTIFACT')
    expect(endpoint?.inputSchema.properties).toHaveProperty('account_id')
    expect(endpoint?.inputSchema.required ?? []).not.toContain('account_id')
    expect(tools.map((tool) => tool.name)).toContain('docs')
  })

  it('rejects a call missing a required argument', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })

    const result = await callNonCodemodeTool(ACCOUNT_TOKEN, 'workers_scripts_get', {})

    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toContain('Input validation error')
    expect(toolText(result)).toContain('script_name')
  })

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

    const result = await callNonCodemodeTool(ACCOUNT_TOKEN, 'workers_scripts_list', {})

    expect(result.result?.isError).toBeFalsy()
    expect(toolText(result)).toContain('worker-a')
    // account_id was auto-resolved into the upstream URL.
    expect(calledUrl).toContain(`/accounts/${ACCOUNT_ID}/workers/scripts`)
  })

  it("names the token's account when a call with another account_id fails", async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    server.use(
      http.get(`${API_BASE}/accounts/not-my-account/workers/scripts`, () =>
        HttpResponse.json(cfError([{ code: 9109, message: 'Unauthorized' }]), { status: 403 })
      )
    )

    const result = await callNonCodemodeTool(ACCOUNT_TOKEN, 'workers_scripts_list', {
      account_id: 'not-my-account'
    })

    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toContain(
      `account_id not-my-account is not this token's account. This token is scoped to ${ACCOUNT_ID} (Acc); omit account_id to use it.`
    )
  })

  it('forwards an explicitly-passed account_id', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/workers/scripts`, () =>
        HttpResponse.json(cfSuccess([{ id: 'worker-b' }]))
      )
    )

    const result = await callNonCodemodeTool(ACCOUNT_TOKEN, 'workers_scripts_list', {
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

    await callNonCodemodeTool(ACCOUNT_TOKEN, 'workers_scripts_list', {})

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

    const result = await callNonCodemodeTool(ACCOUNT_TOKEN, 'workers_scripts_list', {})

    expect(result.result?.isError).toBe(true)
  })
})
