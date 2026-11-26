/**
 * Threshold presets: everything about one "history of one number + a line +
 * what happens at the line" card that the view and the collector share.
 * Pure (no reads, no DOM), so the App's view imports it too.
 *
 * A preset says what the number is (its unit and cadence), what is written
 * when the user clicks (its {@link WriteTarget}: a notification policy or a
 * spend policy, made with the generated tools), and what can happen at the
 * line (its {@link PresetAction}s: email, or stop the product). The server
 * half (the history reader) is in each App's `tool.ts`; see
 * `defineThresholdAlertApp`.
 */
import { CALENDAR_MONTH, ROLLING_7_DAYS } from './model'
import type { Cadence } from './model'
import { exactNumber, policyNumber } from './units'
import type { UnitFormat } from './units'

/** Every registered preset. */
export type PresetId =
  | 'workers-requests-monitor'
  | 'workers-requests-billing'
  | 'r2-storage-billing'
  | 'workers-spend'

/**
 * How an existing setting is reported: by the preset and action that would
 * have created it. `spend_alert` and `spend_limit` are spend policies whose
 * action is `notification` and `usage_block`.
 */
export type ExistingKind = 'monitor' | 'billing' | 'spend_alert' | 'spend_limit'

/** A policy as `GET …/alerting/v3/policies` lists it, as far as recognising one needs. */
export interface ListedPolicy {
  readonly alert_type: string
  readonly filters?: Readonly<Record<string, ReadonlyArray<string>>>
}

/** A spend policy as `GET …/billing/spend-policies` lists it, as far as recognising one needs. */
export interface ListedSpendPolicy {
  readonly product_id: string
  readonly action: string
  readonly threshold_cents: number
}

/** A setting already on the account, of either kind, as presets recognise it. */
export type ListedSetting =
  | ({ readonly target: 'alerting_policy' } & ListedPolicy)
  | ({ readonly target: 'spend_policy' } & ListedSpendPolicy)

/** The notification policy body `alerting_policies_create` sends, exactly as the App shows it. */
export interface AlertingPolicyBody {
  readonly name: string
  readonly alert_type: string
  readonly enabled: true
  readonly filters: Readonly<Record<string, ReadonlyArray<string>>>
  readonly alert_interval?: string
  readonly mechanisms: { readonly email: ReadonlyArray<{ readonly id: string }> }
}

/** The spend policy body `billing_spendPolicies_create` sends: every field, as create and update take it. */
export interface SpendPolicyBody {
  readonly name: string
  readonly product_id: SpendProduct
  readonly enabled: true
  readonly threshold_cents: number
  readonly action: SpendAction
  readonly notification_email: string
}

/** What Create sends: a notification policy or a spend policy, by the preset's target. */
export type PolicyBody = AlertingPolicyBody | SpendPolicyBody

/** What a write needs to change the setting it made: its id and, for a spend policy, its version. */
export interface SettingRef {
  readonly id: string
  /** A spend policy's `version`, which update and delete send as `If-Match`. */
  readonly version?: number
}

/** One call to a generated tool, as `callServerTool` takes it. */
export type ToolCall = {
  name: string
  // oxlint-disable-next-line quality/no-unsafe-dictionary-type -- The generated tool's input schema owns these arguments; the host checks them.
  arguments: Record<string, unknown>
}

/**
 * Where a preset's setting is written, and with which generated tools. The
 * view calls them through the host (`callServerTool`); Code Mode lists them
 * for the App only (`appTools`).
 */
export interface WriteTarget {
  readonly kind: ListedSetting['target']
  /** The generated tools the view calls: create, update, delete. */
  readonly tools: readonly [create: string, update: string, remove: string]
  create(accountId: string, body: PolicyBody): ToolCall
  update(accountId: string, ref: SettingRef, body: PolicyBody): ToolCall
  remove(accountId: string, ref: SettingRef): ToolCall
  /** The request Create would send, for a host that can't call tools. */
  request(accountId: string, body: PolicyBody): string
}

