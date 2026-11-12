import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API_BASE, cfError, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { callTool, modernMcpRequest, parseMcpResult, toolText } from './helpers/mcp'
import { connectWithOAuth } from './helpers/oauth'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'
import { fetchSingleAttempt } from '../src/utils/fetch-single-attempt'

const ACCOUNT = 'single-attempt-account'
const PATH = `/accounts/${ACCOUNT}/workers/scripts/test/versions`
const TOKEN = 'cfat_single-attempt-test'
const CODE = `async () => cloudflare.request({method: 'POST', path: '${PATH}', body: 'private-upload-source'})`

beforeEach(() => {
  mockIdentityProbe({ accounts: [{ id: ACCOUNT, name: 'Test' }] })
})
afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

describe('execute single-attempt mode', () => {
  it.each([200, 401, 403, 429, 500])('sends once and sanitizes HTTP %i', async (status) => {
    let attempts = 0
    server.use(
      http.post(`${API_BASE}${PATH}`, () => {
        attempts++
        return HttpResponse.json(cfError([{ code: 10000, message: 'private-upload-source' }]), {
          status,
          headers: { 'Retry-After': '0', 'X-Private': 'private-header' }
        })
      })
    )
    const result = await callTool(TOKEN, 'execute', { code: CODE, maxRetries: 0 })
    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toContain(`HTTP ${status}`)
    expect(toolText(result)).toContain('10000')
    expect(toolText(result)).toContain('outboundAttempts: 1')
    expect(JSON.stringify(result)).not.toContain('private-upload-source')
    expect(JSON.stringify(result)).not.toContain('private-header')
    expect(attempts).toBe(1)
  })

  it('reports an uncertain network outcome without retrying the upload', async () => {
    let attempts = 0
    server.use(
      http.post(`${API_BASE}${PATH}`, () => {
        attempts++
        return HttpResponse.error()
      })
    )
    const result = await callTool(TOKEN, 'execute', { code: CODE, maxRetries: 0 })
    expect(toolText(result)).toContain('outcome unknown after 1 outbound attempt')
    expect(attempts).toBe(1)
  })

  it.each([301, 302, 303, 307, 308])(
    'does not follow a %i redirect in either isolate',
    async (status) => {
      let attempts = 0
      let redirected = 0
      server.use(
        http.post(`${API_BASE}${PATH}`, () => {
          attempts++
          return new HttpResponse(null, {
            status,
            headers: { Location: `${API_BASE}/redirect-target` }
          })
        }),
        http.all(`${API_BASE}/redirect-target`, () => {
          redirected++
          return HttpResponse.json(cfSuccess({}))
        })
      )
      const result = await callTool(TOKEN, 'execute', { code: CODE, maxRetries: 0 })
      expect(result.result?.isError).toBe(true)
      expect(toolText(result)).toContain(`HTTP ${status}`)
      expect(attempts).toBe(1)
      expect(redirected).toBe(0)
    }
  )

  it('preserves successful uploads', async () => {
    let attempts = 0
    server.use(
      http.post(`${API_BASE}${PATH}`, () => {
        attempts++
        return HttpResponse.json(cfSuccess({ id: 'version-1' }))
      })
    )
    const result = await callTool(TOKEN, 'execute', { code: CODE, maxRetries: 0 })
    expect(result.result?.isError).toBeFalsy()
    expect(toolText(result)).toContain('version-1')
    expect(attempts).toBe(1)
  })

  it('keeps default retries when the option is omitted', async () => {
    let attempts = 0
    server.use(
      http.post(`${API_BASE}${PATH}`, () => {
        attempts++
        return attempts === 1
          ? HttpResponse.json(cfError([]), { status: 429, headers: { 'Retry-After': '0' } })
          : HttpResponse.json(cfSuccess({ id: 'version-1' }))
      })
    )
    const result = await callTool(TOKEN, 'execute', { code: CODE })
    expect(result.result?.isError).toBeFalsy()
    expect(attempts).toBe(2)
  })

  it.each([-1, 1, '0', null])(
    'rejects an unsupported maxRetries value %j before executing',
    async (maxRetries) => {
      let attempts = 0
      server.use(
        http.post(`${API_BASE}${PATH}`, () => {
          attempts++
          return HttpResponse.json(cfSuccess({}))
        })
      )
      const result = await callTool(TOKEN, 'execute', { code: CODE, maxRetries })
      expect(Boolean(result.error || result.result?.isError)).toBe(true)
      expect(attempts).toBe(0)
    }
  )

  it('omits a non-JSON HTTP error body', async () => {
    server.use(
      http.post(
        `${API_BASE}${PATH}`,
        () => new HttpResponse('private-upload-source', { status: 502 })
      )
    )
    const result = await callTool(TOKEN, 'execute', { code: CODE, maxRetries: 0 })
    expect(toolText(result)).toContain('HTTP 502')
    expect(toolText(result)).toContain('provider error codes: []')
    expect(toolText(result)).not.toContain('private-upload-source')
  })

  it('does not retry an interrupted request after its timeout', async () => {
    const controller = new AbortController()
    let attempts = 0
    server.use(
      http.post(`${API_BASE}${PATH}`, () => {
        attempts++
        controller.abort(new DOMException('private timeout details', 'TimeoutError'))
        return HttpResponse.json(cfSuccess({ id: 'version-1' }))
      })
    )
    await expect(
      fetchSingleAttempt(
        new Request(`${API_BASE}${PATH}`, {
          method: 'POST',
          body: 'private-upload-source',
          signal: controller.signal
        })
      )
    ).rejects.toThrow('outcome unknown after 1 outbound attempt')
    expect(attempts).toBe(1)
  })

  it.each(['http', 'tool'])(
    'does not emit a %s permission challenge after an upload refusal',
    async (delivery) => {
      await seedSpec(
        {
          '/accounts/{account_id}/workers/scripts/{script_name}/versions': {
            post: { summary: 'Upload version', 'x-api-token-group': ['Workers Scripts Write'] }
          }
        },
        ['workers']
      )
      const token = await connectWithOAuth(['user:read', 'account:read'])
      let attempts = 0
      server.use(
        http.post(`${API_BASE}${PATH}`, () => {
          attempts++
          return HttpResponse.json(cfError([{ code: 10000, message: 'Authentication error' }]), {
            status: 403
          })
        })
      )
      const ordinaryResponse = await exports.default.fetch(
        modernMcpRequest(
          token,
          'tools/call',
          {
            name: 'execute',
            arguments: { code: CODE }
          },
          { url: `https://mcp.cloudflare.com/mcp?scopeChallenge=${delivery}` }
        )
      )
      if (delivery === 'http') {
        expect(ordinaryResponse.status).toBe(403)
        expect(ordinaryResponse.headers.get('WWW-Authenticate')).toContain('insufficient_scope')
        await ordinaryResponse.text()
      } else {
        expect((await parseMcpResult(ordinaryResponse)).result?._meta).toHaveProperty(
          'mcp/www_authenticate'
        )
      }
      expect(attempts).toBe(1)
      attempts = 0
      const response = await exports.default.fetch(
        modernMcpRequest(
          token,
          'tools/call',
          {
            name: 'execute',
            arguments: { code: CODE, maxRetries: 0 }
          },
          { url: `https://mcp.cloudflare.com/mcp?scopeChallenge=${delivery}` }
        )
      )
      expect(response.status).toBe(200)
      expect(response.headers.has('WWW-Authenticate')).toBe(false)
      const result = await parseMcpResult(response)
      expect(result.result?.isError).toBe(true)
      expect(result.result?._meta).not.toHaveProperty('mcp/www_authenticate')
      expect(attempts).toBe(1)
    }
  )
})
