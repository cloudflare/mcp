import { env, exports } from 'cloudflare:workers'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUTH_PROPS_VERSION, type AuthProps } from '../src/auth/types'
import { runWhoamiTool, registerWhoamiTool, WHOAMI_TOOL } from '../src/tools/whoami'
import { mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, modernMcpRequest, parseMcpResult } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'

const USER_ID = '7c5dae5552338874e5053f2534d2767a'
const ACCOUNT_ID = '023e105f4ecef8ad9ca31a8372d0c353'

const user: AuthProps = {
  type: 'user_token',
  accessToken: 'user-token',
  user: { id: USER_ID, email: 'alice@example.com' },
  accounts: [{ id: ACCOUNT_ID, name: 'Alice Co' }],
  version: AUTH_PROPS_VERSION
}

const accountToken: AuthProps = {
  type: 'account_token',
  accessToken: 'account-token',
  account: { id: ACCOUNT_ID, name: 'Alice Co' }
}

async function listTools(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    return (await client.listTools()).tools
  } finally {
    await client.close()
    await server.close()
  }
}

describe('whoami tool definition', () => {
  it('matches the definition the SDK generates for the Code Mode tool', async () => {
    const server = new McpServer({ name: 'whoami-schema-test', version: '1.0.0' })
    registerWhoamiTool(server, user)

    expect(JSON.parse(JSON.stringify(await listTools(server)))).toEqual([WHOAMI_TOOL])
  })

  it('declares itself as the OpenAI profile tool', () => {
    expect(WHOAMI_TOOL).toMatchObject({
      name: 'whoami',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { required: ['id'], additionalProperties: false },
      _meta: { 'openai/profile': true }
    })
  })
})

describe('whoami result', () => {
  it('identifies a user credential as the Cloudflare user', () => {
    const profile = { id: `user:${USER_ID}`, email: 'alice@example.com' }
    expect(runWhoamiTool(user)).toEqual({
      content: [{ type: 'text', text: JSON.stringify(profile) }],
      structuredContent: profile
    })
  })

  it('identifies an account token as its account', () => {
    const profile = { id: `account:${ACCOUNT_ID}`, name: 'Alice Co' }
    expect(runWhoamiTool(accountToken)).toEqual({
      content: [{ type: 'text', text: JSON.stringify(profile) }],
      structuredContent: profile
    })
  })

  it('keeps the id when the token, email, or accounts change', () => {
    const refreshed: AuthProps = {
      ...user,
      accessToken: 'refreshed-token',
      refreshToken: 'refresh',
      user: { id: USER_ID, email: 'alice@new.example.com' },
      accounts: []
    }
    expect(runWhoamiTool(refreshed)).toHaveProperty('structuredContent.id', `user:${USER_ID}`)
  })

  it('gives a user and an account with the same ID different profiles', () => {
    const sameId: AuthProps = { ...accountToken, account: { id: USER_ID, name: 'Alice Co' } }
    expect(runWhoamiTool(sameId)).toHaveProperty('structuredContent.id', `account:${USER_ID}`)
    expect(runWhoamiTool(user)).toHaveProperty('structuredContent.id', `user:${USER_ID}`)
  })

  it('omits empty display fields', () => {
    const unnamed: AuthProps = { ...accountToken, account: { id: ACCOUNT_ID, name: '' } }
    expect(runWhoamiTool(unnamed).structuredContent).toEqual({ id: `account:${ACCOUNT_ID}` })
  })

  it('returns an error instead of a placeholder when the credential has no ID', () => {
    const anonymous: AuthProps = { ...user, user: { id: '', email: 'alice@example.com' } }
    expect(runWhoamiTool(anonymous)).toMatchObject({ isError: true })
    expect(runWhoamiTool(anonymous)).not.toHaveProperty('structuredContent')
  })
})

describe('whoami over MCP', () => {
  beforeEach(async () => {
    await seedSpec({})
  })

  afterEach(async () => {
    await clearKv(env.OAUTH_KV)
    await clearSpec()
  })

  it.each([
    ['Code Mode', MCP_URL],
    ['endpoint mode', `${MCP_URL}?codemode=false`]
  ])('identifies a user API token in %s', async (_mode, url) => {
    mockIdentityProbe({
      user: { id: USER_ID, email: 'alice@example.com' },
      accounts: [{ id: ACCOUNT_ID, name: 'Alice Co' }]
    })

    const listed = await parseMcpResult(
      await exports.default.fetch(modernMcpRequest('cfut_whoami', 'tools/list', {}, { url }))
    )
    expect(listed.result?.tools?.map((tool) => tool.name)).toContain('whoami')

    const response = await exports.default.fetch(
      modernMcpRequest('cfut_whoami', 'tools/call', { name: 'whoami', arguments: {} }, { url })
    )
    const body = await parseMcpResult(response)
    expect(response.status).toBe(200)
    expect(body.result).toMatchObject({
      structuredContent: { id: `user:${USER_ID}`, email: 'alice@example.com' }
    })
    expect(body.result?.isError).not.toBe(true)
  })

  it.each([
    ['Code Mode', MCP_URL],
    ['endpoint mode', `${MCP_URL}?codemode=false`]
  ])('identifies an account API token in %s', async (_mode, url) => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Alice Co' }] })

    const body = await parseMcpResult(
      await exports.default.fetch(
        modernMcpRequest('cfat_whoami', 'tools/call', { name: 'whoami', arguments: {} }, { url })
      )
    )
    expect(body.result).toMatchObject({
      structuredContent: { id: `account:${ACCOUNT_ID}`, name: 'Alice Co' }
    })
  })

  it.each([
    ['Code Mode', MCP_URL],
    ['endpoint mode', `${MCP_URL}?codemode=false`]
  ])('rejects arguments in %s', async (_mode, url) => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Alice Co' }] })

    const body = await parseMcpResult(
      await exports.default.fetch(
        modernMcpRequest(
          'cfat_whoami',
          'tools/call',
          { name: 'whoami', arguments: { account_id: ACCOUNT_ID } },
          { url }
        )
      )
    )
    expect(body.result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('Unrecognized key') }]
    })
    expect(body.result).not.toHaveProperty('structuredContent')
  })
})
