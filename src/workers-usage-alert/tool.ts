import { z } from 'zod'
import { autoResolvedAccountId, missingAccountMessage } from '../auth/account-access'
import type { AuthProps } from '../auth/types'
import { defineMcpApp, type AppContext, type AppOutcome } from '../mcp-apps/define'
import { ApiReadError, ApiReadUnsupported, apiReader } from '../mcp-apps/api-read'
import {
  USAGE_ALERT_NEXT_STEP,
  USAGE_ALERT_RESOURCE_URI,
  USAGE_ALERT_TOOL_CONFIG,
  UsageAlertInputSchema,
  UsageAlertPreviewSchema,
  type UsageAlertInput,
  type UsageAlertPreview
} from './contract'
import { fillDays, historyWindows, type Window } from './history'
import { clamp, deriveModel, type Day } from './model'
import { appHtml } from './app-html.generated'
import { tools as alertingPolicyTools } from '../generated/forge-mcp/alerting/policies/tools'
import { CREATE_POLICY_TOOL } from './create'

/** Daily Workers requests for each window, as one alias per window in one query. */
function dailyRequestsQuery(windows: readonly Window[]): string {
  const aliases = windows
    .map(
      (_, i) =>
        `      w${i}: workersInvocationsAdaptive(limit: 100, filter: { date_geq: $s${i}, date_leq: $e${i} }, orderBy: [date_ASC]) {
        sum { requests }
        dimensions { date }
      }`
    )
    .join('\n')
  const params = windows.map((_, i) => `$s${i}: Date!, $e${i}: Date!`).join(', ')
  return `query WorkersUsageAlert($account: String!, ${params}) {
  viewer {
    accounts(filter: { accountTag: $account }) {
${aliases}
    }
  }
}`
}

const DailyRows = z.array(
  z.object({
    sum: z.object({ requests: z.number() }),
    dimensions: z.object({ date: z.iso.date() })
  })
)
const DailyRequestsData = z.object({
  viewer: z.object({
    accounts: z.array(z.record(z.string(), DailyRows)).max(1)
  })
})

const AvailableAlerts = z.object({
  result: z.record(z.string(), z.array(z.object({ type: z.string() })))
})

const Policies = z.object({
  result: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      alert_type: z.string(),
      filters: z.record(z.string(), z.array(z.string())).optional()
    })
  )
})

function accountName(props: AuthProps, accountId: string): string | undefined {
  if (props.type === 'account_token')
    return props.account.id === accountId ? props.account.name : undefined
  return props.accounts.find((account) => account.id === accountId)?.name
}

/** Whether a policy watches Workers requests, and how. */
function workersAlertKind(policy: z.output<typeof Policies>['result'][number]) {
  const filters = policy.filters ?? {}
  if (policy.alert_type === 'billing_usage_alert' && filters.product?.includes('worker_requests'))
    return { kind: 'billing' as const, limit: Number(filters.limit?.[0]) }
  if (
    policy.alert_type === 'custom_analytics' &&
    filters.selectors?.some((sql) => /\bevents\.workersInvocations\b/i.test(sql))
  )
    return { kind: 'monitor' as const, limit: Number(filters.alert_trigger_preferences_value?.[0]) }
  return null
}

