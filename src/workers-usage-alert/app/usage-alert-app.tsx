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
import { Button, CloudflareLogo, Collapsible, LayerCard, Radio } from '@cloudflare/kumo'
import type { App } from '@modelcontextprotocol/ext-apps'
import { mountMcpApp } from '../../mcp-apps/app-shell/mount'
import { WorkersThresholdPreviewSchema, type WorkersThresholdPreview } from '../contract'
import {
  clamp,
  deriveModel,
  fitTop,
  replayEmails,
  snapTo,
  stepOf,
  tickOf,
  type Model,
  type Week
} from '../../threshold-alert/model'
import {
  R2_STORAGE_BILLING,
  WORKERS_REQUESTS_BILLING,
  WORKERS_REQUESTS_MONITOR,
  WORKERS_SPEND,
  actionOf,
  type PresetAction,
  type SettingRef,
  type ThresholdAlertPreset
} from '../../threshold-alert/presets'
import {
  createSetting,
  deleteSetting,
  updateSetting,
  type CallTool
} from '../../threshold-alert/create'
import { EMAIL, fmtDay, fmtDays, formatsFor, monthShort, sig as ratio } from './format'
import './usage-alert.css'

/**
 * Where the form is, with what only that step knows. The click is the user's
 * confirmation, so the App creates the policy itself with a tool this server
 * already lists (`createPolicy`): `created`. A host that can't call server
 * tools gets the alert handed to the chat (`sent`), or else the request to
 * send (`review`).
 */
type Phase =
  /** `deleted`: Undo just deleted the alert this card made; the field says so until the next edit. */
  | { readonly kind: 'editing'; readonly deleted?: true }
  | { readonly kind: 'sending' }
  /** `undo`: Undo is deleting it, or Cloudflare refused, with the reason. */
  | { readonly kind: 'created'; readonly undo?: 'deleting' | { readonly failed: string } }
  /**
   * A refused write, with Cloudflare's reason, or one that got no answer
   * (`unconfirmed`): that create may have been made, so the card never says nothing was.
   */
  | { readonly kind: 'failed'; readonly reason: string; readonly unconfirmed: boolean }
  | { readonly kind: 'sent' }
  | { readonly kind: 'review' }
