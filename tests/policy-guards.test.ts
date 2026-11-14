import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { policyRefusalHint } from '../src/policy-guards'
import { API_BASE, cfAccountsSuccess, cfSuccess } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, callTool, modernMcpRequest, parseMcpResult, toolText } from './helpers/mcp'
import { server } from './setup/msw'

const ACCOUNT_ID = '00000000000000000000000000000001'
const ACCOUNT = `/client/v4/accounts/${ACCOUNT_ID}`
const API_TOKEN = 'cfat_test-api-token-policy'

afterEach(() => clearKv(env.OAUTH_KV))

function apiRequest(method: string, path: string, body?: unknown): Request {
  return new Request(`https://api.cloudflare.com${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

describe('policyRefusalHint', () => {
  it.each([
    ['POST', `${ACCOUNT}/registrar/registrations`],
    ['POST', `${ACCOUNT}/registrar/registrations/example.com/transfer-in`],
    ['POST', `${ACCOUNT}/ai-gateway/billing/topup`],
    ['POST', `${ACCOUNT}/ai-gateway/billing/topup/config`],
    ['POST', `${ACCOUNT}/subscriptions`],
    ['PUT', `${ACCOUNT}/subscriptions/sub_1`],
    ['PUT', '/client/v4/zones/z1/subscription'],
    ['POST', '/client/v4/user/subscriptions'],
    ['POST', `${ACCOUNT}/payment-methods`],
    ['POST', `${ACCOUNT}/billing/profile/payment-method`],
    ['POST', `${ACCOUNT}//registrar/registrations/`],
    ['POST', `${ACCOUNT}/%72egistrar/registrations`],
    ['POST', `${ACCOUNT}/ai/run/@cf/black-forest-labs/flux-1-schnell`],
    ['POST', `${ACCOUNT}/ai/run/@cf/myshell-ai/melotts`],
    ['POST', `${ACCOUNT}/ai/run/@cf/stabilityai/stable-diffusion-xl-base-1.0`],
    ['POST', `${ACCOUNT}/ai/run/@cf/deepgram/aura-2-en`],
    ['POST', `${ACCOUNT}/%72egistrar/registrations/%`]
  ])('refuses %s %s', async (method, path) => {
    expect(await policyRefusalHint(apiRequest(method, path))).toBeDefined()
  })

  it('refuses a media model named in the body of the generic run endpoint', async () => {
    const body = { model: '@cf/myshell-ai/melotts', input: { prompt: 'hi' } }
    expect(await policyRefusalHint(apiRequest('POST', `${ACCOUNT}/ai/run`, body))).toBeDefined()
  })

  it('refuses a media model named in the body when the path names a text model', async () => {
    const body = { model: '@cf/black-forest-labs/flux-1-schnell', prompt: 'x' }
    const path = `${ACCOUNT}/ai/run/@cf/meta/llama-3.1-8b-instruct`
    expect(await policyRefusalHint(apiRequest('POST', path, body))).toBeDefined()
  })

  it('allows a text model named in the body, and leaves the body readable', async () => {
    const request = apiRequest('POST', `${ACCOUNT}/ai/run`, { model: 'openai/gpt-5.5', input: {} })
    expect(await policyRefusalHint(request)).toBeUndefined()
    expect(await request.json()).toEqual({ model: 'openai/gpt-5.5', input: {} })
  })

  it.each([
    ['GET', `${ACCOUNT}/registrar/registrations`],
    ['GET', `${ACCOUNT}/subscriptions`],
    ['POST', `${ACCOUNT}/registrar/domain-check`],
    ['POST', `${ACCOUNT}/event_subscriptions/subscriptions`],
    ['POST', '/client/v4/subscriptions/sub_1/consume'],
    ['POST', `${ACCOUNT}/ai/run/@cf/meta/llama-3.1-8b-instruct`],
    ['POST', `${ACCOUNT}/ai/run/@cf/openai/whisper`],
    ['POST', `${ACCOUNT}/ai/run/@cf/deepgram/nova-3`]
  ])('allows %s %s', async (method, path) => {
    expect(await policyRefusalHint(apiRequest(method, path))).toBeUndefined()
  })
})

describe('execute', () => {
  it.each([
    [`/accounts/${ACCOUNT_ID}/registrar/registrations`, {}, 'spend money'],
    [`/accounts/${ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {}, 'generate images'],
    [`/accounts/${ACCOUNT_ID}/ai/run`, { model: '@cf/myshell-ai/melotts' }, 'generate images']
  ])('refuses POST %s without sending it', async (path, body, hint) => {
    let sent = false
    server.use(
      http.get(`${API_BASE}/accounts`, () =>
        HttpResponse.json(cfAccountsSuccess([{ id: ACCOUNT_ID, name: 'Policy Test Account' }]))
      ),
      http.post(`${API_BASE}/accounts/${ACCOUNT_ID}/*`, () => {
        sent = true
        return HttpResponse.json(cfSuccess({}))
      })
    )
    const code = `async () => cloudflare.request({ method: "POST", path: ${JSON.stringify(path)}, body: ${JSON.stringify(body)} })`
    const result = await callTool(API_TOKEN, 'execute', { code })
    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toContain(hint)
    expect(sent).toBe(false)
  })

  it('still sends a text model named in the body, with the body intact', async () => {
    let forwarded: unknown
    server.use(
      http.get(`${API_BASE}/accounts`, () =>
        HttpResponse.json(cfAccountsSuccess([{ id: ACCOUNT_ID, name: 'Policy Test Account' }]))
      ),
      http.post(`${API_BASE}/accounts/${ACCOUNT_ID}/ai/run`, async ({ request }) => {
        forwarded = await request.json()
        return HttpResponse.json(cfSuccess({ response: 'hello there' }))
      })
    )
    const body = { model: '@cf/meta/llama-3.1-8b-instruct', input: { prompt: 'hi' } }
    const code = `async () => cloudflare.request({ method: "POST", path: "/accounts/${ACCOUNT_ID}/ai/run", body: ${JSON.stringify(body)} })`
    const result = await callTool(API_TOKEN, 'execute', { code })
    expect(toolText(result)).toContain('hello there')
    expect(forwarded).toEqual(body)
  })
})

describe('generated tools (?codemode=false)', () => {
  it.each([
    [
      'registrar_registrations_create',
      { path: { account_id: ACCOUNT_ID }, body: { domain_name: 'example.com' } },
      'spend money'
    ],
    [
      'ai_run',
      {
        path: { account_id: ACCOUNT_ID },
        body: { model: '@cf/black-forest-labs/flux-1-schnell', input: { prompt: 'x' } }
      },
      'generate images'
    ]
  ])('refuses %s without sending it', async (name, args, hint) => {
    let sent = false
    server.use(
      http.get(`${API_BASE}/accounts`, () =>
        HttpResponse.json(cfAccountsSuccess([{ id: ACCOUNT_ID, name: 'Policy Test Account' }]))
      ),
      http.post(`${API_BASE}/accounts/${ACCOUNT_ID}/*`, () => {
        sent = true
        return HttpResponse.json(cfSuccess({}))
      })
    )
    const response = await exports.default.fetch(
      modernMcpRequest(
        API_TOKEN,
        'tools/call',
        { name, arguments: args },
        { url: `${MCP_URL}?codemode=false` }
      )
    )
    const result = await parseMcpResult(response)
    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toContain(hint)
    expect(sent).toBe(false)
  })
})
