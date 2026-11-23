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
    const body: unknown = await request.clone().json()
    const ratePlan = (body as { rate_plan?: { id?: unknown } } | null)?.rate_plan?.id
    return typeof ratePlan === 'string' && RATE_PLAN_ID.test(ratePlan)
      ? { accountId: accountId.toLowerCase(), ratePlan }
      : undefined
  } catch {
    return undefined
  }
}

/** Whether two subscriptions are the same account and rate plan. */
export function sameSubscription(
  a: SubscriptionCreate,
  b: SubscriptionCreate | undefined
): boolean {
  return a.accountId === b?.accountId && a.ratePlan === b.ratePlan
}

/**
 * Why `request` must not be sent, or `undefined` to send it. Refuses writes to
 * endpoints that spend money and, on any write under `/accounts/{id}/ai/`, a
 * model named in the `/ai/run/` path or the body's `model` that is not a Workers
 * AI model or is a media-generation one. Reads never are. Both routes to
 * the API call it: `execute`'s `GlobalOutbound` and the generated tools.
 *
 * The one write that spends money and is sent is the account subscription the
 * user `confirmed` (`src/charge-confirmation.ts`): the same account and rate plan.
 */
export async function policyRefusalHint(
  request: Request,
  confirmed?: SubscriptionCreate
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
