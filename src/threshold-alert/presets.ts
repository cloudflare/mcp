/**
 * Threshold alert presets: everything about one kind of "history of one
 * number + a line + who to tell" alert that the view and the collector share.
 * Pure (no reads, no DOM), so the App's view imports it too.
 *
 * Every preset creates one notification policy with the generated
 * `alerting_policies_create`; only `alert_type`, the threshold filter and the
 * history differ. The server half (the history reader) is in each App's
 * `tool.ts`; see `defineThresholdAlertApp`.
 */
import { CALENDAR_MONTH, ROLLING_7_DAYS, type Cadence } from './model'
import { policyNumber, type UnitFormat } from './units'

/** Every registered preset. */
export type PresetId =
  | 'workers-requests-monitor'
  | 'workers-requests-billing'
  | 'r2-storage-billing'

/** How an existing policy is reported: by the preset that would have created it. */
export type ExistingKind = 'monitor' | 'billing'

/** A policy as `GET …/alerting/v3/policies` lists it, as far as recognising one needs. */
export interface ListedPolicy {
  readonly alert_type: string
  readonly filters?: Readonly<Record<string, readonly string[]>>
}

/** The policy body `alerting_policies_create` sends, exactly as the App shows it. */
export interface PolicyBody {
  readonly name: string
  readonly alert_type: string
  readonly enabled: true
  readonly filters: Readonly<Record<string, readonly string[]>>
  readonly alert_interval?: string
  readonly mechanisms: { readonly email: readonly { readonly id: string }[] }
}

/** What the threshold counts, for the slider and the sentences that name it. */
export interface Unit {
  /** `'requests'`. Shown after a number: "about 800 million requests". */
  readonly noun: string
  /** How a value is written: a count ("1.35B") or bytes ("1.5 TB"). */
  readonly format: UnitFormat
}

/** The view's copy. `{limit}` is the formatted threshold. */
export interface PresetCopy {
  /** The alert, in a sentence: "Workers usage alert". */
  readonly label: string
  /** The card's title: what the alert does, in the user's words. */
  readonly title: string
  /** The chart's accessible name. */
  readonly chartLabel: string
  /** The slider's accessible name. */
  readonly sliderLabel: string
  /** The period the threshold is per, after a number: "in 7 days", "in a billing period". */
  readonly per: string
  /** A bucket: "week", "month". */
  readonly bucket: string
  /** The current period: "Last 7 days", "This month". */
  readonly current: string
  /** The over-the-line warning: when it emails if it is already over. */
  readonly alreadyOver: string
  /** What didn't answer when the read failed: "Workers analytics". */
  readonly source: string
  /** The card's message when `available_alerts` lacks the type: it replaces the chart and the form. */
  readonly unavailable: { readonly title: string; readonly body: string }
  /** The empty card's body when there is no history at all: what will fill the chart. */
  readonly noHistory: string
}

export interface ThresholdAlertPreset {
  readonly id: PresetId
  /** The tool that serves it; also how `updateModelContext` names the App. */
  readonly toolName: string
  /** The policy's `alert_type`, which `available_alerts` must list. */
  readonly alertType: string
  /** How this preset's existing policies are reported. */
  readonly existingKind: ExistingKind
  readonly cadence: Cadence
  readonly unit: Unit
  readonly copy: PresetCopy
  /** The policy Create alert sends. */
  policy(accountId: string, limit: number, email: string, name: string): PolicyBody
  /** The policy's name, from the formatted threshold. */
  name(limit: string): string
  /** What the alert waits for, in a sentence for the model: "Workers requests pass 1,000,000 in 7 days". */
  passes(limit: number): string
  /** Whether a listed policy is one of this preset's, and its threshold. */
  recognise(policy: ListedPolicy): { readonly limit: number } | null
}

const first = (policy: ListedPolicy, key: string) => Number(policy.filters?.[key]?.[0])

// ── workers-requests-monitor: today's behaviour ──

