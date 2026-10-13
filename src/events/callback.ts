import { constantTimeEqual, forwardAnsWebhook } from './ans-bridge'
import { publicWebhookFetch } from './service'
import {
  hashSecret,
  openDeliverySecret,
  readSubscriptionRecord,
  type EventEnvironment
} from './state'

/**
 * Why a callback from ANS was acknowledged, dropped or bounced. Logged once
 * per callback with safe fields only, so silent 204s can be told apart.
 */
type CallbackOutcome = 'no_subscription' | 'expired' | 'stale_destination' | 'forwarded'

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
 * Delivery uses no stored credential and makes no Cloudflare API call. ANS
 * presents the destination secret, which seals the callback URL and the
 * client's signing secret; the KV record says which destination is current
 * and until when. Access was checked when the subscription was last created
 * or refreshed.
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
  const presented = request.headers.get('cf-webhook-auth') ?? ''
  const seal = await openDeliverySecret(env, id, presented)
  if (!seal) return new Response(null, { status: 401 })
  const record = await readSubscriptionRecord(env, id)
  // No record: ANS probing a new subscription's destination, or the
  // subscription expired or ended.
  if (!record) {
    logOutcome(id, 'no_subscription', 204)
    return new Response(null, { status: 204 })
  }
  if (record.expiresAt <= Date.now()) {
    logOutcome(id, 'expired', 204, { expiredAt: new Date(record.expiresAt).toISOString() })
    return new Response(null, { status: 204 })
  }
  // A destination for another signing secret: replaced on rotation, or a new
  // destination's creation probe before the record points at it.
  if ((await hashSecret(seal.signingSecret)) !== record.signingSecretHash) {
    logOutcome(id, 'stale_destination', 204)
    return new Response(null, { status: 204 })
  }
  const response = await forwardAnsWebhook(request, id, {
    loadSubscription: async () => ({
      id,
      accountId: record.accountId,
      policyId: record.policyId,
      alertType: record.alertType,
      callbackUrl: seal.callbackUrl,
      signingSecret: seal.signingSecret,
      ingressSecret: presented,
      expiresAt: record.expiresAt
    }),
    eventIdentity: async (_subscription, payload) => payload.alert_correlation_id ?? '',
    now: Date.now,
    webhookFetch: (input, init) => publicWebhookFetch(input, { ...init, signal: deadline })
  })
  logOutcome(id, 'forwarded', response.status, {
    expiresAt: new Date(record.expiresAt).toISOString()
  })
  return response
}
