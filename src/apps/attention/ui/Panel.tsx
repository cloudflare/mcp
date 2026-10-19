import { useEffect, useMemo, useState } from 'react'
import { Alert } from '@openai/apps-sdk-ui/components/Alert'
import { Badge } from '@openai/apps-sdk-ui/components/Badge'
import { Button } from '@openai/apps-sdk-ui/components/Button'
import { EmptyMessage } from '@openai/apps-sdk-ui/components/EmptyMessage'
import { applyDocumentTheme } from '@openai/apps-sdk-ui/theme'
import type { CallToolResult } from '@modelcontextprotocol/server'
import type { AttentionItem, AttentionReport, Severity, Source } from '../report'
import { HostBridge, type HostContext } from './host'

const SOURCE_LABEL: Record<Source, string> = {
  alerts: 'Alert',
  security: 'Security',
  workers: 'Workers'
}

const SOURCE_NAME: Record<Source, string> = {
  alerts: 'Alerts',
  security: 'Security insights',
  workers: 'Workers issues'
}

const SEVERITY_COLOR: Record<Severity, 'danger' | 'warning' | 'secondary'> = {
  critical: 'danger',
  warning: 'warning',
  info: 'secondary'
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'report'; report: AttentionReport }
  | { kind: 'message'; text: string }

function isReport(value: unknown): value is AttentionReport {
  if (typeof value !== 'object' || value === null) return false
  return (
    'accountId' in value &&
    typeof value.accountId === 'string' &&
    'items' in value &&
    Array.isArray(value.items) &&
    'unavailable' in value &&
    Array.isArray(value.unavailable)
  )
}

function viewFor(result: CallToolResult): ViewState {
  if (isReport(result.structuredContent))
    return { kind: 'report', report: result.structuredContent }
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join(' ')
  return { kind: 'message', text: text || 'No data' }
}

function applyContext(context: HostContext): void {
  if (context.theme) applyDocumentTheme(context.theme)
  if (context.displayMode) document.body.dataset.displayMode = context.displayMode
}

function ItemRow({ item, bridge }: { item: AttentionItem; bridge: HostBridge }) {
  const [asked, setAsked] = useState(false)

  async function askAgent() {
    setAsked(true)
    try {
      await bridge.sendFollowUp(item.followUp)
    } catch {
      setAsked(false)
    }
  }

  return (
    <li className="attention-item" data-severity={item.severity}>
      <div className="attention-item-body">
        <div className="attention-item-badges">
          <Badge color={SEVERITY_COLOR[item.severity]} variant="soft">
            {item.severity}
          </Badge>
          <Badge color="secondary" variant="outline">
            {SOURCE_LABEL[item.source]}
          </Badge>
        </div>
        <strong className="attention-item-title">{item.title}</strong>
        <p className="attention-item-detail">{item.detail}</p>
      </div>
      <div className="attention-item-actions">
        <Button color="primary" size="sm" disabled={asked} onClick={askAgent}>
          {asked ? 'Asked' : 'Look into this'}
        </Button>
        {item.link ? (
          <Button
            color="secondary"
            variant="outline"
            size="sm"
            onClick={() => bridge.openLink(item.link ?? '').catch(() => undefined)}
          >
            Open in dashboard
          </Button>
        ) : null}
      </div>
    </li>
  )
}

export function Panel() {
  const [view, setView] = useState<ViewState>({ kind: 'loading' })
  const [toolArguments, setToolArguments] = useState<Record<string, unknown>>({})
  const [refreshing, setRefreshing] = useState(false)

  const bridge = useMemo(
    () =>
      new HostBridge({
        onToolInput: setToolArguments,
        onToolResult: (result) => setView(viewFor(result)),
        onContext: applyContext
      }),
    []
  )

  useEffect(() => {
    bridge.connect().catch(() => undefined)
  }, [bridge])

  async function refresh() {
    setRefreshing(true)
    try {
      const args =
        view.kind === 'report'
          ? { ...toolArguments, account_id: view.report.accountId }
          : toolArguments
      setView(viewFor(await bridge.callTool('show_attention', args)))
    } catch {
      setView({
        kind: 'message',
        text: 'Refresh failed. Ask the assistant to run show_attention again.'
      })
    } finally {
      setRefreshing(false)
    }
  }

  const meta =
    view.kind === 'report'
      ? `Account ${view.report.accountId} · ${new Date(view.report.generatedAt).toLocaleTimeString()}`
      : view.kind === 'message'
        ? view.text
        : 'Loading…'

  return (
    <main className="attention-panel" data-attention-build="apps-sdk-ui">
      <header className="attention-header">
        <div>
          <h1 className="attention-heading">What needs attention</h1>
          <p id="meta" className="attention-meta">
            {meta}
          </p>
        </div>
        <Button
          color="secondary"
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={refresh}
        >
          Refresh
        </Button>
      </header>
      {view.kind === 'report' ? (
        <>
          {view.report.unavailable.map((gap) => (
            <Alert
              key={gap.source}
              color="warning"
              variant="soft"
              title={`${SOURCE_NAME[gap.source]} could not be loaded`}
              description={gap.reason}
            />
          ))}
          {view.report.items.length > 0 ? (
            <ul className="attention-list">
              {view.report.items.map((item) => (
                <ItemRow key={item.id} item={item} bridge={bridge} />
              ))}
            </ul>
          ) : view.report.unavailable.length === 0 ? (
            <EmptyMessage>
              <EmptyMessage.Title>Nothing needs attention right now</EmptyMessage.Title>
              <EmptyMessage.Description>
                No recent alerts, open security insights, or active Workers issues.
              </EmptyMessage.Description>
            </EmptyMessage>
          ) : null}
        </>
      ) : null}
    </main>
  )
}
