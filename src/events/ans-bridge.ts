import { z } from 'zod'

export const MAX_EVENT_BYTES = 256 * 1024
export const SUPPORTED_ALERT_TYPES: ReadonlySet<string> = new Set([
  'workers_observability_real_time_issue'
])

export const CallbackUrl = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (!url.port || url.port === '443') &&
      url.hostname.includes('.') &&
      !/^[\d.]+$/.test(url.hostname) &&
      !url.hostname.includes(':') &&
      !/(^|\.)(localhost|local|internal|test|invalid|onion)\.?$/.test(url.hostname)
    )
  }, 'Callback must use HTTPS on port 443 with a public hostname, without credentials or a fragment')

export const AlertArguments = z
  .object({
    account_id: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .describe('Cloudflare account to monitor'),
    service: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe('Worker name; omit to monitor the account'),
    afterOccurrences: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe('Notify when an issue reaches this occurrence count; use 1 for new issues'),
    afterInactivitySeconds: z
      .number()
      .int()
      .min(3600)
      .max(365 * 86400)
      .optional()
      .describe(
        'Notify when an issue recurs after this many inactive seconds; use instead of afterOccurrences'
      )
  })
  .strict()
  .refine(
    (args) => (args.afterOccurrences === undefined) !== (args.afterInactivitySeconds === undefined),
    'Provide exactly one of afterOccurrences or afterInactivitySeconds'
  )

/**
 * Event names this server offers. Unknown names are not invalid parameters;
 * the methods answer them with `-32011 NotFound` (`data.kind: "event"`).
 */
const EventName = z.string().regex(/^cloudflare\.alert\.[a-z][a-z0-9_]*$/)

/** `true` when the event name is in the catalogue this server implements. */
export function isSupportedEventName(name: string): boolean {
  return SUPPORTED_ALERT_TYPES.has(name.slice('cloudflare.alert.'.length))
}

const WebhookMode = z.literal('webhook')

/**
 * `events/subscribe` params. Follows the MCP Events draft: `cursor` and
 * `maxAgeMs` are accepted and ignored because these events have no replay
 * (`cursor: null`), and any `ttlMs` is clamped rather than rejected.
 */
export const SubscribeParams = z
  .object({
    name: EventName,
    arguments: AlertArguments,
    delivery: z
      .object({
        mode: WebhookMode,
        url: CallbackUrl,
        secret: z.string().refine((value) => {
          try {
            const key = decodeSecret(value)
            return key.length >= 24 && key.length <= 64
          } catch {
            return false
          }
        }, 'Expected whsec_ with a base64-encoded 24–64 byte key')
      })
      .strict(),
    cursor: z.string().nullable().optional(),
    maxAgeMs: z.number().int().nonnegative().optional(),
    ttlMs: z.number().nullable().optional()
  })
  .strict()

/**
 * `events/unsubscribe` params. The subscription key is `(principal, url, name,
 * arguments)`; the draft's example sends `delivery` as `{ url }` alone, so
 * `mode` is optional here.
 */
export const UnsubscribeParams = z
  .object({
    name: EventName,
    arguments: AlertArguments,
    delivery: z.object({ mode: WebhookMode.optional(), url: CallbackUrl }).strict()
  })
  .strict()

export const AvailableAlert = z.object({
  type: z.string().regex(/^[a-z][a-z0-9_]*$/),
  display_name: z.string(),
  description: z.string(),
  filter_options: z
    .array(
      z.object({
        Key: z.string().min(1),
        Range: z.string().optional(),
        ComparisonOperator: z.string().optional(),
        AvailableValues: z
          .array(z.object({ ID: z.string(), Description: z.string() }))
          .nullable()
          .optional()
      })
    )
    .nullish()
    .transform((options) => options ?? [])
})