/** The SQL the monitor runs every hour. Its daily counts match the GraphQL read. */
export function monitorQuery(accountId: string): string {
  return `SELECT COUNT(*) AS value
FROM events.workersInvocations
WHERE accountTag = '${accountId}'
  AND timestamp >= NOW() - INTERVAL '7' DAY`
}

/** The `custom_analytics` policy the Workers usage alert shows and, on Create alert, creates. */
export function monitorPolicy(accountId: string, limit: number, email: string, name: string) {
  return {
    name,
    alert_type: 'custom_analytics',
    enabled: true as const,
    filters: {
      source: ['sql_api'],
      selectors: [monitorQuery(accountId)],
      alert_trigger_preferences: ['threshold'],
      alert_trigger_preferences_operator: ['>='],
      alert_trigger_preferences_value: [String(limit)],
      alert_trigger_preferences_short_window: ['168h'],
      execution_interval: ['1h']
    },
    alert_interval: '168h',
    mechanisms: { email: [{ id: email }] }
  }
}

const WORKERS_REQUESTS: Unit = { noun: 'requests', format: 'count' }

export const WORKERS_REQUESTS_MONITOR: ThresholdAlertPreset = {
  id: 'workers-requests-monitor',
  toolName: 'workers_usage_alert',
  alertType: 'custom_analytics',
  existingKind: 'monitor',
  cadence: ROLLING_7_DAYS,
  unit: WORKERS_REQUESTS,
  copy: {
    label: 'Workers usage alert',
    title: 'Email me when 7 days of Workers requests pass the line',
    chartLabel: 'Workers requests per week, with the 7-day alert threshold',
    sliderLabel: 'Alert threshold, requests in 7 days',
    per: 'in 7 days',
    bucket: 'week',
    current: 'Last 7 days',
    alreadyOver: 'Already over: emails within the hour',
    source: 'Workers analytics',
    unavailable: {
      title: 'Usage alerts aren’t on this plan',
      body: 'This account can’t create custom analytics alerts, so there’s nothing to set up here.'
    },
    noHistory:
      'Normal weeks show up here once your Workers get requests. Until then, tell me a number in chat.'
  },
  policy: monitorPolicy,
  name: (limit) => `Workers requests over ${limit} in 7 days`,
  passes: (limit) => `Workers requests pass ${limit.toLocaleString('en')} in 7 days`,
  recognise: (policy) =>
    policy.alert_type === 'custom_analytics' &&
    policy.filters?.selectors?.some((sql) => /\bevents\.workersInvocations\b/i.test(sql))
      ? { limit: first(policy, 'alert_trigger_preferences_value') }
      : null
}

// ── workers-requests-billing: a billing_usage_alert on worker_requests ──

/** The `billing_usage_alert` product for Workers requests, as the dashboard's Usage Based Billing form sends it. */
export const WORKER_REQUESTS_PRODUCT = 'worker_requests'

export function billingUsagePolicy(_accountId: string, limit: number, email: string, name: string) {
  return billingUsagePolicyFor(WORKER_REQUESTS_PRODUCT, limit, email, name)
}

/** A `billing_usage_alert` on one Usage Based Billing product, as the dashboard's form sends it. */
export function billingUsagePolicyFor(product: string, limit: number, email: string, name: string) {
  return {
    name,
    alert_type: 'billing_usage_alert',
    enabled: true as const,
    filters: { product: [product], limit: [String(limit)] },
    mechanisms: { email: [{ id: email }] }
  }
}

