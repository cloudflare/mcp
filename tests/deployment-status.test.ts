import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API_BASE, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, modernMcpRequest, parseMcpResult } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'
const account = '023e105f4ecef8ad9ca31a8372d0c353'
const build = '11111111-1111-4111-8111-111111111111'
const prefix = `${API_BASE}/accounts/${account}`
function mock(outcome = 'success', percentage = 100, linked = true) {
  server.use(
    http.get(`${prefix}/workers/scripts`, () =>
      HttpResponse.json(cfSuccess([{ id: 'demo', tag: 'tag' }]))
    ),
    http.get(`${prefix}/workers/scripts/demo/deployments`, () =>
      HttpResponse.json(
        cfSuccess({
          deployments: [{ id: 'deployment', versions: [{ version_id: 'v1', percentage }] }]
        })
      )
    ),
    http.get(`${prefix}/builds/workers/tag/builds`, () =>
      HttpResponse.json(
        cfSuccess([
          {
            build_uuid: build,
            created_on: '2026-11-16T12:00:00Z',
            status: 'stopped',
            build_outcome: outcome,
            build_trigger_metadata: {
              commit_hash: 'abcdef123',
              branch: 'main',
              environment_variables: { SECRET: 'never-return' }
            }
          }
        ])
      )
    ),
    http.get(`${prefix}/builds/builds/${build}/logs`, () =>
      HttpResponse.json(
        cfSuccess({
          events: [
            {
              type: 'initializing',
              started_on: '2026-11-16T12:00:00Z',
              ended_on: '2026-11-16T12:00:02Z'
            },
            {
              type: 'deploying',
              started_on: '2026-11-16T12:00:02Z',
              ended_on: '2026-11-16T12:00:04Z'
            }
          ],
          truncated: true,
          lines: [['private log text must not be retained']]
        })
      )
    ),
    http.get(`${prefix}/builds/builds`, () =>
      HttpResponse.json(cfSuccess({ builds: linked ? { v1: { build_uuid: build } } : {} }))
    )
  )
}
async function call(mode = '', args: Record<string, unknown> = {}) {
  const response = await exports.default.fetch(
    modernMcpRequest(
      'status-token',
      'tools/call',
      { name: 'workers_deployment_status', arguments: { script_name: 'demo', ...args } },
      { url: MCP_URL + mode }
    )
  )
  const parsed = await parseMcpResult(response)
  return parsed.result
}
beforeEach(async () => {
  await seedSpec({})
  mockIdentityProbe({ accounts: [{ id: account, name: 'Test' }] })
})
afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})
describe('deployment status through real MCP worker', () => {
  for (const mode of ['', '?codemode=false'])
    it(`proves build to traffic link ${mode}`, async () => {
      mock()
      const result = await call(mode)
      expect(result?.structuredContent).toMatchObject({ state: 'live', traffic: 100 })
      expect(JSON.stringify(result)).not.toContain('never-return')
      expect(JSON.stringify(result)).not.toContain('private log text')
      expect(result?.structuredContent).toMatchObject({
        events: [{ type: 'initializing' }, { type: 'deploying' }]
      })
    })
  it('keeps deployment evidence when optional stage events fail', async () => {
    mock()
    server.use(
      http.get(`${prefix}/builds/builds/${build}/logs`, () =>
        HttpResponse.json({}, { status: 403 })
      )
    )
    expect((await call())?.structuredContent).toMatchObject({ state: 'live', events: [] })
  })
  it('shows a failed build rather than green deployment', async () => {
    mock('fail')
    expect((await call())?.structuredContent).toMatchObject({
      state: 'failed',
      failureStage: 'deploying',
      message: 'Deployment failed. This run is not established as deployed.'
    })
  })
  it('keeps failure wording generic when stage evidence is missing', async () => {
    mock('fail')
    server.use(
      http.get(`${prefix}/builds/builds/${build}/logs`, () =>
        HttpResponse.json(cfSuccess({ events: [] }))
      )
    )
    const result = (await call())?.structuredContent
    expect(result).toMatchObject({ state: 'failed', events: [] })
    expect(result).not.toHaveProperty('failureStage')
    expect(result).toHaveProperty(
      'message',
      'The build run failed. The failed stage and deployed changes could not be established.'
    )
  })
  it('does not infer live from successful build without version link', async () => {
    mock('success', 100, false)
    expect((await call())?.structuredContent).toMatchObject({ state: 'unverified' })
  })
  it('reports partial traffic', async () => {
    mock('success', 25)
    expect((await call())?.structuredContent).toMatchObject({ state: 'partial', traffic: 25 })
  })
  it('does not mistake an inaccessible Worker for an offline site', async () => {
    mock()
    server.use(http.get(`${prefix}/workers/scripts`, () => HttpResponse.json(cfSuccess([]))))
    expect((await call())?.structuredContent).toMatchObject({ state: 'unverified', build: null })
  })
  it('does not mistake missing build history for no deployment', async () => {
    mock()
    server.use(
      http.get(`${prefix}/builds/workers/tag/builds`, () => HttpResponse.json(cfSuccess([])))
    )
    expect((await call())?.structuredContent).toMatchObject({ state: 'no_builds' })
  })
  it('rejects a deployment that changes while linking versions', async () => {
    mock()
    let reads = 0
    server.use(
      http.get(`${prefix}/workers/scripts/demo/deployments`, () =>
        HttpResponse.json(
          cfSuccess({
            deployments: [
              { id: `deployment-${reads++}`, versions: [{ version_id: 'v1', percentage: 100 }] }
            ]
          })
        )
      )
    )
    const result = (await call())?.structuredContent
    expect(result).toMatchObject({ state: 'unverified' })
    expect(result).not.toHaveProperty('traffic')
  })
  it('rejects a historical build belonging to another Worker', async () => {
    mock()
    server.use(
      http.get(`${prefix}/builds/builds/${build}`, () =>
        HttpResponse.json(
          cfSuccess({
            build_uuid: build,
            created_on: '2026-11-16T12:00:00Z',
            status: 'stopped',
            build_outcome: 'success',
            trigger: { external_script_id: 'another-worker' }
          })
        )
      )
    )
    expect((await call('', { build_id: build }))?.structuredContent).toMatchObject({
      state: 'unverified',
      build: null
    })
  })
  it('serves a self-contained App resource without account data', async () => {
    const response = await exports.default.fetch(
      modernMcpRequest('status-token', 'resources/read', {
        uri: 'ui://cloudflare/deployment-status.html'
      })
    )
    const { result } = await parseMcpResult(response)
    expect(result).toMatchObject({ contents: [{ mimeType: 'text/html;profile=mcp-app' }] })
    expect(JSON.stringify(result)).not.toContain('status-token')
    expect(JSON.stringify(result)).not.toContain(account)
  })
  it('renders a refused read as unverified', async () => {
    server.use(
      http.get(`${prefix}/workers/scripts`, () =>
        HttpResponse.json(
          { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
          { status: 403 }
        )
      )
    )
    expect((await call())?.structuredContent).toMatchObject({ state: 'unverified', build: null })
  })
})
