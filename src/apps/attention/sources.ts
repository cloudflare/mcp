import { z } from 'zod'
import { fetchWithRetry } from '../../utils/fetch-retry'
import type { AttentionItem, Severity, Source, UnavailableSource } from './report'

const ALERT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const PAGE_SIZE = 25
const MAX_SERVER_ERROR_ATTEMPTS = 3
const SERVER_ERROR_RETRY_MS = 250

const EnvelopeSchema = z.looseObject({
  success: z.boolean(),
  errors: z.array(z.looseObject({ message: z.string() })).optional(),
  result: z.unknown()
})

const AlertSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  alert_type: z.string().optional(),
  alert_body: z.string().optional(),
  description: z.string().optional(),
  sent: z.string().optional()
})

const SecurityInsightSchema = z.looseObject({
  id: z.string(),
  subject: z.string().optional(),
  issue_type: z.string().optional(),
  issue_class: z.string().optional(),
  severity: z.enum(['Low', 'Moderate', 'Critical']).optional(),
  resolve_text: z.string().optional(),
  resolve_link: z.string().optional(),
  timestamp: z.string().optional()
})

const SecurityResultSchema = z.looseObject({ issues: z.array(SecurityInsightSchema).default([]) })

const WorkersIssueSchema = z.looseObject({
  id: z.string(),
  service: z.string(),
  title: z.string(),
  count: z.number(),
  lastObserved: z.number()
})

export interface FeedRequest {
  apiBase: string
  accessToken: string
  accountId: string
  now: Date
}

export type FeedResult =
  | { ok: true; items: AttentionItem[] }
  | { ok: false; unavailable: UnavailableSource }

class FeedError extends Error {}

const MISSING_PERMISSION: Record<Source, string> = {
  alerts: 'Notifications Read',
  security: 'Account Security Center Insights Read',
  workers: 'Workers Observability Read'
}

const FEED_PATH: Record<Source, string> = {
  alerts: 'alerting/v3/history',
  security: 'security-center/insights',
  workers: 'workers/observability/issues'
}

class PermissionError extends FeedError {}

function missingPermissionReason(source: Source): string {
  return `This token can't read it. Add the ${MISSING_PERMISSION[source]} permission.`
}

async function fetchResult(request: FeedRequest, path: string, query: URLSearchParams) {
  const url = `${request.apiBase}/accounts/${encodeURIComponent(request.accountId)}/${path}?${query}`
  let lastStatus = 0
  for (let attempt = 1; attempt <= MAX_SERVER_ERROR_ATTEMPTS; attempt++) {
    const response = await fetchWithRetry(
      url,
      { headers: { Authorization: `Bearer ${request.accessToken}` } },
      { caller: 'attention_panel' }
    )
    lastStatus = response.status
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel()
      throw new PermissionError(path)
    }
    if (response.status < 500) return parseEnvelope(response)
    await response.body?.cancel()
    if (attempt < MAX_SERVER_ERROR_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, SERVER_ERROR_RETRY_MS * attempt))
    }
  }
  throw new FeedError(`Cloudflare API returned ${lastStatus}`)
}

async function parseEnvelope(response: Response): Promise<unknown> {
  const envelope = EnvelopeSchema.safeParse(await response.json().catch(() => undefined))
  if (!envelope.success) throw new FeedError(`unexpected response (${response.status})`)
  if (!envelope.data.success) {
    const message = envelope.data.errors?.map((error) => error.message).join('; ')
    throw new FeedError(message || `request failed (${response.status})`)
  }
  return envelope.data.result
}

function isoFromEpoch(value: number): string {
  const milliseconds = value < 1e12 ? value * 1000 : value
  return new Date(milliseconds).toISOString()
}

function alertItem(alert: z.infer<typeof AlertSchema>): AttentionItem {
  const title = alert.name || alert.alert_type || 'Notification'
  const detail = alert.alert_body || alert.description || alert.alert_type || ''
  return {
    id: `alert:${alert.id}`,
    source: 'alerts',
    severity: 'warning',
    title,
    detail,
    observedAt: alert.sent,
    followUp: `A Cloudflare notification fired${alert.sent ? ` at ${alert.sent}` : ''}: "${title}". ${detail} Find out what triggered it and whether I need to act.`
  }
}

const SECURITY_SEVERITY: Record<'Low' | 'Moderate' | 'Critical', Severity> = {
  Critical: 'critical',
  Moderate: 'warning',
  Low: 'info'
}

const DASHBOARD_ORIGIN = 'https://dash.cloudflare.com'

