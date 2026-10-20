import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse, type JsonBodyType } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API_BASE, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, callTool, modernMcpRequest, parseMcpResult, toolText } from './helpers/mcp'
import { connectWithOAuth } from './helpers/oauth'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'

/**
 * Cloudflare refuses some endpoints without the permission (D1, KV, R2) but
 * filters the lists of others to what the credential may see: `GET /zones`
 * without `zone.read` is `200` with an empty `result` (cloudflare/mcp#302). Such
 * a list is refused as 403, with the same explanation and step-up as a real
 * refusal, on every tool surface. Driven through the real worker.
 */

const ZONE_ID = '023e105f4ecef8ad9ca31a8372d0c353'
const ACCOUNT_ID = 'acc-1'
const DNS_PATH = `/zones/${ZONE_ID}/dns_records`
const MEMBERS_PATH = `/accounts/${ACCOUNT_ID}/members`
const BASELINE = ['user:read', 'account:read']
const RESOURCE_METADATA = 'https://mcp.cloudflare.com/.well-known/oauth-protected-resource/mcp'
const FILTERED = 'Cloudflare answered 200 with an empty list'

const get = (path: string) => `async () => cloudflare.request({ method: "GET", path: "${path}" })`

beforeEach(async () => {
  await seedSpec(
    {
      '/zones': { get: { summary: 'List Zones', 'x-api-token-group': ['Zone Zone Read'] } },
      '/zones/{zone_id}/dns_records': {
        get: {
          summary: 'List DNS Records',
          'x-api-token-group': ['DNS Read', 'DNS Write'],
          parameters: [{ name: 'zone_id', in: 'path', required: true }]
        },
        post: {
          summary: 'Create DNS Record',
          'x-api-token-group': ['DNS Write'],
          parameters: [{ name: 'zone_id', in: 'path', required: true }]
        }
      },
      '/accounts/{account_id}/members': {
        get: {
          summary: 'List Members',
          'x-api-token-group': [
            'SCIM Provisioning',
            'Account Settings Write',
            'Account Settings Read'
          ],
          parameters: [{ name: 'account_id', in: 'path', required: true }]
        }
      }
    },
    ['dns']
  )
  server.use(http.post(`${API_BASE}${DNS_PATH}`, () => HttpResponse.json(cfSuccess({ id: 'r1' }))))
})

afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

function answer(path: string, body: JsonBodyType): void {
  server.use(http.get(`${API_BASE}${path}`, () => HttpResponse.json(body)))
}

function execute(token: string, code: string, query = ''): Promise<Response> {
  return exports.default.fetch(
    modernMcpRequest(
      token,
      'tools/call',
      { name: 'execute', arguments: { code } },
      { url: `${MCP_URL}${query}` }
    )
  )
}

function callDirectTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
  query: string
): Promise<Response> {
  return exports.default.fetch(
    modernMcpRequest(token, 'tools/call', { name, arguments: args }, { url: `${MCP_URL}${query}` })
  )
}

function expectChallenge(response: Response, scope: string): void {
  expect(response.status).toBe(403)
  const challenge = response.headers.get('WWW-Authenticate') ?? ''
  expect(challenge).toContain('error="insufficient_scope"')
  expect(challenge).toContain(`scope="${[...BASELINE, scope].join(' ')}"`)
  expect(challenge).toContain(`resource_metadata="${RESOURCE_METADATA}"`)
}

async function resultOf(response: Response) {
  const body = await parseMcpResult(response)
  return {
    status: response.status,
    result: body.result,
    text: body.result?.content?.[0]?.text ?? ''
  }
}

