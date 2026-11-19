import { env, exports } from 'cloudflare:workers'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIRECT_CONNECTION } from '../src/api-permissions'
import { ScopeChallenge } from '../src/scope-challenge'
import { stringifyResponse } from '../src/truncate'
import { AUTH_PROPS_VERSION, type AuthProps } from '../src/auth/types'
import {
  GRAPHQL_ANALYTICS_TOOL,
  registerGraphqlAnalyticsTool
} from '../src/tools/graphql-analytics'
import { API_BASE, cfError, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, modernMcpRequest, parseMcpResult } from './helpers/mcp'
import { connectWithOAuth } from './helpers/oauth'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'

const ACCOUNT_ID = '00000000000000000000000000000001'
const OTHER_ACCOUNT_ID = '00000000000000000000000000000002'
const ZONE_ID = '023e105f4ecef8ad9ca31a8372d0c353'

const DIRECT_URL = `${MCP_URL}?codemode=false&scopeChallenge=tool`
const CODE_MODE_URL = `${MCP_URL}?scopeChallenge=tool`

const ACCOUNT_QUERY = `query ($accountTag: string!) {
  viewer { accounts(filter: { accountTag: $accountTag }) { workersInvocationsAdaptive(limit: 1, filter: {}) { sum { requests } } } }
}`

// Cloudflare's answers (measured for #364): GraphQL answers a missing permission with 200.
const ACCOUNT_DENIED = { data: null, errors: [{ message: 'authorization denied' }] }
const ZONE_DENIED = {
  data: null,
  errors: [
    {
      message: `Actor 'com.cloudflare.api.token.x' does not have permission 'com.cloudflare.api.account.zone.analytics.read' for zone ${ZONE_ID}`
    }
  ]
}

/** The JSON bodies `/graphql` received, answering each with `answer`. */
function answerGraphql(answer: object, init?: ResponseInit): unknown[] {
  const received: unknown[] = []
  server.use(
    http.post(`${API_BASE}/graphql`, async ({ request }) => {
      received.push(await request.json())
      return HttpResponse.json(answer, init)
    })
  )
  return received
}

async function callGraphql(token: string, args: Record<string, unknown>, url = DIRECT_URL) {
  const body = await parseMcpResult(
    await exports.default.fetch(
      modernMcpRequest(token, 'tools/call', { name: 'graphql_analytics', arguments: args }, { url })
    )
  )
  return {
    result: body.result,
    text: body.result?.content?.[0]?.text ?? '',
    meta: body.result?._meta
  }
}

async function listedTools(url: string) {
  const body = await parseMcpResult(
    await exports.default.fetch(modernMcpRequest('cfat_graphql', 'tools/list', {}, { url }))
  )
  return body.result?.tools ?? []
}

beforeEach(async () => {
  await seedSpec({})
})

afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

describe('graphql_analytics tool definition', () => {
  const user: AuthProps = {
    type: 'user_token',
    accessToken: 'user-token',
    user: { id: 'user-1', email: 'alice@example.com' },
    accounts: [{ id: ACCOUNT_ID, name: 'Alice Co' }],
    version: AUTH_PROPS_VERSION
  }

  it('matches the definition the SDK generates for the Code Mode tool', async () => {
    const mcp = new McpServer({ name: 'graphql-schema-test', version: '1.0.0' })
    registerGraphqlAnalyticsTool(
      mcp,
      user,
      stringifyResponse,
      DIRECT_CONNECTION,
      new ScopeChallenge(undefined)
    )
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)])
    try {
      const { tools } = await client.listTools()
      expect(JSON.parse(JSON.stringify(tools))).toEqual([GRAPHQL_ANALYTICS_TOOL])
    } finally {
      await client.close()
      await mcp.close()
    }
  })

  it('is a read-only tool', () => {
    expect(GRAPHQL_ANALYTICS_TOOL.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    })
  })

  it.each([
    ['Code Mode', MCP_URL],
    ['direct tools', `${MCP_URL}?codemode=false`]
  ])('is listed in %s', async (_mode, url) => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })

    const tools = await listedTools(url)

    expect(tools.map((tool) => tool.name)).toContain('graphql_analytics')
    expect(tools.find((tool) => tool.name === 'graphql_analytics')).toMatchObject({
      annotations: { readOnlyHint: true }
    })
  })
})

