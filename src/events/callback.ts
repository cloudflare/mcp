import { EventApi, EventApiError, POLICIES, AUTOMATIONS } from './api'
import { forwardAnsWebhook } from './ans-bridge'
import { ManagedPolicy, asSubscription, publicWebhookFetch, readPolicyState } from './service'
import { DeliveryTicket, decryptState, deliveryAccessToken, type EventEnvironment } from './state'

export async function handleAnsCallback(
  request: Request,
  env: EventEnvironment
): Promise<Response> {
  const deadline = AbortSignal.timeout(4000)
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  const match = /^\/events\/ans\/(sub_[a-f0-9]{64})$/.exec(new URL(request.url).pathname)
  if (!match) return new Response(null, { status: 404 })
  const id = match[1]
  const secret = request.headers.get('cf-webhook-auth') ?? ''
  let ticket: DeliveryTicket
  try {
    ticket = DeliveryTicket.parse(await decryptState(env, `delivery:${id}`, secret))
    if (ticket.id !== id) return new Response(null, { status: 401 })
  } catch {
    return new Response(null, { status: 401 })
  }
  if (ticket.expiresAt <= Date.now() || !ticket.policyId) return new Response(null, { status: 204 })
  try {
    const accessToken = await deliveryAccessToken(env, ticket)
    if (!accessToken) return new Response(null, { status: 204 })
    const api = new EventApi(env.CLOUDFLARE_API_BASE, accessToken, ticket.accountId, deadline)
    const [policyData] = await Promise.all([
      api.result(`${POLICIES}/${encodeURIComponent(ticket.policyId)}`),
      api.result(AUTOMATIONS)
    ])
    const policy = ManagedPolicy.parse(policyData)
    const state = await readPolicyState(env, policy, id)
    if (state.params.arguments.account_id !== ticket.accountId)
      return new Response(null, { status: 403 })
    return await forwardAnsWebhook(request, id, {
      loadSubscription: async () => asSubscription(state, policy, secret),
      hasAccess: async () => true,
      eventIdentity: async (_subscription, payload) => payload.alert_correlation_id ?? '',
      now: Date.now,
      webhookFetch: (input, init) => publicWebhookFetch(input, { ...init, signal: deadline }),
      deactivateSubscription: async () => {
        const { id: _policyId, ...body } = policy
        await api.result(`${POLICIES}/${encodeURIComponent(policy.id)}`, 'PUT', {
          ...body,
          enabled: false
        })
      }
    })
  } catch (error) {
    if (error instanceof EventApiError && [401, 403, 404].includes(error.status))
      return new Response(null, { status: 204 })
    return new Response(null, { status: 503 })
  }
}