const EDITING: Phase = { kind: 'editing' }
type Tone = '' | 'hit' | 'now' | 'warn' | 'bad'
/** Plain text, or a figure shown bold and direction-isolated. */
type FactPart = string | { readonly b: string }
type Fact = readonly [Tone, readonly FactPart[]]

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
      <span>
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
      {w.rolling != null && w.lastDay && (
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
type Pending = { kind: 'loading' } | { kind: 'error'; retry: (() => void) | undefined }

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
      : m.typical != null
        ? 'chart'
        : 'empty'
  const ready = view === 'chart'
  const [limit, setLimitState] = useState(() =>
    clamp(p.summary.suggestedLimit ?? m.suggested ?? m.minLimit, m.minLimit, m.maxLimit)
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
  const ids = { title: useId(), sub: useId(), err: useId(), hint: useId() }

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
    done: useRef<HTMLDivElement>(null),
    create: useRef<HTMLButtonElement>(null)
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

  const locked = !ready || (phase.kind !== 'editing' && phase.kind !== 'failed')
  const address = email.trim()
  const invalid = touched && !EMAIL.test(address)
  const done = phase.kind === 'created' || phase.kind === 'sent' || phase.kind === 'review'
  const unconfirmed = phase.kind === 'failed' && phase.unconfirmed
  const undo = phase.kind === 'created' ? phase.undo : undefined
  const undoing = undo === 'deleting'
  const undoFailed = typeof undo === 'object' ? undo.failed : ''
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
    // Prefer the side the week's text would continue on: right in left-to-right, left in right-to-left.
    const rtl = getComputedStyle(chart).direction === 'rtl'
    const right = rtl ? r.left - 8 - w < c.left : r.right + 8 + w <= c.right
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
    // The slider is vertical; the horizontal arrows follow reading direction, as ARIA's slider pattern says.
    const fwd = getComputedStyle(e.currentTarget).direction === 'rtl' ? -st : st
    const v = (
      {
        ArrowUp: L + st,
        ArrowRight: L + fwd,
        ArrowDown: L - st,
        ArrowLeft: L - fwd,
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
  // The policy's name is stored in Cloudflare and read by everyone on the account: one fixed format.
  const name = preset.name(fmtPolicy(limit), action.id)
  const policy = preset.policy(p.accountId, limit, address, action.id)
  const what = preset.passes(limit)
  const does = action.does(address)
  const request = preset.target.request(p.accountId, policy)
  const target = preset.target
  const settle = (next: Phase) => {
    setPhase(next)
    requestAnimationFrame(() => refs.done.current?.focus({ preventScroll: true }))
  }
  const fail = (reason: string, unconfirmed = false) =>
    setPhase({ kind: 'failed', reason, unconfirmed })
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
  /**
   * The field's trailing message: a fixed short phrase, so it never crowds the
   * address, or nothing. `say` is the full sentence a screen reader hears.
   */
  const hint: { tone: '' | 'bad'; text: string; say: string } | null = invalid
    ? address
      ? {
          tone: 'bad',
          text: 'Invalid email',
          say: 'Enter a full email address, like name@example.com.'
        }
      : { tone: 'bad', text: 'Required', say: `Enter the email address to send ${noun} emails to.` }
    : unconfirmed
      ? {
          tone: 'bad',
          text: 'May have saved',
          say: `No answer from Cloudflare: the ${noun} may have been created. Check this account before trying again.`
        }
      : phase.kind === 'failed'
        ? {
            tone: 'bad',
            text: 'Didn’t save',
            say: `Didn’t save: ${failureReason(phase.reason)}. ${saving ? `The ${noun} wasn’t changed` : 'Nothing was created'}. Try again.`
          }
        : phase.kind === 'editing' && phase.deleted
          ? {
              tone: '',
              text: 'Deleted',
              say: `The ${noun} was deleted. Nothing will happen at the line.`
            }
          : null
  const submit = async () => {
    if (locked || !app) return
    setTouched(true)
    if (!EMAIL.test(address)) return refs.email.current?.focus()
    const caps = app.getHostCapabilities()
    setPhase({ kind: 'sending' })
    const call: CallTool = (c) => app.callServerTool(c)
    if (saving && made) {
      const saved = await updateSetting(call, target, p.accountId, made, policy).catch(
        (error: unknown) => ({ status: 'refused' as const, error: String(error) })
      )
      if (saved.status === 'done') {
        // A spend policy's update returns its next version, which the next write must send.
        setMade(saved.ref ? { ...made, ...saved.ref } : made)
        tell(
          `${capital(noun)} ${made.id} updated: it ${does} when ${what}. The user clicked ${action.save} in the ${preset.toolName} App. It's done: don't change it again or ask to confirm it.`
        )
        createdAt.current = performance.now()
        return settle({ kind: 'created' })
      }
      return fail(
        saved.status === 'unavailable' ? `this connection can’t update the ${noun}` : saved.error
      )
    }
    if (caps?.serverTools) {
      const created = await createSetting(call, target, p.accountId, policy).catch(
        (error: unknown) => ({ status: 'refused' as const, error: String(error) })
      )
      if (created.status === 'done') {
        // Tell the model, so it doesn't offer to create it again.
        tell(
          `${capital(noun)} created${created.ref ? ` (${created.ref.id})` : ''}: it ${does} when ${what}. The user clicked ${action.create} in the ${preset.toolName} App. It's done: don't create it again or ask to confirm it.`
        )
        setMade(created.ref ?? null)
        createdAt.current = performance.now()
        return settle({ kind: 'created' })
      }
      if (created.status === 'refused') return fail(created.error)
      if (created.status === 'unknown') {
        tell(
          `${action.create} got no answer from Cloudflare (${failureReason(created.error)}): the ${noun} may have been created on account ${p.accountId}. Before creating it again, list the account's ${target.kind === 'spend_policy' ? 'spend policies' : 'notification policies'} and check for "${name}".`
        )
        return fail(created.error, true)
      }
    }
    if (!caps?.message) return settle({ kind: 'review' })
    try {
      if (caps.updateModelContext)
        await app.updateModelContext({
          content: [
            {
              type: 'text',
              text: `Not created yet: the user confirmed this ${noun} in the ${preset.toolName} App. Create it only with a write the user approves, exactly as written:\n${request}`
            }
          ]
        })
      const result = await app.sendMessage({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Create the ${noun} on account ${p.accountId}: it ${does} when ${what}.`
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
    if (!app || !made || undoing || performance.now() - createdAt.current < 500) return
    setPhase({ kind: 'created', undo: 'deleting' })
    const deleted = await deleteSetting(
      (c) => app.callServerTool(c),
      target,
      p.accountId,
      made
    ).catch((error: unknown) => ({ status: 'refused' as const, error: String(error) }))
    if (deleted.status !== 'done') {
      const failed = deleted.status === 'refused' ? failureReason(deleted.error) : 'try again'
      return setPhase({ kind: 'created', undo: { failed } })
    }
    tell(
      `${capital(noun)} ${made.id} deleted: no ${noun} from this card exists now. The user clicked Undo in the ${preset.toolName} App. Don't recreate it unless the user asks.`
    )
    setMade(null)
    setPhase({ kind: 'editing', deleted: true })
    requestAnimationFrame(() => refs.create.current?.focus({ preventScroll: true }))
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
        style={
          {
            insetInlineStart: pct(w.offset),
            inlineSize: pct(w.length),
            '--d': `${delay(i)}ms`
          } as CSSProperties
        }
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
          <CloudflareLogo variant="glyph" className="cf" aria-hidden />
          <div>
            <h2 className="title" id={ids.title}>
              {action.title}
            </h2>
          </div>
        </header>
        <div className="chart">
          <div
            className="hc"
            ref={refs.plot}
            role="group"
            aria-label={copy.chartLabel}
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
                  Typical<i className="wk"> {copy.bucket}</i> <b>{sig(m.typical)}</b>
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
              {ready && bars(false)}
            </div>
            <div className="hc-hot" ref={refs.hot} aria-hidden="true">
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
                    <p id={ids.sub}>{copy.source} didn’t answer. Nothing was changed.</p>
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
            <div className="hc-line" ref={refs.line}>
              <div
                className="hc-knob"
                ref={refs.knob}
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
          </div>
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
            ref={refs.tip}
            data-show={tip != null || undefined}
            aria-hidden="true"
          >
            {tip != null && m.weeks[tip] && tipBody(m, m.weeks[tip], limit, preset)}
          </div>
        </div>
        {/* The outcome reads as the chart's legend: grey for past periods, blue for now. */}
        {facts && (
          <p className="sub" id={ids.sub} aria-live="polite">
            <FactLine fact={facts[0]} slot="past" />
            <FactLine fact={facts[1]} slot="now" />
          </p>
        )}
        {/* A create with no answer may have been made: say so where everyone sees it, before Create anyway. */}
        {unconfirmed && (
          <p className="note" data-tone="bad">
            No answer from Cloudflare, so this {noun} may already exist. Check this account before
            creating it again.
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
              if (phase.kind === 'failed' && !unconfirmed) setPhase(EDITING)
            }}
          >
            {preset.actions.map((a) => (
              <Radio.Item key={a.id} value={a.id} label={a.label} />
            ))}
          </Radio.Group>
        )}
        {/* What a setting that stops something does, said before Create, where it can't be missed. */}
        {ready && action.caution && (
          <p className="note" data-tone="warn">
            {action.caution}
          </p>
        )}
        {ready && existing.length > 0 && (
          <p className="note">
            Already on this account:{' '}
            {existing.map((a, i) => (
              <span key={i}>
                {i > 0 && '; '}
                {/* A name someone typed, in any script: isolated so it can't reorder what's around it. */}
                <bdi>{a.name}</bdi>
                {a.limit ? ` (${approx(a.limit, 2)})` : ''}
                {a.enabled ? '' : ', off'}
              </span>
            ))}
          </p>
        )}
      </LayerCard.Primary>
      {/* An alert this account can't create has nothing to fill in: no form, not a disabled one. */}
      {view !== 'unavailable' && (
        <div className="foot">
          <div className="f-layer f-form" inert={done}>
            <label className="to">
              <span className="to-l">To</span>
              <input
                ref={refs.email}
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
                  // A create with no answer stays unconfirmed: editing the address doesn't settle it.
                  if (
                    phase.kind === 'editing'
                      ? phase.deleted
                      : !unconfirmed && phase.kind === 'failed'
                  )
                    setPhase(EDITING)
                }}
                onBlur={() => address && setTouched(true)}
                // Not after a create that got no answer: sending it again takes the button's own click.
                onKeyDown={(e) => e.key === 'Enter' && !unconfirmed && submit()}
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
              ref={refs.create}
              variant="primary"
              className="create"
              loading={phase.kind === 'sending'}
              disabled={!ready}
              onClick={submit}
            >
              {unconfirmed
                ? 'Create anyway'
                : phase.kind === 'failed'
                  ? 'Try again'
                  : saving
                    ? action.save
                    : action.create}
            </Button>
            <p className="sr" id={ids.err} role="alert">
              {hint?.say}
            </p>
          </div>
          <div className="f-layer f-done" inert={!done}>
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
                {phase.kind === 'created'
                  ? action.done
                  : phase.kind === 'review'
                    ? 'Ready to create'
                    : 'Sent to chat'}
              </span>
              <span
                className="done-2"
                data-tone={undoFailed ? 'bad' : undefined}
                title={
                  undoFailed
                    ? `Didn’t delete: ${undoFailed}`
                    : `Past ${fmt(limit)} ${copy.per} · ${address}`
                }
              >
                {undoing ? (
                  'Deleting…'
                ) : undoFailed ? (
                  'Didn’t delete. Try again.'
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
                  onClick={onUndo}
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
                  requestAnimationFrame(() => refs.knob.current?.focus({ preventScroll: true }))
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

/** Cloudflare's reason for a refused create, short enough for one line: its message, not the whole tool error. */
function failureReason(text: string): string {
  const message = /"message"\s*:\s*"([^"]+)"/.exec(text)?.[1]
  return (message ?? (text.split('\n').find(Boolean) || 'try again')).slice(0, 120)
}

const plain = (parts: readonly FactPart[]) =>
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
  if (toolName === R2_STORAGE_BILLING.toolName)
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
  renderError: (_text, retry, toolName) => (
    <UsageAlertCard
      key="error"
      preview={placeholder(toolName)}
      app={undefined}
      pending={{ kind: 'error', retry }}
    />
  ),
  copy: {
    pending: 'Reading usage…',
    cancelled: 'Usage check cancelled.',
    malformed: 'Usage could not be displayed. Check the tool’s text result.'
  }
})
