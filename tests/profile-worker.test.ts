import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProfileTool } from '../src/tools/profile'
import {
  API_BASE,
  cfAccountsSuccess,
  cfError,
  cfSuccess,
  mockIdentityProbe
} from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_HOST, MCP_URL, modernMcpRequest, parseMcpResult } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'

const SUBJECT_ID = '00000000000000000000000000000001'
// Permanent fixtures: changing the encoding must not silently rename profiles.
const USER_PROFILE_ID = '0fb8feb386a6c952d79a83e88b0fac8435bdf44ea4bdeaf675d9f5d6058c2455'
const ACCOUNT_PROFILE_ID = '85e1035ef0f71e5a7ec8fabced8bb5b51e6d35312c9a3c625bad1078305001e9'
const CASES = [
  { version: '2026-07-28', codemode: true },
  { version: '2026-07-28', codemode: false },
  { version: '2025-06-18', codemode: true },
  { version: '2025-06-18', codemode: false }
]

function request(
  token: string,
  method: string,
  args: Record<string, unknown>,
  version: string,
  codemode: boolean
): Request {
  const url = codemode ? MCP_URL : `${MCP_URL}?codemode=false`
  const params = method === 'tools/call' ? { name: 'get_profile', arguments: args } : {}
  if (version === '2026-07-28') return modernMcpRequest(token, method, params, { url })
  return new Request(url, {
    method: 'POST',
    headers: {
      Host: MCP_HOST,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': version
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
}

async function result(
  token: string,
  method: string,
  args: Record<string, unknown> = {},
  version = '2026-07-28',
  codemode = true
) {
  const response = await exports.default.fetch(request(token, method, args, version, codemode))
  expect(response.status).toBe(200)
  return (await parseMcpResult(response)).result as {
    content?: Array<{ type: string; text: string }>
    structuredContent?: { id: string; email?: string; name?: string }
    isError?: boolean
    tools?: Array<Record<string, unknown>>
  }
}

beforeEach(async () => {
  await seedSpec({})
  mockIdentityProbe({ user: { id: SUBJECT_ID, email: 'same-label@example.com' }, accounts: [] })
})
afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

describe.each(CASES)(
  'authenticated profile: $version, codemode=$codemode',
  ({ version, codemode }) => {
    it('publishes the designated read-only profile contract and returns matching JSON/structured content', async () => {
      const listed = await result('cfut_profile-token', 'tools/list', {}, version, codemode)
      const profileTool = listed.tools?.find((tool) => tool.name === 'get_profile')
      expect(profileTool).toMatchObject({
        _meta: {
          'openai/profile': true,
          securitySchemes: [{ type: 'oauth2', scopes: ['user:read', 'account:read'] }]
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: {
          type: 'object',
          properties: { id: { type: 'string', minLength: 1, pattern: '\\S' } },
          required: ['id'],
          additionalProperties: false
        }
      })
      expect(profileTool?.description).toContain('do not cache responses')
      const called = await result('cfut_profile-token', 'tools/call', {}, version, codemode)
      expect(called.isError).toBe(false)
      expect(called.structuredContent).toEqual({
        id: USER_PROFILE_ID,
        email: 'same-label@example.com'
      })
      expect(JSON.parse(called.content![0].text)).toEqual(called.structuredContent)
      expect(called.content![0].text).not.toContain('cfut_profile-token')
    })

    it.each([
      { label: 'success', args: {}, isError: false },
      { label: 'validation error', args: { user_id: 'someone-else' }, isError: true }
    ])(
      'prevents caching of profile $label responses, preserving browser CORS',
      async ({ args, isError }) => {
        for (const origin of [undefined, `https://${MCP_HOST}`]) {
          const req = request('cfut_profile-token', 'tools/call', args, version, codemode)
          if (origin) req.headers.set('Origin', origin)
          const response = await exports.default.fetch(req)
          expect(response.status).toBe(200)
          expect(response.headers.get('cache-control')).toBe('no-store, no-transform')
          expect(response.headers.get('access-control-allow-origin')).toBe(origin ?? null)
          const body = await parseMcpResult(response)
          expect(body.result?.isError).toBe(isError)
        }
      }
    )

    it('rejects caller-supplied profile selectors', async () => {
      const called = await result(
        'cfut_profile-token',
        'tools/call',
        { user_id: 'someone-else' },
        version,
        codemode
      )
      expect(called.isError).toBe(true)
      expect(called.structuredContent).toBeUndefined()
    })

    it('returns a real auth challenge when credentials are invalid', async () => {
      server.use(
        http.get(`${API_BASE}/user`, () =>
          HttpResponse.json(cfError([{ code: 10000, message: 'Authentication error' }]), {
            status: 401
          })
        )
      )
      const response = await exports.default.fetch(
        request('cfut_invalid-token', 'tools/call', {}, version, codemode)
      )
      expect(response.status).toBe(401)
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('www-authenticate')).toContain('invalid_token')
      expect(await response.text()).not.toContain('structuredContent')
    })
  }
)

it('keeps public metadata identical across users and tool modes', async () => {
  const first = await result('cfut_first', 'tools/list')
  mockIdentityProbe({
    user: { id: 'different-user', email: 'different@example.com' },
    accounts: []
  })
  const second = await result('cfut_second', 'tools/list', {}, '2026-07-28', false)
  expect(first.tools?.find((tool) => tool.name === 'get_profile')).toEqual(
    second.tools?.find((tool) => tool.name === 'get_profile')
  )
})

it('keeps user identity stable across credentials, email, account-list and permission changes', async () => {
  const first = await result('cfut_original', 'tools/call')
  mockIdentityProbe({
    user: { id: SUBJECT_ID, email: 'changed@example.com' },
    accounts: [{ id: 'new-account', name: 'New account' }]
  })
  const reconnected = await result('cfoat_new-credential', 'tools/call')
  expect(reconnected.structuredContent?.id).toBe(first.structuredContent?.id)
  expect(reconnected.structuredContent?.email).toBe('changed@example.com')
})

it('isolates concurrent identities, same display labels and account/user namespaces', async () => {
  server.use(
    http.get(`${API_BASE}/user`, ({ request }) =>
      HttpResponse.json(
        cfSuccess({
          id:
            request.headers.get('Authorization') === 'Bearer cfut_other'
              ? 'other-user'
              : SUBJECT_ID,
          email: 'same-label@example.com'
        })
      )
    ),
    http.get(`${API_BASE}/accounts`, () =>
      HttpResponse.json(cfAccountsSuccess([{ id: SUBJECT_ID, name: 'same-label@example.com' }]))
    )
  )
  const [user, other, account] = await Promise.all([
    result('cfut_user', 'tools/call'),
    result('cfut_other', 'tools/call'),
    result('cfat_account', 'tools/call', {}, '2026-07-28', false)
  ])
  expect(
    new Set([
      user.structuredContent?.id,
      other.structuredContent?.id,
      account.structuredContent?.id
    ]).size
  ).toBe(3)
  expect(account.structuredContent).toEqual({
    id: ACCOUNT_PROFILE_ID,
    name: 'same-label@example.com'
  })
  expect(account.structuredContent).not.toHaveProperty('email')
})

it.each([
  { type: 'user_token' as const, expectedId: USER_PROFILE_ID },
  { type: 'account_token' as const, expectedId: ACCOUNT_PROFILE_ID }
])(
  'preserves the permanent $type ID and distinguishes a recreated subject with the same label',
  async ({ type, expectedId }) => {
    const propsFor = (subject: string) =>
      type === 'user_token'
        ? {
            type,
            accessToken: 'unused',
            user: { id: subject, email: 'same-label@example.com' },
            accounts: []
          }
        : {
            type,
            accessToken: 'unused',
            account: { id: subject, name: 'same-label@example.com' }
          }
    const original = await runProfileTool(propsFor(SUBJECT_ID))
    const recreated = await runProfileTool(propsFor('00000000000000000000000000000002'))
    expect(original.structuredContent?.id).toBe(expectedId)
    expect(recreated.structuredContent?.id).not.toBe(expectedId)
    expect(original.isError).toBe(false)
    expect(recreated.isError).toBe(false)
  }
)

it('fails rather than inventing a profile for missing validated identity', async () => {
  const called = await runProfileTool({
    type: 'user_token',
    accessToken: 'unused',
    user: { id: ' ', email: 'user@example.com' },
    accounts: []
  })
  expect(called.isError).toBe(true)
  expect(called.structuredContent).toBeUndefined()
})

it('bounds display metadata without changing profile identity', async () => {
  const first = await runProfileTool({
    type: 'account_token',
    accessToken: 'unused',
    account: { id: SUBJECT_ID, name: 'a'.repeat(20_000) }
  })
  const renamed = await runProfileTool({
    type: 'account_token',
    accessToken: 'rotated',
    account: { id: SUBJECT_ID, name: 'Renamed' }
  })
  expect(first.structuredContent?.name).toHaveLength(256)
  expect(first.structuredContent?.id).toBe(renamed.structuredContent?.id)
})
