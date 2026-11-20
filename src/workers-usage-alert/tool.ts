/**
 * The two Workers threshold alert Apps. They share one view and one history
 * read (89 days of Workers requests) and differ only in their preset: the
 * hourly `custom_analytics` monitor on a rolling 7 days, and the dashboard's
 * `billing_usage_alert` on billed requests in a billing period.
 */
import { defineThresholdAlertApp, type Collected } from '../threshold-alert/define'
import { WORKERS_REQUESTS_BILLING, WORKERS_REQUESTS_MONITOR } from '../threshold-alert/presets'
import {
  BILLING_ALERT_RESOURCE_URI,
  BILLING_ALERT_TOOL_CONFIG,
  BillingAlertInputSchema,
  BillingAlertPreviewSchema,
  USAGE_ALERT_NEXT_STEP,
  USAGE_ALERT_RESOURCE_URI,
  USAGE_ALERT_TOOL_CONFIG,
  UsageAlertInputSchema,
  UsageAlertPreviewSchema,
  type BillingAlertPreview,
  type UsageAlertPreview
} from './contract'
import { readWorkersRequests } from './read'
import { appHtml } from './app-html.generated'

/** Both Workers presets: each recognises the other's policies as already watching Workers requests. */
const WORKERS_PRESETS = [WORKERS_REQUESTS_BILLING, WORKERS_REQUESTS_MONITOR]

const common = (c: Collected) => ({
  nextStep: USAGE_ALERT_NEXT_STEP,
  checkedAt: c.checkedAt,
  accountId: c.accountId,
  ...(c.accountName ? { accountName: c.accountName } : {}),
  ...(c.userEmail ? { userEmail: c.userEmail } : {}),
  today: c.today,
  days: c.days
})
const round = (n: number | null) => (n == null ? null : Math.round(n))

/**
 * The Workers usage alert App, served in both tool modes. Its tool only
 * reads; the view's buttons create, save and delete the policy.
 */
export const workersUsageAlertApp = defineThresholdAlertApp({
  preset: WORKERS_REQUESTS_MONITOR,
  related: WORKERS_PRESETS,
  ...USAGE_ALERT_TOOL_CONFIG,
  input: UsageAlertInputSchema,
  output: UsageAlertPreviewSchema,
  resource: { uri: USAGE_ALERT_RESOURCE_URI, name: 'Workers usage alert', html: appHtml },
  limitations: [
    'Request counts come from Workers analytics, not billing. They are not dollar cost.',
    'Workers analytics keep 89 complete days; older traffic cannot be read.'
  ],
  readHistory: readWorkersRequests,
  shape: (c): UsageAlertPreview => ({
    kind: 'workers_usage_alert_preview',
    ...common(c),
    summary: {
      typicalWeek: round(c.model.typical),
      last7Days: Math.round(c.model.current),
      busiestWeek: Math.round(c.model.peak),
      suggestedLimit: c.suggestedLimit
    },
    alertAvailable: c.alertAvailable,
    existingAlerts: c.existingAlerts,
    otherPolicies: c.otherPolicies,
    limitations: c.limitations
  })
})

/**
 * The Workers billing usage alert App: the same card and reads, previewing
 * a `billing_usage_alert` on `worker_requests` by calendar month.
 */
export const workersBillingAlertApp = defineThresholdAlertApp({
  preset: WORKERS_REQUESTS_BILLING,
  related: WORKERS_PRESETS,
  ...BILLING_ALERT_TOOL_CONFIG,
  input: BillingAlertInputSchema,
  output: BillingAlertPreviewSchema,
  resource: {
    uri: BILLING_ALERT_RESOURCE_URI,
    name: 'Workers billing usage alert',
    html: appHtml
  },
  limitations: [
    'The chart is Workers analytics by calendar month. Billing counts requests in the billing period, which can start on another day, and its free allowance applies there; the alert’s count is billing’s.',
    'Workers analytics keep 89 complete days, so at most two whole months are charted.',
    'The threshold is a request count, not dollar cost. The alert sends email; it isn’t a spending limit and never blocks traffic.'
  ],
  readHistory: readWorkersRequests,
  shape: (c): BillingAlertPreview => ({
    kind: 'workers_billing_alert_preview',
    ...common(c),
    summary: {
      typicalMonth: round(c.model.typical),
      thisMonth: Math.round(c.model.current),
      busiestMonth: Math.round(c.model.peak),
      suggestedLimit: c.suggestedLimit
    },
    alertAvailable: c.alertAvailable,
    existingAlerts: c.existingAlerts,
    otherPolicies: c.otherPolicies,
    limitations: c.limitations
  })
})
