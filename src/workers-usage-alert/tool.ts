import { z } from 'zod'
import { autoResolvedAccountId, missingAccountMessage } from '../auth/account-access'
import type { AuthProps } from '../auth/types'
import { defineMcpApp, type AppContext, type AppOutcome } from '../mcp-apps/define'
import { ApiReadError, ApiReadUnsupported, apiReader } from '../mcp-apps/api-read'
import {
  USAGE_ALERT_RESOURCE_URI,
  USAGE_ALERT_TOOL_CONFIG,
  UsageAlertInputSchema,
  UsageAlertPreviewSchema,
  WORKER_REQUESTS_PRODUCT,
  type UsageAlertInput,
  type UsageAlertPreview
} from './contract'
import { periodsAsOf, roundLimit } from './periods'
import { appHtml } from './app-html.generated'

/**
 * Daily Workers requests for both periods in one query. Each alias stays within
 * the dataset's widest range, which a single six-week range exceeds.
 */
const DAILY_REQUESTS_QUERY = `query WorkersUsageAlert($account: String!, $previousStart: Date!, $previousEnd: Date!, $currentStart: Date!, $currentEnd: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      previous: workersInvocationsAdaptive(limit: 100, filter: { date_geq: $previousStart, date_leq: $previousEnd }, orderBy: [date_ASC]) {
        sum { requests }
        dimensions { date }
      }
      current: workersInvocationsAdaptive(limit: 100, filter: { date_geq: $currentStart, date_leq: $currentEnd }, orderBy: [date_ASC]) {
        sum { requests }
        dimensions { date }
      }
    }
  }
}`

const DailyRows = z.array(
  z.object({
    sum: z.object({ requests: z.number() }),
    dimensions: z.object({ date: z.iso.date() })
  })
)
const DailyRequestsData = z.object({
  viewer: z.object({
    accounts: z.array(z.object({ previous: DailyRows, current: DailyRows })).max(1)
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

const rows = (list: z.output<typeof DailyRows>): [string, number][] =>
  list.map((row) => [row.dimensions.date, Math.round(row.sum.requests)])

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
  const asOf = input.as_of ?? now.toISOString().slice(0, 10)
  const { current, previous } = periodsAsOf(asOf)
  const reader = apiReader(context, signal, 'workers_usage_alert')
  const limitations = [
    'Months are UTC calendar months; the account’s billing period may start on another day.',
    'Request counts come from Workers analytics, not billing. They are not dollar cost.'
  ]

  // Usage is what the App is about: without it there is nothing to preview.
  let usage: z.output<typeof DailyRequestsData>
  try {
    usage = await reader.graphql(
      DAILY_REQUESTS_QUERY,
      {
        account: accountId,
        previousStart: previous.start,
        previousEnd: previous.end,
        currentStart: current.start,
        currentEnd: current.end
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
        const product = policy.filters?.product ?? []
        if (
          policy.alert_type === 'billing_usage_alert' &&
          product.includes(WORKER_REQUESTS_PRODUCT)
        ) {
          const limit = Number(policy.filters?.limit?.[0])
          return [
            {
              id: policy.id,
              name: policy.name,
              enabled: policy.enabled,
              ...(Number.isFinite(limit) ? { limit } : {})
            }
          ]
        }
        otherPolicies[policy.alert_type] = (otherPolicies[policy.alert_type] ?? 0) + 1
        return []
      })
    : null

  const previousRows = rows(account.previous)
  const previousTotal = previousRows.reduce((sum, [, requests]) => sum + requests, 0)
  if (previousRows.length < previous.days)
    limitations.push(
      `${previous.month} has ${previousRows.length} of ${previous.days} days of data; its total may be low.`
    )

  const preview: UsageAlertPreview = {
    kind: 'workers_usage_alert_preview',
    checkedAt: now.toISOString(),
    accountId,
    ...(accountName(context.props, accountId)
      ? { accountName: accountName(context.props, accountId) }
      : {}),
    ...(context.props.type === 'user_token' ? { userEmail: context.props.user.email } : {}),
    currentMonth: current.month,
    previousMonth: previous.month,
    current: rows(account.current),
    previous: previousRows,
    alertAvailable: available
      ? Object.values(available.result).some((types) =>
          types.some((type) => type.type === 'billing_usage_alert')
        )
      : null,
    existingAlerts,
    otherPolicies,
    ...(previousTotal > 0 ? { suggestedLimit: roundLimit(previousTotal * 1.25) } : {}),
    limitations
  }
  return { ok: true, value: preview, ...(challenge ? { meta: challenge } : {}) }
}

/** The read-only Workers usage alert preview App, served in both tool modes. */
export const workersUsageAlertApp = defineMcpApp({
  name: 'workers_usage_alert',
  ...USAGE_ALERT_TOOL_CONFIG,
  input: UsageAlertInputSchema,
  output: UsageAlertPreviewSchema,
  resource: { uri: USAGE_ALERT_RESOURCE_URI, name: 'Workers usage alert', html: appHtml },
  run: collect
})
