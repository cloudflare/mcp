import { z } from 'zod'

export const USAGE_ALERT_RESOURCE_URI = 'ui://cloudflare/workers-usage-alert.html'

/** The billing product the alert watches. The only one this App supports so far. */
export const WORKER_REQUESTS_PRODUCT = 'worker_requests'

export const UsageAlertInputSchema = z.strictObject({
  account_id: z
    .string()
    .regex(/^[a-f0-9]{32}$/i)
    .optional()
    .describe('Account to read. Optional when the connection has exactly one account.'),
  as_of: z.iso
    .date()
    .optional()
    .describe(
      'Treat this UTC date as today, for reviewing a past month. Defaults to the current date.'
    )
})
export type UsageAlertInput = z.infer<typeof UsageAlertInputSchema>

/** One day's Workers requests, from the GraphQL Analytics API. */
export const DailyRequestsSchema = z.tuple([z.iso.date(), z.number().int().nonnegative()])

/** A notification policy already on the account, as far as this App needs it. */
export const ExistingPolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  /** The `limit` filter, for a `billing_usage_alert` on Workers requests. */
  limit: z.number().optional()
})

export const UsageAlertPreviewSchema = z.object({
  kind: z.literal('workers_usage_alert_preview'),
  checkedAt: z.iso.datetime(),
  accountId: z.string(),
  accountName: z.string().optional(),
  /** UTC calendar months, `YYYY-MM`. Billing periods may not align with them. */
  currentMonth: z.string(),
  previousMonth: z.string(),
  /** Daily request counts, oldest first. Days without traffic may be absent. */
  current: z.array(DailyRequestsSchema),
  previous: z.array(DailyRequestsSchema),
  /** Whether the account can create a `billing_usage_alert`, from `available_alerts`. `null`: not read. */
  alertAvailable: z.boolean().nullable(),
  /** The billing usage alerts on Workers requests that already exist. `null`: not read. */
  existingAlerts: z.array(ExistingPolicySchema).nullable(),
  /** Every other policy, counted by type, so the view can say what exists without listing it. */
  otherPolicies: z.record(z.string(), z.number().int()),
  /** A suggested threshold, 25% over the previous month, rounded. The user picks the real one. */
  suggestedLimit: z.number().int().positive().optional(),
  limitations: z.array(z.string())
})
export type UsageAlertPreview = z.infer<typeof UsageAlertPreviewSchema>

export const USAGE_ALERT_TOOL_CONFIG = {
  title: 'Workers usage alert',
  description:
    'Preview an email alert for when Workers requests this billing period pass a threshold. Use for requests like “tell me if our Workers traffic gets way bigger than normal” or “alert me before Workers usage spikes”. Reads daily Workers requests for this and last month, and the account’s existing notification policies. Read-only: it creates nothing. Displays a chart in MCP Apps hosts where the user picks the threshold; summarize last month’s total and any existing alert rather than repeating the data. Request counts are not dollar cost, and the alert does not block traffic.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
}
