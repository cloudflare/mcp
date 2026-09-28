import { createExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import * as v0102 from 'workers-oauth-provider-0-10-2'
import * as v110 from 'workers-oauth-provider-1-1-0'
import { afterEach, describe, expect, it } from 'vitest'
import { AUTH_PROPS_VERSION } from '../../src/auth/types'
import { cfAccountsSuccess, cfSuccess } from '../helpers/cloudflare-api'
import { clearKv } from '../helpers/kv'
import { modernMcpRequest, parseMcpResult } from '../helpers/mcp'
import { server } from '../setup/msw'

/**
 * Grants and tokens issued before an upgrade keep working after it. Each case issues them with the
 * real package a deployment ran (0.10.2 in production, 1.1.0 on staging), configured as that
 * deployment was, into the same OAUTH_KV; then the current worker, on the current package, serves
 * the access token, refreshes the grant, and serves the new token.
 */

const MCP_ORIGIN = 'https://mcp.cloudflare.com'
const MCP_RESOURCE = `${MCP_ORIGIN}/mcp`
const REDIRECT_URI = 'https://app.example.com/cb'
const CODE_VERIFIER = 'test-downstream-code-verifier'
const CODE_CHALLENGE = 'I4fhllfHqqQsgap17V2SDI0scSei8H7U0e0rZBDIcbo'

const notFound = { fetch: () => new Response(null, { status: 404 }) }

/** What issuing tokens needs from a legacy release: its provider and two of its helpers. */
interface LegacyDeployment {
  fetch(request: Request): Promise<Response>
  /** parseAuthRequest() then completeAuthorization() with the props that release's callback stored. */
  authorize(authorizeUrl: string): Promise<string>
}

/** The props the /oauth/callback of these releases stored. */
const CALLBACK_PROPS = {
  type: 'user_token',
  user: { id: 'user-1', email: 'user@example.com' },
  accounts: [{ id: 'acc-1', name: 'Account One' }],
  accountCount: 1,
  version: AUTH_PROPS_VERSION,
  accessToken: 'upstream-access-1',
  refreshToken: 'upstream-refresh-1'
}

/** The provider options each release shipped with, minus the handlers issuing tokens doesn't reach. */
const BASE_OPTIONS = {
  apiHandlers: { '/mcp': notFound },
  defaultHandler: notFound,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: { resource: MCP_RESOURCE, resource_name: 'Cloudflare API MCP Server' },
  accessTokenTTL: 3600,
  refreshTokenTTL: 2592000
}

/** Production: 0.10.2, which also matched legacy grants by origin. */
function production0102(): LegacyDeployment {
  const options: v0102.OAuthProviderOptions = { ...BASE_OPTIONS, resourceMatchOriginOnly: true }
  const provider = new v0102.OAuthProvider(options)
  const helpers = v0102.getOAuthApi(options, env)
  const ctx = createExecutionContext()
  return {
    fetch: (request) => provider.fetch(request, env, ctx),
    async authorize(authorizeUrl) {
      const request = await helpers.parseAuthRequest(new Request(authorizeUrl))
      const grant = { request, userId: 'user-1', metadata: { label: 'user@example.com' }, scope: request.scope }
      return (await helpers.completeAuthorization({ ...grant, props: CALLBACK_PROPS })).redirectTo
    }
  }
}

/** Staging: 1.1.0. */
function staging110(): LegacyDeployment {
  const options: v110.OAuthProviderOptions = BASE_OPTIONS
  const provider = new v110.OAuthProvider(options)
  const helpers = v110.getOAuthApi(options, env)
  const ctx = createExecutionContext()
  return {
    fetch: (request) => provider.fetch(request, env, ctx),
    async authorize(authorizeUrl) {
      const request = await helpers.parseAuthRequest(new Request(authorizeUrl))
      const grant = { request, userId: 'user-1', metadata: { label: 'user@example.com' }, scope: request.scope }
      return (await helpers.completeAuthorization({ ...grant, props: CALLBACK_PROPS })).redirectTo
    }
  }
}

const LEGACY_DEPLOYMENTS = [
  { version: '0.10.2 (production)', deploy: production0102 },
  { version: '1.1.0 (staging)', deploy: staging110 }
]

/** Register a client, authorize it and exchange the code, all on the legacy package. */
async function issueWithLegacy(
  legacy: LegacyDeployment,
  resource: string | undefined
): Promise<{ clientId: string; access_token: string; refresh_token: string }> {
  const registration = await legacy.fetch(
    new Request(`${MCP_ORIGIN}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' })
    })
  )
  expect(registration.status).toBe(201)
  const { client_id: clientId } = (await registration.json()) as { client_id: string }

  const authorize = new URL(`${MCP_ORIGIN}/authorize`)
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: 'user:read account:read offline_access',
    state: 'client-state',
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    ...(resource === undefined ? {} : { resource })
  }).toString()
  const code = new URL(await legacy.authorize(authorize.href)).searchParams.get('code')!
  const exchange = await legacy.fetch(
    new Request(`${MCP_ORIGIN}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: CODE_VERIFIER,
        ...(resource === undefined ? {} : { resource })
      }).toString()
    })
  )
  expect(exchange.status).toBe(200)
  const tokens = (await exchange.json()) as { access_token: string; refresh_token: string }
  return { clientId, ...tokens }
}