export const AlertPayload = z.object({
  name: z.string(),
  text: z.string(),
  account_id: z.string(),
  account_name: z.string().optional(),
  policy_id: z.string(),
  policy_name: z.string().optional(),
  alert_type: z.string(),
  alert_correlation_id: z.string().optional(),
  alert_event: z.string().optional(),
  event_id: z.string().optional(),
  severity: z.string().optional(),
  ts: z.number().int().nonnegative(),
  data: z.record(z.string(), z.unknown()).optional()
})

export type NotificationPayload = z.infer<typeof AlertPayload>

const IssueNotificationPayload = AlertPayload.extend({
  data: z
    .object({
      issue: z
        .object({
          id: z.string().min(1),
          services: z.array(z.object({ name: z.string().min(1) }).passthrough()).min(1)
        })
        .passthrough()
    })
    .passthrough()
})

const EventPayloadSchemas: Readonly<Record<string, z.ZodType<NotificationPayload>>> = {
  workers_observability_real_time_issue: IssueNotificationPayload
}

export function alertEventDefinitions(catalog: unknown) {
  const groups = z.record(z.string(), z.array(AvailableAlert)).parse(catalog)
  return Object.values(groups)
    .flat()
    .filter((alert) => SUPPORTED_ALERT_TYPES.has(alert.type))
    .map((alert) => ({
      name: `cloudflare.alert.${alert.type}`,
      description: `${alert.display_name}: ${alert.description}`,
      delivery: ['webhook'],
      inputSchema: {
        ...z.toJSONSchema(AlertArguments),
        oneOf: [
          { required: ['afterOccurrences'], not: { required: ['afterInactivitySeconds'] } },
          { required: ['afterInactivitySeconds'], not: { required: ['afterOccurrences'] } }
        ]
      },
      payloadSchema: z.toJSONSchema(EventPayloadSchemas[alert.type])
    }))
}

export interface Subscription {
  id: string
  principal: string
  accountId: string
  policyId: string
  alertType: string
  callbackUrl: string
  signingSecret: string
  previousSigningSecret?: string
  previousSecretExpiresAt?: number
  ingressSecret: string
  expiresAt: number
  active: boolean
}

export interface BridgeDependencies {
  loadSubscription(id: string): Promise<Subscription | null>
  hasAccess(subscription: Subscription): Promise<boolean>
  deactivateSubscription(id: string): Promise<void>
  eventIdentity(subscription: Subscription, alert: NotificationPayload): Promise<string>
  webhookFetch: typeof fetch
  now(): number
}

function decodeSecret(secret: string): Uint8Array {
  if (!secret.startsWith('whsec_')) throw new Error('Invalid signing key prefix')
  const encoded = secret.slice(6)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid base64 signing key')
  const decoded = atob(encoded)
  if (btoa(decoded).replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('Noncanonical base64 signing key')
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export async function subscriptionId(principal: string, input: unknown): Promise<string> {
  const subscription = SubscribeParams.safeParse(input)
  const params = subscription.success ? subscription.data : UnsubscribeParams.parse(input)
  return `sub_${await digest(
    canonicalJson([principal, params.delivery.url, params.name, params.arguments])
  )}`
}

const DEFAULT_TTL_MS = 30 * 60 * 1000
const MIN_TTL_MS = 60 * 1000
const MAX_TTL_MS = 60 * 60 * 1000

/**
 * Grant a subscription lifetime from the client's `ttlMs` suggestion.
 *
 * The draft gives TTLs no rejection path: an omitted suggestion gets the
 * default, `null` (no expiry) and anything too long are clamped to the
 * maximum, and anything too short is clamped up to the floor.
 *
 * @param now - Current time in Unix milliseconds.
 * @param ttlMs - The client's suggested lifetime.
 * @returns The expiry time in Unix milliseconds.
 */
export function subscriptionExpiration(now: number, ttlMs?: number | null): number {
  const suggested = ttlMs === undefined ? DEFAULT_TTL_MS : (ttlMs ?? MAX_TTL_MS)
  const granted = Number.isFinite(suggested) ? suggested : MAX_TTL_MS
  return now + Math.min(Math.max(granted, MIN_TTL_MS), MAX_TTL_MS)
}

export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const leftHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(left))
  const rightHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(right))
  const leftBytes = new Uint8Array(leftHash)
  const rightBytes = new Uint8Array(rightHash)
  let difference = 0
  for (let index = 0; index < leftBytes.length; index++) {
    difference |= leftBytes[index] ^ rightBytes[index]
  }
  return difference === 0
}

