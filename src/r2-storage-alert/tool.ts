/**
 * The R2 storage billing alert App: the shared threshold alert view over
 * R2 Standard storage, previewing a `billing_usage_alert` on `r2_storage` by
 * calendar month. Only the preset, the read and the result's names differ
 * from the Workers Apps.
 */
import { defineThresholdAlertApp } from '../threshold-alert/define'
import { R2_STORAGE_BILLING } from '../threshold-alert/presets'
import {
  R2_STORAGE_ALERT_NEXT_STEP,
  R2_STORAGE_ALERT_RESOURCE_URI,
  R2_STORAGE_ALERT_TOOL_CONFIG,
  R2StorageAlertInputSchema,
  R2StorageAlertPreviewSchema,
  type R2StorageAlertPreview
} from './contract'
import { readR2Storage, storedOn } from './read'
// The one view every threshold alert shares.
import { appHtml } from '../workers-usage-alert/app-html.generated'

const round = (n: number | null) => (n == null ? null : Math.round(n))

export const r2StorageAlertApp = defineThresholdAlertApp({
  preset: R2_STORAGE_BILLING,
  // Only R2 storage policies watch the same number.
  related: [R2_STORAGE_BILLING],
  ...R2_STORAGE_ALERT_TOOL_CONFIG,
  input: R2StorageAlertInputSchema,
  output: R2StorageAlertPreviewSchema,
  resource: {
    uri: R2_STORAGE_ALERT_RESOURCE_URI,
    name: 'R2 storage billing alert',
    html: appHtml
  },
  limitations: [
    'The chart is R2 Standard storage from R2 analytics: each day’s peak across every bucket, averaged by calendar month as billing averages it over the billing period. Billing’s period can start on another day and its free 10 GB-month applies there; the alert’s count is billing’s.',
    'Infrequent Access storage, operations and egress aren’t counted.',
    'The threshold is an amount of storage in bytes (decimal: 1 TB is 10¹² bytes), not dollars. The alert sends email; it never deletes data or blocks uploads.'
  ],
  readHistory: readR2Storage,
  shape: (c): R2StorageAlertPreview => ({
    kind: 'r2_storage_alert_preview',
    nextStep: R2_STORAGE_ALERT_NEXT_STEP,
    checkedAt: c.checkedAt,
    accountId: c.accountId,
    ...(c.userEmail ? { userEmail: c.userEmail } : {}),
    today: c.today,
    days: c.days,
    summary: {
      typicalMonth: round(c.model.typical),
      thisMonth: Math.round(c.model.current),
      busiestMonth: Math.round(c.model.peak),
      storedNow: Math.round(storedOn(c.days)),
      suggestedLimit: c.suggestedLimit
    },
    alertAvailable: c.alertAvailable,
    existingAlerts: c.existingAlerts,
    otherPolicies: c.otherPolicies,
    limitations: c.limitations
  })
})
