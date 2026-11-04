import { z } from 'zod'

export const SourceSchema = z.enum(['alerts', 'security', 'workers'])
export type Source = z.infer<typeof SourceSchema>

export const SeveritySchema = z.enum(['critical', 'warning', 'info'])
export type Severity = z.infer<typeof SeveritySchema>

export const AttentionItemSchema = z.strictObject({
  id: z.string(),
  source: SourceSchema,
  severity: SeveritySchema,
  title: z.string(),
  detail: z.string(),
  observedAt: z.string().optional(),
  link: z.string().optional(),
  followUp: z.string()
})
export type AttentionItem = z.infer<typeof AttentionItemSchema>

export const UnavailableSourceSchema = z.strictObject({
  source: SourceSchema,
  reason: z.string()
})
export type UnavailableSource = z.infer<typeof UnavailableSourceSchema>

export const AttentionReportSchema = z.strictObject({
  accountId: z.string(),
  generatedAt: z.string(),
  items: z.array(AttentionItemSchema),
  unavailable: z.array(UnavailableSourceSchema)
})
export type AttentionReport = z.infer<typeof AttentionReportSchema>

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }

export function sortItems(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (b.observedAt ?? '').localeCompare(a.observedAt ?? '')
  )
}

const SOURCE_LABEL: Record<Source, string> = {
  alerts: 'Alerts',
  security: 'Security insights',
  workers: 'Workers issues'
}

export function reportText(report: AttentionReport): string {
  const lines = report.items.map(
    (item, index) => `${index + 1}. [${item.severity}] ${item.title}. ${item.detail}`
  )
  const gaps = report.unavailable.map(
    ({ source, reason }) => `${SOURCE_LABEL[source]} could not be loaded: ${reason}`
  )
  const count = report.items.length
  const headline =
    count > 0
      ? `${count} ${count === 1 ? 'thing needs' : 'things need'} attention in account ${report.accountId}:`
      : report.unavailable.length > 0
        ? `Nothing needs attention in the feeds that loaded for account ${report.accountId}.`
        : `Nothing needs attention in account ${report.accountId}.`
  return [headline, ...lines, ...gaps].join('\n')
}