export const ALERTING_POLICY: WriteTarget = {
  kind: 'alerting_policy',
  tools: ['alerting_policies_create', 'alerting_policies_update', 'alerting_policies_delete'],
  create: (accountId, body) => ({
    name: 'alerting_policies_create',
    arguments: { path: { account_id: accountId }, body }
  }),
  update: (accountId, ref, body) => ({
    name: 'alerting_policies_update',
    arguments: { path: { account_id: accountId, policy_id: ref.id }, body }
  }),
  remove: (accountId, ref) => ({
    name: 'alerting_policies_delete',
    arguments: { path: { account_id: accountId, policy_id: ref.id } }
  }),
  request: (accountId, body) =>
    `POST /accounts/${accountId}/alerting/v3/policies\n${JSON.stringify(body, null, 2)}`
}

/** `If-Match` takes the version the change is based on; a create returns it. */
const ifMatch = (ref: SettingRef) => ({ 'if-match': String(ref.version ?? '') })

export const SPEND_POLICY: WriteTarget = {
  kind: 'spend_policy',
  tools: [
    'billing_spendPolicies_create',
    'billing_spendPolicies_update',
    'billing_spendPolicies_delete'
  ],
  create: (accountId, body) => ({
    name: 'billing_spendPolicies_create',
    arguments: { path: { account_id: accountId }, body }
  }),
  update: (accountId, ref, body) => ({
    name: 'billing_spendPolicies_update',
    arguments: { path: { account_id: accountId, policy_id: ref.id }, headers: ifMatch(ref), body }
  }),
  remove: (accountId, ref) => ({
    name: 'billing_spendPolicies_delete',
    arguments: { path: { account_id: accountId, policy_id: ref.id }, headers: ifMatch(ref) }
  }),
  request: (accountId, body) =>
    `POST /accounts/${accountId}/billing/spend-policies\n${JSON.stringify(body, null, 2)}`
}

/** What the threshold counts, for the slider and the sentences that name it. */
export interface Unit {
  /** `'requests'`. Shown after a number: "about 800 million requests". */
  readonly noun: string
  /** How a value is written: a count ("1.35B"), bytes ("1.5 TB") or cents ("$50"). */
  readonly format: UnitFormat
}

/**
 * What happens when the number passes the line, and the card's words for it.
 * A preset with one action shows no choice; with more, the card asks which.
 */
export interface PresetAction {
  /** `alert`, or a spend policy's `notification` / `usage_block`. */
  readonly id: string
  /** The choice, when there is one: "Email me", "Stop Workers". */
  readonly label: string
  /** Under the choice, what it means in a few words: "Workers keep running". */
  readonly hint: string
  /** The card's title: what the setting does, in the user's words. */
  readonly title: string
  /** The button: "Create alert", "Set limit". */
  readonly create: string
  /** The button on a setting this card made: "Save alert". */
  readonly save: string
  /** The done line: "Alert on", "Limit on". */
  readonly done: string
  /** What the card made, in a sentence: "alert", "spending limit". */
  readonly noun: string
  /** The over-the-line warning: what happens if it is already over. */
  readonly alreadyOver: string
  /** A consequence the card must say before Create, such as stopping every Worker. */
  readonly caution?: string
  /** What the setting does, for the model: "emails a@b.c", "stops Workers and emails a@b.c". */
  does(email: string): string
}

/** The view's copy. */
export interface PresetCopy {
  /** The setting, in a sentence: "Workers usage alert". */
  readonly label: string
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
  /** What didn't answer when the read failed: "Workers analytics". */
  readonly source: string
  /** The card's message when the account can't have the setting: it replaces the chart and the form. */
  readonly unavailable: { readonly title: string; readonly body: string }
  /** The empty card's body when there is no history at all: what will fill the chart. */
  readonly noHistory: string
}

export interface ThresholdAlertPreset {
  readonly id: PresetId
  /** The tool that serves it; also how `updateModelContext` names the App. */
  readonly toolName: string
  /** Where Create writes, and with which generated tools. */
  readonly target: WriteTarget
  /** A notification policy's `alert_type`, which `available_alerts` must list; `null` for a spend policy. */
  readonly alertType: string | null
  readonly cadence: Cadence
  readonly unit: Unit
  readonly copy: PresetCopy
  /** What can happen at the line, the default first. */
  readonly actions: readonly [PresetAction, ...Array<PresetAction>]
  /** What Create sends, for the chosen action. */
  policy(accountId: string, limit: number, email: string, action: string): PolicyBody
  /** The setting's stored name, from the formatted threshold. */
  name(limit: string, action: string): string
  /** What the setting waits for, in a sentence for the model: "Workers requests pass 1,000,000 in 7 days". */
  passes(limit: number): string
  /** Whether a setting on the account is one of this preset's: its kind and threshold. */
  recognise(setting: ListedSetting): { readonly kind: ExistingKind; readonly limit: number } | null
}

