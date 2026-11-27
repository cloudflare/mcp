/**
 * The Workers spending limit App: the shared threshold view over Workers
 * usage charges, previewing a spend policy on `workers` by calendar month.
 * The card chooses what happens at the line: an email (`notification`) or a
 * spending limit that stops Workers (`usage_block`). Only the preset, the
 * read and the result's names differ from the alert Apps.
 */
import { defineThresholdAlertApp } from '../threshold-alert/define'
import { WORKERS_SPEND } from '../threshold-alert/presets'
import {
  WORKERS_SPEND_NEXT_STEP,
  WORKERS_SPEND_RESOURCE_URI,
  WORKERS_SPEND_TOOL_CONFIG,
  WorkersSpendInputSchema,
  WorkersSpendPreviewSchema
} from './contract'
import type { WorkersSpendPreview } from './contract'
import { readWorkersSpend } from './read'
// The one view every threshold App shares.
import { appHtml } from '../workers-usage-alert/app-html.generated'

/** Cents as the dollars the model reads and names, to the cent. */
const dollars = (cents: number) => Math.round(cents) / 100

export const workersSpendLimitApp = defineThresholdAlertApp({
  preset: WORKERS_SPEND,
  // Only Workers spend policies watch the same number; the request-count alerts are another unit.
  related: [WORKERS_SPEND],
  ...WORKERS_SPEND_TOOL_CONFIG,
  input: WorkersSpendInputSchema,
  output: WorkersSpendPreviewSchema,
  resource: {
    uri: WORKERS_SPEND_RESOURCE_URI,
    name: 'Workers spending limit',
    html: appHtml
  },
  limitations: [
    'The chart is Workers usage charges from billable usage (requests and CPU time, after included usage) by calendar month. The spend policy counts the subscription billing period, which can start on another day; its count is billing’s.',
    'The Workers Paid subscription fee, Durable Objects, Workers AI, KV and R2 aren’t counted.',
    'Amounts in `limit` and `summary` are US dollars; the policy stores them as cents. A spending limit stops new Worker invocations once billing evaluates it, which takes time, so it doesn’t guarantee a maximum invoice.'
  ],
  readHistory: readWorkersSpend,
  shape: (c, input): WorkersSpendPreview => {
    const preview: WorkersSpendPreview = {
      kind: 'workers_spend_limit_preview',
      nextStep: WORKERS_SPEND_NEXT_STEP,
      checkedAt: c.checkedAt,
      accountId: c.accountId,
      today: c.today,
      days: c.days,
      action: input.action ?? 'notification',
      summary: {
        typicalMonth: c.model.typical === null ? null : dollars(c.model.typical),
        thisMonth: dollars(c.model.current),
        busiestMonth: dollars(c.model.peak),
        suggestedLimit: c.suggestedLimit === null ? null : dollars(c.suggestedLimit)
      },
      alertAvailable: c.alertAvailable,
      existingAlerts: c.existingAlerts,
      otherPolicies: c.otherPolicies,
      limitations: c.limitations
    }
    if (c.accountName) {
      preview.accountName = c.accountName
    }
    if (c.userEmail) {
      preview.userEmail = c.userEmail
    }
    return preview
  }
})
