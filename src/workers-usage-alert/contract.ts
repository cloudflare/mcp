import { z } from 'zod'

export const USAGE_ALERT_RESOURCE_URI = 'ui://cloudflare/workers-usage-alert.html'

/** Days of history read: the Workers analytics retention (12w6d), less today. */
export const HISTORY_DAYS = 89

export const UsageAlertInputSchema = z.strictObject({
  account_id: z
    .string()
    .regex(/^[a-f0-9]{32}$/i)
    .optional()
    .describe('Account to read. Optional when the connection has exactly one account.'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Requests in 7 days to start the threshold at, when the user named a number. Otherwise the App suggests one.'
    ),
  as_of: z.iso
    .date()
    .optional()
    .describe(
      'Treat this UTC date as today. Defaults to the current date. Analytics older than 89 complete days cannot be read.'
    )
})
export type UsageAlertInput = z.infer<typeof UsageAlertInputSchema>

/** One complete UTC day's Workers requests, from the GraphQL Analytics API. */
export const DailyRequestsSchema = z.tuple([z.iso.date(), z.number().int().nonnegative()])

/** An alert already on the account that watches Workers requests. */
export const ExistingAlertSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  /** `monitor`: a `custom_analytics` policy on `events.workersInvocations`. `billing`: a `billing_usage_alert` on `worker_requests`. */
  kind: z.enum(['monitor', 'billing']),
  /** Its threshold, when it has one. */
  limit: z.number().optional()
})

export const UsageAlertPreviewSchema = z.object({
  kind: z.literal('workers_usage_alert_preview'),
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
  days: z.array(DailyRequestsSchema),
  /** Requests in 7 days: the alert's unit. `null` with under a week of history. */
  summary: z.object({
    /** The median day × 7. */
    typicalWeek: z.number().nullable(),
    /** The last 7 complete days. */
    last7Days: z.number(),
    /** The busiest 7 days in `days`. */
    busiestWeek: z.number(),
    /** Where the threshold starts: the input `limit`, or a typical week plus a quarter. */
    suggestedLimit: z.number().nullable()
  }),
  /** Whether the account can create the `custom_analytics` monitor, from `available_alerts`. `null`: not read. */
  alertAvailable: z.boolean().nullable(),
  /** Alerts on Workers requests that already exist. `null`: not read. */
  existingAlerts: z.array(ExistingAlertSchema).nullable(),
  /** Every other policy, counted by type. */
  otherPolicies: z.record(z.string(), z.number().int()),
  limitations: z.array(z.string())
})
export type UsageAlertPreview = z.infer<typeof UsageAlertPreviewSchema>

export const USAGE_ALERT_TOOL_CONFIG = {
  title: 'Workers usage alert',
  description:
    'Set up an email alert for when Workers traffic gets clearly bigger than normal, such as “ping me if our Workers traffic gets way out of hand”. Reads the account’s daily Workers requests for the last 89 complete days (all that Workers analytics keep) and its notification policies, and in MCP Apps hosts shows a weekly chart where the user drags the threshold (requests in 7 days) and enters an email. This tool only reads. Where the App shows, its Create alert button creates the alert when the user clicks it: don’t ask in chat to confirm or create it, and don’t create it again. Only if the App hands the policy to the chat, create it with a write the user approves. In a host that shows no App, such as a terminal, don’t mention a chart: give the suggested threshold and ask in chat for the limit and the email. Summarize the typical week and any existing alert instead of repeating the daily data. Request counts are not dollar cost, and the alert never blocks traffic.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
}
