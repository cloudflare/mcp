import { z } from 'zod'

const CHARGEABLE_WRITE =
  /\/(accounts\/[^/]+\/(registrar\/registrations|ai-gateway\/billing\/topup|payment-methods|billing\/profile\/payment-method|subscriptions|bulk\/subscriptions|pay-invoice)|user\/subscriptions|zones\/[^/]+\/subscriptions?)(\/|$)/i

const ACCOUNT_SUBSCRIPTIONS_PATH = /^\/client\/v4\/accounts\/([0-9a-f]{32})\/subscriptions\/?$/i

const RATE_PLAN_ID = /^[\w.-]{1,64}$/

const ACCOUNT_AI_PATH = /^\/client\/v4\/accounts\/[^/]+\/ai(\/|$)/i

const MODEL_IN_RUN_PATH = /\/ai\/run\/(.+)$/i

const WORKERS_AI_MODEL_PREFIX = '@cf/'

const MEDIA_MODEL =
  /(black-forest-labs|stabilityai|runwayml|lykon|leonardo|myshell-ai|stable-diffusion|deepgram\/aura)/i

/** Why a request that spends money was not sent (Software Directory Policy §4.A). */
export const CHARGEABLE_HINT =
  'This server does not send requests that spend money (domain registration or transfer, credit top-ups, subscriptions, invoice payments, payment methods). Ask the user to do it in the Cloudflare dashboard.'

/** Why a run of a model that is not a Workers AI model was not sent: it is paid from Unified Billing credits and may generate media. */
export const THIRD_PARTY_MODEL_HINT =
  'This server only runs Workers AI models (`@cf/...`). Third-party models are paid from Unified Billing credits and can generate images, video, or audio, so they are not sent.'

/** Why a request whose path can't be decoded was not sent, since the guard can't read it. */
export const UNREADABLE_PATH_HINT =
  'This server could not read the request path, so it was not sent. Send the path without malformed percent-escapes.'

/** Why a Workers AI run of an image or audio model was not sent (Software Directory Policy §4.B). */
export const MEDIA_GENERATION_HINT =
  'This server does not run Workers AI models that generate images, video, or audio.'

function plainPath(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname).replace(/\/{2,}/g, '/')
  } catch {
    return undefined
  }
}

async function modelInBody(request: Request): Promise<string> {
  try {
    const body: unknown = await request.clone().json()
    return body !== null && typeof body === 'object' && 'model' in body ? String(body.model) : ''
  } catch {
    return ''
  }
}

/** An account subscription a request would create: the one chargeable write a user can confirm. */
export interface SubscriptionCreate {
  readonly accountId: string
  /** The body's `rate_plan.id`, such as `r2_paid`. */
  readonly ratePlan: string
  /** The body's `frequency`, such as `monthly`, if it sets one. */
  readonly frequency?: string
  /** The body's `component_values`, as component name to value. */
  readonly quantities: Readonly<Record<string, number>>
  /** SHA-256 of the body, so a confirmation covers this exact request and nothing else. */
  readonly digest: string
}

const SubscriptionBody = z.object({
  rate_plan: z.object({ id: z.string().regex(RATE_PLAN_ID) }),
  frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']).optional(),
  component_values: z.array(z.object({ name: z.string(), value: z.number().optional() })).optional()
})

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The account subscription `request` would create, if it is
 * `POST /accounts/{account_id}/subscriptions` with a rate plan in its body.
 * The body stays readable.
 */
export async function subscriptionCreate(
  request: Request
): Promise<SubscriptionCreate | undefined> {
  if (request.method !== 'POST') return undefined
  const path = plainPath(new URL(request.url).pathname)
  const accountId = path === undefined ? undefined : ACCOUNT_SUBSCRIPTIONS_PATH.exec(path)?.[1]
  if (!accountId) return undefined
  try {
    return await subscriptionFromBody(accountId, await request.clone().text())
  } catch {
    return undefined
  }
}

/**
 * The account subscription a create request with body `text` would make on
 * `accountId`, or `undefined` if the body names no valid rate plan.
 */
export async function subscriptionFromBody(
  accountId: string,
  text: string
): Promise<SubscriptionCreate | undefined> {
  try {
    const body = SubscriptionBody.safeParse(JSON.parse(text))
    if (!body.success) return undefined
    const quantities = Object.fromEntries(
      (body.data.component_values ?? []).map((component) => [component.name, component.value ?? 0])
    )
    return {
      accountId: accountId.toLowerCase(),
      ratePlan: body.data.rate_plan.id,
      ...(body.data.frequency && { frequency: body.data.frequency }),
      quantities,
      digest: await sha256(text)
    }
  } catch {
    return undefined
  }
}

/** What identifies a confirmed subscription: its account, rate plan and request body digest. */
export type SubscriptionKey = Pick<SubscriptionCreate, 'accountId' | 'ratePlan' | 'digest'>

/** Whether two subscriptions are the same account, rate plan and request body. */
export function sameSubscription(a: SubscriptionKey, b: SubscriptionKey | undefined): boolean {
  return a.accountId === b?.accountId && a.ratePlan === b.ratePlan && a.digest === b.digest
}

/**
 * Why `request` must not be sent, or `undefined` to send it. Refuses writes to
 * endpoints that spend money and, on any write under `/accounts/{id}/ai/`, a
 * model named in the `/ai/run/` path or the body's `model` that is not a Workers
 * AI model or is a media-generation one. Reads never are. Both routes to
 * the API call it: `execute`'s `GlobalOutbound` and the generated tools.
 *
 * The one write that spends money and is sent is the account subscription the
 * user `confirmed` (`src/charge-confirmation.ts`): the same account, rate plan
 * and request body.
 */
export async function policyRefusalHint(
  request: Request,
  confirmed?: SubscriptionKey
): Promise<string | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined
  const path = plainPath(new URL(request.url).pathname)
  if (path === undefined) return UNREADABLE_PATH_HINT
  if (CHARGEABLE_WRITE.test(path)) {
    const subscription = confirmed && (await subscriptionCreate(request))
    return subscription && sameSubscription(subscription, confirmed) ? undefined : CHARGEABLE_HINT
  }
  if (!ACCOUNT_AI_PATH.test(path)) return undefined
  const models = [path.match(MODEL_IN_RUN_PATH)?.[1] ?? '', await modelInBody(request)].filter(
    (model) => model !== ''
  )
  if (models.some((model) => !model.startsWith(WORKERS_AI_MODEL_PREFIX))) {
    return THIRD_PARTY_MODEL_HINT
  }
  if (models.some((model) => MEDIA_MODEL.test(model))) return MEDIA_GENERATION_HINT
  return undefined
}
