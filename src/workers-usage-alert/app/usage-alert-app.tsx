import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'

/** A style with the CSS custom properties the stylesheet reads (`--v`, `--d`). */
type VarStyle = CSSProperties & { readonly [name: `--${string}`]: string | number }
/** A style for an element whose bar height or delay the stylesheet reads from custom properties. */
const varStyle = (style: VarStyle): CSSProperties => style
import { Button, Checkbox, Collapsible, LayerCard, Radio } from '@cloudflare/kumo'
import type { App } from '@modelcontextprotocol/ext-apps'
import { mountMcpApp } from '../../mcp-apps/app-shell/mount'
import { WorkersThresholdPreviewSchema } from '../contract'
import type { WorkersThresholdPreview } from '../contract'
import {
  clamp,
  deriveModel,
  fitTop,
  replayEmails,
  snapTo,
  stepOf,
  tickOf
} from '../../threshold-alert/model'
import type { Model, Week } from '../../threshold-alert/model'
import {
  R2_STORAGE_BILLING,
  WORKERS_REQUESTS_BILLING,
  WORKERS_REQUESTS_MONITOR,
  WORKERS_SPEND,
  actionOf
} from '../../threshold-alert/presets'
import type { PresetAction, SettingRef, ThresholdAlertPreset } from '../../threshold-alert/presets'
import { createSetting, deleteSetting, updateSetting } from '../../threshold-alert/create'
import type { CallTool, WriteResult } from '../../threshold-alert/create'
import {
  EDITING,
  afterCreate,
  afterSave,
  afterUndo,
  buttonLabel,
  failureReason,
  handoffOf,
  hintFor,
  undoFailureLine,
  unconfirmedNote
} from '../../threshold-alert/form'
import type { Phase, Step, WriteContext } from '../../threshold-alert/form'
import { EMAIL, fmtDay, fmtDays, formatsFor, monthShort, sig as ratio } from './format'
import './usage-alert.css'

type Tone = '' | 'hit' | 'now' | 'warn' | 'bad'
/** Plain text, or a figure shown bold and direction-isolated. */
type FactPart = string | { readonly b: string }
type Fact = readonly [Tone, ReadonlyArray<FactPart>]

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const canHover = () => matchMedia('(hover: hover) and (pointer: fine)').matches
// Drag past an edge to grow or shrink the axis, like a list scrolling when you drag past its end:
// px zone inside each edge, px to full speed, e-folds per second. Settling eases with time constant TAU (s).
const EDGE = 10
const RAMP = 110
const GROW = 1.8
const TAU = 0.055

/** Two short facts under the chart, verdict first (BLUF), each sized to fit one line at 320px. */
function outcome(
  m: Model,
  limit: number,
  preset: ThresholdAlertPreset,
  action: PresetAction
): [Fact, Fact] {
  const { bucket, current } = preset.copy
  const { alreadyOver } = action
  const { approx, sig } = formatsFor(preset.unit.format)
  const sent = replayEmails(m.days, m.rolling, limit, m.cadence)
  const first = sent.find((e) => e.first)
  // By month, the replay is Workers analytics by calendar month, not billing's count in its
  // period: an estimate, and said as one.
  const about = m.cadence.kind === 'month' ? 'About ' : ''
  const none = m.cadence.kind === 'month' ? 'No crossings charted' : 'No past emails'
  const past: Fact =
    m.typical && limit < m.typical
      ? ['warn', [`Below a typical ${bucket} (`, { b: approx(m.typical, 2) }, ')']]
      : sent.length && first
        ? [
            'hit',
            [
              about,
              { b: String(sent.length) },
              ` past ${sent.length === 1 ? 'email' : 'emails'}, first `,
              { b: fmtDay(first.date) }
            ]
          ]
        : limit >= 2 * m.peak
          ? ['', [`${none}; `, { b: `${ratio(limit / m.peak)}×` }, ` the busiest ${bucket}`]]
          : ['', [`${none}; busiest ${bucket} `, { b: sig(m.peak) }]]
  const now: Fact =
    m.current >= limit ? ['warn', [alreadyOver]] : ['now', [`${current}: `, { b: sig(m.current) }]]
  return [past, now]
}

function FactLine({ fact, slot }: { fact: Fact; slot: 'past' | 'now' }) {
  return (
    <span className="sub-i" data-tone={fact[0]} data-slot={slot}>
      <i aria-hidden="true" />
      {/* A fact that doesn't fit is ellipsized; the whole sentence stays a hover away. */}
      <span title={plain(fact[1]).trim() || undefined}>
        {fact[1].map((part, i) =>
          typeof part === 'string' ? (
            part
          ) : (
            <b key={i}>
              <bdi>{part.b}</bdi>
            </b>
          )
        )}
      </span>
    </span>
  )
}