export async function signedHeaders(
  subscription: Subscription,
  eventId: string,
  body: string,
  now: number
): Promise<Headers> {
  const timestamp = String(Math.floor(now / 1000))
  const secrets = [subscription.signingSecret]
  if (subscription.previousSigningSecret && (subscription.previousSecretExpiresAt ?? 0) > now) {
    secrets.push(subscription.previousSigningSecret)
  }
  const signatures = await Promise.all(
    secrets.map(async (secret) => {
      const bytes = decodeSecret(secret)
      if (bytes.length < 24 || bytes.length > 64) throw new Error('Invalid signing key length')
      const key = await crypto.subtle.importKey(
        'raw',
        bytes.buffer as ArrayBuffer,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      )
      const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`${eventId}.${timestamp}.${body}`)
      )
      return `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`
    })
  )
  return new Headers({
    'Content-Type': 'application/json',
    'webhook-id': eventId,
    'webhook-timestamp': timestamp,
    'webhook-signature': signatures.join(' '),
    'X-MCP-Subscription-Id': subscription.id
  })
}

/**
 * Why a callback endpoint failed verification. These are the draft's
 * `lastError` categories; raw endpoint responses are never surfaced.
 */
export type CallbackFailureReason =
  | 'connection_refused'
  | 'timeout'
  | 'tls_error'
  | 'http_4xx'
  | 'http_5xx'
  | 'challenge_failed'

/** Outcome of the callback verification handshake. */
export type CallbackVerification =
  | { readonly _tag: 'verified' }
  | { readonly _tag: 'failed'; readonly reason: CallbackFailureReason }

function transportFailureReason(error: unknown): CallbackFailureReason {
  if (
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  )
    return 'timeout'
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (/tls|ssl|certificate/.test(message)) return 'tls_error'
  return 'connection_refused'
}

/**
 * Run the draft's endpoint-verification handshake: POST a signed
 * `verification` envelope and require the endpoint to echo the challenge in a
 * 2xx body, compared in constant time.
 *
 * @param subscription - The subscription whose callback URL and secret to use.
 * @param webhookFetch - Fetch restricted to public callback URLs.
 * @param now - Current time in Unix milliseconds, used for the signature.
 * @returns `verified`, or `failed` with the draft's failure category.
 */
export async function verifyCallback(
  subscription: Subscription,
  webhookFetch: typeof fetch,
  now: number
): Promise<CallbackVerification> {
  if (!CallbackUrl.safeParse(subscription.callbackUrl).success)
    return { _tag: 'failed', reason: 'connection_refused' }
  const challenge = crypto.randomUUID()
  const body = JSON.stringify({ type: 'verification', challenge })
  let response: Response
  try {
    response = await webhookFetch(subscription.callbackUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: await signedHeaders(
        subscription,
        `msg_verification_${crypto.randomUUID()}`,
        body,
        now
      ),
      body
    })
  } catch (error) {
    return { _tag: 'failed', reason: transportFailureReason(error) }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (response.status >= 500) return { _tag: 'failed', reason: 'http_5xx' }
    if (response.status >= 400) return { _tag: 'failed', reason: 'http_4xx' }
    // A 3xx under manual redirects: the endpoint did not accept the challenge.
    return { _tag: 'failed', reason: 'challenge_failed' }
  }
  let echoed: unknown
  try {
    echoed = await readJson(response, 4096)
  } catch {
    return { _tag: 'failed', reason: 'challenge_failed' }
  }
  const result = z.object({ challenge: z.string() }).safeParse(echoed)
  if (!result.success || !(await constantTimeEqual(challenge, result.data.challenge)))
    return { _tag: 'failed', reason: 'challenge_failed' }
  return { _tag: 'verified' }
}