describe('graphql_analytics runs queries only', () => {
  beforeEach(() => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
  })

  it.each([
    ['a mutation', 'mutation { deleteEverything }'],
    ['a named mutation after a comment', '# hi\nmutation Drop($a: Int = 1) { drop(a: $a) }'],
    ['a subscription', 'subscription { events { id } }'],
    ['a mutation after a query', '{ viewer { zones { zoneTag } } }\nmutation { drop }'],
    ['a mutation after a block string', '"""query"""\nmutation { drop }']
  ])('refuses %s and sends nothing', async (_name, query) => {
    const received = answerGraphql({ data: {} })

    const { result, text } = await callGraphql('cfat_graphql', { query })

    expect(result?.isError).toBe(true)
    expect(text).toContain('queries only')
    expect(text).toContain('Nothing was sent')
    expect(received).toEqual([])
  })

  it.each([
    ['a comment', '# mutation { drop }\n{ viewer { zones { zoneTag } } }'],
    ['a string', '{ viewer { zones(filter: { name: "mutation" }) { zoneTag } } }'],
    ['a block string', '{ viewer { zones(filter: { name: """a\nmutation""" }) { zoneTag } } }'],
    ['a field name', '{ viewer { mutation subscription } }'],
    [
      'a fragment name',
      'query { viewer { ...mutation } } fragment mutation on Viewer { zones { zoneTag } }'
    ],
    ['an operation name', 'query subscription { viewer { zones { zoneTag } } }']
  ])('sends a query whose %s mentions mutation', async (_name, query) => {
    const received = answerGraphql({ data: { viewer: {} } })

    const { result } = await callGraphql('cfat_graphql', { query })

    expect(result?.isError).not.toBe(true)
    expect(received).toEqual([{ query }])
  })

  it('refuses arguments it does not know', async () => {
    const received = answerGraphql({ data: {} })

    const { result, text } = await callGraphql('cfat_graphql', {
      query: '{ viewer { zones { zoneTag } } }',
      account_id: ACCOUNT_ID
    })

    expect(result?.isError).toBe(true)
    expect(text).toContain('Unrecognized key')
    expect(received).toEqual([])
  })
})

describe('graphql_analytics fills in $accountTag', () => {
  it('adds the connection’s only account when the query declares it', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    const received = answerGraphql({ data: { viewer: {} } })

    await callGraphql('cfat_graphql', { query: ACCOUNT_QUERY, variables: { limit: 5 } })

    expect(received).toEqual([
      { query: ACCOUNT_QUERY, variables: { limit: 5, accountTag: ACCOUNT_ID } }
    ])
  })

  it('keeps an explicit accountTag', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    const received = answerGraphql({ data: { viewer: {} } })

    await callGraphql('cfat_graphql', {
      query: ACCOUNT_QUERY,
      variables: { accountTag: OTHER_ACCOUNT_ID }
    })

    expect(received).toEqual([
      { query: ACCOUNT_QUERY, variables: { accountTag: OTHER_ACCOUNT_ID } }
    ])
  })

  it('sends a query that does not declare it as written', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    const received = answerGraphql({ data: { viewer: {} } })
    const query =
      'query ($zoneTag: string!) { viewer { zones(filter: { zoneTag: $zoneTag }) { zoneTag } } }'

    await callGraphql('cfat_graphql', { query, variables: { zoneTag: ZONE_ID } })
    await callGraphql('cfat_graphql', { query })

    expect(received).toEqual([{ query, variables: { zoneTag: ZONE_ID } }, { query }])
  })

  it('leaves it out when the connection has several accounts', async () => {
    mockIdentityProbe({
      user: { id: 'user-1', email: 'alice@example.com' },
      accounts: [
        { id: ACCOUNT_ID, name: 'One' },
        { id: OTHER_ACCOUNT_ID, name: 'Two' }
      ]
    })
    const received = answerGraphql({ data: { viewer: {} } })

    await callGraphql('cfut_graphql', { query: ACCOUNT_QUERY })

    expect(received).toEqual([{ query: ACCOUNT_QUERY }])
  })
})