/** Collects the usage and alerting evidence the preview shows. Read-only. */
async function collect(
  input: UsageAlertInput,
  context: AppContext,
  signal: AbortSignal
): Promise<AppOutcome<UsageAlertPreview>> {
  const accountId = input.account_id ?? autoResolvedAccountId(context.props)
  if (!accountId)
    return { ok: false, text: missingAccountMessage(context.props, 'Use GET /accounts.') }

  const now = new Date()
  const today = input.as_of ?? now.toISOString().slice(0, 10)
  const windows = historyWindows(today)
  const reader = apiReader(context, signal, 'workers_usage_alert')
  const limitations = [
    'Request counts come from Workers analytics, not billing. They are not dollar cost.',
    'Workers analytics keep 89 complete days; older traffic cannot be read.'
  ]

  // Usage is what the App is about: without it there is nothing to preview.
  let usage: z.output<typeof DailyRequestsData>
  try {
    usage = await reader.graphql(
      dailyRequestsQuery(windows),
      {
        account: accountId,
        ...Object.fromEntries(
          windows.flatMap((w, i) => [
            [`s${i}`, w.start],
            [`e${i}`, w.end]
          ])
        )
      },
      'account',
      DailyRequestsData
    )
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof ApiReadError)
      return { ok: false, text: error.text, meta: error.result._meta }
    if (error instanceof ApiReadUnsupported || error instanceof z.ZodError)
      return { ok: false, text: 'Cloudflare returned an unsupported analytics response.' }
    throw error
  }
  const account = usage.viewer.accounts[0]
  if (!account)
    return {
      ok: false,
      text: `No Workers analytics were returned for account ${accountId}. Check the account ID and that the connection can read its analytics.`
    }

  // Alerting reads only add context. A refusal is noted, not fatal, and never
  // reads as "no alerts exist".
  let challenge: Record<string, unknown> | undefined
  const optional = async <T>(read: () => Promise<T>, what: string): Promise<T | null> => {
    try {
      return await read()
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof ApiReadError) {
        challenge ??= error.result._meta
        limitations.push(`${what} could not be read: ${error.text}`)
      } else if (error instanceof ApiReadUnsupported || error instanceof z.ZodError) {
        limitations.push(`${what} could not be read: Cloudflare returned an unsupported response.`)
      } else throw error
      return null
    }
  }
  const prefix = `/accounts/${accountId}/alerting/v3`
  const [available, policies] = await Promise.all([
    optional(
      () => reader.get(`${prefix}/available_alerts`, AvailableAlerts),
      'Available alert types'
    ),
    optional(() => reader.get(`${prefix}/policies`, Policies), 'Existing notification policies')
  ])

  const otherPolicies: Record<string, number> = {}
  const existingAlerts = policies
    ? policies.result.flatMap((policy) => {
        const watch = workersAlertKind(policy)
        if (!watch) {
          otherPolicies[policy.alert_type] = (otherPolicies[policy.alert_type] ?? 0) + 1
          return []
        }
        return [
          {
            id: policy.id,
            name: policy.name,
            enabled: policy.enabled,
            kind: watch.kind,
            ...(Number.isFinite(watch.limit) ? { limit: watch.limit } : {})
          }
        ]
      })
    : null

  const rows: Day[] = Object.values(account).flatMap((list) =>
    list.map((row): Day => [row.dimensions.date, Math.round(row.sum.requests)])
  )
  const days = fillDays(rows, windows)
  const model = deriveModel(days, today)
  if (days.length && days.length < 7)
    limitations.push(
      `Only ${days.length} days of Workers traffic: under a week, so there is no typical week to compare against.`
    )
  const suggestedLimit =
    input.limit != null ? clamp(input.limit, model.minLimit, model.maxLimit) : model.suggested

  const name = accountName(context.props, accountId)
  const preview: UsageAlertPreview = {
    kind: 'workers_usage_alert_preview',
    nextStep: USAGE_ALERT_NEXT_STEP,
    checkedAt: now.toISOString(),
    accountId,
    ...(name ? { accountName: name } : {}),
    ...(context.props.type === 'user_token' ? { userEmail: context.props.user.email } : {}),
    today,
    days,
    summary: {
      typicalWeek: model.typical == null ? null : Math.round(model.typical),
      last7Days: Math.round(model.last7),
      busiestWeek: Math.round(model.peak),
      suggestedLimit: model.typical == null && input.limit == null ? null : suggestedLimit
    },
    alertAvailable: available
      ? Object.values(available.result).some((types) =>
          types.some((type) => type.type === 'custom_analytics')
        )
      : null,
    existingAlerts,
    otherPolicies,
    limitations
  }
  return { ok: true, value: preview, ...(challenge ? { meta: challenge } : {}) }
}

/**
 * The Workers usage alert App, served in both tool modes. Its tool only
 * reads; the view's Create alert button creates the policy.
 */
export const workersUsageAlertApp = defineMcpApp({
  name: 'workers_usage_alert',
  ...USAGE_ALERT_TOOL_CONFIG,
  input: UsageAlertInputSchema,
  output: UsageAlertPreviewSchema,
  resource: { uri: USAGE_ALERT_RESOURCE_URI, name: 'Workers usage alert', html: appHtml },
  // Create alert creates the policy it shows with the generated tool; see `create.ts`.
  appTools: alertingPolicyTools.filter((tool) => tool.name === CREATE_POLICY_TOOL),
  run: collect
})
