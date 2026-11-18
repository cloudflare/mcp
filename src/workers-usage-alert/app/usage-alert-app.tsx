import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Badge, Button, CloudflareLogo, Input } from '@cloudflare/kumo'
import { mountMcpApp } from '../../mcp-apps/app-shell/mount'
import { UsageAlertPreviewSchema, type UsageAlertPreview } from '../contract'
import { roundLimit } from '../periods'
import { compact, crossingDay, cumulative, daysIn, monthLabel, projection } from './forecast'
import './usage-alert.css'

const W = 520
const H = 168
const PL = 32
const PR = 4
const PT = 6
const PB = 20
const PRESETS = [1.1, 1.25, 1.5] as const
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

function UsageAlertCard({ preview: p }: { preview: UsageAlertPreview }) {
  const days = daysIn(p.currentMonth)
  const prev = useMemo(() => cumulative(p.previous), [p.previous])
  const cur = useMemo(() => cumulative(p.current), [p.current])
  const proj = useMemo(() => projection(cur, p.current, days), [cur, p.current, days])
  const prevTotal = prev.at(-1)?.[1] ?? 0
  const curTotal = cur.at(-1)?.[1] ?? 0
  const projected = proj.at(-1)?.[1] ?? curTotal
  const yMax = Math.max(1, Math.ceil((Math.max(prevTotal, projected) * 1.6) / 1e8) * 1e8)
  const minLimit = roundLimit(Math.max(1, prevTotal * 0.25))
  const maxLimit = roundLimit(yMax * 0.95)
  const clamp = (v: number) => Math.max(minLimit, Math.min(maxLimit, roundLimit(v)))

  const [limit, setLimit] = useState(() => clamp(p.suggestedLimit ?? prevTotal * 1.25))
  const [email, setEmail] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const svg = useRef<SVGSVGElement>(null)

  const prevName = monthLabel(p.previousMonth)
  const curName = monthLabel(p.currentMonth)
  const x = (d: number) => PL + ((d - 1) / (31 - 1)) * (W - PL - PR)
  const y = (v: number) => PT + (1 - v / yMax) * (H - PT - PB)
  const path = (pts: readonly [number, number][]) =>
    pts.map(([d, v], i) => `${i ? 'L' : 'M'}${x(d).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  const area = (pts: readonly [number, number][]) =>
    pts.length
      ? `${path(pts)} L${x(pts.at(-1)![0]).toFixed(1)} ${y(0)} L${x(pts[0][0]).toFixed(1)} ${y(0)} Z`
      : ''
  const hy = y(limit)
  const prevHit = crossingDay(prev, limit)
  const curHit = crossingDay([...cur, ...proj.slice(1)], limit)
  const pct = prevTotal ? Math.round((limit / prevTotal - 1) * 20) * 5 : 0
  const vs =
    pct === 0
      ? `equal to ${prevName}`
      : `about ${Math.abs(pct)}% ${pct > 0 ? 'above' : 'below'} ${prevName}`
  const validEmail = EMAIL.test(email.trim())
  const existing = p.existingAlerts ?? []

  const fromPointer = (e: PointerEvent) => {
    const box = svg.current!.getBoundingClientRect()
    const py = ((e.clientY - box.top) / box.height) * H
    setLimit(clamp((1 - (py - PT) / (H - PT - PB)) * yMax))
  }
  const onKey = (e: KeyboardEvent) => {
    if (reviewing) return
    const step = e.shiftKey ? limit * 0.2 : limit * 0.05
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') setLimit(clamp(limit + step))
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') setLimit(clamp(limit - step))
    else if (e.key === 'Home') setLimit(minLimit)
    else if (e.key === 'End') setLimit(maxLimit)
    else return
    e.preventDefault()
  }

  const label = `Alert ~${compact(limit)}`
  const pw = 14 + label.length * 6.4 + 10
  const px = PL + 8
  const py = hy - 22 < PT ? hy + 4 : hy - 22
  const payload = {
    name: `Workers requests above ~${compact(limit)}`,
    alert_type: 'billing_usage_alert',
    enabled: true,
    filters: { product: ['worker_requests'], limit: [String(limit)] },
    mechanisms: { email: [{ id: email.trim() || '<email>' }] }
  }

  return (
    <article className="card" aria-labelledby="usage-title">
      <header>
        <div className="title">
          <CloudflareLogo variant="glyph" className="logo" />
          <strong id="usage-title">Workers usage alert</strong>
        </div>
        <Badge appearance="dot" variant="neutral">
          {p.accountName ?? p.accountId}
        </Badge>
      </header>
      <div className="body">
        <div className="legend">
          {[
            ['var(--chart-blue)', `${curName} so far`, curTotal, ''],
            ['var(--chart-disabled)', `${prevName} total`, prevTotal, ''],
            ['var(--chart-warning)', 'Alert at', limit, 'dash']
          ].map(([color, name, value, cls]) => (
            <div className="lg" key={name as string}>
              <div className="k">
                <span className={`dot ${cls}`} style={{ background: color as string }} />
                {name}
              </div>
              <div className="v">
                <b>{compact(value as number)}</b>
                <span>req</span>
              </div>
            </div>
          ))}
        </div>
        <svg
          ref={svg}
          className="chart"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Cumulative Workers requests. ${prevName} total ${compact(prevTotal)}. ${curName} ${compact(curTotal)} after ${cur.length} days. Alert threshold about ${compact(limit)}.`}
          onPointerMove={(e) => e.buttons === 1 && !reviewing && fromPointer(e)}
        >
          <defs>
            <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#4290F0" stopOpacity=".4" />
              <stop offset="1" stopColor="#4290F0" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3, 4].map((i) => {
            const v = (yMax / 4) * i
            return (
              <g key={i}>
                <line
                  x1={PL}
                  x2={W - PR}
                  y1={y(v)}
                  y2={y(v)}
                  stroke="var(--chart-grid)"
                  strokeDasharray={i ? '3 3' : undefined}
                />
                <text x={PL - 6} y={y(v) + 4} textAnchor="end" className="tick">
                  {i ? compact(v) : '0'}
                </text>
              </g>
            )
          })}
          {[
            [1, 'Day 1', 'start'],
            [15, '15', 'middle'],
            [days, String(days), 'end']
          ].map(([d, t, anchor]) => (
            <text
              key={t}
              x={x(d as number)}
              y={H - 4}
              textAnchor={anchor as 'start' | 'middle' | 'end'}
              className="tick"
            >
              {t}
            </text>
          ))}
          <rect
            x={PL}
            y={PT}
            width={W - PL - PR}
            height={Math.max(0, hy - PT)}
            fill="var(--chart-warning)"
            opacity=".07"
          />
          <path d={path(prev)} fill="none" stroke="var(--chart-disabled)" strokeWidth="2" />
          <path d={area(cur)} fill="url(#g)" />
          <path
            d={path(proj)}
            fill="none"
            stroke="var(--chart-blue)"
            strokeWidth="2"
            strokeDasharray="5 4"
          />
          <path d={path(cur)} fill="none" stroke="var(--chart-blue)" strokeWidth="2" />
          {prevHit && (
            <circle
              cx={x(prevHit)}
              cy={hy}
              r="3.5"
              fill="var(--color-kumo-base)"
              stroke="var(--chart-disabled)"
              strokeWidth="2"
            />
          )}
          <line
            x1={PL}
            x2={W - PR}
            y1={hy}
            y2={hy}
            stroke="var(--chart-warning)"
            strokeWidth="1.5"
            strokeDasharray="6 4"
          />
          <g
            className="handle"
            tabIndex={reviewing ? -1 : 0}
            role="slider"
            aria-label="Alert threshold"
            aria-orientation="vertical"
            aria-valuemin={minLimit}
            aria-valuemax={maxLimit}
            aria-valuenow={limit}
            aria-valuetext={`About ${compact(limit)} requests`}
            aria-disabled={reviewing}
            onKeyDown={onKey}
            onPointerDown={(e) => {
              if (reviewing) return
              svg.current?.setPointerCapture(e.pointerId)
              fromPointer(e)
            }}
          >
            <rect x={PL} y={hy - 12} width={W - PL - PR} height="24" fill="transparent" />
            <rect className="pill" x={px} y={py} width={pw} height="18" rx="9" />
            <path
              d={`M${px + 9} ${py + 6} l3 -3 l3 3 M${px + 9} ${py + 12} l3 3 l3 -3`}
              fill="none"
              stroke="var(--chart-warning)"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <text x={px + 21} y={py + 13} className="pill-text">
              {label}
            </text>
          </g>
        </svg>
        <div className="pills" role="group" aria-label="Alert threshold presets">
          <span className="lbl">Alert when</span>
          {PRESETS.map((m, i) => {
            const value = clamp(prevTotal * m)
            return (
              <button
                key={m}
                type="button"
                className="pill-btn"
                aria-pressed={value === limit}
                disabled={reviewing}
                onClick={() => setLimit(value)}
              >
                {Math.round((m - 1) * 100)}% over{i === 0 ? ` ${prevName}` : ''}
              </button>
            )
          })}
        </div>
        <p className="summary" aria-live="polite">
          Emails you at <b>~{compact(limit)} requests</b>, {vs}.{' '}
          {prevHit
            ? `${prevName} would have triggered it on ${prevName} ${prevHit}.`
            : `${prevName} never reached it.`}{' '}
          {curHit
            ? `${curName} is on track to reach it around ${curName} ${curHit}.`
            : `${curName} is on track for ${compact(projected)}.`}{' '}
          This alert doesn’t block traffic.
        </p>
        {existing.length > 0 && (
          <p className="subtle">
            Existing Workers request alert{existing.length > 1 ? 's' : ''}:{' '}
            {existing
              .map(
                (a) =>
                  `${a.name}${a.limit ? ` (~${compact(a.limit)})` : ''}${a.enabled ? '' : ', disabled'}`
              )
              .join('; ')}
            .
          </p>
        )}
        {p.alertAvailable === false && (
          <p role="alert" className="warn">
            This account can’t create billing usage alerts.
          </p>
        )}
        <div className="foot">
          <Input
            aria-label="Email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            value={email}
            disabled={reviewing}
            aria-invalid={email !== '' && !validEmail}
            onChange={(e) => setEmail(e.target.value)}
          />
          {reviewing ? (
            <Button variant="secondary" onClick={() => setReviewing(false)}>
              Back
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!validEmail || p.alertAvailable === false}
              onClick={() => setReviewing(true)}
            >
              Review alert
            </Button>
          )}
        </div>
        {reviewing && (
          <section aria-label="Alert to create" className="review">
            <p className="subtle">
              Creating alerts from this card isn’t available yet. This is the policy it would
              create:
            </p>
            <pre>{`POST /accounts/${p.accountId}/alerting/v3/policies\n${JSON.stringify(payload, null, 2)}`}</pre>
          </section>
        )}
      </div>
      <p className="observed">
        Cloudflare API · read {new Date(p.checkedAt).toLocaleString()} · read-only.
        {p.limitations.length > 0 && ` ${p.limitations.join(' ')}`}
      </p>
    </article>
  )
}

mountMcpApp({
  name: 'Cloudflare Workers usage alert',
  output: UsageAlertPreviewSchema,
  render: (preview) => <UsageAlertCard key={preview.checkedAt} preview={preview} />,
  copy: {
    pending: 'Reading Workers usage…',
    cancelled: 'Usage check cancelled.',
    malformed: 'Workers usage could not be displayed. Check the tool’s text result.'
  }
})
