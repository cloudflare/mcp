import { z } from 'zod'
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  inputRequired,
  inputResponse
} from '@modelcontextprotocol/server'
import type { InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import { env } from 'cloudflare:workers'
import { subscriptionFromBody } from './policy-guards'
import type { SubscriptionCreate, SubscriptionKey } from './policy-guards'
import { describePrice, priceSubscription } from './subscription-price'

/**
 * Asking the user to confirm the one request that spends money and is still
 * sent: creating an account subscription (Software Directory Policy §4.A,
 * "require confirmation through MCP elicitation, or block by default").
 *
 * The question is an elicitation embedded in an `input_required` result, so it
 * needs no session: the client shows it and retries the call with the answer.
 * The question states the price the catalog gives for the request, and the
 * answer is keyed by the account, rate plan and a digest of the request body,
 * so it only ever confirms the exact subscription and price the user was shown. Clients that can't be asked keep the
 * block.
 */

const KEY_PREFIX = 'subscription:'

const MAX_REPORTED_BODY = 4096

const Answer = z.object({ confirm: z.boolean().describe('Create this subscription') })

const SubscriptionKeyShape = z.object({
  accountId: z.string().regex(/^[0-9a-f]{32}$/),
  ratePlan: z.string().regex(/^[\w.-]{1,64}$/),
  digest: z.string().regex(/^[0-9a-f]{64}$/)
})

const ElicitationCapability = z.object({
  elicitation: z.object({ form: z.unknown().optional(), url: z.unknown().optional() })
})

/** The header `GlobalOutbound` names a refused subscription in, for the sandbox to report. */
export const NEEDS_CONFIRMATION_HEADER = 'X-Cloudflare-MCP-Needs-Confirmation'

/** What the user answered when asked to confirm a subscription. */
export type Confirmation = 'confirmed' | 'declined' | 'unasked'

/** Why a subscription the user declined was not created. */
export const DECLINED_HINT =
  'The user declined to create this subscription, so the request was not sent. Do not ask again unless they change their mind.'

/** Why a program that had already changed something isn't rerun to ask for confirmation. */
export const UNSAFE_TO_CONFIRM =
  'Creating a subscription needs the user to confirm it, which reruns this program. Earlier requests in it may already have changed resources, so it was not rerun. Send the subscription request in a call of its own.'

function key({ accountId, ratePlan, digest }: SubscriptionKey): string {
  return `${KEY_PREFIX}${accountId}:${ratePlan}:${digest}`
}

/**
 * Whether the client can ask the user a question: a 2026-07-28 request, whose
 * envelope declares form elicitation. `elicitation: {}` counts as form support.
 */
export function canConfirm(ctx: ServerContext): boolean {
  const envelope: Record<string, unknown> | undefined = ctx.mcpReq.envelope
  if (typeof envelope?.[PROTOCOL_VERSION_META_KEY] !== 'string') return false
  const capabilities = ElicitationCapability.safeParse(envelope[CLIENT_CAPABILITIES_META_KEY])
  if (!capabilities.success) return false
  const { form, url } = capabilities.data.elicitation
  return form !== undefined || url === undefined
}

/** What this call's retry says the user answered about `subscription`. */
export function confirmationOf(ctx: ServerContext, subscription: SubscriptionKey): Confirmation {
  const answer = inputResponse(ctx.mcpReq.inputResponses, key(subscription))
  if (answer.kind !== 'elicit') return 'unasked'
  if (answer.action !== 'accept') return 'declined'
  return Answer.safeParse(answer.content).data?.confirm === true ? 'confirmed' : 'declined'
}

/**
 * The subscription this call's retry answers about, and the answer. A call
 * asks about one subscription at a time, so there is at most one.
 */
export function answeredSubscription(
  ctx: ServerContext
): { subscription: SubscriptionKey; confirmation: Confirmation } | undefined {
  for (const name of Object.keys(ctx.mcpReq.inputResponses ?? {})) {
    if (!name.startsWith(KEY_PREFIX)) continue
    const [accountId, ratePlan, digest] = name.slice(KEY_PREFIX.length).split(':')
    const subscription = SubscriptionKeyShape.safeParse({ accountId, ratePlan, digest })
    if (!subscription.success) continue
    return {
      subscription: subscription.data,
      confirmation: confirmationOf(ctx, subscription.data)
    }
  }
  return undefined
}

const Reported = z.object({
  accountId: z.string().regex(/^[0-9a-f]{32}$/),
  body: z.string().max(MAX_REPORTED_BODY)
})

/** The header value `GlobalOutbound` sends for a refused `subscription` with request body `body`. */
export function reportSubscription(accountId: string, body: string): string {
  return encodeURIComponent(JSON.stringify({ accountId, body }))
}

/**
 * The subscription the sandbox says a refused request would create. The
 * sandbox is untrusted, so it reports the request body, and the price, the
 * quantities and the digest are all read from that one body: a wrong body
 * only asks the user about a request `GlobalOutbound` then holds the code to.
 */
export async function reportedSubscription(
  header: string | undefined
): Promise<SubscriptionCreate | undefined> {
  if (!header) return undefined
  try {
    const reported = Reported.safeParse(JSON.parse(decodeURIComponent(header)))
    if (!reported.success) return undefined
    return await subscriptionFromBody(reported.data.accountId, reported.data.body)
  } catch {
    return undefined
  }
}

/**
 * The `input_required` result that asks the user to confirm `subscription`,
 * with the price Cloudflare's rate plan catalog gives for it.
 */
export async function askToConfirm(subscription: SubscriptionCreate): Promise<InputRequiredResult> {
  const price = await priceSubscription(subscription, env.CLOUDFLARE_API_BASE)
  return inputRequired({
    inputRequests: {
      [key(subscription)]: inputRequired.elicit({
        message: `Create the "${subscription.ratePlan}" subscription on Cloudflare account ${subscription.accountId}? This is a purchase: it can add charges to the account, billed to its default payment method.\n\n${describePrice(subscription, price)}`,
        requestedSchema: Answer
      })
    }
  })
}