export const WORKERS_REQUESTS_BILLING: ThresholdAlertPreset = {
  id: 'workers-requests-billing',
  toolName: 'workers_billing_alert',
  alertType: 'billing_usage_alert',
  existingKind: 'billing',
  cadence: CALENDAR_MONTH,
  unit: WORKERS_REQUESTS,
  copy: {
    label: 'Workers billing usage alert',
    title: 'Email me when billed Workers requests pass the line',
    chartLabel: 'Workers requests per month, with the billing usage threshold',
    sliderLabel: 'Alert threshold, billed requests in a billing period',
    per: 'in a billing period',
    bucket: 'month',
    current: 'This month',
    alreadyOver: 'Likely over this month: emails once billing counts it',
    source: 'Workers analytics',
    unavailable: {
      title: 'Billing alerts aren’t on this plan',
      body: 'This account can’t create usage-based billing alerts, so there’s nothing to set up here.'
    },
    noHistory:
      'Normal months show up here once your Workers get requests. Until then, tell me a number in chat.'
  },
  policy: billingUsagePolicy,
  name: (limit) => `Billed Workers requests over ${limit}`,
  passes: (limit) => `Workers requests pass ${limit.toLocaleString('en')} in a billing period`,
  recognise: (policy) =>
    policy.alert_type === 'billing_usage_alert' &&
    policy.filters?.product?.includes(WORKER_REQUESTS_PRODUCT)
      ? { limit: first(policy, 'limit') }
      : null
}

// ── r2-storage-billing: a billing_usage_alert on r2_storage ──

/**
 * The `billing_usage_alert` product for R2 storage, as the dashboard's Usage
 * Based Billing form sends it. Its limit is in bytes ("bytes of storage").
 */
export const R2_STORAGE_PRODUCT = 'r2_storage'

const R2_STORAGE: Unit = { noun: 'of storage', format: 'bytes' }

/**
 * R2 storage bills in GB-months: the average of each day's peak over the
 * billing period. Each day of history is that day's peak ÷ 30, so a month's
 * total is what billing counts, and the monthly cadence is billing's rule.
 */
export const R2_STORAGE_BILLING: ThresholdAlertPreset = {
  id: 'r2-storage-billing',
  toolName: 'r2_storage_alert',
  alertType: 'billing_usage_alert',
  existingKind: 'billing',
  cadence: CALENDAR_MONTH,
  unit: R2_STORAGE,
  copy: {
    label: 'R2 storage billing alert',
    title: 'Email me when billed R2 storage passes the line',
    chartLabel:
      'R2 Standard storage by month, averaged as billing counts it, with the alert threshold',
    sliderLabel: 'Alert threshold, average R2 storage in a billing period',
    per: 'averaged over a billing period',
    bucket: 'month',
    current: 'Billed so far',
    alreadyOver: 'Likely over this month: emails once billing counts it',
    source: 'R2 analytics',
    unavailable: {
      title: 'Billing alerts aren’t on this plan',
      body: 'This account can’t create usage-based billing alerts, so there’s nothing to set up here.'
    },
    noHistory:
      'Normal months show up here once your R2 buckets hold data. Until then, tell me a number in chat.'
  },
  policy: (_accountId, limit, email, name) =>
    billingUsagePolicyFor(R2_STORAGE_PRODUCT, limit, email, name),
  name: (limit) => `Billed R2 storage over ${limit}`,
  passes: (limit) =>
    `billed R2 storage passes ${policyNumber(limit, 'bytes')} (${limit.toLocaleString('en')} bytes, averaged over a billing period)`,
  recognise: (policy) =>
    policy.alert_type === 'billing_usage_alert' &&
    policy.filters?.product?.includes(R2_STORAGE_PRODUCT)
      ? { limit: first(policy, 'limit') }
      : null
}

/** Every registered preset, by id. */
export const PRESETS: Readonly<Record<PresetId, ThresholdAlertPreset>> = {
  'workers-requests-monitor': WORKERS_REQUESTS_MONITOR,
  'workers-requests-billing': WORKERS_REQUESTS_BILLING,
  'r2-storage-billing': R2_STORAGE_BILLING
}

/** Which preset's policy a listed one is, if any, among `presets`. */
export function recogniseAmong(presets: readonly ThresholdAlertPreset[], policy: ListedPolicy) {
  for (const preset of presets) {
    const hit = preset.recognise(policy)
    if (hit) return { kind: preset.existingKind, limit: hit.limit }
  }
  return null
}