function refreshRequest(clientId: string, refreshToken: string): Request {
  return new Request(`${MCP_ORIGIN}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId
      }).toString()
  })
}

/** The current worker's token endpoint. */
function refresh(clientId: string, refreshToken: string): Promise<Response> {
  return exports.default.fetch(refreshRequest(clientId, refreshToken))
}

async function listTools(accessToken: string): Promise<{ status: number; tools?: string[] }> {
  const response = await exports.default.fetch(modernMcpRequest(accessToken, 'tools/list'))
  if (response.status !== 200) return { status: response.status }
  const body = await parseMcpResult(response)
  return { status: 200, tools: body.result?.tools?.map((tool) => tool.name) }
}

/** Cloudflare's token endpoint rotates the upstream grant; count the rotations. */
function useUpstreamRefresh(): () => string[] {
  const seen: string[] = []
  server.use(
    http.post('https://dash.cloudflare.com/oauth2/token', async ({ request }) => {
      seen.push(new URLSearchParams(await request.text()).get('refresh_token') ?? '')
      return HttpResponse.json({
        access_token: 'upstream-access-2',
        expires_in: 3600,
        refresh_token: 'upstream-refresh-2',
        scope: 'user:read account:read offline_access',
        token_type: 'bearer'
      })
    }),
    http.get('https://api.cloudflare.com/client/v4/user', () =>
      HttpResponse.json(cfSuccess({ id: 'user-1', email: 'user@example.com' }))
    ),
    http.get('https://api.cloudflare.com/client/v4/accounts', () =>
      HttpResponse.json(cfAccountsSuccess([{ id: 'acc-1', name: 'Account One' }]))
    )
  )
  return () => seen
}

afterEach(async () => {
  await clearKv(env.OAUTH_KV)
})

describe.each(LEGACY_DEPLOYMENTS)('grants issued by workers-oauth-provider $version', ({ deploy }) => {
  it('serve MCP, refresh, and serve the refreshed token after the upgrade', async () => {
    const legacy = await issueWithLegacy(deploy(), MCP_RESOURCE)
    const upstreamRefreshes = useUpstreamRefresh()

    // The access token issued before the upgrade is accepted as it is.
    expect(await listTools(legacy.access_token)).toEqual({ status: 200, tools: ['docs', 'search', 'execute'] })

    // The refresh token is too, and the upstream Cloudflare grant rotates with it.
    const refreshed = await refresh(legacy.clientId, legacy.refresh_token)
    expect(refreshed.status).toBe(200)
    const tokens = (await refreshed.json()) as { access_token: string; refresh_token: string; resource: string }
    expect(tokens.resource).toBe(MCP_RESOURCE)
    expect(upstreamRefreshes()).toEqual(['upstream-refresh-1'])
    expect(await listTools(tokens.access_token)).toEqual({ status: 200, tools: ['docs', 'search', 'execute'] })

    // The grant is rewritten in the current format (with KV key metadata) and keeps its resource.
    const [grant] = (await env.OAUTH_KV.list({ prefix: 'grant:' })).keys
    expect(grant.metadata).toMatchObject({ resource: MCP_RESOURCE })
  })

  it('serve a grant issued without a resource, bound to the sole resource', async () => {
    const legacy = await issueWithLegacy(deploy(), undefined)
    useUpstreamRefresh()
    expect((await listTools(legacy.access_token)).status).toBe(200)
    const refreshed = await refresh(legacy.clientId, legacy.refresh_token)
    expect(refreshed.status).toBe(200)
    await expect(refreshed.json()).resolves.toMatchObject({ resource: MCP_RESOURCE })
  })
})

describe('a grant bound to the bare origin, written before 0.10.1', () => {
  // Releases before 0.10.1 could bind a grant to the origin instead of the MCP endpoint; 0.10.x
  // never issues one. 1.x compares the resource exactly, and so, for these grants, did 0.10.2.
  it('fails to refresh with invalid_grant after the upgrade, as it already did on 0.10.2', async () => {
    const production = production0102()
    const legacy = await issueWithLegacy(production, MCP_RESOURCE)
    const [{ name: grantKey }] = (await env.OAUTH_KV.list({ prefix: 'grant:' })).keys
    const grant = (await env.OAUTH_KV.get(grantKey, 'json')) as Record<string, unknown>
    await env.OAUTH_KV.put(grantKey, JSON.stringify({ ...grant, resource: MCP_ORIGIN }))
    useUpstreamRefresh()

    const before = await production.fetch(refreshRequest(legacy.clientId, legacy.refresh_token))
    expect(before.status).toBe(400)

    const after = await refresh(legacy.clientId, legacy.refresh_token)
    expect(after.status).toBe(400)
    // invalid_grant tells conformant clients to start a new authorization.
    await expect(after.json()).resolves.toMatchObject({ error: 'invalid_grant' })
  })
})