describe('graphql_analytics explains a query refused for a missing permission', () => {
  it('names Account Analytics Read for an API token', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    answerGraphql(ACCOUNT_DENIED)

    const { result, text, meta } = await callGraphql('cfat_graphql', { query: ACCOUNT_QUERY })

    expect(result?.isError).toBe(true)
    expect(text).toContain('GraphQL error: authorization denied')
    expect(text).toContain('needs one of these permissions: Account Analytics Read')
    expect(meta).not.toHaveProperty('mcp/www_authenticate')
  })

  it('steps up for Analytics Read when an OAuth connection lacks it', async () => {
    const token = await connectWithOAuth(['user:read', 'account:read'], {
      id: ACCOUNT_ID,
      name: 'Acc'
    })
    answerGraphql(ZONE_DENIED)

    const { result, text, meta } = await callGraphql(token, {
      query: '{ viewer { zones { zoneTag } } }'
    })

    expect(result?.isError).toBe(true)
    expect(text).toContain('`analytics.read` (Analytics Read)')
    const challenges = meta?.['mcp/www_authenticate'] as string[]
    expect(challenges).toHaveLength(1)
    expect(challenges[0]).toContain('analytics.read')
  })

  it('steps up for Account Analytics Read, and not when the connection holds it', async () => {
    const missing = await connectWithOAuth(['user:read', 'account:read'], {
      id: ACCOUNT_ID,
      name: 'Acc'
    })
    answerGraphql(ACCOUNT_DENIED)

    const first = await callGraphql(missing, { query: ACCOUNT_QUERY })
    expect((first.meta?.['mcp/www_authenticate'] as string[])[0]).toContain(
      'account-analytics.read'
    )

    const held = await connectWithOAuth(['user:read', 'account:read', 'account-analytics.read'], {
      id: ACCOUNT_ID,
      name: 'Acc'
    })
    const second = await callGraphql(held, { query: ACCOUNT_QUERY })
    expect(second.text).toContain('already has `account-analytics.read`')
    expect(second.meta).not.toHaveProperty('mcp/www_authenticate')
  })

  it('adds no permission text to any other GraphQL error', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    answerGraphql({ data: null, errors: [{ message: 'unknown field "zonez"' }] })

    const { result, text, meta } = await callGraphql('cfat_graphql', {
      query: '{ viewer { zonez } }'
    })

    expect(result?.isError).toBe(true)
    expect(text).toContain('GraphQL error: unknown field "zonez"')
    expect(text).not.toContain('permission')
    expect(meta).not.toHaveProperty('mcp/www_authenticate')
  })

  it('is a success when data came back with errors', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    const partial = {
      data: { viewer: { zones: [{ zoneTag: ZONE_ID }, null] } },
      errors: [{ message: 'authorization denied', path: ['viewer', 'zones', 1] }]
    }
    answerGraphql(partial)

    const { result, text } = await callGraphql('cfat_graphql', {
      query: '{ viewer { zones { zoneTag } } }'
    })

    expect(result?.isError).not.toBe(true)
    expect(JSON.parse(text)).toEqual(partial)
  })
})

describe('graphql_analytics reads a failed request like the other direct tools', () => {
  it('explains a 403 REST envelope', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    answerGraphql(cfError([{ code: 10000, message: 'Authentication error' }]), { status: 403 })

    const { result, text } = await callGraphql('cfat_graphql', {
      query: '{ viewer { zones { zoneTag } } }'
    })

    expect(result?.isError).toBe(true)
    expect(text).toContain('Cloudflare API error: POST /graphql returned HTTP 403.')
    expect(text).toContain('Authentication error')
  })

  it('passes a 400 through as an error', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    answerGraphql(cfError([{ code: 1000, message: 'bad request' }]), { status: 400 })

    const { result, text } = await callGraphql('cfat_graphql', { query: '{' })

    expect(result?.isError).toBe(true)
    expect(text).toContain('POST /graphql returned HTTP 400.')
    expect(text).not.toContain('permission')
  })
})

describe('graphql_analytics in Code Mode', () => {
  it('runs a query and fills in $accountTag', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    const received = answerGraphql({ data: { viewer: { accounts: [] } } })

    const { result, text } = await callGraphql(
      'cfat_graphql',
      { query: ACCOUNT_QUERY },
      CODE_MODE_URL
    )

    expect(result?.isError).not.toBe(true)
    expect(JSON.parse(text)).toEqual({ data: { viewer: { accounts: [] } } })
    expect(received).toEqual([{ query: ACCOUNT_QUERY, variables: { accountTag: ACCOUNT_ID } }])
  })

  it('refuses a mutation', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    const received = answerGraphql({ data: {} })

    const { result, text } = await callGraphql(
      'cfat_graphql',
      { query: 'mutation { drop }' },
      CODE_MODE_URL
    )

    expect(result?.isError).toBe(true)
    expect(text).toContain('queries only')
    expect(received).toEqual([])
  })
})