function tipBody(m: Model, w: Week, limit: number, preset: ThresholdAlertPreset) {
  const monthly = m.cadence.kind === 'month'
  const { approx, sig } = formatsFor(preset.unit.format)
  const from = w.partial ? (m.days.find(([d]) => d >= w.start)?.[0] ?? w.start) : w.start
  const range = fmtDays(from, w.end)
  const email = replayEmails(m.days, m.rolling, limit, m.cadence).find(
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
            {w.daysActual < 7 || (monthly && w.partial)
              ? `${w.daysActual} ${w.daysActual === 1 ? 'day' : 'days'}`
              : w.daysEstimate
                ? `This ${preset.copy.bucket}`
                : monthly
                  ? `${w.daysActual} days`
                  : 'Week'}
          </span>
          <b>{sig(w.rawActual, 3)}</b>
        </div>
      )}
      {w.daysEstimate > 0 && (
        <div className="tip-r">
          <i className="sw-est" />
          <span>Estimate, {w.daysEstimate} days</span>
          <b>{approx(w.rawEstimate, 3)}</b>
        </div>
      )}
      {w.rolling !== null && w.lastDay && (
        <div className="tip-r">
          <i />
          <span>
            {monthly ? 'Month to' : '7 days to'} {fmtDay(w.lastDay)}
          </span>
          <b>{sig(w.rolling, 3)}</b>
        </div>
      )}
      {email && (
        <div className="tip-e">
          <i />
          {monthly ? 'Would likely have emailed' : 'Would have emailed'}
          {email.first ? '' : ' again'} {fmtDay(email.date)}
        </div>
      )}
    </>
  )
}

/**
 * What the card shows before a result: `loading` while the tool runs (a
 * skeleton in the same boxes), `error` when it failed, with Try again when the
 * host can call the tool again.
 */
type Pending =
  | { kind: 'loading' }
  | { kind: 'error'; reason: string; retry: (() => void) | undefined }

/**
 * The card's one content state: still reading, failed, an alert this account
 * can't create, nothing to compare against, or a chart.
 */
type View = Pending['kind'] | 'unavailable' | 'empty' | 'chart'

