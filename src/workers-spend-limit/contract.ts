import { z } from 'zod'
import {
  ExistingAlertSchema,
  previewHead,
  previewTail,
  READ_ONLY,
  thresholdAlertInput
} from '../threshold-alert/contract'
import { HISTORY_DAYS } from '../threshold-alert/history'

export { ExistingAlertSchema }

/** The shared threshold view, at its own URI so a host that caches by URI never mixes cards. */
export const WORKERS_SPEND_RESOURCE_URI = 'ui://cloudflare/workers-spend-limit.html'

export const WorkersSpendInputSchema = thresholdAlertInput(
  'Workers usage charges in a billing period to start the threshold at, in US cents ($50 is 5000), when the user named an amount. Otherwise the App suggests one.',
  HISTORY_DAYS
).extend({
  action: z
    .enum(['notification', 'usage_block'])
    .optional()
    .describe(
      'What the card starts on: `notification` to email at 80% and 100% (the default), `usage_block` when the user asked to stop, cap or block Workers at the amount. The user can switch on the card.'
    )
})
export type WorkersSpendInput = z.infer<typeof WorkersSpendInputSchema>

/** What the model does next, in the result it reads. */
export const WORKERS_SPEND_NEXT_STEP =
  'Reply bottom line first (BLUF): the first sentence is the suggested amount in dollars and whether a month in the history would have reached it, such as “I’d set it at $60 a month; no month in the last 89 days reached that.” If a limitation says the amount the user named was replaced, that is the first sentence instead. If the card starts on a spending limit, say in one sentence that at the amount every Worker on the account stops taking new requests until the next billing period. Then one sentence at most of context, such as the typical month or an existing spend policy. Where the App shows, the user picks Email me or Stop Workers, sets the amount and email on the card and clicks Create, which creates it: end by pointing to the card, without a question. Where no App shows, ask for the amount, the email and whether to stop Workers or only email.'

export const WorkersSpendPreviewSchema = z.object({
  kind: z.literal('workers_spend_limit_preview'),
  ...previewHead,
  /** The action the card starts on: what the user asked for, or `notification`. */
  action: z.enum(['notification', 'usage_block']),
  /** US cents in a month: the policy's unit. `null` with under a week of history. */
  summary: z.object({
    /** The median day × an average month's days, in cents. */
    typicalMonth: z.number().nullable(),
    /** This calendar month so far, to yesterday, in cents. */
    thisMonth: z.number(),
    /** The busiest whole month charted, this month projected to its end, in cents. */
    busiestMonth: z.number(),
    /** Where the threshold starts, in cents: the input `limit`, or a tenth above the busiest month. */
    suggestedLimit: z.number().nullable()
  }),
  /** Whether the account's spend policies could be read, so it can have one. `null`: not read. */
  alertAvailable: z.boolean().nullable(),
  ...previewTail
})
export type WorkersSpendPreview = z.infer<typeof WorkersSpendPreviewSchema>

export const WORKERS_SPEND_TOOL_CONFIG = {
  title: 'Workers spending limit',
  description:
    'Set a Cloudflare spend policy on Workers usage charges in the current billing period: an email alert at 80% and 100% of a dollar amount, or a spending limit that also stops every Worker on the account from taking new requests at the amount until the next billing period. Use it for “warn me if Workers is going to cost more than $50 this month”, “cap our Workers so we never pay more than $20”, or “just shut off our Workers if they cost more than $100”. Counts Workers requests and CPU time after included usage, not the Workers Paid fee, Durable Objects, Workers AI, KV or R2. Reads the last 89 complete days of Workers usage charges from billable usage and the account’s spend policies, and in MCP Apps hosts shows a monthly chart where the user picks Email me or Stop Workers, drags the amount and enters an email. Pass `action: usage_block` when the user asked to stop, cap or block Workers. This tool only reads. Where the App shows, its Create button creates the policy when the user clicks it: don’t ask in chat to confirm or create it, and don’t create it again. Only if the App hands the policy to the chat, create it with a write the user approves. Where the App shows, keep the reply short and end by pointing to the card, without asking in chat for the amount or the email. In a host that shows no App, such as a terminal, don’t mention a chart: give the suggested amount and ask in chat for the amount, the email and whether to stop Workers. Summarize the typical month and any existing spend policy instead of repeating the daily data. A limit doesn’t guarantee a maximum invoice: blocking takes time. For a request count rather than dollars, use workers_billing_alert; for a spike in traffic, workers_usage_alert; for R2 or an account-wide dollar budget, neither.',
  annotations: READ_ONLY
}