function dashboardLink(value: string | undefined, accountId: string): string | undefined {
  if (!value) return undefined
  const resolved = value.startsWith('/')
    ? `${DASHBOARD_ORIGIN}${value.replaceAll(':account_id', encodeURIComponent(accountId))}`
    : value
  if (!URL.canParse(resolved)) return undefined
  const url = new URL(resolved)
  return url.protocol === 'https:' && url.hostname === 'dash.cloudflare.com' ? url.href : undefined
}

const DASHBOARD_TRANSLATION_KEY = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/

function readableText(value: string | undefined): string | undefined {
  return value && !DASHBOARD_TRANSLATION_KEY.test(value) ? value : undefined
}

function securityItem(
  insight: z.infer<typeof SecurityInsightSchema>,
  accountId: string
): AttentionItem {
  const kind = (insight.issue_type ?? 'security insight').replaceAll('_', ' ')
  const subject = insight.subject ?? 'this account'
  const detail =
    readableText(insight.resolve_text) || insight.issue_class?.replaceAll('_', ' ') || kind
  return {
    id: `security:${insight.id}`,
    source: 'security',
    severity: insight.severity ? SECURITY_SEVERITY[insight.severity] : 'info',
    title: `${kind} on ${subject}`,
    detail,
    observedAt: insight.timestamp,
    link: dashboardLink(insight.resolve_link, accountId),
    followUp: `Cloudflare Security Center flagged ${kind} on ${subject}: ${detail}. Explain the risk and walk me through fixing it.`
  }
}

const COUNT_FORMAT = new Intl.NumberFormat('en-US')

const TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC'
})

function occurrenceText(count: number): string {
  return count === 1 ? 'once' : `${COUNT_FORMAT.format(count)} times`
}

function workersItem(issue: z.infer<typeof WorkersIssueSchema>): AttentionItem {
  const lastSeen = isoFromEpoch(issue.lastObserved)
  const seen = `Seen ${occurrenceText(issue.count)}, last on ${TIME_FORMAT.format(new Date(lastSeen))} UTC.`
  return {
    id: `workers:${issue.id}`,
    source: 'workers',
    severity: 'warning',
    title: `${issue.service}: ${issue.title}`,
    detail: seen,
    observedAt: lastSeen,
    followUp: `Workers Observability detected an issue in the Worker "${issue.service}": "${issue.title}", seen ${issue.count} times, last at ${lastSeen}. Find the cause and suggest a fix.`
  }
}

async function alertItems(request: FeedRequest): Promise<AttentionItem[]> {
  const since = new Date(request.now.getTime() - ALERT_LOOKBACK_MS).toISOString()
  const query = new URLSearchParams({ since, per_page: String(PAGE_SIZE) })
  const result = z
    .array(AlertSchema)
    .nullable()
    .parse(await fetchResult(request, FEED_PATH.alerts, query))
  return (result ?? []).map(alertItem)
}

async function securityItems(request: FeedRequest): Promise<AttentionItem[]> {
  const query = new URLSearchParams({ dismissed: 'false', per_page: String(PAGE_SIZE) })
  const result = SecurityResultSchema.parse(await fetchResult(request, FEED_PATH.security, query))
  return result.issues.map((insight) => securityItem(insight, request.accountId))
}

async function workersItems(request: FeedRequest): Promise<AttentionItem[]> {
  const query = new URLSearchParams({
    status: 'active',
    orderBy: 'lastObserved',
    order: 'desc',
    perPage: String(PAGE_SIZE)
  })
  const result = z
    .array(WorkersIssueSchema)
    .parse(await fetchResult(request, FEED_PATH.workers, query))
  return result.map(workersItem)
}

const FEEDS: Record<Source, (request: FeedRequest) => Promise<AttentionItem[]>> = {
  alerts: alertItems,
  security: securityItems,
  workers: workersItems
}

function reasonFor(source: Source, error: unknown): string {
  if (error instanceof PermissionError) return missingPermissionReason(source)
  if (error instanceof FeedError) return error.message
  if (error instanceof z.ZodError) return 'unexpected response shape'
  return error instanceof Error ? error.message : String(error)
}

export async function loadFeed(source: Source, request: FeedRequest): Promise<FeedResult> {
  try {
    return { ok: true, items: await FEEDS[source](request) }
  } catch (error) {
    return { ok: false, unavailable: { source, reason: reasonFor(source, error) } }
  }
}

export const SOURCES: readonly Source[] = ['alerts', 'security', 'workers']