export async function readJson(
  message: Request | Response,
  limit = MAX_EVENT_BYTES
): Promise<unknown> {
  const reader = message.body?.getReader()
  if (!reader) throw new Error('Missing JSON body')
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > limit) throw new Error('JSON body too large')
      text += decoder.decode(part.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export async function forwardAnsWebhook(
  request: Request,
  id: string,
  dependencies: BridgeDependencies
): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  const subscription = await dependencies.loadSubscription(id)
  if (
    !subscription ||
    !(await constantTimeEqual(
      request.headers.get('cf-webhook-auth') ?? '',
      subscription.ingressSecret
    )) ||
    !subscription.ingressSecret
  ) {
    return new Response(null, { status: 401 })
  }
  const now = dependencies.now()
  if (!subscription.active || subscription.expiresAt <= now) {
    return new Response(null, { status: 204 })
  }
  try {
    if (!(await dependencies.hasAccess(subscription))) {
      await dependencies.deactivateSubscription(id)
      return new Response(null, { status: 204 })
    }
  } catch {
    return new Response(null, { status: 503 })
  }
  const reader = request.body?.getReader()
  if (!reader) return new Response(null, { status: 400 })
  const chunks: Uint8Array[] = []
  let size = 0
  let part = await reader.read()
  while (!part.done) {
    size += part.value.length
    if (size > MAX_EVENT_BYTES) {
      await reader.cancel()
      return new Response(null, { status: 413 })
    }
    chunks.push(part.value)
    part = await reader.read()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  const input = new TextDecoder().decode(bytes)
  let alert: z.infer<typeof AlertPayload>
  try {
    alert = (EventPayloadSchemas[subscription.alertType] ?? AlertPayload).parse(JSON.parse(input))
  } catch {
    return new Response(null, { status: 400 })
  }
  if (
    !SUPPORTED_ALERT_TYPES.has(subscription.alertType) ||
    alert.account_id !== subscription.accountId ||
    alert.policy_id !== subscription.policyId ||
    alert.alert_type !== subscription.alertType
  ) {
    return new Response(null, { status: 403 })
  }
  const occurrenceTime = new Date(alert.ts * 1000)
  if (!Number.isFinite(occurrenceTime.getTime())) return new Response(null, { status: 400 })
  const identity = await dependencies.eventIdentity(subscription, alert)
  if (!identity) return new Response(null, { status: 503 })
  const eventId = `evt_${await digest(JSON.stringify([subscription.id, identity]))}`
  const body = JSON.stringify({
    eventId,
    name: `cloudflare.alert.${subscription.alertType}`,
    timestamp: occurrenceTime.toISOString(),
    data: alert,
    cursor: null
  })
  if (new TextEncoder().encode(body).length > MAX_EVENT_BYTES) {
    return new Response(null, { status: 413 })
  }
  try {
    CallbackUrl.parse(subscription.callbackUrl)
    const response = await dependencies.webhookFetch(subscription.callbackUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: await signedHeaders(subscription, eventId, body, now),
      body
    })
    await response.body?.cancel().catch(() => {})
    if (response.ok) return new Response(null, { status: 204 })
    // The draft makes 410 and 413 non-retryable for this delivery only; the
    // subscription itself stays active. Acknowledge so ANS does not retry.
    if (response.status === 410 || response.status === 413) {
      return new Response(null, { status: 204 })
    }
    // Every other non-2xx (including redirects, which are never followed) is
    // retried. ANS owns retries, with backoff and bounded attempts.
    return new Response(null, { status: 503 })
  } catch {
    return new Response(null, { status: 503 })
  }
}