describe('execute', () => {
  it('challenges for the scope, as it does for a 403', async () => {
    const token = await connectWithOAuth(BASELINE)
    answer(DNS_PATH, cfSuccess([]))

    expectChallenge(await execute(token, get(DNS_PATH)), 'dns.read')
  })

  it('throws the refusal, explained, with scopeChallenge=tool', async () => {
    const token = await connectWithOAuth(BASELINE)
    answer(DNS_PATH, cfSuccess([]))

    const { status, result, text } = await resultOf(
      await execute(token, get(DNS_PATH), '?scopeChallenge=tool')
    )

    expect(status).toBe(200)
    expect(result?.isError).toBe(true)
    expect(text).toContain(`Cloudflare API error: GET ${DNS_PATH} returned HTTP 403: ${FILTERED}`)
    expect(text).toContain('was not granted a scope this endpoint accepts')
    expect(text).toContain('`dns.read` (DNS Read)')
    const [challenge] = result?._meta?.['mcp/www_authenticate'] as string[]
    expect(challenge).toContain('scope="user:read account:read dns.read"')
  })

  it('keeps the explanation when the code catches the error', async () => {
    const token = await connectWithOAuth(BASELINE)
    answer(DNS_PATH, cfSuccess([]))

    const code = `async () => { try { await cloudflare.request({ method: "GET", path: "${DNS_PATH}" }) } catch (e) { return e.message } }`
    const { text } = await resultOf(await execute(token, code))

    expect(text).toContain(FILTERED)
    expect(text).toContain('`dns.read` (DNS Read)')
  })

  it('refuses a bare empty array as well as the envelope', async () => {
    const token = await connectWithOAuth(BASELINE)
    answer(DNS_PATH, [])

    expectChallenge(await execute(token, get(DNS_PATH)), 'dns.read')
  })

  it('matches /zones despite its spec permission name, Zone Zone Read', async () => {
    const token = await connectWithOAuth(BASELINE)
    answer('/zones', cfSuccess([]))

    expectChallenge(await execute(token, get('/zones')), 'zone.read')
  })

  it('does not challenge after a write went through, and says why', async () => {
    const token = await connectWithOAuth(BASELINE)
    answer(DNS_PATH, cfSuccess([]))

    const code = `async () => {
      await cloudflare.request({ method: "POST", path: "${DNS_PATH}", body: { type: "A" } })
      return cloudflare.request({ method: "GET", path: "${DNS_PATH}" })
    }`
    const { status, result, text } = await resultOf(await execute(token, code))

    expect(status).toBe(200)
    expect(text).toContain(FILTERED)
    expect(text).toContain('not offered for an automatic retry')
    expect(result?._meta).not.toHaveProperty('mcp/www_authenticate')
  })

  it('trusts an empty list when the connection holds an accepted scope', async () => {
    const token = await connectWithOAuth([...BASELINE, 'dns.read'])
    answer(DNS_PATH, cfSuccess([]))

    const { status, result, text } = await resultOf(await execute(token, get(DNS_PATH)))

    expect(status).toBe(200)
    expect(result?.isError).toBeFalsy()
    expect(text).toContain('"result": []')
  })

  it('trusts a list with rows', async () => {
    const token = await connectWithOAuth(BASELINE)
    answer(DNS_PATH, cfSuccess([{ id: 'record' }]))

    const { result, text } = await resultOf(await execute(token, get(DNS_PATH)))

    expect(result?.isError).toBeFalsy()
    expect(text).toContain('record')
  })

  it('trusts an endpoint the baseline scopes may grant', async () => {
    // Measured: /accounts/{account_id}/members answers account:read alone.
    const token = await connectWithOAuth(BASELINE)
    answer(MEMBERS_PATH, cfSuccess([]))

    const { status, result } = await resultOf(await execute(token, get(MEMBERS_PATH)))

    expect(status).toBe(200)
    expect(result?.isError).toBeFalsy()
  })

  it('trusts a direct API token, whose permissions are unknown', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    answer(DNS_PATH, cfSuccess([]))

    const result = await callTool('cfat_direct', 'execute', { code: get(DNS_PATH) })

    expect(result.result?.isError).toBeFalsy()
    expect(toolText(result)).toContain('"result": []')
  })
})

describe('endpoint tools', () => {
  const listDns = (token: string, query: string) =>
    callDirectTool(token, 'get_zones_dns_records', { zone_id: ZONE_ID }, `?codemode=false${query}`)

  it('challenge for the scope', async () => {
    const token = await connectWithOAuth(BASELINE)
    answer(DNS_PATH, cfSuccess([]))

    expectChallenge(await listDns(token, ''), 'dns.read')
  })

  it('report the refusal, explained, with scopeChallenge=tool', async () => {
    const token = await connectWithOAuth(BASELINE)
    answer(DNS_PATH, cfSuccess([]))

    const { result, text } = await resultOf(await listDns(token, '&scopeChallenge=tool'))

    expect(result?.isError).toBe(true)
    expect(text).toContain(`Cloudflare API error: GET ${DNS_PATH} returned HTTP 403.`)
    expect(text).toContain(FILTERED)
    expect(text).toContain('`dns.read` (DNS Read)')
    expect(result?._meta?.['mcp/www_authenticate']).toHaveLength(1)
  })

  it('trust a list with rows', async () => {
    const token = await connectWithOAuth(BASELINE)
    answer(DNS_PATH, cfSuccess([{ id: 'record' }]))

    const { status, result, text } = await resultOf(await listDns(token, ''))

    expect(status).toBe(200)
    expect(result?.isError).toBeFalsy()
    expect(text).toContain('record')
  })

  it('trust an endpoint the baseline scopes may grant', async () => {
    const token = await connectWithOAuth(BASELINE)
    answer(MEMBERS_PATH, cfSuccess([]))

    const { status, result } = await resultOf(
      await callDirectTool(
        token,
        'get_accounts_members',
        { account_id: ACCOUNT_ID },
        '?codemode=false'
      )
    )

    expect(status).toBe(200)
    expect(result?.isError).toBeFalsy()
  })
})

describe('forge tools', () => {
  it('challenge for the scope', async () => {
    const token = await connectWithOAuth(BASELINE)
    answer(`/accounts/${ACCOUNT_ID}/d1/database`, cfSuccess([]))

    expectChallenge(await callDirectTool(token, 'd1_list', {}, '?forge=true'), 'd1.read')
  })

  it('trust a list with rows', async () => {
    const token = await connectWithOAuth(BASELINE)
    answer(`/accounts/${ACCOUNT_ID}/d1/database`, cfSuccess([{ uuid: 'db-1' }]))

    const { status, result, text } = await resultOf(
      await callDirectTool(token, 'd1_list', {}, '?forge=true')
    )

    expect(status).toBe(200)
    expect(result?.isError).toBeFalsy()
    expect(text).toContain('db-1')
  })
})
