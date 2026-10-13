import { constantTimeEqual, forwardAnsWebhook } from './ans-bridge'
import { publicWebhookFetch } from './service'
import {
  ingressSecret,
  readDeliveryTicket,
  type DeliveryTicket,
  type EventEnvironment
} from './state'

/**
 * Why a callback from ANS was acknowledged, dropped or bounced. Logged once
 * per callback with safe fields only, so silent 204s can be told apart.
 */
type CallbackOutcome = 'no_ticket' | 'ticket_expired' | 'unreadable_ticket' | 'forwarded'

function logOutcome(
  subscription: string,
  outcome: CallbackOutcome,
  status: number,
  detail: Record<string, unknown> = {}
): void {
  console.log(
    JSON.stringify({ event: 'mcp_events_callback', subscription, outcome, status, ...detail })
  )
}

/**
 * Receive an ANS webhook for one subscription and forward it to the subscriber
 * as a signed MCP event.
 *
 * Delivery uses no user credential and makes no Cloudflare API call: the KV
 * ticket says where to send and how to sign, and access was checked when the
 * subscription was last created or refreshed.
 */
export async function handleAnsCallback(
  request: Request,
  env: EventEnvironment
): Promise<Response> {
  const deadline = AbortSignal.timeout(4000)
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  const match = /^\/events\/ans\/(sub_[a-f0-9]{64})$/.exec(new URL(request.url).pathname)
  if (!match) return new Response(null, { status: 404 })
  const id = match[1]
  const secret = await ingressSecret(env, id)
  if (!(await constantTimeEqual(request.headers.get('cf-webhook-auth') ?? '', secret)))
    return new Response(null, { status: 401 })
  let ticket: DeliveryTicket | null
  try {
    ticket = await readDeliveryTicket(env, id)
  } catch {
    // Unreadable (e.g. the encryption key rotated): fail closed, don't retry.
    logOutcome(id, 'unreadable_ticket', 401)
    return new Response(null, { status: 401 })
  }
  // No ticket: ANS's creation probe, or the subscription expired or ended.
  if (!ticket) {
    logOutcome(id, 'no_ticket', 204)
    return new Response(null, { status: 204 })
  }
  if (ticket.expiresAt <= Date.now()) {
    logOutcome(id, 'ticket_expired', 204, { expiredAt: new Date(ticket.expiresAt).toISOString() })
    return new Response(null, { status: 204 })
  }
  const { previousSigningSecret, previousSecretExpiresAt, ...current } = ticket
  const response = await forwardAnsWebhook(request, id, {
    loadSubscription: async () => ({
      ...current,
      ingressSecret: secret,
      ...(previousSigningSecret ? { previousSigningSecret, previousSecretExpiresAt } : {})
    }),
    eventIdentity: async (_subscription, payload) => payload.alert_correlation_id ?? '',
    now: Date.now,
    webhookFetch: (input, init) => publicWebhookFetch(input, { ...init, signal: deadline })
  })
  logOutcome(id, 'forwarded', response.status, {
    expiresAt: new Date(ticket.expiresAt).toISOString()
  })
  return response
}
