import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { policyRefusalHint, subscriptionCreate } from '../src/policy-guards'
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
    const body = { model: '@cf/meta/llama-3.1-8b-instruct', input: {} }
    const request = apiRequest('POST', `${ACCOUNT}/ai/run`, body)
    expect(await policyRefusalHint(request)).toBeUndefined()
    expect(await request.json()).toEqual(body)
  })

  it.each([
    [`${ACCOUNT}/ai/run`, 'google/nano-banana'],
    [`${ACCOUNT}/ai/run`, 'google/veo-3.1'],
    [`${ACCOUNT}/ai/run`, 'openai/gpt-image-2'],
    [`${ACCOUNT}/ai/run`, 'elevenlabs/eleven-v3'],
    [`${ACCOUNT}/ai/run`, 'openai/gpt-5.5'],
    [`${ACCOUNT}/ai/v1/responses`, 'openai/gpt-image-2'],
    [`${ACCOUNT}/ai/v1/chat/completions`, 'openai/tts-1']
  ])('refuses the third-party model in the body of POST %s (%s)', async (path, model) => {
    expect(await policyRefusalHint(apiRequest('POST', path, { model }))).toContain(
      'Workers AI models'
    )
  })

  it('refuses a third-party model named in the run path', async () => {
    const path = `${ACCOUNT}/ai/run/bytedance/seedream-5-pro`
    expect(await policyRefusalHint(apiRequest('POST', path))).toContain('Workers AI models')
  })

  it.each([`${ACCOUNT}/ai/v1/chat/completions`, `${ACCOUNT}/ai/v1/responses`])(
    'refuses a Workers AI media model in the body of POST %s',
    async (path) => {
      const body = { model: '@cf/black-forest-labs/flux-1-schnell' }
      expect(await policyRefusalHint(apiRequest('POST', path, body))).toContain('generate images')
    }
  )

  it.each([
    [
      `${ACCOUNT}/ai/v1/chat/completions`,
      { model: '@cf/meta/llama-3.1-8b-instruct', messages: [] }
    ],
    [`${ACCOUNT}/ai/tomarkdown`, undefined],
    [`${ACCOUNT}/ai-gateway/gateways`, { id: 'g1' }]
  ])('allows POST %s', async (path, body) => {
    expect(await policyRefusalHint(apiRequest('POST', path, body))).toBeUndefined()
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

  describe('a confirmed account subscription', () => {
    const confirmed = { accountId: ACCOUNT_ID, ratePlan: 'r2_paid' }
    const create = (ratePlan: string, account = ACCOUNT) =>
      apiRequest('POST', `${account}/subscriptions`, { rate_plan: { id: ratePlan } })

    it('is sent, with the body intact', async () => {
      const request = create('r2_paid')
      expect(await subscriptionCreate(request)).toEqual(confirmed)
      expect(await policyRefusalHint(request, confirmed)).toBeUndefined()
      expect(await request.json()).toEqual({ rate_plan: { id: 'r2_paid' } })
    })

    it('is refused until it is confirmed', async () => {
      expect(await policyRefusalHint(create('r2_paid'))).toBeDefined()
    })

    it.each([
      ['another rate plan', create('workers_paid')],
      [
        'another account',
        create('r2_paid', '/client/v4/accounts/00000000000000000000000000000002')
      ],
      ['no rate plan', apiRequest('POST', `${ACCOUNT}/subscriptions`, {})],
      [
        'an update',
        apiRequest('PUT', `${ACCOUNT}/subscriptions/sub_1`, { rate_plan: { id: 'r2_paid' } })
      ],
      [
        'a zone subscription',
        apiRequest('POST', '/client/v4/zones/z1/subscription', { rate_plan: { id: 'r2_paid' } })
      ],
      [
        'a payment method',
        apiRequest('POST', `${ACCOUNT}/payment-methods`, { rate_plan: { id: 'r2_paid' } })
      ]
    ])('unlocks nothing else: %s', async (_name, request) => {
      expect(await policyRefusalHint(request, confirmed)).toBeDefined()
    })
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

describe('creating a subscription asks the user to confirm', () => {
  const SUBSCRIPTION = { rate_plan: { id: 'r2_paid' }, frequency: 'monthly' }
  const KEY = `subscription:${ACCOUNT_ID}:r2_paid`
  const CAN_ASK = { elicitation: {} }
  const ACCEPT = { [KEY]: { action: 'accept', content: { confirm: true } } }

  /** Mock the API and record the subscription bodies and other writes it receives. */
  function mockApi(): { subscriptions: unknown[]; writes: string[] } {
    const received = { subscriptions: [] as unknown[], writes: [] as string[] }
    server.use(
      http.get(`${API_BASE}/accounts`, () =>
        HttpResponse.json(cfAccountsSuccess([{ id: ACCOUNT_ID, name: 'Policy Test Account' }]))
      ),
      http.post(`${API_BASE}/accounts/${ACCOUNT_ID}/subscriptions`, async ({ request }) => {
        received.subscriptions.push(await request.json())
        return HttpResponse.json(cfSuccess({ id: 'sub_1' }))
      }),
      http.post(`${API_BASE}/accounts/${ACCOUNT_ID}/storage/kv/namespaces`, () => {
        received.writes.push('kv')
        return HttpResponse.json(cfSuccess({ id: 'ns_1' }))
      })
    )
    return received
  }

  describe.each([
    [
      'execute',
      MCP_URL,
      'execute',
      {
        code: `async () => cloudflare.request({ method: "POST", path: "/accounts/${ACCOUNT_ID}/subscriptions", body: ${JSON.stringify(SUBSCRIPTION)} })`
      }
    ],
    [
      'the generated tool',
      `${MCP_URL}?codemode=false`,
      'accounts_subscriptions_create',
      { path: { account_or_zone: 'accounts', account_or_zone_id: ACCOUNT_ID }, body: SUBSCRIPTION }
    ]
  ])('%s', (_route, url, name, args) => {
    const call = (
      extra: Record<string, unknown> = {},
      clientCapabilities: Record<string, unknown> = CAN_ASK
    ) =>
      exports.default
        .fetch(
          modernMcpRequest(
            API_TOKEN,
            'tools/call',
            { name, arguments: args, ...extra },
            { url, clientCapabilities }
          )
        )
        .then(parseMcpResult)

    it('asks before sending anything', async () => {
      const api = mockApi()
      const { result } = await call()
      expect(result?.resultType).toBe('input_required')
      expect(result?.inputRequests?.[KEY]?.method).toBe('elicitation/create')
      expect(result?.inputRequests?.[KEY]?.params.message).toContain('"r2_paid"')
      expect(result?.inputRequests?.[KEY]?.params.message).toContain(ACCOUNT_ID)
      expect(api.subscriptions).toEqual([])
    })

    it('sends it once the user accepts', async () => {
      const api = mockApi()
      const result = await call({ inputResponses: ACCEPT })
      expect(result.result?.isError).not.toBe(true)
      expect(toolText(result)).toContain('sub_1')
      expect(api.subscriptions).toEqual([SUBSCRIPTION])
    })

    it.each([
      ['declines', { [KEY]: { action: 'decline' } }],
      ['cancels', { [KEY]: { action: 'cancel' } }],
      ['accepts without confirming', { [KEY]: { action: 'accept', content: { confirm: false } } }]
    ])('does not send it when the user %s', async (_answer, inputResponses) => {
      const api = mockApi()
      const result = await call({ inputResponses })
      expect(result.result?.isError).toBe(true)
      expect(toolText(result)).toContain('declined')
      expect(api.subscriptions).toEqual([])
    })

    it('does not send a subscription other than the one the user accepted', async () => {
      const api = mockApi()
      const other = `subscription:${ACCOUNT_ID}:workers_paid`
      const { result } = await call({
        inputResponses: { [other]: { action: 'accept', content: { confirm: true } } }
      })
      expect(result?.resultType).toBe('input_required')
      expect(Object.keys(result?.inputRequests ?? {})).toEqual([KEY])
      expect(api.subscriptions).toEqual([])
    })

    it('keeps the block for a client that cannot ask', async () => {
      const api = mockApi()
      const result = await call({}, {})
      expect(result.result?.isError).toBe(true)
      expect(toolText(result)).toContain('spend money')
      expect(api.subscriptions).toEqual([])
    })
  })

  it('does not rerun code that already changed something', async () => {
    const api = mockApi()
    const code = `async () => {
      await cloudflare.request({ method: "POST", path: "/accounts/${ACCOUNT_ID}/storage/kv/namespaces", body: { title: "t" } })
      return cloudflare.request({ method: "POST", path: "/accounts/${ACCOUNT_ID}/subscriptions", body: ${JSON.stringify(SUBSCRIPTION)} })
    }`
    const result = await exports.default
      .fetch(
        modernMcpRequest(
          API_TOKEN,
          'tools/call',
          { name: 'execute', arguments: { code } },
          { clientCapabilities: CAN_ASK }
        )
      )
      .then(parseMcpResult)
    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toContain('a call of its own')
    expect(api.writes).toEqual(['kv'])
    expect(api.subscriptions).toEqual([])
  })

  it('keeps the block for a 2025-era request', async () => {
    const api = mockApi()
    const code = `async () => cloudflare.request({ method: "POST", path: "/accounts/${ACCOUNT_ID}/subscriptions", body: ${JSON.stringify(SUBSCRIPTION)} })`
    const result = await callTool(API_TOKEN, 'execute', { code })
    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toContain('spend money')
    expect(api.subscriptions).toEqual([])
  })
})
