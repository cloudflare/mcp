import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { policyRefusalHint, subscriptionCreate, subscriptionFromBody } from '../src/policy-guards'
import { API_BASE, cfAccountsSuccess, cfSuccess } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, callTool, modernMcpRequest, parseMcpResult, toolText } from './helpers/mcp'
import { server } from './setup/msw'

const ACCOUNT_ID = '00000000000000000000000000000001'
const ACCOUNT = `/client/v4/accounts/${ACCOUNT_ID}`
const API_TOKEN = 'cfat_test-api-token-policy'

afterEach(() => clearKv(env.OAUTH_KV))

/** The input request key the server asks under for creating `body` on the test account. */
async function confirmationKey(body: unknown): Promise<string> {
  const subscription = await subscriptionFromBody(ACCOUNT_ID, JSON.stringify(body))
  if (!subscription) throw new Error('not a subscription body')
  return `subscription:${ACCOUNT_ID}:${subscription.ratePlan}:${subscription.digest}`
}

const R2_PAID_PLAN = {
  id: 'R2_PAID',
  public_name: 'R2 Storage',
  currency: 'USD',
  components: [
    {
      name: 'base',
      publicName: 'Base',
      chargeType: 'subscription',
      defaultQuantity: 1,
      tiers: [{ lowerThreshold: 0, upperThreshold: 0, pricingType: 'fixed', price: 0 }]
    },
    {
      name: 'r2_class_a_operations',
      publicName: 'R2 Storage Class A Operations',
      chargeType: 'usage',
      tiers: [{ lowerThreshold: 0, upperThreshold: 0, pricingType: 'unit', price: 4.5 }]
    }
  ]
}

const TEAMS_FREE_PLAN = {
  id: 'TEAMS_FREE',
  public_name: 'Cloudflare Zero Trust',
  currency: 'USD',
  components: [
    {
      name: 'users',
      publicName: 'Monthly Fee (Per User)',
      chargeType: 'subscription',
      defaultQuantity: 50,
      tiers: [{ lowerThreshold: 1, upperThreshold: 50, pricingType: 'unit', price: 0 }]
    }
  ]
}

