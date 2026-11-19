import { useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Button,
  CloudflareLogo,
  Collapsible,
  Input,
  LayerCard,
  Radio,
  Slider
} from '@cloudflare/kumo'
import type { App } from '@modelcontextprotocol/ext-apps'
import { mountMcpApp } from '../../mcp-apps/app-shell/mount'
import {
  UsageAlertPreviewSchema,
  WORKER_REQUESTS_PRODUCT,
  type UsageAlertPreview
} from '../contract'
import { EMAIL, compact, limitAbove, monthName } from './format'
import './usage-alert.css'

const PRESETS = [
  { id: 'p10', name: 'A bit busier', percent: 10 },
  { id: 'p25', name: 'Clearly busier', percent: 25 },
  { id: 'p50', name: 'Way out of hand', percent: 50 }
] as const
type Choice = (typeof PRESETS)[number]['id'] | 'custom'
const SLIDER = { min: 5, max: 100, step: 5 }
const PERCENT = { style: 'unit', unit: 'percent', signDisplay: 'exceptZero' } as const

/**
 * What "Create alert" did. The App never writes: with a host that takes
 * messages it hands the confirmed alert to the chat, where the model proposes
 * the write through a tool the user confirms; otherwise it shows the request
 * it would send.
 */
type Handoff = 'editing' | 'sending' | 'sent' | 'review'

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function UsageAlertCard({ preview: p, app }: { preview: UsageAlertPreview; app: App }) {
  const previousTotal = useMemo(() => p.previous.reduce((sum, [, n]) => sum + n, 0), [p.previous])
  const month = monthName(p.previousMonth)
  const [choice, setChoice] = useState<Choice>('p25')
  const [custom, setCustom] = useState(35)
  const [email, setEmail] = useState(p.userEmail ?? '')
  const [touched, setTouched] = useState(false)
  const [handoff, setHandoff] = useState<Handoff>('editing')
  const emailRef = useRef<HTMLInputElement>(null)
  const doneRef = useRef<HTMLSpanElement>(null)
  const ids = { title: useId(), error: useId(), summary: useId() }

  const percent = choice === 'custom' ? custom : PRESETS.find((o) => o.id === choice)!.percent
  const limit = limitAbove(previousTotal, percent)
  const address = email.trim()
  const validEmail = EMAIL.test(address)
  const invalid = touched && !validEmail
  const locked = handoff !== 'editing'
  const unavailable = p.alertAvailable === false
  const existing = p.existingAlerts ?? []
  const describe = (pct: number) => (
    <>
      <span className="num">~{compact(limitAbove(previousTotal, pct))}</span> requests · {pct}% more
      than {month}
    </>
  )
  const policy = {
    name: `Workers requests ${percent}% over ${month} (~${compact(limit)})`,
    alert_type: 'billing_usage_alert',
    enabled: true,
    filters: { product: [WORKER_REQUESTS_PRODUCT], limit: [String(limit)] },
    mechanisms: { email: [{ id: address }] }
  }
  const request = `POST /accounts/${p.accountId}/alerting/v3/policies\n${JSON.stringify(policy, null, 2)}`

  const settle = (next: Handoff) => {
    setHandoff(next)
    requestAnimationFrame(() => doneRef.current?.focus())
  }
  const submit = async () => {
    setTouched(true)
    if (!validEmail) return emailRef.current?.focus()
    const caps = app.getHostCapabilities()
    if (!caps?.message) return settle('review')
    setHandoff('sending')
    try {
      if (caps.updateModelContext)
        await app.updateModelContext({
          content: [
            {
              type: 'text',
              text: `The user confirmed this Workers usage alert in the workers_usage_alert App. It has not been created. Create it only with a write tool the user confirms:\n${request}`
            }
          ]
        })
      const result = await app.sendMessage({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Create a Workers usage alert on ${p.accountName ?? p.accountId}: email ${address} when Workers requests pass ${limit.toLocaleString('en')} in a billing period (${percent}% more than ${month}).`
          }
        ]
      })
      settle(result.isError ? 'review' : 'sent')
    } catch {
      settle('review')
    }
  }

  return (
    <LayerCard
      className="ld"
      data-locked={locked || undefined}
      render={<section aria-labelledby={ids.title} />}
    >
      <LayerCard.Primary className="ld-primary">
        <div className="ld-head">
          <CloudflareLogo variant="glyph" className="cf" aria-hidden />
          <h2 className="ld-title" id={ids.title}>
            How much busier than {month} before I email you?
          </h2>
        </div>
        <div className="ld-body">
          <Radio.Group<Choice>
            appearance="card"
            className="rg"
            value={choice}
            disabled={locked}
            onValueChange={(next) => {
              if (next === 'custom' && choice !== 'custom') setCustom(percent)
              setChoice(next)
            }}
          >
            <Radio.Legend className="sr-only">Email me when Workers requests are</Radio.Legend>
            {PRESETS.map((o) => (
              <Radio.Item<Choice>
                key={o.id}
                value={o.id}
                label={o.name}
                description={describe(o.percent)}
              />
            ))}
            <Radio.Item<Choice>
              value="custom"
              label="Custom"
              className="rc-custom"
              description={choice === 'custom' ? describe(custom) : 'Pick your own amount'}
            />
            {/* The slider belongs to the Custom card, as in the design. Its arrow
                keys move the slider, not the radio selection. */}
            <div
              className="collapse-panel"
              data-open={choice === 'custom'}
              inert={choice !== 'custom'}
              style={
                {
                  '--thumb-at': (custom - SLIDER.min) / (SLIDER.max - SLIDER.min)
                } as CSSProperties
              }
              onKeyDown={(e) => e.stopPropagation()}
            >
              <div>
                <div className="sl-marks" aria-hidden="true">
                  {PRESETS.map((o) => (
                    <span
                      key={o.id}
                      style={{
                        left: `${((o.percent - SLIDER.min) / (SLIDER.max - SLIDER.min)) * 100}%`
                      }}
                    />
                  ))}
                </div>
                <Slider
                  className="sl"
                  value={custom}
                  min={SLIDER.min}
                  max={SLIDER.max}
                  step={SLIDER.step}
                  largeStep={SLIDER.step * 4}
                  format={PERCENT}
                  disabled={locked}
                  getAriaLabel={() => `Percent more than ${month}`}
                  onValueChange={(v) => setCustom(v as number)}
                />
              </div>
            </div>
          </Radio.Group>
          <p className="sr-only" id={ids.summary} aria-live="polite">
            Emails at about {compact(limit)} Workers requests in a billing period, {percent}% more
            than {month}’s {compact(previousTotal)}. This alert doesn’t block traffic.
          </p>
          {existing.length > 0 && (
            <p className="note">
              Already on this account:{' '}
              {existing
                .map(
                  (a) =>
                    `${a.name}${a.limit ? ` (~${compact(a.limit)})` : ''}${a.enabled ? '' : ', disabled'}`
                )
                .join('; ')}
              .
            </p>
          )}
          {unavailable && (
            <p role="alert" className="note warn">
              This account can’t create billing usage alerts.
            </p>
          )}
        </div>
      </LayerCard.Primary>
      <div className="ld-actions">
        {handoff === 'editing' || handoff === 'sending' ? (
          <>
            <label className="to">
              To
              <Input
                ref={emailRef}
                className="email"
                type="email"
                autoComplete="email"
                spellCheck={false}
                placeholder="name@example.com"
                aria-label="Alert email"
                aria-describedby={ids.error}
                aria-invalid={invalid}
                variant={invalid ? 'error' : 'default'}
                value={email}
                disabled={handoff === 'sending'}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => address && setTouched(true)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </label>
            <Button
              variant="primary"
              loading={handoff === 'sending'}
              disabled={unavailable}
              aria-describedby={ids.summary}
              onClick={submit}
            >
              Create alert
            </Button>
            <p className="err" id={ids.error} hidden={!invalid}>
              Enter a valid email address.
            </p>
          </>
        ) : (
          <>
            <span
              className="saved"
              data-sent={handoff === 'sent'}
              ref={doneRef}
              tabIndex={-1}
              aria-live="polite"
            >
              {handoff === 'sent' ? (
                <>
                  <Check /> Sent to chat to create: emails {address} at ~{compact(limit)} requests.
                </>
              ) : (
                'Creating alerts from here isn’t available yet.'
              )}
            </span>
            <Button
              variant="ghost"
              onClick={() => {
                setHandoff('editing')
                requestAnimationFrame(() => emailRef.current?.focus())
              }}
            >
              Edit
            </Button>
            {handoff === 'review' && (
              <Collapsible className="request-disclosure">
                <Collapsible.DefaultTrigger className="text-sm font-normal text-kumo-subtle">
                  Show request
                </Collapsible.DefaultTrigger>
                <Collapsible.Panel>
                  <pre className="request">{request}</pre>
                </Collapsible.Panel>
              </Collapsible>
            )}
          </>
        )}
      </div>
    </LayerCard>
  )
}

mountMcpApp({
  name: 'Cloudflare Workers usage alert',
  output: UsageAlertPreviewSchema,
  render: (preview, { app }) => (
    <UsageAlertCard key={preview.checkedAt} preview={preview} app={app} />
  ),
  copy: {
    pending: 'Reading Workers usage…',
    cancelled: 'Usage check cancelled.',
    malformed: 'Workers usage could not be displayed. Check the tool’s text result.'
  }
})
