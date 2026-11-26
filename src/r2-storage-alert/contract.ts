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

/** The shared threshold alert view, at its own URI so a host that caches by URI never mixes cards. */
export const R2_STORAGE_ALERT_RESOURCE_URI = 'ui://cloudflare/r2-storage-alert.html'

export const R2StorageAlertInputSchema = thresholdAlertInput(
  'Average R2 storage in a billing period, in bytes (decimal: 1 TB is 1000000000000), to start the threshold at, when the user named an amount. Otherwise the App suggests one.',
  HISTORY_DAYS
)
export type R2StorageAlertInput = z.infer<typeof R2StorageAlertInputSchema>

/** What the model does next, in the result it reads. */
export const R2_STORAGE_ALERT_NEXT_STEP =
  'Reply bottom line first (BLUF): the first sentence is the suggested threshold in TB or GB and whether a month in the history would have passed it, such as “I’d alert at about 1.5 TB of billed storage; no month in the last 89 days reached it.” If a limitation says the amount the user named was replaced, that is the first sentence instead. Then one sentence at most of context, such as the typical month or an existing alert. Where the App shows, the user sets the threshold and email on the card and clicks Create alert, which creates it: end by pointing to the card, without a question. Where no App shows, ask for the amount and email.'

export const R2StorageAlertPreviewSchema = z.object({
  kind: z.literal('r2_storage_alert_preview'),
  ...previewHead,
  /** Storage in bytes averaged over a month: the alert's unit (GB-months × 10⁹). `null` with under a week of history. */
  summary: z.object({
    /** The median day's peak storage, in bytes: what a typical billing period averages to. */
    typicalMonth: z.number().nullable(),
    /** This calendar month so far: each day's peak ÷ 30, summed, in bytes. */
    thisMonth: z.number(),
    /** The busiest whole month charted, this month projected to its end, in bytes. */
    busiestMonth: z.number(),
    /** Yesterday's peak storage across every bucket, in bytes. */
    storedNow: z.number(),
    /** Where the threshold starts, in bytes: the input `limit`, or a tenth above the busiest month. */
    suggestedLimit: z.number().nullable()
  }),
  /** Whether the account can create `billing_usage_alert`, from `available_alerts`. `null`: not read. */
  alertAvailable: z.boolean().nullable(),
  ...previewTail
})
export type R2StorageAlertPreview = z.infer<typeof R2StorageAlertPreviewSchema>

export const R2_STORAGE_ALERT_TOOL_CONFIG = {
  title: 'R2 storage billing alert',
  description:
    'Set up a Cloudflare billing usage notification for when billed R2 storage in the current billing period passes an amount, such as “alert me when our R2 storage passes 1 TB” or “email me before R2 storage starts costing real money”. Creates a billing_usage_alert on r2_storage, the dashboard’s Usage Based Billing notification; R2 bills storage as the average of each day’s peak over the billing period (GB-months). Reads the last 89 complete days of R2 Standard storage across every bucket and the account’s notification policies, and in MCP Apps hosts shows a monthly chart where the user drags the threshold and enters an email. This tool only reads. Where the App shows, its Create alert button creates the alert when the user clicks it: don’t ask in chat to confirm or create it, and don’t create it again. Only if the App hands the policy to the chat, create it with a write the user approves. Where the App shows, keep the reply short and end by pointing to the card, without asking in chat for the amount or the email. In a host that shows no App, such as a terminal, don’t mention a chart: give the suggested threshold and ask in chat for the amount and the email. Summarize the typical month and any existing alert instead of repeating the daily data. The threshold is an amount of storage in bytes, not dollars, and the alert never deletes data, blocks uploads or caps storage: don’t call it to do those, say so instead. For R2 operations, egress or a dollar budget, neither this nor the Workers tools apply.',
  annotations: READ_ONLY
}
