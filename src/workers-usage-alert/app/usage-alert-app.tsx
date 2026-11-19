import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent
} from 'react'
import { Button, CloudflareLogo, Collapsible, LayerCard } from '@cloudflare/kumo'
import type { App } from '@modelcontextprotocol/ext-apps'
import { mountMcpApp } from '../../mcp-apps/app-shell/mount'
import { UsageAlertPreviewSchema, type UsageAlertPreview } from '../contract'
import {
  clamp,
  deriveModel,
  fitTop,
  monitorPolicy,
  replayEmails,
  snapTo,
  stepOf,
  tickOf,
  type Model,
  type Week
} from '../model'
import { EMAIL, fmt, fmtDay, monthShort, sig, words } from './format'
import './usage-alert.css'

/**
 * What "Create alert" did. The App never writes: with a host that takes
 * messages it hands the alert to the chat, where the model proposes the write
 * through a tool the user approves; otherwise it shows the request.
 */
type Phase = 'editing' | 'sending' | 'sent' | 'review'
type Tone = '' | 'hit' | 'now' | 'warn'
type Fact = readonly [Tone, string]

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const canHover = () => matchMedia('(hover: hover) and (pointer: fine)').matches
// Drag past an edge to grow or shrink the axis, like a list scrolling when you drag past its end:
// px zone inside each edge, px to full speed, e-folds per second. Settling eases with time constant TAU (s).
const EDGE = 10
const RAMP = 110
const GROW = 1.8
const TAU = 0.055

/** Two short facts under the title, each sized to fit one line at 320px. */
function outcome(m: Model, limit: number): [Fact, Fact] {
  const sent = replayEmails(m.days, m.rolling, limit)
  const first = sent.find((e) => e.first)
  const past: Fact =
    m.typical && limit < m.typical
      ? ['warn', `Below a typical week (<b>~${sig(m.typical)}</b>)`]
      : sent.length && first
        ? [
            'hit',
            `<b>${sent.length}</b> past ${sent.length === 1 ? 'email' : 'emails'}, first <b>${fmtDay(first.date)}</b>`
          ]
        : limit >= 2 * m.peak
          ? ['', `No past emails; <b>${sig(limit / m.peak)}×</b> busiest week`]
          : ['', `No past emails; busiest week <b>${sig(m.peak)}</b>`]
  const now: Fact =
    m.last7 >= limit
      ? ['warn', 'Already over: emails within the hour']
      : ['now', `Last 7 days: <b>${sig(m.last7)}</b>`]
  return [past, now]
}

function FactLine({ fact }: { fact: Fact }) {
  return (
    <span className="sub-i" data-tone={fact[0]}>
      <i aria-hidden="true" />
      <span dangerouslySetInnerHTML={{ __html: fact[1] }} />
    </span>
  )
}

function tipBody(m: Model, w: Week, limit: number) {
  const from = w.partial ? (m.days.find(([d]) => d >= w.start)?.[0] ?? w.start) : w.start
  const range = `${fmtDay(from)}–${from.slice(0, 7) === w.end.slice(0, 7) ? Number(w.end.slice(8)) : fmtDay(w.end)}`
  const email = replayEmails(m.days, m.rolling, limit).find(
    (e) => e.date >= w.start && e.date <= w.end
  )
  const swatch = w.partial ? 'var(--c-dis)' : w.daysEstimate ? 'var(--c-now)' : 'var(--c-past)'
  return (
    <>
      <div className="tip-h">{range}</div>
      {w.daysActual > 0 && (
        <div className="tip-r">
          <i style={{ background: swatch }} />
          <span>
            {w.daysActual < 7
              ? `${w.daysActual} ${w.daysActual === 1 ? 'day' : 'days'}`
              : w.daysEstimate
                ? 'This week'
                : 'Week'}
          </span>
          <b>{sig(w.rawActual, 3)}</b>
        </div>
      )}
      {w.daysEstimate > 0 && (
        <div className="tip-r">
          <i className="sw-est" />
          <span>Estimate, {w.daysEstimate} days</span>
          <b>~{sig(w.rawEstimate, 3)}</b>
        </div>
      )}
      {w.rolling != null && w.lastDay && (
        <div className="tip-r">
          <i />
          <span>7 days to {fmtDay(w.lastDay)}</span>
          <b>{sig(w.rolling, 3)}</b>
        </div>
      )}
      {email && (
        <div className="tip-e">
          <i />
          {email.first ? 'Would have emailed' : 'Would have emailed again'} {fmtDay(email.date)}
        </div>
      )}
    </>
  )
}

