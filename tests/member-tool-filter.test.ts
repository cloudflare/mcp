import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetMemberRolesMemo } from '../src/auth/member-permissions'
import { tools as generatedTools } from '../src/generated/forge-mcp'
import { buildMcpTools } from '../src/openapi'
import { membership, mockIdentityProbe, mockMemberships } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, mcpToolListRequest, parseMcpResult } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'

/**
 * The direct tools leave out endpoints none of the user's member roles reach,
 * through the real worker: auth, the transport and both direct-tool engines
 * are real; the Cloudflare API is mocked with MSW.
 */

const ACCOUNT = { id: '00000000000000000000000000000001', name: 'Acc' }
const USER_TOKEN = 'cfut_member_filter'
const ACCOUNT_TOKEN = 'cfat_member_filter'

const SPEC_PATHS = {
  '/accounts/{account_id}/d1/database': {
    get: {
      summary: 'List D1 Databases',
      parameters: [{ name: 'account_id', in: 'path', required: true }],
      'x-api-token-group': ['D1 Read', 'D1 Write']
    },
    post: {
      summary: 'Create D1 Database',
      parameters: [{ name: 'account_id', in: 'path', required: true }],
      'x-api-token-group': ['D1 Write']
    }
  },
  '/accounts/{account_id}/future': {
    get: {
      summary: 'A Future Product',
      parameters: [{ name: 'account_id', in: 'path', required: true }],
      'x-api-token-group': ['A Permission From Next Year']
    }
  },
  '/accounts/{account_id}/unlisted': {
    get: {
      summary: 'No Permissions Listed',
      parameters: [{ name: 'account_id', in: 'path', required: true }]
    }
  }
}

const toolName = (path: string, method: string) =>
  buildMcpTools(SPEC_PATHS).find((tool) => tool.path === path && tool.method === method)!.name

async function listToolNames(token: string, query: string): Promise<string[]> {
  const response = await exports.default.fetch(
    new Request(`${MCP_URL}?${query}`, mcpToolListRequest(token))
  )
  const result = (await parseMcpResult(response)) as {
    result?: { tools?: Array<{ name: string }> }
  }
  return (result.result?.tools ?? []).map((tool) => tool.name)
}

beforeEach(async () => {
  await seedSpec(SPEC_PATHS)
})

afterEach(async () => {
  resetMemberRolesMemo()
  await clearSpec()
  await clearKv(env.OAUTH_KV)
})

describe('?codemode=false', () => {
  const listD1 = toolName('/accounts/{account_id}/d1/database', 'get')
  const createD1 = toolName('/accounts/{account_id}/d1/database', 'post')

  it('leaves out endpoints a read-only member can’t use', async () => {
    mockIdentityProbe({ user: { id: 'user', email: 'user@example.com' }, accounts: [ACCOUNT] })
    mockMemberships([[membership(['Administrator Read Only'])]])

    const names = await listToolNames(USER_TOKEN, 'codemode=false')

    expect(names).toContain(listD1)
    expect(names).not.toContain(createD1)
    expect(names).toContain(toolName('/accounts/{account_id}/future', 'get'))
    expect(names).toContain(toolName('/accounts/{account_id}/unlisted', 'get'))
    expect(names.slice(0, 2)).toEqual(['docs', 'whoami'])
  })

  it('lists every endpoint for a Super Administrator', async () => {
    mockIdentityProbe({ user: { id: 'user', email: 'user@example.com' }, accounts: [ACCOUNT] })
    mockMemberships([[membership(['Super Administrator - All Privileges'])]])

    expect(await listToolNames(USER_TOKEN, 'codemode=false')).toHaveLength(2 + 4)
  })

  it('lists every endpoint for an account token, without asking for memberships', async () => {
    mockIdentityProbe({ accounts: [ACCOUNT] })
    const memberships = mockMemberships([[membership(['Administrator Read Only'])]])

    expect(await listToolNames(ACCOUNT_TOKEN, 'codemode=false')).toContain(createD1)
    expect(memberships.requests).toBe(0)
  })
})

describe('?codemode=false&experimentalForge=true', () => {
  const QUERY = 'codemode=false&experimentalForge=true'

  it('leaves out generated tools a read-only member can’t use', async () => {
    mockIdentityProbe({ user: { id: 'user', email: 'user@example.com' }, accounts: [ACCOUNT] })
    mockMemberships([[membership(['Administrator Read Only'])]])

    const names = await listToolNames(USER_TOKEN, QUERY)

    expect(names).toContain('d1_list')
    expect(names).not.toContain('d1_create')
    expect(names.length).toBeLessThan(2 + generatedTools.length)
  })

  it('lists every generated tool for a Super Administrator', async () => {
    mockIdentityProbe({ user: { id: 'user', email: 'user@example.com' }, accounts: [ACCOUNT] })
    mockMemberships([[membership(['Super Administrator - All Privileges'])]])

    expect(await listToolNames(USER_TOKEN, QUERY)).toHaveLength(2 + generatedTools.length)
  })
})