/** Serve the public rate plan catalog for the plans the tests create. */
function mockCatalog(): void {
  server.use(
    http.get(`${API_BASE}/billing/rate_plans/r2_paid`, () =>
      HttpResponse.json(cfSuccess(R2_PAID_PLAN))
    ),
    http.get(`${API_BASE}/billing/rate_plans/teams_free`, () =>
      HttpResponse.json(cfSuccess(TEAMS_FREE_PLAN))
    )
  )
}

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
    ['POST', `${ACCOUNT}/bulk/subscriptions`],
    ['POST', `${ACCOUNT}/pay-invoice`],
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
    ['POST', `${ACCOUNT}/storage/kv/namespaces/ns1/bulk/delete`],
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
    const R2_BODY = { rate_plan: { id: 'r2_paid' } }
    const create = (ratePlan: string, account = ACCOUNT) =>
      apiRequest('POST', `${account}/subscriptions`, { rate_plan: { id: ratePlan } })
    const confirmedR2 = async () => {
      const subscription = await subscriptionFromBody(ACCOUNT_ID, JSON.stringify(R2_BODY))
      if (!subscription) throw new Error('not a subscription body')
      return subscription
    }

    it('is sent, with the body intact', async () => {
      const request = create('r2_paid')
      const confirmed = await confirmedR2()
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
        'the same rate plan with more components',
        apiRequest('POST', `${ACCOUNT}/subscriptions`, {
          rate_plan: { id: 'r2_paid' },
          component_values: [{ name: 'base', value: 5 }]
        })
      ],
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
      expect(await policyRefusalHint(request, await confirmedR2())).toBeDefined()
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

describe('a subscription the code catches the refusal of', () => {
  const BODY = { rate_plan: { id: 'teams_free' } }
  const code = `async () => cloudflare.request({ method: "POST", path: "/accounts/${ACCOUNT_ID}/subscriptions", body: { rate_plan: { id: "teams_free" } } }).catch(e => ({ error: String(e) }))`

  function mockApi(): unknown[] {
    const sent: unknown[] = []
    mockCatalog()
    server.use(
      http.get(`${API_BASE}/accounts`, () =>
        HttpResponse.json(cfAccountsSuccess([{ id: ACCOUNT_ID, name: 'Policy Test Account' }]))
      ),
      http.post(`${API_BASE}/accounts/${ACCOUNT_ID}/subscriptions`, async ({ request }) => {
        sent.push(await request.json())
        return HttpResponse.json(cfSuccess({ id: 'sub_zt' }))
      })
    )
    return sent
  }

  const call = (extra: Record<string, unknown> = {}) =>
    exports.default
      .fetch(
        modernMcpRequest(
          API_TOKEN,
          'tools/call',
          { name: 'execute', arguments: { code }, ...extra },
          { url: MCP_URL, clientCapabilities: { elicitation: {} } }
        )
      )
      .then(parseMcpResult)

  it('still asks the user, and sends nothing first', async () => {
    const sent = mockApi()
    const { result } = await call()
    const key = await confirmationKey(BODY)
    expect(result?.resultType).toBe('input_required')
    expect(result?.inputRequests?.[key]?.params.message).toContain('"teams_free"')
    expect(result?.inputRequests?.[key]?.params.message).toContain('Fixed charge: $0.00')
    expect(sent).toEqual([])
  })

  it('sends it once the user accepts', async () => {
    const sent = mockApi()
    const key = await confirmationKey(BODY)
    const result = await call({
      inputResponses: { [key]: { action: 'accept', content: { confirm: true } } }
    })
    expect(toolText(result)).toContain('sub_zt')
    expect(sent).toEqual([{ rate_plan: { id: 'teams_free' } }])
  })
})

describe('execute names the call that turns on a product', () => {
  it('tells agents that enabling R2 or Zero Trust is an account subscription', async () => {
    server.use(
      http.get(`${API_BASE}/accounts`, () =>
        HttpResponse.json(cfAccountsSuccess([{ id: ACCOUNT_ID, name: 'Policy Test Account' }]))
      )
    )
    const listed = (await callTool(API_TOKEN, '', null, { method: 'tools/list' })) as unknown as {
      result?: { tools?: { name: string; description?: string }[] }
    }
    const execute = listed.result?.tools?.find((tool) => tool.name === 'execute')
    expect(execute?.description).toContain('POST /accounts/{account_id}/subscriptions')
    expect(execute?.description).toContain('r2_paid (R2 Storage)')
    expect(execute?.description).toContain('teams_free (Zero Trust)')
  })
})

describe('creating a subscription asks the user to confirm', () => {
  const SUBSCRIPTION = { rate_plan: { id: 'r2_paid' }, frequency: 'monthly' }
  const CAN_ASK = { elicitation: {} }
  const accept = (key: string) => ({ [key]: { action: 'accept', content: { confirm: true } } })

  /** Mock the API and record the subscription bodies and other writes it receives. */
  function mockApi(): { subscriptions: unknown[]; writes: string[] } {
    const received = { subscriptions: [] as unknown[], writes: [] as string[] }
    mockCatalog()
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

    it('asks before sending anything, and states the price', async () => {
      const api = mockApi()
      const key = await confirmationKey(SUBSCRIPTION)
      const { result } = await call()
      const message = result?.inputRequests?.[key]?.params.message
      expect(result?.resultType).toBe('input_required')
      expect(result?.inputRequests?.[key]?.method).toBe('elicitation/create')
      expect(message).toContain('"r2_paid"')
      expect(message).toContain(ACCOUNT_ID)
      expect(message).toContain('Fixed charge: $0.00 per month.')
      expect(message).toContain('- Base: 1 = $0.00')
      expect(message).toContain('Usage charges apply: R2 Storage Class A Operations.')
      expect(api.subscriptions).toEqual([])
    })

    it('sends it once the user accepts', async () => {
      const api = mockApi()
      const result = await call({ inputResponses: accept(await confirmationKey(SUBSCRIPTION)) })
      expect(result.result?.isError).not.toBe(true)
      expect(toolText(result)).toContain('sub_1')
      expect(api.subscriptions).toEqual([SUBSCRIPTION])
    })

    it.each([
      ['declines', { action: 'decline' }],
      ['cancels', { action: 'cancel' }],
      ['accepts without confirming', { action: 'accept', content: { confirm: false } }]
    ])('does not send it when the user %s', async (_answer, answer) => {
      const api = mockApi()
      const result = await call({
        inputResponses: { [await confirmationKey(SUBSCRIPTION)]: answer }
      })
      expect(result.result?.isError).toBe(true)
      expect(toolText(result)).toContain('declined')
      expect(api.subscriptions).toEqual([])
    })

    it('does not send a subscription other than the one the user accepted', async () => {
      const api = mockApi()
      const other = await confirmationKey({ rate_plan: { id: 'workers_paid' } })
      const { result } = await call({ inputResponses: accept(other) })
      expect(result?.resultType).toBe('input_required')
      expect(Object.keys(result?.inputRequests ?? {})).toEqual([
        await confirmationKey(SUBSCRIPTION)
      ])
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

describe('the price in the confirmation', () => {
  const CAN_ASK = { elicitation: {} }

  function mockSubscriptions(): unknown[] {
    const sent: unknown[] = []
    server.use(
      http.get(`${API_BASE}/accounts`, () =>
        HttpResponse.json(cfAccountsSuccess([{ id: ACCOUNT_ID, name: 'Policy Test Account' }]))
      ),
      http.post(`${API_BASE}/accounts/${ACCOUNT_ID}/subscriptions`, async ({ request }) => {
        sent.push(await request.json())
        return HttpResponse.json(cfSuccess({ id: 'sub_1' }))
      })
    )
    return sent
  }

  const create = (body: unknown, inputResponses?: Record<string, unknown>) =>
    exports.default
      .fetch(
        modernMcpRequest(
          API_TOKEN,
          'tools/call',
          {
            name: 'execute',
            arguments: {
              code: `async () => cloudflare.request({ method: "POST", path: "/accounts/${ACCOUNT_ID}/subscriptions", body: ${JSON.stringify(body)} })`
            },
            ...(inputResponses && { inputResponses })
          },
          { url: MCP_URL, clientCapabilities: CAN_ASK }
        )
      )
      .then(parseMcpResult)

  it('prices the component values the request sets', async () => {
    mockCatalog()
    mockSubscriptions()
    const body = {
      rate_plan: { id: 'teams_free' },
      component_values: [{ name: 'users', value: 20 }]
    }
    const { result } = await create(body)
    const message = result?.inputRequests?.[await confirmationKey(body)]?.params.message
    expect(message).toContain('- Monthly Fee (Per User): 20 = $0.00')
    expect(message).toContain('Usage charges: none.')
  })

  it('names component values the catalog does not price', async () => {
    mockCatalog()
    mockSubscriptions()
    const body = {
      rate_plan: { id: 'teams_free' },
      component_values: [{ name: 'users', value: 500 }]
    }
    const { result } = await create(body)
    const message = result?.inputRequests?.[await confirmationKey(body)]?.params.message
    expect(message).toContain('Not priced by the catalog: Monthly Fee (Per User).')
  })

  it('says the price is unknown when the catalog does not answer', async () => {
    mockSubscriptions()
    server.use(
      http.get(`${API_BASE}/billing/rate_plans/r2_paid`, () =>
        HttpResponse.json({ success: false, errors: [{ message: 'down' }] }, { status: 500 })
      )
    )
    const body = { rate_plan: { id: 'r2_paid' } }
    const { result } = await create(body)
    const message = result?.inputRequests?.[await confirmationKey(body)]?.params.message
    expect(result?.resultType).toBe('input_required')
    expect(message).toContain('Price: Cloudflare did not return a price for this rate plan')
  })

  it('does not send a request whose body differs from the one the user accepted', async () => {
    mockCatalog()
    const sent = mockSubscriptions()
    const shown = { rate_plan: { id: 'teams_free' } }
    const sentBody = {
      rate_plan: { id: 'teams_free' },
      component_values: [{ name: 'users', value: 500 }]
    }
    const accepted = {
      [await confirmationKey(shown)]: { action: 'accept', content: { confirm: true } }
    }
    const { result } = await create(sentBody, accepted)
    expect(result?.resultType).toBe('input_required')
    expect(Object.keys(result?.inputRequests ?? {})).toEqual([await confirmationKey(sentBody)])
    expect(sent).toEqual([])
  })
})