function UsageAlertCard({ preview: p, app }: { preview: UsageAlertPreview; app: App }) {
  const m = useMemo(() => deriveModel(p.days, p.today), [p.days, p.today])
  const ready = m.typical != null
  const [limit, setLimitState] = useState(() =>
    clamp(p.summary.suggestedLimit ?? m.suggested ?? m.minLimit, m.minLimit, m.maxLimit)
  )
  const [entered, setEntered] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [tip, setTip] = useState<number | null>(null)
  const [phase, setPhase] = useState<Phase>('editing')
  const [email, setEmail] = useState(p.userEmail ?? '')
  const [touched, setTouched] = useState(false)
  const ids = { title: useId(), sub: useId(), err: useId() }

  const refs = {
    plot: useRef<HTMLDivElement>(null),
    grid: useRef<HTMLDivElement>(null),
    line: useRef<HTMLDivElement>(null),
    knob: useRef<HTMLDivElement>(null),
    zone: useRef<HTMLDivElement>(null),
    hot: useRef<HTMLDivElement>(null),
    typ: useRef<HTMLDivElement>(null),
    typLabel: useRef<HTMLSpanElement>(null),
    tip: useRef<HTMLDivElement>(null),
    bars: useRef<HTMLDivElement>(null),
    email: useRef<HTMLInputElement>(null),
    done: useRef<HTMLDivElement>(null)
  }
  // The live axis: `top` is drawn, `target` is where it settles; `line` is the drawn line, `limit` the snapped value.
  const A = useRef({
    top: fitTop(m, limit),
    target: fitTop(m, limit),
    line: limit,
    ptr: 0,
    raf: 0,
    last: 0
  })
  const limitRef = useRef(limit)
  const ticks = useRef(new Map<number, HTMLDivElement>())
  const tipRef = useRef<number | null>(null)
  tipRef.current = tip
  const setLimit = (v: number) => {
    limitRef.current = v
    setLimitState(v)
  }

  const locked = !ready || phase !== 'editing'
  const address = email.trim()
  const invalid = touched && !EMAIL.test(address)
  const unavailable = p.alertAvailable === false
  const [past, now] = ready ? outcome(m, limit) : emptyFacts(m)

  // ── Drawing: positions only, with transforms; runs every frame while moving ──
  const placeTip = useCallback(() => {
    const i = tipRef.current
    const el = refs.tip.current
    const plot = refs.plot.current
    if (i == null || !el || !plot) return
    const chart = el.parentElement!
    const col = refs.bars.current?.querySelector<HTMLElement>(`[data-w="${i}"]`)
    if (!col) return
    const c = chart.getBoundingClientRect()
    const r = col.getBoundingClientRect()
    const top = Math.min(
      ...Array.from(col.children, (b) => b.getBoundingClientRect().top),
      r.bottom
    )
    const w = el.offsetWidth
    const h = el.offsetHeight
    const right = r.right + 8 + w <= c.right
    const x = clamp(right ? r.right - c.left + 8 : r.left - c.left - 8 - w, 0, c.width - w)
    const y = clamp((top + r.bottom) / 2 - c.top - h / 2, 0, plot.offsetTop + plot.offsetHeight - h)
    el.style.setProperty('--o', right ? 'left center' : 'right center')
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  }, [])

  const draw = useCallback(() => {
    const plot = refs.plot.current
    if (!plot) return
    const a = A.current
    const px = (v: number) => (v / a.top) * plot.clientHeight
    const p0 = px(a.line)
    plot.style.setProperty('--top', String(a.top / m.base))
    refs.line.current!.style.transform = `translateY(${-p0}px)`
    refs.zone.current!.style.transform = `translateY(${-p0}px)`
    refs.hot.current!.style.clipPath = `inset(0 -4px ${p0}px -4px)`
    // Gridlines keyed by value: lines both scales share stay put, the rest crossfade.
    const grid = refs.grid.current!
    const t = tickOf(a.top)
    const want = new Set<number>()
    for (let k = 1; k * t <= a.top * 1.0001; k++) want.add(k * t)
    for (const [v, el] of ticks.current)
      if (!want.has(v)) {
        ticks.current.delete(v)
        el.setAttribute('data-in', '')
        setTimeout(() => el.remove(), 160)
      }
    for (const v of want) {
      let el = ticks.current.get(v)
      if (!el) {
        el = document.createElement('div')
        el.className = 'hc-grid'
        el.setAttribute('data-in', '')
        const label = document.createElement('span')
        label.textContent = fmt(v)
        el.append(label)
        grid.append(el)
        ticks.current.set(v, el)
        const fresh = el
        requestAnimationFrame(() => requestAnimationFrame(() => fresh.removeAttribute('data-in')))
      }
      const tp = px(v)
      el.style.transform = `translateY(${-tp}px)`
      el.firstElementChild!.toggleAttribute('data-hidden', Math.abs(tp - p0) < 14)
    }
    if (m.typical && refs.typ.current && refs.typLabel.current) {
      const tp = px(m.typical)
      refs.typ.current.style.transform = `translateY(${-tp}px)`
      // The label hangs under its line; near the baseline it sits above instead of on the months.
      const up = tp < 24
      refs.typLabel.current.style.top = up ? '-20px' : ''
      refs.typLabel.current.toggleAttribute(
        'data-hidden',
        up ? p0 > tp - 2 && p0 < tp + 24 : p0 < tp + 2 && p0 > tp - 24
      )
    }
    placeTip()
  }, [m, placeTip])

  const snap = (v: number, top: number) => clamp(snapTo(v, stepOf(top)), m.minLimit, m.maxLimit)

  const dragStep = useCallback(
    (dt: number) => {
      const plot = refs.plot.current!
      const a = A.current
      const r = plot.getBoundingClientRect()
      const over = r.top + EDGE - a.ptr
      const under = a.ptr - (r.bottom - EDGE)
      if (over > 0 && dt)
        a.top = a.target = Math.min(
          m.maxLimit,
          a.top * Math.exp(GROW * Math.min(1, over / RAMP) * dt)
        )
      if (under > 0 && dt)
        a.top = a.target = Math.max(
          m.minTop,
          a.top * Math.exp(-GROW * Math.min(1, under / RAMP) * dt)
        )
      a.line = clamp(clamp((r.bottom - a.ptr) / r.height, 0, 1) * a.top, m.minLimit, m.maxLimit)
      const next = snap(a.line, a.top)
      if (next !== limitRef.current) setLimit(next)
    },
    [m]
  )

  const draggingRef = useRef(false)
  const frame = useCallback(
    (now: number) => {
      const a = A.current
      const dt = Math.min(0.05, (now - a.last) / 1000)
      a.last = now
      a.raf = 0
      let more = draggingRef.current
      if (draggingRef.current) dragStep(dt)
      else {
        const k = reduceMotion() ? 1 : 1 - Math.exp(-dt / TAU)
        a.top += (a.target - a.top) * k
        a.line += (limitRef.current - a.line) * k
        more =
          Math.abs(a.target - a.top) > a.target * 2e-4 ||
          Math.abs(limitRef.current - a.line) > a.top * 2e-4
        if (!more) {
          a.top = a.target
          a.line = limitRef.current
        }
      }
      draw()
      if (more) a.raf = requestAnimationFrame(frame)
    },
    [dragStep, draw]
  )
  const kick = useCallback(() => {
    const a = A.current
    if (!a.raf) {
      a.last = performance.now()
      a.raf = requestAnimationFrame(frame)
    }
  }, [frame])

  useLayoutEffect(() => draw(), [draw, tip, entered])
  useEffect(() => {
    const plot = refs.plot.current
    if (!plot) return
    const ro = new ResizeObserver(() => draw())
    ro.observe(plot)
    // One frame in the loading shape, so the threshold drops in after the bars rise.
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      cancelAnimationFrame(A.current.raf)
    }
  }, [draw])

  // ── Drag: the line follows the pointer 1:1; the value snaps; release glides to the step ──
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (locked || e.button !== 0 || draggingRef.current) return
    e.preventDefault()
    const plot = e.currentTarget
    plot.setPointerCapture(e.pointerId)
    draggingRef.current = true
    setDragging(true)
    setTip(null)
    A.current.target = A.current.top
    const move = (ev: globalThis.PointerEvent) => {
      A.current.ptr = ev.clientY
      dragStep(0)
      draw()
    }
    move(e.nativeEvent)
    kick()
    const up = () => {
      plot.removeEventListener('pointermove', move)
      plot.removeEventListener('pointerup', up)
      plot.removeEventListener('pointercancel', up)
      draggingRef.current = false
      setDragging(false)
      A.current.target = fitTop(m, limitRef.current)
      kick()
      refs.knob.current?.focus({ preventScroll: true })
    }
    plot.addEventListener('pointermove', move)
    plot.addEventListener('pointerup', up)
    plot.addEventListener('pointercancel', up)
  }

  // Keyboard: an arrow is one drag step, Shift or Page a gridline; past the top the axis grows to follow.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (locked || draggingRef.current) return
    const a = A.current
    const big = tickOf(a.target)
    const st = e.shiftKey ? big : stepOf(a.target)
    const L = limitRef.current
    const v = (
      {
        ArrowUp: L + st,
        ArrowRight: L + st,
        ArrowDown: L - st,
        ArrowLeft: L - st,
        PageUp: L + big,
        PageDown: L - big,
        Home: m.minLimit,
        End: m.maxLimit
      } as Record<string, number>
    )[e.key]
    if (v == null) return
    e.preventDefault()
    const s =
      e.key === 'Home' || e.key === 'End' ? 1 : e.key.startsWith('Page') || e.shiftKey ? big : st
    const next = clamp(snapTo(v, s), m.minLimit, m.maxLimit)
    setLimit(next)
    a.line = next
    a.target = fitTop(m, next)
    draw()
    kick()
  }

  // ── Hand-off: editing → sending → sent | review ──
  const name = `Workers requests over ${fmt(limit)} in 7 days`
  const policy = monitorPolicy(p.accountId, limit, address, name)
  const request = `POST /accounts/${p.accountId}/alerting/v3/policies\n${JSON.stringify(policy, null, 2)}`
  const settle = (next: Phase) => {
    setPhase(next)
    requestAnimationFrame(() => refs.done.current?.focus({ preventScroll: true }))
  }
  const submit = async () => {
    if (locked || unavailable) return
    setTouched(true)
    if (!EMAIL.test(address)) return refs.email.current?.focus()
    const caps = app.getHostCapabilities()
    if (!caps?.message) return settle('review')
    setPhase('sending')
    try {
      if (caps.updateModelContext)
        await app.updateModelContext({
          content: [
            {
              type: 'text',
              text: `The user confirmed this Workers usage alert in the workers_usage_alert App. It has not been created. Create it only with a write the user approves, exactly as written:\n${request}`
            }
          ]
        })
      const result = await app.sendMessage({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Create the Workers usage alert on ${p.accountName ?? p.accountId}: email ${address} when Workers requests pass ${limit.toLocaleString('en')} in 7 days.`
          }
        ]
      })
      settle(result.isError ? 'review' : 'sent')
    } catch {
      settle('review')
    }
  }

  const n = m.weeks.length
  const delay = (i: number) => Math.round(260 * Math.sqrt(i / Math.max(1, n - 1)))
  const pct = (d: number) => `${(d / m.span) * 100}%`
  const bars = (hot: boolean) =>
    m.weeks.map((w, i) => (
      <div
        key={w.start}
        className={`hc-col${tip === i ? ' hl' : ''}`}
        {...{ [hot ? 'data-hw' : 'data-w']: i }}
        style={{ left: pct(w.offset), width: pct(7), '--d': `${delay(i)}ms` } as CSSProperties}
      >
        {w.estimate > 0 && (
          <div className="hc-bar est" style={{ '--v': w.estimate / m.base } as CSSProperties} />
        )}
        {w.actual > 0 && (
          <div
            className={`hc-bar${w.partial ? ' partial' : w.daysEstimate ? ' now' : ''}`}
            style={{ '--v': w.actual / m.base } as CSSProperties}
          />
        )}
      </div>
    ))
  const existing = p.existingAlerts ?? []
  const state = !ready ? 'empty' : entered ? 'ready' : 'loading'

  return (
    <LayerCard
      className="lc"
      data-data={state}
      data-phase={phase}
      data-dragging={dragging || undefined}
      aria-busy={phase === 'sending'}
      render={<section aria-labelledby={ids.title} aria-describedby={ids.sub} />}
    >
      <LayerCard.Primary className="lc-primary">
        <header className="hd">
          <CloudflareLogo variant="glyph" className="cf" aria-hidden />
          <div>
            <h2 className="title" id={ids.title}>
              Email me when a week of Workers requests passes the line
            </h2>
            <p className="sub" id={ids.sub} aria-live="polite">
              <FactLine fact={past} />
              <FactLine fact={now} />
            </p>
          </div>
        </header>
        <div className="chart">
          <div
            className="hc"
            ref={refs.plot}
            role="group"
            aria-label="Workers requests per week, with the 7-day alert threshold"
            data-locked={locked || undefined}
            data-hl={tip != null || undefined}
            onPointerDown={onPointerDown}
          >
            <div className="hc-gridset" ref={refs.grid} />
            <div className="hc-clip">
              <div className="hc-zone" ref={refs.zone} />
            </div>
            {m.typical != null && (
              <div className="hc-typ" ref={refs.typ}>
                <span ref={refs.typLabel}>
                  Typical<i className="wk"> week</i> <b>{sig(m.typical)}</b>
                </span>
              </div>
            )}
            <div
              className="hc-bars"
              ref={refs.bars}
              onPointerOver={(e) => {
                if (!canHover() || draggingRef.current || !ready) return
                const col = (e.target as HTMLElement).closest<HTMLElement>('.hc-col')
                if (col) setTip(Number(col.dataset.w))
              }}
              onPointerLeave={() => !draggingRef.current && setTip(null)}
            >
              {bars(false)}
            </div>
            <div className="hc-hot" ref={refs.hot} aria-hidden="true">
              {bars(true)}
            </div>
            <div className="hc-msg">
              {!ready && <span dangerouslySetInnerHTML={{ __html: emptyMessage(m) }} />}
            </div>
            <div className="hc-line" ref={refs.line}>
              <div
                className="hc-knob"
                ref={refs.knob}
                role="slider"
                tabIndex={locked ? -1 : 0}
                aria-disabled={locked}
                aria-label="Alert threshold, requests in 7 days"
                aria-orientation="vertical"
                aria-valuemin={m.minLimit}
                aria-valuemax={m.maxLimit}
                aria-valuenow={limit}
                aria-valuetext={`About ${words(limit)} requests in 7 days. ${plain(past[1])}. ${plain(now[1])}.`}
                onKeyDown={onKeyDown}
              >
                <span aria-hidden="true">~{fmt(limit)}</span>
              </div>
            </div>
          </div>
          <div className="hc-x" aria-hidden="true">
            {ready &&
              m.months
                .filter((mo) => mo.to - mo.from >= 4)
                .map((mo) => (
                  <span
                    key={mo.key}
                    style={{ left: pct((mo.from + mo.to) / 2), translate: '-50% 0' }}
                  >
                    {monthShort(mo.key)}
                  </span>
                ))}
          </div>
          <div
            className="hc-tip"
            ref={refs.tip}
            data-show={tip != null || undefined}
            aria-hidden="true"
          >
            {tip != null && m.weeks[tip] && tipBody(m, m.weeks[tip], limit)}
          </div>
        </div>
        {(existing.length > 0 || unavailable) && (
          <p className="note" data-tone={unavailable ? 'warn' : undefined}>
            {unavailable
              ? 'This account can’t create custom analytics alerts.'
              : `Already on this account: ${existing
                  .map(
                    (a) =>
                      `${a.name}${a.limit ? ` (~${sig(a.limit)})` : ''}${a.enabled ? '' : ', off'}`
                  )
                  .join('; ')}`}
          </p>
        )}
      </LayerCard.Primary>
      <div className="foot">
        <div className="f-layer f-form" inert={phase === 'sent' || phase === 'review'}>
          <label className="to">
            <span className="to-l">To</span>
            <input
              ref={refs.email}
              className="input"
              type="email"
              autoComplete="email"
              spellCheck={false}
              placeholder="Email address"
              aria-label="Alert email"
              aria-describedby={ids.err}
              aria-invalid={invalid}
              readOnly={phase === 'sending'}
              disabled={!ready}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => address && setTouched(true)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </label>
          <Button
            variant="primary"
            className="create"
            loading={phase === 'sending'}
            disabled={!ready || unavailable}
            onClick={submit}
          >
            Create alert
          </Button>
          <p className="err" id={ids.err} data-show={invalid || undefined} role="alert">
            {invalid ? 'Enter a valid email address.' : ''}
          </p>
        </div>
        <div className="f-layer f-done" inert={phase !== 'sent' && phase !== 'review'}>
          <div className="done" ref={refs.done} tabIndex={-1} role="status">
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
              <circle
                className="ck-ring"
                cx="11"
                cy="11"
                r="9"
                stroke="currentColor"
                strokeWidth="1.6"
                transform="rotate(-90 11 11)"
              />
              <path
                className="ck-tick"
                d="M7 11.3l2.7 2.7L15 8.6"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="done-1">
              {phase === 'review' ? 'Ready to create' : 'Sent to chat'}
            </span>
            <span className="done-2" title={`Past ${fmt(limit)} in 7 days, emails ${address}`}>
              <span>
                Past <b>{fmt(limit)}</b> in 7 days, emails&nbsp;
              </span>
              <span className="em">{address}</span>
            </span>
          </div>
          <Button
            variant="ghost"
            onClick={() => {
              setPhase('editing')
              requestAnimationFrame(() => refs.knob.current?.focus({ preventScroll: true }))
            }}
          >
            Edit
          </Button>
        </div>
      </div>
      {phase === 'review' && (
        <Collapsible className="request-disclosure">
          <Collapsible.DefaultTrigger className="text-sm font-normal text-kumo-subtle">
            Request to create it
          </Collapsible.DefaultTrigger>
          <Collapsible.Panel>
            <pre className="request">{request}</pre>
          </Collapsible.Panel>
        </Collapsible>
      )}
    </LayerCard>
  )
}

const plain = (html: string) => html.replace(/<[^>]+>/g, '')

/** Too little history and no history read the same way: nothing to compare against, so the limit comes from chat. */
function emptyFacts(m: Model): [Fact, Fact] {
  const n = m.days.length
  return n
    ? [
        ['', `Only ${n} ${n === 1 ? 'day' : 'days'} of history`],
        ['', 'Not a full week yet']
      ]
    : [
        ['', 'No requests in 90 days'],
        ['', 'Nothing to compare yet']
      ]
}
function emptyMessage(m: Model): string {
  const n = m.days.length
  return n
    ? `<b>Only ${n} ${n === 1 ? 'day' : 'days'} of Workers requests so far.</b><br>A full week shows what normal looks like. Tell me a number in chat and I’ll set the limit.`
    : `<b>No Workers requests in the last 90 days.</b><br>There’s no normal week to compare against yet. Tell me a number in chat and I’ll set the limit.`
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
