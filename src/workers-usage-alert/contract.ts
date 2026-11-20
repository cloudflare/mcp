import { z } from 'zod'
import { DaySchema, ExistingAlertSchema, thresholdAlertInput } from '../threshold-alert/contract'
import { HISTORY_DAYS } from './history'

export { HISTORY_DAYS }
export { ExistingAlertSchema }

/**
 * Both Workers presets share one view, served at a URI per tool so a host
 * that caches by URI never shows one tool's card for the other.
 */
export const USAGE_ALERT_RESOURCE_URI = 'ui://cloudflare/workers-usage-alert.html'
export const BILLING_ALERT_RESOURCE_URI = 'ui://cloudflare/workers-billing-alert.html'

export const UsageAlertInputSchema = thresholdAlertInput(
  'Requests in 7 days to start the threshold at, when the user named a number. Otherwise the App suggests one.',
  HISTORY_DAYS
)
export type UsageAlertInput = z.infer<typeof UsageAlertInputSchema>

export const BillingAlertInputSchema = thresholdAlertInput(
  'Billed Workers requests in a billing period to start the threshold at, when the user named a number (50M is 50000000). Otherwise the App suggests one.',
  HISTORY_DAYS
)
export type BillingAlertInput = z.infer<typeof BillingAlertInputSchema>

/** One complete UTC day's Workers requests, from the GraphQL Analytics API. */
export const DailyRequestsSchema = DaySchema

/**
 * What the model does next, in the result it reads. ChatGPT asked in chat for
 * the limit and email with this guidance only in the tool description.
 */
export const USAGE_ALERT_NEXT_STEP =
  'Reply bottom line first (BLUF): the first sentence is the suggested threshold and whether it would have emailed in the history, such as “I’d alert at about 1.35B requests in 7 days; that never happened in the last 89 days.” If a limitation says the number the user named was replaced, that is the first sentence instead. Then one sentence at most of context, such as the typical period or an existing alert. Where the App shows, the user sets the threshold and email on the card and clicks Create alert, which creates it: end by pointing to the card, without a question. Where no App shows, ask for the limit and email.'

/** The fields every Workers threshold alert's result starts with. */
const head = {
  /** How to reply: see `USAGE_ALERT_NEXT_STEP`. */
  nextStep: z.string(),
  checkedAt: z.iso.datetime(),
  accountId: z.string(),
  accountName: z.string().optional(),
  /** The signed-in user's own email, for a user credential: the view's default recipient. */
  userEmail: z.string().optional(),
  /** The day treated as today, `YYYY-MM-DD`. It is still counting, so it isn't in `days`. */
  today: z.iso.date(),
  /**
   * Complete UTC days, oldest first, from the first day with traffic to
   * yesterday. Days without traffic inside that range are 0.
   */
  days: z.array(DailyRequestsSchema)
}
/** And ends with, after its summary and whether its alert type is available. */
const tail = {
  /** Alerts on Workers requests that already exist, either kind. `null`: not read. */
  existingAlerts: z.array(ExistingAlertSchema).nullable(),
  /** Every other policy, counted by type. */
  otherPolicies: z.record(z.string(), z.number().int()),
  limitations: z.array(z.string())
}

export const UsageAlertPreviewSchema = z.object({
  kind: z.literal('workers_usage_alert_preview'),
  ...head,
  /** Requests in 7 days: the alert's unit. `null` with under a week of history. */
  summary: z.object({
    /** The median day × 7. */
    typicalWeek: z.number().nullable(),
    /** The last 7 complete days. */
    last7Days: z.number(),
    /** The busiest 7 days in `days`. */
    busiestWeek: z.number(),
    /** Where the threshold starts: the input `limit`, or a tenth above the busiest week. */
    suggestedLimit: z.number().nullable()
  }),
  /** Whether the account can create the `custom_analytics` monitor, from `available_alerts`. `null`: not read. */
  alertAvailable: z.boolean().nullable(),
  ...tail
})
export type UsageAlertPreview = z.infer<typeof UsageAlertPreviewSchema>

