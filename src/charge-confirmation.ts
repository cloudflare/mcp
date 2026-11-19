import { z } from 'zod'
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  inputRequired,
  inputResponse
} from '@modelcontextprotocol/server'
import type { InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import type { SubscriptionCreate } from './policy-guards'

/**
 * Asking the user to confirm the one request that spends money and is still
 * sent: creating an account subscription (Software Directory Policy §4.A,
 * "require confirmation through MCP elicitation, or block by default").
 *
 * The question is an elicitation embedded in an `input_required` result, so it
 * needs no session: the client shows it and retries the call with the answer.
 * The answer is keyed by the account and rate plan, so it only ever confirms
 * the subscription the user was shown. Clients that can't be asked keep the
 * block.
 */

const KEY_PREFIX = 'subscription:'

const Answer = z.object({ confirm: z.boolean().describe('Create this subscription') })

const Subscription = z.object({
  accountId: z.string().regex(/^[0-9a-f]{32}$/),
  ratePlan: z.string().regex(/^[\w.-]{1,64}$/)
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

function key({ accountId, ratePlan }: SubscriptionCreate): string {
  return `${KEY_PREFIX}${accountId}:${ratePlan}`
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
export function confirmationOf(ctx: ServerContext, subscription: SubscriptionCreate): Confirmation {
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
): { subscription: SubscriptionCreate; confirmation: Confirmation } | undefined {
  for (const name of Object.keys(ctx.mcpReq.inputResponses ?? {})) {
    if (!name.startsWith(KEY_PREFIX)) continue
    const [accountId, ratePlan] = name.slice(KEY_PREFIX.length).split(':')
    const subscription = Subscription.safeParse({ accountId, ratePlan })
    if (!subscription.success) continue
    return {
      subscription: subscription.data,
      confirmation: confirmationOf(ctx, subscription.data)
    }
  }
  return undefined
}

/**
 * The subscription the sandbox says a refused request would create. The
 * sandbox is untrusted: a wrong value only asks the user about a subscription
 * `GlobalOutbound` then holds the code to.
 */
export function reportedSubscription(header: string | undefined): SubscriptionCreate | undefined {
  if (!header) return undefined
  try {
    return Subscription.safeParse(JSON.parse(decodeURIComponent(header))).data
  } catch {
    return undefined
  }
}

/** The `input_required` result that asks the user to confirm `subscription`. */
export function askToConfirm(subscription: SubscriptionCreate): InputRequiredResult {
  return inputRequired({
    inputRequests: {
      [key(subscription)]: inputRequired.elicit({
        message: `Create the "${subscription.ratePlan}" subscription on Cloudflare account ${subscription.accountId}? This is a purchase: it can add charges to the account, billed to its default payment method.`,
        requestedSchema: Answer
      })
    }
  })
}
