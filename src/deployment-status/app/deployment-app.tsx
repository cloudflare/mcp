import { useState } from 'react'
import { mountMcpApp } from '../../mcp-apps/app-shell/mount'
import { Badge, Button, CloudflareLogo } from '@cloudflare/kumo'
import {
  GitBranchIcon,
  GitCommitIcon,
  CheckCircleIcon,
  WarningCircleIcon,
  ClockIcon,
  MinusCircleIcon,
  XCircleIcon
} from '@phosphor-icons/react'
import { DeploymentStatusSchema, type DeploymentStatus } from '../contract'
import './deployment.css'
import { BUILD_STAGES } from '../stages'

const labels: Record<DeploymentStatus['state'], string> = {
  live: 'Deployed',
  partial: 'Partially live',
  not_live: 'Not live',
  building: 'Building',
  queued: 'Queued',
  failed: 'Build failed',
  cancelled: 'Build stopped',
  no_builds: 'No build history',
  unverified: 'Unverified'
}
function StatusCard({ status: s }: { status: DeploymentStatus }) {
  const [details, setDetails] = useState(false)
  const [copy, setCopy] = useState('')
  const build = s.build,
    meta = build?.build_trigger_metadata
  const success = s.state === 'live',
    failed = s.state === 'failed'
  const summary = JSON.stringify(s, null, 2)
  const stages = BUILD_STAGES.map(([type, label]) => {
    const event = s.events.find((e) => e.type === type)
    const seconds =
      event?.started_on && event.ended_on
        ? Math.round((Date.parse(event.ended_on) - Date.parse(event.started_on)) / 1000)
        : undefined
    const state = !event?.started_on
      ? 'unknown'
      : failed && s.failureStage === type
        ? 'failed'
        : s.state === 'cancelled' || (failed && !s.failureStage)
          ? 'unknown'
          : seconds !== undefined && seconds >= 0
            ? event?.started_on === event?.ended_on
              ? 'skipped'
              : 'complete'
            : build?.status !== 'stopped'
              ? 'pending'
              : 'unknown'
    return {
      label,
      time: event?.started_on,
      state,
      value:
        state === 'skipped'
          ? 'Skipped'
          : seconds !== undefined && seconds >= 0
            ? seconds >= 60
              ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
              : `${seconds}s`
            : state === 'pending'
              ? 'In progress'
              : 'Unavailable'
    }
  })
  return (
    <article className="card" aria-label={`${s.worker} deployment status`}>
      <header>
        <div className="title">
          <CloudflareLogo variant="glyph" className="logo" />
          <strong>{s.worker}</strong>
        </div>
        <Badge appearance="dot" variant={success ? 'success' : failed ? 'error' : 'neutral'}>
          {failed && s.failureStage === 'deploying' ? 'Deployment failed' : labels[s.state]}
        </Badge>
      </header>
      <div className="receipt">
        <section className="body">
          {meta && (
            <div className="metadata">
              {meta.branch && (
                <span>
                  <GitBranchIcon aria-hidden="true" />
                  {meta.branch}
                </span>
              )}
              {meta.commit_hash && (
                <span>
                  <GitCommitIcon aria-hidden="true" />
                  <code>{meta.commit_hash.slice(0, 7)}</code>
                </span>
              )}
              <span>Workers Builds</span>
            </div>
          )}
          {meta?.commit_message && (
            <h2 className="subject">{meta.commit_message.split('\n')[0]}</h2>
          )}
          {meta?.author && <p className="subtle author">by {meta.author}</p>}
          {s.state !== 'live' && (
            <div className={`outcome ${failed ? 'failed' : ''}`}>
              <WarningCircleIcon aria-hidden="true" />
              <p>{s.message}</p>
            </div>
          )}
          {build && (
            <ol role="list" aria-label="Build progress" className="stages">
              {stages.map((stage) => (
                <li key={stage.label} data-state={stage.state}>
                  <p className="stage-label">{stage.label}</p>
                  <div className="stage-track">
                    <span>{stage.value}</span>
                    {stage.state === 'complete' ? (
                      <CheckCircleIcon weight="fill" aria-label="Completed" />
                    ) : stage.state === 'failed' ? (
                      <XCircleIcon weight="fill" aria-label="Failed" />
                    ) : stage.state === 'pending' ? (
                      <ClockIcon aria-label="Pending" />
                    ) : (
                      <MinusCircleIcon aria-label="Not verified" />
                    )}
                  </div>
                  <p className="stage-time">
                    {stage.time
                      ? new Date(stage.time).toLocaleTimeString(undefined, {
                          hour12: false,
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                          fractionalSecondDigits: 3
                        })
                      : 'Timing unavailable'}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>
        <footer>
          <span className="traffic-summary">
            {success ? (
              <CheckCircleIcon weight="fill" className="confirmed" aria-hidden="true" />
            ) : (
              <WarningCircleIcon aria-hidden="true" />
            )}
            {meta?.commit_hash && <code>{meta.commit_hash.slice(0, 7)}</code>}
            {s.traffic !== undefined
              ? `${s.traffic}% traffic linked to this build`
              : 'Active deployment not verified for this build'}
          </span>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={details}
            aria-controls="deployment-details"
            onClick={() => setDetails(!details)}
          >
            {details ? 'Hide evidence' : 'View evidence'}
          </Button>
        </footer>
        {details && (
          <section id="deployment-details" className="details">
            <dl>
              {[
                ['Build', build?.build_uuid],
                ['Deployment', s.deploymentId],
                ['Checked at', s.checkedAt],
                ...s.versions.map((v) => ['Active version', `${v.id} · ${v.percentage}%`])
              ].map(
                ([k, v], i) =>
                  v && (
                    <div key={i}>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  )
              )}
            </dl>
            {s.limitations.map((l, i) => (
              <p key={i} className="subtle">
                {l}
              </p>
            ))}
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(summary)
                  setCopy('Summary copied.')
                } catch {
                  setCopy('Could not copy. Select the summary below.')
                }
              }}
            >
              Copy status summary
            </Button>
            <p role="status">{copy}</p>
            {copy.startsWith('Could') && <pre>{summary}</pre>}
          </section>
        )}
      </div>
      <p className="observed">
        Cloudflare API · checked {new Date(s.checkedAt).toLocaleString()} · read-only. Website
        availability not checked.
      </p>
    </article>
  )
}
mountMcpApp({
  name: 'Cloudflare deployment status',
  output: DeploymentStatusSchema,
  render: (status) => <StatusCard key={status.checkedAt} status={status} />,
  copy: {
    pending: 'Checking deployment status…',
    cancelled: 'Deployment check cancelled.',
    malformed: 'Deployment status could not be displayed. Check the tool’s text result.'
  }
})