function UsageAlertCard({
  preview: p,
  app,
  pending
}: {
  preview: WorkersThresholdPreview
  app: App | undefined
  pending?: Pending
}) {
  const preset = presetOf(p)
  const copy = preset.copy
  const { fmt, sig, approx, words, policy: fmtPolicy } = formatsFor(preset.unit.format)
  const m = useMemo(
    () => deriveModel(p.days, p.today, preset.cadence),
    [p.days, p.today, preset.cadence]
  )
  /**
   * What the card is showing, decided once: `chart` only when there is a
   * typical period to draw the bars and line against. Everything else (bars,
   * months, legend, the slider) follows from this, so an empty card can't
   * draw bars.
   */
  // `alertAvailable: null` is unknown (the read was refused), not "no": only `false` closes the card.
  const view: View = pending
    ? pending.kind
    : p.alertAvailable === false
      ? 'unavailable'
      : m.typical !== null
        ? 'chart'
        : 'empty'
  const ready = view === 'chart'
  const [limit, setLimitState] = useState(() =>
    clamp(
      // The summary is in the model's unit (a spend policy's dollars); the chart counts the preset's.
      p.summary.suggestedLimit === null
        ? (m.suggested ?? m.minLimit)
        : p.summary.suggestedLimit * (preset.unit.modelScale ?? 1),
      m.minLimit,
      m.maxLimit
    )
  )
  const [entered, setEntered] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [tip, setTip] = useState<number | null>(null)
  const [phase, setPhase] = useState<Phase>(EDITING)
  const [email, setEmail] = useState(p.userEmail ?? '')
  // What happens at the line: the result's starting choice, or the preset's one action.
  const [actionId, setActionId] = useState(() => actionOf(preset, startAction(p)).id)
  const action = actionOf(preset, actionId)
  const [touched, setTouched] = useState(false)
  // A setting that stops something is confirmed with a tick naming the account, not only the button.
  const [confirmed, setConfirmed] = useState(false)
  const [confirmAsked, setConfirmAsked] = useState(false)
  const account = p.accountName ?? p.accountId
  const caution = action.caution?.(account)
  const handoff = handoffOf(app?.getHostCapabilities())
  const ids = { title: useId(), sub: useId(), err: useId(), hint: useId() }

  const plotEl = useRef<HTMLFieldSetElement>(null)
  const gridEl = useRef<HTMLDivElement>(null)
  const lineEl = useRef<HTMLDivElement>(null)
  const knobEl = useRef<HTMLDivElement>(null)
  const zoneEl = useRef<HTMLDivElement>(null)
  const hotEl = useRef<HTMLDivElement>(null)
  const typEl = useRef<HTMLDivElement>(null)
  const typLabelEl = useRef<HTMLSpanElement>(null)
  const tipEl = useRef<HTMLDivElement>(null)
  const barsEl = useRef<HTMLDivElement>(null)
  const emailEl = useRef<HTMLInputElement>(null)
  const doneEl = useRef<HTMLDivElement>(null)
  const createEl = useRef<HTMLButtonElement>(null)
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

  const locked = !ready || (phase.kind !== 'editing' && phase.kind !== 'failed')
  const address = email.trim()
  const invalid = touched && !EMAIL.test(address)
  const done = phase.kind === 'created' || phase.kind === 'sent' || phase.kind === 'review'
  const unconfirmed = phase.kind === 'failed' && phase.unconfirmed
  const undo = phase.kind === 'created' ? phase.undo : undefined
  const undoing = undo === 'deleting'
  const undoFailure = typeof undo === 'object' ? undo : undefined
  // The legend under the chart, shimmering while it loads. An empty or failed card has no chart, so no legend:
  // its message says it all.
  const facts: readonly [Fact, Fact] | null =
    view === 'loading'
      ? [
          ['', ['\u00a0']],
          ['', ['\u00a0']]
        ]
      : view === 'chart'
        ? outcome(m, limit, preset, action)
        : null

  // ── Drawing: positions only, with transforms; runs every frame while moving ──
  const placeTip = useCallback(() => {
    const i = tipRef.current
    const el = tipEl.current
    const plot = plotEl.current
    if (i === null || !el || !plot) {
      return
    }
    const chart = el.parentElement
    const col = barsEl.current?.querySelector<HTMLElement>(`[data-w="${i}"]`)
    if (!chart || !col) {
      return
    }
    const c = chart.getBoundingClientRect()
    const r = col.getBoundingClientRect()
    const top = Math.min(
      ...Array.from(col.children, (b) => b.getBoundingClientRect().top),
      r.bottom
    )
    const w = el.offsetWidth
    const h = el.offsetHeight
    // Prefer the side the week's text would continue on: right in left-to-right, left in right-to-left.
    const rtl = getComputedStyle(chart).direction === 'rtl'
    const right = rtl ? r.left - 8 - w < c.left : r.right + 8 + w <= c.right
    const x = clamp(right ? r.right - c.left + 8 : r.left - c.left - 8 - w, 0, c.width - w)
    const y = clamp((top + r.bottom) / 2 - c.top - h / 2, 0, plot.offsetTop + plot.offsetHeight - h)
    el.style.setProperty('--o', right ? 'left center' : 'right center')
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  }, [])

  const draw = useCallback(() => {
    const plot = plotEl.current
    const line = lineEl.current
    const zone = zoneEl.current
    const hot = hotEl.current
    const grid = gridEl.current
    if (!plot || !line || !zone || !hot || !grid) {
      return
    }
    const a = A.current
    const px = (v: number) => (v / a.top) * plot.clientHeight
    const p0 = px(a.line)
    plot.style.setProperty('--top', String(a.top / m.base))
    line.style.transform = `translateY(${-p0}px)`
    zone.style.transform = `translateY(${-p0}px)`
    hot.style.clipPath = `inset(0 -4px ${p0}px -4px)`
    // Gridlines keyed by value: lines both scales share stay put, the rest crossfade.
    const t = tickOf(a.top)
    const want = new Set<number>()
    for (let k = 1; k * t <= a.top * 1.0001; k++) {
      want.add(k * t)
    }
    for (const [v, el] of ticks.current) {
      if (!want.has(v)) {
        ticks.current.delete(v)
        el.setAttribute('data-in', '')
        setTimeout(() => el.remove(), 160)
      }
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
      el.firstElementChild?.toggleAttribute('data-hidden', Math.abs(tp - p0) < 14)
    }
    if (m.typical && typEl.current && typLabelEl.current) {
      const tp = px(m.typical)
      typEl.current.style.transform = `translateY(${-tp}px)`
      // The label hangs under its line; near the baseline it sits above instead of on the months.
      const up = tp < 24
      typLabelEl.current.style.top = up ? '-20px' : ''
      typLabelEl.current.toggleAttribute(
        'data-hidden',
        up ? p0 > tp - 2 && p0 < tp + 24 : p0 < tp + 2 && p0 > tp - 24
      )
    }
    placeTip()
  }, [m, placeTip, fmt])

  const snap = useCallback(
    (v: number, top: number) => clamp(snapTo(v, stepOf(top)), m.minLimit, m.maxLimit),
    [m]
  )

  const dragStep = useCallback(
    (dt: number) => {
      const plot = plotEl.current
      if (!plot) {
        return
      }
      const a = A.current
      const r = plot.getBoundingClientRect()
      const over = r.top + EDGE - a.ptr
      const under = a.ptr - (r.bottom - EDGE)
      if (over > 0 && dt) {
        a.top = a.target = Math.min(
          m.maxLimit,
          a.top * Math.exp(GROW * Math.min(1, over / RAMP) * dt)
        )
      }
      if (under > 0 && dt) {
        a.top = a.target = Math.max(
          m.minTop,
          a.top * Math.exp(-GROW * Math.min(1, under / RAMP) * dt)
        )
      }
      a.line = clamp(clamp((r.bottom - a.ptr) / r.height, 0, 1) * a.top, m.minLimit, m.maxLimit)
      const next = snap(a.line, a.top)
      if (next !== limitRef.current) {
        setLimit(next)
      }
    },
    [m, snap]
  )

  const draggingRef = useRef(false)
  const frame = useCallback(
    (now: number) => {
      const a = A.current
      const dt = Math.min(0.05, (now - a.last) / 1000)
      a.last = now
      a.raf = 0
      let more = draggingRef.current
      if (draggingRef.current) {
        dragStep(dt)
      } else {
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
      if (more) {
        a.raf = requestAnimationFrame(frame)
      }
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
    const plot = plotEl.current
    if (!plot) {
      return
    }
    const ro = new ResizeObserver(() => draw())
    ro.observe(plot)
    // One frame in the loading shape, so the threshold drops in after the bars rise.
    const raf = requestAnimationFrame(() => setEntered(true))
    // The axis state object lives for the component's lifetime; its frame id changes.
    const axis = A.current
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      cancelAnimationFrame(axis.raf)
    }
  }, [draw])

  // ── Drag: the line follows the pointer 1:1; the value snaps; release glides to the step ──
  const onPointerDown = (e: PointerEvent<HTMLFieldSetElement>) => {
    if (locked || e.button !== 0 || draggingRef.current) {
      return
    }
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
      knobEl.current?.focus({ preventScroll: true })
    }
    plot.addEventListener('pointermove', move)
    plot.addEventListener('pointerup', up)
    plot.addEventListener('pointercancel', up)
  }

  // Keyboard: an arrow is one drag step, Shift or Page a gridline; past the top the axis grows to follow.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (locked || draggingRef.current) {
      return
    }
    const a = A.current
    const big = tickOf(a.target)
    const st = e.shiftKey ? big : stepOf(a.target)
    const L = limitRef.current
    // The slider is vertical; the horizontal arrows follow reading direction, as ARIA's slider pattern says.
    const fwd = getComputedStyle(e.currentTarget).direction === 'rtl' ? -st : st
    const keys = new Map([
      ['ArrowUp', L + st],
      ['ArrowRight', L + fwd],
      ['ArrowDown', L - st],
      ['ArrowLeft', L - fwd],
      ['PageUp', L + big],
      ['PageDown', L - big],
      ['Home', m.minLimit],
      ['End', m.maxLimit]
    ])
    const v = keys.get(e.key)
    if (v === undefined) {
      return
    }
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

  // ── Writes: editing → sending → created | failed, or hand-off → sent | review ──
  // The policy's name is stored in Cloudflare and read by everyone on the account: one fixed format.
  const name = preset.name(fmtPolicy(limit), action.id)
  const policy = preset.policy(p.accountId, limit, address, action.id)
  const target = preset.target
  const request = target.request(p.accountId, policy)
  const written: WriteContext = {
    preset,
    action,
    accountId: p.accountId,
    account,
    name,
    does: action.does(address),
    what: preset.passes(limit)
  }
  const settle = (next: Phase) => {
    setPhase(next)
    if (next.kind !== 'failed') {
      requestAnimationFrame(() => doneEl.current?.focus({ preventScroll: true }))
    }
  }
  /**
   * The setting this card created and hasn't deleted, by the id (and, for a
   * spend policy, the version) its write returned: Undo deletes it. Once Edit
   * reopens the form, the button reads Save and updates it instead of
   * creating a second one.
   */
  const [made, setMade] = useState<SettingRef | null>(null)
  const policyId = made?.id ?? null
  const createdAt = useRef(0)
  const saving = made !== null && phase.kind !== 'created'
  const noun = action.noun
  const tell = (text: string) =>
    void app?.updateModelContext?.({ content: [{ type: 'text', text }] }).catch(() => {})
  /** Apply what a write's answer did: the form's phase, the setting it made, and what the model is told. */
  const step = (next: Step) => {
    if (next.made !== undefined) {
      setMade(next.made)
    }
    if (next.tell) {
      tell(next.tell)
    }
    if (next.phase.kind === 'created') {
      createdAt.current = performance.now()
    }
    settle(next.phase)
  }
  const askedConfirm = confirmAsked && caution !== undefined && !confirmed
  const hint = hintFor({
    phase,
    noun,
    invalid,
    address,
    unconfirmedCaution: askedConfirm ? caution : undefined
  })
  const missedNote = unconfirmedNote(phase, noun)
  const submit = async () => {
    if (locked || !app) {
      return
    }
    setTouched(true)
    if (!EMAIL.test(address)) {
      return emailEl.current?.focus()
    }
    if (caution && !confirmed) {
      return setConfirmAsked(true)
    }
    const caps = app.getHostCapabilities()
    setPhase({ kind: 'sending' })
    const call: CallTool = (c) => app.callServerTool(c)
    if (saving && made) {
      const saved = await updateSetting(call, target, p.accountId, made, policy).catch(refused)
      return step(afterSave(saved, made, written))
    }
    if (caps?.serverTools) {
      const created = await createSetting(call, target, p.accountId, policy).catch(refused)
      const next = afterCreate(created, written)
      if (next !== 'handoff') {
        return step(next)
      }
    }
    if (!caps?.message) {
      return settle({ kind: 'review' })
    }
    try {
      if (caps.updateModelContext) {
        await app.updateModelContext({
          content: [
            {
              type: 'text',
              text: `Not created yet: the user confirmed this ${noun} in the ${preset.toolName} App. Create it only with a write the user approves, exactly as written:\n${request}`
            }
          ]
        })
      }
      const result = await app.sendMessage({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Create the ${noun} on account ${account} (${p.accountId}): it ${written.does} when ${written.what}.`
          }
        ]
      })
      settle({ kind: result.isError ? 'review' : 'sent' })
    } catch {
      settle({ kind: 'review' })
    }
  }

  // Undo: delete the setting just created; the form returns as it was, with a neutral notice in the field.
  const onUndo = async () => {
    // Undo appears under the pointer that just clicked Create: ignore the second click of a double-click.
    if (!app || !made || undoing || performance.now() - createdAt.current < 500) {
      return
    }
    setPhase({ kind: 'created', undo: 'deleting' })
    const deleted = await deleteSetting(
      (c) => app.callServerTool(c),
      target,
      p.accountId,
      made
    ).catch(refused)
    const next = afterUndo(deleted, made, written)
    if (next.made !== undefined) {
      setMade(next.made)
    }
    if (next.tell) {
      tell(next.tell)
    }
    setPhase(next.phase)
    if (next.phase.kind === 'editing') {
      requestAnimationFrame(() => createEl.current?.focus({ preventScroll: true }))
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
        style={varStyle({
          insetInlineStart: pct(w.offset),
          inlineSize: pct(w.length),
          '--d': `${delay(i)}ms`
        })}
      >
        {w.estimate > 0 && (
          <div className="hc-bar est" style={varStyle({ '--v': w.estimate / m.base })} />
        )}
        {w.actual > 0 && (
          <div
            className={`hc-bar${w.partial ? ' partial' : w.daysEstimate ? ' now' : ''}`}
            style={varStyle({ '--v': w.actual / m.base })}
          />
        )}
      </div>
    ))
  const existing = p.existingAlerts ?? []
  const state = view === 'chart' ? (entered ? 'ready' : 'entering') : view

  return (
    <LayerCard
      className="lc"
      data-data={state}
      data-phase={phase.kind}
      data-dragging={dragging || undefined}
      aria-busy={pending?.kind === 'loading' || phase.kind === 'sending' || undoing}
      render={<section aria-labelledby={ids.title} aria-describedby={ids.sub} />}
    >
      <LayerCard.Primary className="lc-primary">
        <header className="hd">
          <h2 className="title" id={ids.title}>
            {action.title}
          </h2>
        </header>
        <div className="chart">
          {/* The chart and its slider, named as one group: a fieldset, reset to a plain box in the CSS. */}
          <fieldset
            className="hc"
            ref={plotEl}
            aria-label={copy.chartLabel}
            data-locked={locked || undefined}
            data-hl={tip !== null || undefined}
            onPointerDown={onPointerDown}
          >
            <div className="hc-gridset" ref={gridEl} />
            <div className="hc-clip">
              <div className="hc-zone" ref={zoneEl} />
            </div>
            {m.typical !== null && (
              <div className="hc-typ" ref={typEl}>
                <span ref={typLabelEl}>
                  Typical<i className="wk"> {copy.bucket}</i> <b>{sig(m.typical)}</b>
                </span>
              </div>
            )}
            <div
              className="hc-bars"
              ref={barsEl}
              onPointerOver={(e) => {
                if (!canHover() || draggingRef.current || !ready) {
                  return
                }
                const col =
                  // oxlint-disable-next-line @nkzw/no-instanceof -- A pointer event's target is a DOM node; only an Element has closest().
                  e.target instanceof Element ? e.target.closest<HTMLElement>('.hc-col') : null
                if (col) {
                  setTip(Number(col.dataset.w))
                }
              }}
              onPointerLeave={() => !draggingRef.current && setTip(null)}
            >
              {ready && bars(false)}
            </div>
            <div className="hc-hot" ref={hotEl} aria-hidden="true">
              {ready && bars(true)}
            </div>
            <div className="hc-skel" aria-hidden="true">
              {SKELETON.map((h, i) => (
                <i key={i} style={{ height: `${h}%` }} />
              ))}
            </div>
            <div className="hc-msg">
              {view === 'error' && pending?.kind === 'error' ? (
                <>
                  <div className="es-copy">
                    <h3>Couldn’t read your usage</h3>
                    {/* Cloudflare's own reason, as D1 Studio shows it: a refusal reads differently from an outage. */}
                    <p id={ids.sub}>
                      {copy.source}: <bdi>{pending.reason}</bdi>. Nothing was changed.
                    </p>
                    {pending.retry && (
                      <Button variant="outline" size="sm" className="retry" onClick={pending.retry}>
                        Try again
                      </Button>
                    )}
                  </div>
                  <div className="es-stage" aria-hidden="true">
                    <EmptyArt />
                  </div>
                </>
              ) : (
                (view === 'empty' || view === 'unavailable') && (
                  <>
                    <div className="es-copy">
                      <h3>
                        {view === 'unavailable' ? copy.unavailable.title : emptyCopy(m, preset)[0]}
                      </h3>
                      {/* No legend on an empty or failed card, so its message is what describes it. */}
                      <p id={ids.sub}>
                        {view === 'unavailable' ? copy.unavailable.body : emptyCopy(m, preset)[1]}
                      </p>
                    </div>
                    <div className="es-stage" aria-hidden="true">
                      <EmptyArt />
                    </div>
                  </>
                )
              )}
            </div>
            <div className="hc-line" ref={lineEl}>
              {/* A vertical slider whose axis rescales while it moves: no <input type="range"> can be drawn
                  or driven like this, so it is ARIA's slider pattern on a div. */}
              <div
                className="hc-knob"
                ref={knobEl}
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- See above: a native range input can't rescale its axis mid-drag.
                role="slider"
                tabIndex={locked ? -1 : 0}
                aria-disabled={locked}
                aria-label={copy.sliderLabel}
                aria-orientation="vertical"
                aria-valuemin={m.minLimit}
                aria-valuemax={m.maxLimit}
                aria-valuenow={limit}
                aria-valuetext={`About ${words(limit)} ${preset.unit.noun} ${copy.per}.${facts ? ` ${plain(facts[0][1])}. ${plain(facts[1][1])}.` : ''}`}
                onKeyDown={onKeyDown}
              >
                <span aria-hidden="true">{approx(limit)}</span>
              </div>
            </div>
          </fieldset>
          <div className="hc-x" aria-hidden="true">
            {ready &&
              m.months
                .filter((mo) => mo.to - mo.from >= 4)
                .map((mo) => (
                  <span key={mo.key} style={{ insetInlineStart: pct((mo.from + mo.to) / 2) }}>
                    {monthShort(mo.key)}
                  </span>
                ))}
          </div>
          <div
            className="hc-tip"
            ref={tipEl}
            data-show={tip !== null || undefined}
            aria-hidden="true"
          >
            {tip !== null && m.weeks[tip] && tipBody(m, m.weeks[tip], limit, preset)}
          </div>
        </div>
        {/* The outcome reads as the chart's legend: grey for past periods, blue for now. */}
        {facts && (
          <p className="sub" id={ids.sub} aria-live="polite">
            <FactLine fact={facts[0]} slot="past" />
            <FactLine fact={facts[1]} slot="now" />
          </p>
        )}
        {/* A write with no answer may have been made: say so where everyone sees it, before the button. */}
        {missedNote && (
          <p className="note" data-tone="bad">
            {missedNote}
          </p>
        )}
        {/* A choice of what happens at the line, when the preset has one: email, or stop the product. */}
        {ready && preset.actions.length > 1 && (
          <Radio.Group
            legend="At the line"
            appearance="segmented"
            orientation="horizontal"
            className="act"
            value={action.id}
            disabled={locked}
            onValueChange={(id) => {
              setActionId(id)
              setConfirmed(false)
              setConfirmAsked(false)
              if (phase.kind === 'failed' && !unconfirmed) {
                setPhase(EDITING)
              }
            }}
          >
            {preset.actions.map((a) => (
              <Radio.Item key={a.id} value={a.id} label={a.label} />
            ))}
          </Radio.Group>
        )}
        {/* What a setting that stops something does, naming the account, confirmed with a tick before the
            button does anything: the button alone is not enough for stopping every Worker. */}
        {ready && caution && (
          <Checkbox
            className="caution"
            variant={askedConfirm ? 'error' : 'default'}
            label={caution}
            checked={confirmed}
            disabled={locked}
            onCheckedChange={(checked) => {
              setConfirmed(checked === true)
              setConfirmAsked(false)
            }}
          />
        )}
        {/* Create writes to this account: name it before the click, since the model may have picked it.
            What already watches the same number there follows in the same line. */}
        {ready && account && (
          <p className="note">
            Account: <bdi>{account}</bdi>
            {existing.length > 0 && '. Already on it: '}
            {existing.map((a, i) => (
              <span key={i}>
                {i > 0 && '; '}
                {/* A name someone typed, in any script: isolated so it can't reorder what's around it. */}
                <bdi>{a.name}</bdi>
                {/* The card's names carry their threshold ("over $40"); only a name that doesn't gets it after. */}
                {a.limit && !a.name.includes(fmtPolicy(a.limit)) ? ` (${approx(a.limit, 2)})` : ''}
                {a.enabled ? '' : ', off'}
              </span>
            ))}
          </p>
        )}
      </LayerCard.Primary>
      {/* An alert this account can't create, or a card with no history read, has nothing to fill in:
          no form, not a disabled one. */}
      {view !== 'unavailable' && view !== 'error' && (
        <div className="foot">
          <div className="f-layer f-form" inert={done}>
            <label className="to">
              <span className="to-l">To</span>
              <input
                ref={emailEl}
                className="input"
                type="email"
                dir="auto"
                autoComplete="email"
                spellCheck={false}
                placeholder="Email address"
                aria-label={`${capital(noun)} email`}
                aria-describedby={ids.hint}
                aria-invalid={invalid}
                readOnly={phase.kind === 'sending'}
                disabled={!ready}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value)
                  // A write with no answer stays unconfirmed: editing the address doesn't settle it.
                  if (
                    phase.kind === 'editing'
                      ? phase.deleted
                      : !unconfirmed && phase.kind === 'failed'
                  ) {
                    setPhase(EDITING)
                  }
                }}
                onBlur={() => address && setTouched(true)}
                // Not after a write that got no answer: sending it again takes the button's own click.
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !unconfirmed) {
                    void submit()
                  }
                }}
              />
              <span
                className="to-hint"
                id={ids.hint}
                data-tone={hint?.tone}
                title={phase.kind === 'failed' ? failureReason(phase.reason) : undefined}
              >
                {hint?.text}
              </span>
            </label>
            <Button
              ref={createEl}
              variant="primary"
              className="create"
              loading={phase.kind === 'sending'}
              disabled={!ready}
              onClick={() => void submit()}
            >
              {buttonLabel({ phase, action, saving, handoff })}
            </Button>
            <p className="sr" id={ids.err} role="alert">
              {hint?.say}
            </p>
          </div>
          <div className="f-layer f-done" inert={!done}>
            {/* role="status" rather than <output>: an explicit live region is announced in every screen reader. */}
            {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- See above. */}
            <div className="done" ref={doneEl} tabIndex={-1} role="status">
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
                {phase.kind === 'created'
                  ? action.done
                  : phase.kind === 'review'
                    ? 'Ready to create'
                    : 'Sent to chat'}
              </span>
              <span
                className="done-2"
                data-tone={undoFailure ? 'bad' : undefined}
                title={
                  undoFailure
                    ? undoFailureLine(undoFailure, noun)
                    : `Past ${fmt(limit)} ${copy.per} · ${address} · ${account}`
                }
              >
                {undoing ? (
                  'Deleting…'
                ) : undoFailure ? (
                  undoFailureLine(undoFailure, noun)
                ) : (
                  <>
                    Past <b>{fmt(limit)}</b> {copy.per} · <bdi>{address}</bdi>
                  </>
                )}
              </span>
            </div>
            <div className="done-acts">
              {phase.kind === 'created' && policyId && (
                <Button
                  variant="ghost"
                  className="undo"
                  loading={undoing}
                  aria-description={`Deletes this ${noun}`}
                  onClick={() => void onUndo()}
                >
                  Undo
                </Button>
              )}
              <Button
                variant="ghost"
                className="edit"
                disabled={undoing}
                onClick={() => {
                  // On an alert this card made, Edit changes that alert (Save alert), not a second one.
                  setPhase(EDITING)
                  requestAnimationFrame(() => knobEl.current?.focus({ preventScroll: true }))
                }}
              >
                Edit
              </Button>
            </div>
          </div>
        </div>
      )}
      {phase.kind === 'review' && (
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

/** A write that threw before it was sent: the host refused the call, so nothing was written. */
const refused = (error: unknown): WriteResult => ({ status: 'refused', error: String(error) })

const plain = (parts: ReadonlyArray<FactPart>) =>
  parts.map((part) => (typeof part === 'string' ? part : part.b)).join('')

/** The loading bars, in % of the plot: a plausible week shape, not data. */
const SKELETON = [40, 52, 66, 50, 44, 40, 36]

/** Some traffic, but under a week of it: nothing to compare against yet. */
const shortHistory = (m: Model) => m.days.length > 0 && m.days.length < 7

/** An empty card's message: what was read, what that means and what to do. */
function emptyCopy(m: Model, preset: ThresholdAlertPreset): [string, string] {
  const bucket = preset.copy.bucket
  return shortHistory(m)
    ? [
        'Not a full week yet',
        'A week of history shows what normal looks like. Until then, tell me a number in chat.'
      ]
    : [`No ${bucket}s to compare yet`, preset.copy.noHistory]
}

/**
 * The empty-state drawing: a dashed cloud of circles standing on the
 * chart's floor. The dashes crawl (`es-dash`), the outer circle and the floor
 * the other way (`es-dash-r`).
 */
function EmptyArt() {
  const line = { stroke: 'currentColor', strokeWidth: 1.5 }
  const dash = { ...line, strokeDasharray: '3 3' }
  return (
    <svg
      className="es-art"
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="xMidYMax meet"
      viewBox="0 0 455 209"
      fill="none"
    >
      <circle cx="114.453" cy="113.587" r="48.4347" {...dash} className="es-dash-r" />
      <line x1="208.629" y1="207.904" x2="4.24023" y2="207.904" {...dash} className="es-dash-r" />
      <line x1="449.281" y1="207.943" x2="280.042" y2="207.943" {...dash} className="es-dash-r" />
      <line x1="280.93" y1="207.939" x2="208.946" y2="207.939" {...line} />
      <path
        d="M449.299 208.419C452.346 199.411 453.999 189.761 453.999 179.725C453.999 130.292 413.926 90.2192 364.494 90.2192C315.061 90.2192 274.988 130.292 274.988 179.725C274.988 189.761 276.641 199.411 279.688 208.419"
        {...dash}
        className="es-dash"
      />
      <path
        d="M142.289 208.277C142.952 204.384 143.299 200.383 143.299 196.302C143.299 157.246 111.639 125.587 72.5835 125.586C33.5269 125.586 1.86365 157.245 1.86328 196.302C1.86328 200.384 2.21464 204.384 2.87857 208.277"
        {...dash}
        className="es-dash"
      />
      <path
        d="M314.396 208.419C314.458 206.848 314.498 205.27 314.498 203.684C314.498 137.921 261.188 84.6075 195.425 84.6064C129.662 84.6064 76.3477 137.92 76.3477 203.684C76.3477 205.27 76.3882 206.848 76.4496 208.419"
        {...dash}
        className="es-dash"
      />
      <path
        d="M244.943 0.835938C303.403 0.835938 350.883 47.8566 351.622 106.141L351.631 107.52C351.631 153.749 322.222 193.108 281.094 207.919H208.798C167.669 193.109 138.261 153.749 138.261 107.52C138.261 48.6007 186.025 0.8368 244.943 0.835938Z"
        fill="url(#es-hatch)"
        {...line}
      />
      <defs>
        <pattern
          id="es-hatch"
          patternUnits="userSpaceOnUse"
          patternTransform="matrix(17.55 0 0 17.55 137.762 0.336914)"
          preserveAspectRatio="none"
          viewBox="0 0 16.32 16.32"
          width="1.5"
          height="1.5"
        >
          <use href="#es-hatch_inner" transform="translate(-16.32 -16.32)" />
          <use href="#es-hatch_inner" transform="translate(0 -16.32)" />
          <use href="#es-hatch_inner" transform="translate(-16.32 0)" />
          <g id="es-hatch_inner">
            <line x1="17.3536" y1="0.353553" x2="0.353554" y2="17.3536" stroke="currentColor" />
          </g>
        </pattern>
      </defs>
    </svg>
  )
}

/** Which preset a result is, by its `kind`. */
const presetOf = (p: WorkersThresholdPreview) =>
  p.kind === 'workers_spend_limit_preview'
    ? WORKERS_SPEND
    : p.kind === 'r2_storage_alert_preview'
      ? R2_STORAGE_BILLING
      : p.kind === 'workers_billing_alert_preview'
        ? WORKERS_REQUESTS_BILLING
        : WORKERS_REQUESTS_MONITOR

/** The action a result starts on, when its preset has a choice. */
const startAction = (p: WorkersThresholdPreview) =>
  p.kind === 'workers_spend_limit_preview' ? p.action : undefined

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * No result yet: no days, so nothing to draw, edit or create. Shaped as the
 * result of the tool the host says is running, so a billing card that is
 * loading or failed shows the billing copy.
 */
function placeholder(toolName: string | undefined): WorkersThresholdPreview {
  const common = {
    nextStep: '',
    checkedAt: new Date().toISOString(),
    accountId: '',
    today: new Date().toISOString().slice(0, 10),
    days: [],
    alertAvailable: null,
    existingAlerts: null,
    otherPolicies: {},
    limitations: []
  }
  if (toolName === WORKERS_SPEND.toolName) {
    return {
      kind: 'workers_spend_limit_preview',
      ...common,
      action: 'notification',
      summary: { typicalMonth: null, thisMonth: 0, busiestMonth: 0, suggestedLimit: null }
    }
  }
  if (toolName === R2_STORAGE_BILLING.toolName) {
    return {
      kind: 'r2_storage_alert_preview',
      ...common,
      summary: {
        typicalMonth: null,
        thisMonth: 0,
        busiestMonth: 0,
        storedNow: 0,
        suggestedLimit: null
      }
    }
  }
  return toolName === WORKERS_REQUESTS_BILLING.toolName
    ? {
        kind: 'workers_billing_alert_preview',
        ...common,
        summary: { typicalMonth: null, thisMonth: 0, busiestMonth: 0, suggestedLimit: null }
      }
    : {
        kind: 'workers_usage_alert_preview',
        ...common,
        summary: { typicalWeek: null, last7Days: 0, busiestWeek: 0, suggestedLimit: null }
      }
}

mountMcpApp({
  name: 'Cloudflare threshold alert',
  output: WorkersThresholdPreviewSchema,
  render: (preview, { app }) => (
    <UsageAlertCard key={preview.checkedAt} preview={preview} app={app} />
  ),
  renderPending: (toolName) => (
    <UsageAlertCard
      key="pending"
      preview={placeholder(toolName)}
      app={undefined}
      pending={{ kind: 'loading' }}
    />
  ),
  renderError: (text, retry, toolName) => (
    <UsageAlertCard
      key="error"
      preview={placeholder(toolName)}
      app={undefined}
      pending={{ kind: 'error', reason: failureReason(text), retry }}
    />
  ),
  copy: {
    pending: 'Reading usage…',
    cancelled: 'Usage check cancelled.',
    malformed: 'Usage could not be displayed. Check the tool’s text result.'
  }
})