/** The action a choice names, or the default. */
export const actionOf = (preset: ThresholdAlertPreset, id?: string): PresetAction =>
  preset.actions.find((a) => a.id === id) ?? preset.actions[0]

/** The one action of a notification-policy preset: an email. */
function emailAction(title: string, alreadyOver: string): PresetAction {
  return {
    id: 'alert',
    label: 'Email me',
    hint: 'Only emails',
    title,
    create: 'Create alert',
    save: 'Save alert',
    done: 'Alert on',
    noun: 'alert',
    alreadyOver,
    does: (email) => `emails ${email}`
  }
}

const first = (policy: ListedPolicy, key: string) => Number(policy.filters?.[key]?.[0])
const asAlerting = (setting: ListedSetting) =>
  setting.target === 'alerting_policy' ? setting : undefined

// ── workers-requests-monitor: an hourly custom_analytics monitor on 7 days ──

/** The SQL the monitor runs every hour. Its daily counts match the GraphQL read. */
export function monitorQuery(accountId: string): string {
  return `SELECT COUNT(*) AS value
FROM events.workersInvocations
WHERE accountTag = '${accountId}'
  AND timestamp >= NOW() - INTERVAL '7' DAY`
}

/** The `custom_analytics` policy the Workers usage alert shows and, on Create alert, creates. */
export function monitorPolicy(
  accountId: string,
  limit: number,
  email: string,
  name: string
): AlertingPolicyBody {
  return {
    name,
    alert_type: 'custom_analytics',
    enabled: true,
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

const monitorName = (limit: string) => `Workers requests over ${limit} in 7 days`

export const WORKERS_REQUESTS_MONITOR: ThresholdAlertPreset = {
  id: 'workers-requests-monitor',
  toolName: 'workers_usage_alert',
  target: ALERTING_POLICY,
  alertType: 'custom_analytics',
  cadence: ROLLING_7_DAYS,
  unit: WORKERS_REQUESTS,
  copy: {
    label: 'Workers usage alert',
    chartLabel: 'Workers requests per week, with the 7-day alert threshold',
    sliderLabel: 'Alert threshold, requests in 7 days',
    per: 'in 7 days',
    bucket: 'week',
    current: 'Last 7 days',
    source: 'Workers analytics',
    unavailable: {
      title: 'Usage alerts aren’t on this plan',
      body: 'This account can’t create custom analytics alerts, so there’s nothing to set up here.'
    },
    noHistory:
      'Normal weeks show up here once your Workers get requests. Until then, tell me a number in chat.'
  },
  actions: [
    emailAction(
      'Email me when 7 days of Workers requests pass the line',
      'Already over: emails within the hour'
    )
  ],
  policy: (accountId, limit, email) =>
    monitorPolicy(accountId, limit, email, monitorName(policyNumber(limit, 'count'))),
  name: monitorName,
  passes: (limit) => `Workers requests pass ${limit.toLocaleString('en')} in 7 days`,
  recognise: (setting) => {
    const policy = asAlerting(setting)
    return policy?.alert_type === 'custom_analytics' &&
      policy.filters?.selectors?.some((sql) => /\bevents\.workersInvocations\b/i.test(sql))
      ? { kind: 'monitor', limit: first(policy, 'alert_trigger_preferences_value') }
      : null
  }
}

// ── workers-requests-billing: a billing_usage_alert on worker_requests ──

/** The `billing_usage_alert` product for Workers requests, as the dashboard's Usage Based Billing form sends it. */
export const WORKER_REQUESTS_PRODUCT = 'worker_requests'

/** A `billing_usage_alert` on one Usage Based Billing product, as the dashboard's form sends it. */
export function billingUsagePolicyFor(
  product: string,
  limit: number,
  email: string,
  name: string
): AlertingPolicyBody {
  return {
    name,
    alert_type: 'billing_usage_alert',
    enabled: true,
    filters: { product: [product], limit: [String(limit)] },
    mechanisms: { email: [{ id: email }] }
  }
}

/** Whether a setting is a `billing_usage_alert` on `product`, and its limit. */
const billingUsageOn = (product: string) => (setting: ListedSetting) => {
  const policy = asAlerting(setting)
  return policy?.alert_type === 'billing_usage_alert' && policy.filters?.product?.includes(product)
    ? { kind: 'billing' as const, limit: first(policy, 'limit') }
    : null
}

const billingName = (limit: string) => `Billed Workers requests over ${limit}`

export const WORKERS_REQUESTS_BILLING: ThresholdAlertPreset = {
  id: 'workers-requests-billing',
  toolName: 'workers_billing_alert',
  target: ALERTING_POLICY,
  alertType: 'billing_usage_alert',
  cadence: CALENDAR_MONTH,
  unit: WORKERS_REQUESTS,
  copy: {
    label: 'Workers billing usage alert',
    chartLabel: 'Workers requests per month, with the billing usage threshold',
    sliderLabel: 'Alert threshold, billed requests in a billing period',
    per: 'in a billing period',
    bucket: 'month',
    current: 'This month',
    source: 'Workers analytics',
    unavailable: {
      title: 'Billing alerts aren’t on this plan',
      body: 'This account can’t create usage-based billing alerts, so there’s nothing to set up here.'
    },
    noHistory:
      'Normal months show up here once your Workers get requests. Until then, tell me a number in chat.'
  },
  actions: [
    emailAction(
      'Email me when billed Workers requests pass the line',
      'Likely over this month: emails once billing counts it'
    )
  ],
  policy: (_accountId, limit, email) =>
    billingUsagePolicyFor(
      WORKER_REQUESTS_PRODUCT,
      limit,
      email,
      billingName(policyNumber(limit, 'count'))
    ),
  name: billingName,
  passes: (limit) => `Workers requests pass ${limit.toLocaleString('en')} in a billing period`,
  recognise: billingUsageOn(WORKER_REQUESTS_PRODUCT)
}

// ── r2-storage-billing: a billing_usage_alert on r2_storage ──

/**
 * The `billing_usage_alert` product for R2 storage, as the dashboard's Usage
 * Based Billing form sends it. Its limit is in bytes ("bytes of storage").
 */
export const R2_STORAGE_PRODUCT = 'r2_storage'

const R2_STORAGE: Unit = { noun: 'of storage', format: 'bytes' }

const r2Name = (limit: string) => `Billed R2 storage over ${limit}`

/**
 * R2 storage bills in GB-months: the average of each day's peak over the
 * billing period. Each day of history is that day's peak ÷ 30, so a month's
 * total is what billing counts, and the monthly cadence is billing's rule.
 */
export const R2_STORAGE_BILLING: ThresholdAlertPreset = {
  id: 'r2-storage-billing',
  toolName: 'r2_storage_alert',
  target: ALERTING_POLICY,
  alertType: 'billing_usage_alert',
  cadence: CALENDAR_MONTH,
  unit: R2_STORAGE,
  copy: {
    label: 'R2 storage billing alert',
    chartLabel:
      'R2 Standard storage by month, averaged as billing counts it, with the alert threshold',
    sliderLabel: 'Alert threshold, average R2 storage in a billing period',
    per: 'averaged over a billing period',
    bucket: 'month',
    current: 'Billed so far',
    source: 'R2 analytics',
    unavailable: {
      title: 'Billing alerts aren’t on this plan',
      body: 'This account can’t create usage-based billing alerts, so there’s nothing to set up here.'
    },
    noHistory:
      'Normal months show up here once your R2 buckets hold data. Until then, tell me a number in chat.'
  },
  actions: [
    emailAction(
      'Email me when billed R2 storage passes the line',
      'Likely over this month: emails once billing counts it'
    )
  ],
  policy: (_accountId, limit, email) =>
    billingUsagePolicyFor(R2_STORAGE_PRODUCT, limit, email, r2Name(policyNumber(limit, 'bytes'))),
  name: r2Name,
  passes: (limit) =>
    `billed R2 storage passes ${policyNumber(limit, 'bytes')} (${limit.toLocaleString('en')} bytes, averaged over a billing period)`,
  recognise: billingUsageOn(R2_STORAGE_PRODUCT)
}

// ── workers-spend: a spend policy on Workers, an email alert or a spending limit ──

/** The products a spend policy takes. */
export type SpendProduct = 'workers' | 'durable_objects'
/** A spend policy's `action`: email at 80% and 100%, or also block the product at 100%. */
export type SpendAction = 'notification' | 'usage_block'

const DOLLARS: Unit = { noun: 'in Workers charges', format: 'cents' }

const spendName = (limit: string, action: string) =>
  action === 'usage_block' ? `Workers spending limit ${limit}` : `Workers spend over ${limit}`

/**
 * A spend policy on Workers: requests and CPU time charged in the current
 * billing period, after included usage, in US cents. The chart is the
 * billable usage cost of the Workers product family by day, so a month's bar
 * is what the policy counts. `notification` emails at 80% and 100%;
 * `usage_block` also stops new Worker invocations at 100% until the next
 * billing period or until the limit changes.
 */
export const WORKERS_SPEND: ThresholdAlertPreset = {
  id: 'workers-spend',
  toolName: 'workers_spend_limit',
  target: SPEND_POLICY,
  alertType: null,
  cadence: CALENDAR_MONTH,
  unit: DOLLARS,
  copy: {
    label: 'Workers spend policy',
    chartLabel: 'Workers usage charges by month, with the spend threshold',
    sliderLabel: 'Spend threshold, Workers usage charges in a billing period',
    per: 'in a billing period',
    bucket: 'month',
    current: 'This month',
    source: 'Billable usage',
    unavailable: {
      title: 'Spend limits aren’t on this account',
      body: 'Spending limits and alerts are for pay-as-you-go accounts on Workers Paid, so there’s nothing to set up here.'
    },
    noHistory:
      'Monthly charges show up here once your Workers go past the included usage. Until then, tell me an amount in chat.'
  },
  actions: [
    {
      id: 'notification',
      label: 'Email me',
      hint: 'Workers keep running',
      title: 'Email me when Workers charges pass the line',
      create: 'Create alert',
      save: 'Save alert',
      done: 'Alert on',
      noun: 'spend alert',
      alreadyOver: 'Already over: emails once billing counts it',
      does: (email) => `emails ${email} at 80% and 100%`
    },
    {
      id: 'usage_block',
      label: 'Stop Workers',
      hint: 'Blocks new requests',
      title: 'Stop Workers when charges pass the line',
      create: 'Set limit',
      save: 'Save limit',
      done: 'Limit on',
      noun: 'spending limit',
      alreadyOver: 'Already over: Workers stop once it’s evaluated',
      caution:
        'At the line, every Worker on this account stops taking new requests until the next billing period.',
      does: (email) =>
        `stops new Worker invocations on the account at 100% and emails ${email} at 80% and 100%`
    }
  ],
  policy: (_accountId, limit, email, action) => {
    const spend: SpendAction = action === 'usage_block' ? 'usage_block' : 'notification'
    return {
      name: spendName(policyNumber(limit, 'cents'), spend),
      product_id: 'workers',
      enabled: true,
      threshold_cents: Math.round(limit),
      action: spend,
      notification_email: email
    }
  },
  name: spendName,
  passes: (limit) =>
    `Workers usage charges pass ${exactNumber(limit, 'cents')} in a billing period`,
  recognise: (setting) =>
    setting.target === 'spend_policy' && setting.product_id === 'workers'
      ? {
          kind: setting.action === 'usage_block' ? 'spend_limit' : 'spend_alert',
          limit: setting.threshold_cents
        }
      : null
}

/** Every registered preset, by id. */
export const PRESETS: Readonly<Record<PresetId, ThresholdAlertPreset>> = {
  'workers-requests-monitor': WORKERS_REQUESTS_MONITOR,
  'workers-requests-billing': WORKERS_REQUESTS_BILLING,
  'r2-storage-billing': R2_STORAGE_BILLING,
  'workers-spend': WORKERS_SPEND
}

/** Which preset's setting a listed one is, if any, among `presets`. */
export function recogniseAmong(
  presets: ReadonlyArray<ThresholdAlertPreset>,
  setting: ListedSetting
) {
  for (const preset of presets) {
    const hit = preset.recognise(setting)
    if (hit) {
      return hit
    }
  }
  return null
}