export const BillingAlertPreviewSchema = z.object({
  kind: z.literal('workers_billing_alert_preview'),
  ...head,
  /** Requests in a month: the alert's unit. `null` with under a week of history. */
  summary: z.object({
    /** The median day × an average month's days. */
    typicalMonth: z.number().nullable(),
    /** This calendar month so far, to yesterday. */
    thisMonth: z.number(),
    /** The busiest whole month in `days`, or the most any month reached. */
    busiestMonth: z.number(),
    /** Where the threshold starts: the input `limit`, or a tenth above the busiest month. */
    suggestedLimit: z.number().nullable()
  }),
  /** Whether the account can create `billing_usage_alert`, from `available_alerts`. `null`: not read. */
  alertAvailable: z.boolean().nullable(),
  ...tail
})
export type BillingAlertPreview = z.infer<typeof BillingAlertPreviewSchema>

/** What the shared view renders: either Workers preset's result. */
export const WorkersThresholdPreviewSchema = z.discriminatedUnion('kind', [
  UsageAlertPreviewSchema,
  BillingAlertPreviewSchema
])
export type WorkersThresholdPreview = z.infer<typeof WorkersThresholdPreviewSchema>

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
}

/**
 * What every Workers threshold alert's description says about requests to stop traffic.
 * ChatGPT opened the card for “just shut off our Workers if they go over 1M requests”.
 */
const NOT_A_CAP =
  'Don’t call it to shut off, pause, cap, rate-limit or block Workers (“shut off our Workers over 1M requests”): this alert only emails and never blocks traffic, so say that instead.'

/** What every Workers threshold alert's description says about the card, after its own first sentences. */
const CARD_FLOW =
  'This tool only reads. Where the App shows, its Create alert button creates the alert when the user clicks it: don’t ask in chat to confirm or create it, and don’t create it again. Only if the App hands the policy to the chat, create it with a write the user approves. Where the App shows, keep the reply short and end by pointing to the card: the user moves the line and clicks Create alert there, so don’t ask in chat for the limit or the email. In a host that shows no App, such as a terminal, don’t mention a chart: give the suggested threshold and ask in chat for the limit and the email.'

export const USAGE_ALERT_TOOL_CONFIG = {
  title: 'Workers usage alert',
  description: `Set up an email alert for when Workers traffic gets clearly bigger than normal, such as “ping me if our Workers traffic gets way out of hand”. Use it also when the user asks whether or how they can be told about a traffic surge, a bot or attack hammering their Workers, or a request spike (“is there a way to get told when a bot hammers our Workers?”): this is that way, so call it rather than searching the web. Reads the account’s daily Workers requests for the last 89 complete days (all that Workers analytics keep) and its notification policies, and in MCP Apps hosts shows a weekly chart where the user drags the threshold (requests in 7 days) and enters an email. ${CARD_FLOW} Summarize the typical week and any existing alert instead of repeating the daily data. Request counts are not dollar cost, and the alert never blocks traffic. ${NOT_A_CAP} For a threshold on billed requests in a billing period (“before our bill passes 50M requests”), use workers_billing_alert; for dollar spend, neither.`,
  annotations: READ_ONLY
}

export const BILLING_ALERT_TOOL_CONFIG = {
  title: 'Workers billing usage alert',
  description: `Set up a Cloudflare billing usage notification for when billed Workers requests in the current billing period pass a number, such as “email me before our Workers bill passes 50M requests” or “tell me when we go over our included Workers requests this month”. Creates a billing_usage_alert on worker_requests, the dashboard’s Usage Based Billing notification. Reads the last 89 complete days of Workers requests and the account’s notification policies, and in MCP Apps hosts shows a monthly chart where the user drags the threshold (requests in a month) and enters an email. ${CARD_FLOW} Summarize the typical month and any existing alert instead of repeating the daily data. The threshold is a request count, not dollars; the chart is Workers analytics by calendar month, which approximates billed usage in the billing period. It isn’t a spending limit and never blocks traffic. ${NOT_A_CAP} For traffic clearly above normal in any 7 days (“way out of hand”), use workers_usage_alert; for a dollar budget, neither.`,
  annotations: READ_ONLY
}
