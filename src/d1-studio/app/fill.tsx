/**
 * Filling a host frame taller than the card. ChatGPT draws an App's frame at
 * least ~200 px tall; a card shorter than that would leave an empty band
 * under it. One rule for every short
 * card: the slack (the frame's height less the card's own, measured from the
 * committed layout without what the card already took, so taking it never
 * changes it) goes, in order:
 *
 * - closed, a result: a peek of its first whole rows (at most 2), drawn from
 *   the card's bottom edge up; the peek opens the rows.
 * - closed, otherwise (or no row fits): one more line of content where it
 *   fits whole (the failed card's fix, the answer's "Fixes query 3"), then the
 *   recessed band with the card's stats and ways out, BAND_MIN (34 px) where
 *   the slack holds it, else BAND_SLIM (28 px).
 * - edited: the agent's band under the action row.
 *
 * What is left is spread, never pooled, each space up to its cap (16 px, the
 * editor's blank 20). The band is always the card's last element; nothing goes
 * under it. In a frame of the card's own height (Claude) the slack is 0 and
 * nothing changes.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

// ── The filler. One rule for every short card in a frame taller than itself. The slack is what
//    the frame's minimum (in the App, the iframe's) leaves the card in its compact form: measured from the committed DOM
//    without what the card already took, so taking it never changes it.
//    'closed': a result with whole rows under the SQL shows a peek (at most 2); else the content line (where it fits
//    whole, with a 34 px band under it), then the band.
//    'edit': the band under the action row.
//    The band is one height, BAND_MIN where the slack holds it, else BAND_SLIM; its row is
//    centred. A closed card with less room than BAND_SLIM grows to it. An edited card makes BAND_SLIM's missing px from
//    the space between the head's last line and the SQL (down to HEAD_GAP_MIN), then the raised panel's top inset (down
//    to TOP_INSET_MIN); where even that can't, no band. The slack left is spread, never pooled, each step up to its cap:
//    the space between the raised panel's content and its edge (GAP_CAP; a wrapped note is centred first), the
//    closed card's content lines (LINE_CAP each, the smallest first), the editor (EDITOR_BLANK_CAP below its last line),
//    then the card's bottom edge (≤ 16 px). In a frame of the card's height (Claude) the slack is 0 and nothing changes. ──
export const ROW_H = 30
/** The table's header row and the hairline over it. */
const HEAD_H = 31
/** The band: a 16 px row and 9 px of tray above and below. */
const BAND_MIN = 34
/** The band where BAND_MIN can't be made: a 16 px row and 6 px above and below. */
const BAND_SLIM = 28
/** The least space between the head's last line of text and the SQL, and the raised panel's least top inset. */
const HEAD_GAP_MIN = 6
const TOP_INSET_MIN = 4
/** The spread's caps, each one spacer: the panel's content to its edge (and a note's space above), a closed card's
 *  content line to the one above it, the editor's blank under its last line. */
const GAP_CAP = 16
const LINE_CAP = 16
const EDITOR_BLANK_CAP = 20
/** One more line of content under the state line (`.b18-rich` is exactly this tall). */
export const RICH_H = 24
/** The failed card's fix line: D1's words move to their own line, the hint and its button follow (+ 24 px at 560). */
export const FIX_H = 24
/** What the card takes from the slack, in px. `hg` / `ti`: taken from the head's gap and the panel's top inset for
 *  BAND_SLIM. `gap`: added under the panel's content; `note`: an edited card's wrapped note moved up (≤ 0, the px go to
 *  `gap`); `lines`: above each of a closed card's content lines; `grow`: to the editor. `slot`: a write card's
 *  one-line note grown to its two-line slot, and `slotDy`, its line moved down in it; `top` / `head`: added to the panel's top inset and to the gap between the
 *  head and the SQL. Nothing goes under the band: it is the card's last element, at its one height. */
export type Plan = {
  rich: boolean
  tight: boolean
  band: number
  hg: number
  ti: number
  slot: number
  slotDy: number
  gap: number
  note: number
  lines: number[]
  grow: number
  top: number
  head: number
}
export const NO_PLAN: Plan = {
  rich: false,
  tight: false,
  band: 0,
  hg: 0,
  ti: 0,
  slot: 0,
  slotDy: 0,
  gap: 0,
  note: 0,
  lines: [],
  grow: 0,
  top: 0,
  head: 0
}
const samePlan = (a: Plan, b: Plan) =>
  a.rich === b.rich &&
  a.tight === b.tight &&
  a.band === b.band &&
  a.hg === b.hg &&
  a.ti === b.ti &&
  a.slot === b.slot &&
  a.slotDy === b.slotDy &&
  a.gap === b.gap &&
  a.note === b.note &&
  a.lines.join() === b.lines.join() &&
  a.grow === b.grow &&
  a.top === b.top &&
  a.head === b.head
/** What the plan sets on the raised panel, as absolute px (so each rule applies only where the card took something). Set
 *  here, not in React's style, so they always pair the committed plan with the spaces measured without it. */
const FILL_VARS = [
  '--fill-hg',
  '--fill-hd',
  '--fill-ti',
  '--fill-pb',
  '--fill-nt',
  '--fill-slot',
  '--fill-slot-dy',
  '--fill-m1',
  '--fill-m2',
  '--fill-m3'
]
function applyVars(panel: HTMLElement, plan: Plan, base: Room) {
  const v: Record<string, number> = {}
  if (plan.hg) v['--fill-hg'] = plan.hg
  if (plan.head) v['--fill-hd'] = base.headMargin + plan.head
  if (plan.ti || plan.top) v['--fill-ti'] = base.top - plan.ti + plan.top
  if (plan.slot) {
    // The slot is the two-line note's box; the one line sits in the middle of the white around it.
    v['--fill-slot'] = base.noteBox + plan.slot
    v['--fill-slot-dy'] = plan.slotDy
  }
  if (plan.gap) v['--fill-pb'] = base.pad + plan.gap
  if (plan.note) v['--fill-nt'] = base.noteMargin + plan.note
  plan.lines.forEach((n, i) => {
    if (n && i < 3) v[`--fill-m${i + 1}`] = (base.lineMargins[i] ?? 0) + n
  })
  for (const k of FILL_VARS)
    if (k in v) panel.style.setProperty(k, `${v[k]}px`)
    else panel.style.removeProperty(k)
}
/** The card's spaces as they are without the plan: what each step can take up to its cap. */
type Room = {
  slack: number
  narrow: boolean
  /** The px BAND_SLIM can take from the head's gap and the panel's top inset. */
  giveHg: number
  giveTi: number
  /** The panel's top padding and bottom padding. */
  top: number
  pad: number
  /** The panel's content to its edge: the box's gap and the spacer a reader sees (from the content's last ink). */
  gap: number
  gapSeen: number
  /** An edited card's note: its margin; its text's space above (to the editor's text) and below (to the panel's edge);
   *  whether it wraps. -1: no note. */
  noteMargin: number
  noteAbove: number
  noteBelow: number
  noteWraps: boolean
  /** The note is a write card's (sending, timeout, sent, no-send host). */
  noteWrite: boolean
  /** A write card's one-line note: its box, top padding and line height, and the px that make it the two-line
   *  note's box (0: no write note, or it already wraps). */
  noteBox: number
  notePad: number
  noteLine: number
  slotNeed: number
  /** A closed card's content lines: each one's margin, its box's gap to what is above it and the spacer seen. */
  lineMargins: number[]
  lineGaps: number[]
  lineSeen: number[]
  /** The editor's blank under its last line. */
  blank: number
  /** The panel's top inset (its edge to the head's text) and the head's text to the SQL, as seen and as boxes;
   *  the SQL's own margin. -1: not measured. */
  topSeen: number
  headSeen: number
  headBox: number
  headMargin: number
}
const NO_ROOM: Room = {
  slack: 0,
  narrow: false,
  giveHg: 0,
  giveTi: 0,
  top: 0,
  pad: 0,
  gap: 0,
  gapSeen: 0,
  noteMargin: 0,
  noteAbove: -1,
  noteBelow: -1,
  noteWraps: false,
  noteWrite: false,
  noteBox: 0,
  notePad: 0,
  noteLine: 0,
  slotNeed: 0,
  topSeen: -1,
  headSeen: -1,
  headBox: 0,
  headMargin: 0,
  lineMargins: [],
  lineGaps: [],
  lineSeen: [],
  blank: -1
}
const sameRoom = (a: Room, b: Room) => JSON.stringify(a) === JSON.stringify(b)
/** A step's slot: the spacer a reader sees now, up to the cap there and in the box (whichever comes first). */
const slot = (seen: number, box: number, cap: number) => ({
  now: seen,
  cap: Math.min(cap, seen + cap - box)
})
/** Spread `left` px over slots, the smallest first (so equal slots stay balanced), none past its cap. */
function spread(left: number, slots: { now: number; cap: number }[]) {
  const add = slots.map(() => 0)
  for (; left > 0; left--) {
    let best = -1
    for (let i = 0; i < slots.length; i++) {
      const v = slots[i]!.now + add[i]
      if (v < slots[i]!.cap && (best < 0 || v < slots[best]!.now + add[best])) best = i
    }
    if (best < 0) break
    add[best]++
  }
  return add
}
/** The band's one height, and the slack left spread in the order above. */
function planOf(
  mode: 'closed' | 'edit',
  r: Room,
  base: Pick<Plan, 'rich' | 'tight' | 'slot'>,
  slack: number
): Plan {
  // A write card's one-line note in its two-line slot is planned as the two-line note it stands in for (its text
  // and the content's last ink end a line lower), so every send state gets the same plan.
  const lower = base.slot ? base.slot - r.noteLine : 0
  const noteBelow = r.noteBelow + lower
  const gapSeen = r.gapSeen + lower
  // An edited card's wrapped note sits optically centred between the editor's text and the panel's edge (the space
  // above its text reads ~2 px larger than the same space below): it moves up, and the px it frees go under it.
  const note = mode === 'edit' && r.noteAbove >= 0
  const lift =
    note && (r.noteWraps || base.slot > 0)
      ? Math.max(0, Math.min(Math.round((r.noteAbove - noteBelow + 2) / 2), r.noteAbove - 2))
      : 0
  let band = slack >= BAND_MIN ? BAND_MIN : BAND_SLIM
  let hg = 0
  let ti = 0
  if (mode === 'edit' && band === BAND_SLIM && slack < BAND_SLIM) {
    const need = BAND_SLIM - slack
    if (slack > 0 && need <= r.giveHg + r.giveTi) {
      hg = Math.min(need, r.giveHg)
      ti = need - hg
    } else band = 0
  }
  let left = Math.max(0, band ? slack - band : slack)
  // Step 4 first in a write card: its slot holds a one-line note or a two-line one, and the one line's white
  // (both lines' spaces plus the line it doesn't use) stays within GAP_CAP on each side only if the gap under the note
  // stays small, so the editor takes its px before the gap does.
  const editorGrow = (n: number) =>
    mode === 'edit' && r.blank >= 0 ? Math.min(n, Math.max(0, EDITOR_BLANK_CAP - r.blank)) : 0
  const writeFirst = mode === 'edit' && r.noteWrite ? editorGrow(left) : 0
  left -= writeFirst
  // Step 2: the panel's content (an edited card's note stays with the SQL it is about) to its edge.
  const g = slot(gapSeen + lift, r.gap + lift, GAP_CAP)
  const gap = Math.min(left, Math.max(0, g.cap - g.now))
  left -= gap
  // Step 3: a closed card's content lines, the smallest gap first.
  const lines =
    mode === 'closed'
      ? spread(
          left,
          r.lineGaps.map((b, i) => slot(r.lineSeen[i]!, b, LINE_CAP))
        )
      : []
  left -= lines.reduce((a, b) => a + b, 0)
  // Step 4: the editor, to EDITOR_BLANK_CAP under its last line.
  const grow = writeFirst || editorGrow(left)
  if (!writeFirst) left -= grow
  // Step 5: what is left stays in the white panel, never under the band: the panel's top inset, the head's text to
  // the SQL and the content to the panel's edge, the smallest first, each to GAP_CAP. Past every cap (no card here
  // reaches it) the same three take it evenly, so the frame still shows no gap.
  const rest: { now: number; cap: number }[] = [
    r.topSeen >= 0 ? { now: r.topSeen, cap: GAP_CAP } : { now: 0, cap: 0 },
    r.headSeen >= 0 ? slot(r.headSeen, r.headBox, GAP_CAP) : { now: 0, cap: 0 },
    { now: g.now + gap, cap: g.cap }
  ]
  const add = spread(left, rest)
  left -= add[0] + add[1] + add[2]
  if (left > 0) {
    const over = spread(
      left,
      rest.map((s, i) => ({ now: s.now + add[i], cap: s.cap > 0 ? Infinity : 0 }))
    )
    over.forEach((n, i) => (add[i] += n))
  }
  // The one-line note in the slot: down to the middle of the white between the editor and the panel's edge (the
  // half px up, so it stays with the SQL it is about).
  const slotDy = base.slot
    ? Math.max(0, Math.floor((g.now + gap + add[2] + r.noteLine - (r.noteAbove - lift)) / 2))
    : 0
  return {
    ...base,
    slotDy,
    band,
    hg,
    ti,
    gap: gap + lift + add[2],
    note: -lift,
    lines: lines.some(Boolean) ? lines : [],
    grow,
    top: add[0],
    head: add[1]
  }
}
export function Fill({
  mode,
  peekable,
  max,
  peek,
  band,
  label,
  onFilled,
  onOpen,
  plan,
  onPlan,
  richH = 0,
  richTight = false
}: {
  mode: 'closed' | 'edit'
  peekable: boolean
  max: number
  peek: (n: number) => ReactNode
  band: ReactNode
  label: string
  onFilled: (what: string) => void
  onOpen: () => void
  plan: Plan
  onPlan: (p: Plan) => void
  /** The content line this card can add, in px (0: none). */
  richH?: number
  /** The line costs nothing where the state line already wraps (the failed card at 352). */
  richTight?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [m, setM] = useState<Room>(NO_ROOM)
  const planRef = useRef(plan)
  planRef.current = plan
  const readRef = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    const el = ref.current
    const card = el?.closest<HTMLElement>('section.dq')
    if (!el || !card) return
    const read = (readRef.current = () => {
      const p = planRef.current
      // The frame is the iframe: the host's minimum height, which the view never reports as its own (useHostSize).
      const min = window.innerHeight
      const cs = getComputedStyle(card)
      const z = 1
      const top = (e: Element) => e.getBoundingClientRect().top / z
      const bottom = (e: Element) => e.getBoundingClientRect().bottom / z
      const shown = (e: Element) => e.getBoundingClientRect().height / z > 1 && !e.matches('.dq-sr')
      let natural =
        parseFloat(cs.paddingTop) +
        parseFloat(cs.paddingBottom) +
        parseFloat(cs.borderTopWidth) +
        parseFloat(cs.borderBottomWidth)
      for (const c of Array.from(card.children) as HTMLElement[]) {
        if (c === el) continue
        const ccs = getComputedStyle(c)
        natural +=
          c.getBoundingClientRect().height / z +
          parseFloat(ccs.marginTop) +
          parseFloat(ccs.marginBottom)
      }
      const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
      natural -=
        (p.rich && !p.tight ? richH : 0) +
        p.slot +
        p.gap +
        p.note +
        sum(p.lines) +
        p.grow +
        p.top +
        p.head -
        p.hg -
        p.ti
      // Down to the whole px, so what the card takes never passes the frame's minimum by a rounding.
      const slack = Math.max(0, Math.floor(min - natural + 0.01))
      const narrow = card.getBoundingClientRect().width / z < 440
      const r: Room = { ...NO_ROOM, slack, narrow, lineMargins: [], lineGaps: [], lineSeen: [] }
      // What a reader sees of an element: its text, icons and controls, and the SQL's drawn box.
      const ink = (e: Element) => {
        let t = Infinity
        let b = -Infinity
        const take = (q: DOMRect) => {
          if (q.height <= 1 || q.width <= 1) return
          t = Math.min(t, q.top / z)
          b = Math.max(b, q.bottom / z)
        }
        if (e.matches('.dq-sql-cell, .dq-editor')) take(e.getBoundingClientRect())
        const tw = document.createTreeWalker(e, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
        for (let n = tw.nextNode(); n; n = tw.nextNode()) {
          if (n.nodeType === Node.TEXT_NODE) {
            if (!n.textContent?.trim() || n.parentElement?.closest('.dq-sr, textarea')) continue
            const range = document.createRange()
            range.selectNodeContents(n)
            for (const q of Array.from(range.getClientRects())) take(q)
            continue
          }
          const x = n as Element
          const q = x.getBoundingClientRect()
          if (
            x.matches('svg, .dq-sql-cell, .dq-editor') ||
            (x.tagName === 'BUTTON' && q.height / z <= 40)
          )
            take(q)
        }
        return { top: t, bottom: b }
      }
      const panel = card.querySelector<HTMLElement>(':scope > .dq-receipt')
      if (panel) {
        const pcs = getComputedStyle(panel)
        r.top = parseFloat(pcs.paddingTop) + p.ti - p.top
        r.pad = parseFloat(pcs.paddingBottom) - p.gap
        const kids = (Array.from(panel.children) as HTMLElement[]).filter(shown)
        const last = kids[kids.length - 1]
        // A write note in its slot has its line `slotDy` low and the panel a slot low: measured without them.
        const slotLow = p.slot - p.slotDy
        if (last) {
          r.gap = Math.round(bottom(panel) - bottom(last) - p.gap)
          r.gapSeen = Math.round(bottom(panel) - ink(last).bottom - p.gap - slotLow)
        }
        // The head's text (not its controls' boxes) to the panel's top edge and to the SQL under it.
        const head = kids[0]
        const sqlBox = kids[1]
        if (head?.matches('.dq-head') && sqlBox?.matches('.dq-cell, .dq-full')) {
          let t = Infinity
          let b = -Infinity
          const tw = document.createTreeWalker(head, NodeFilter.SHOW_TEXT)
          for (let n = tw.nextNode(); n; n = tw.nextNode()) {
            const at = n.parentElement
            if (!n.textContent?.trim() || !at || at.closest('.dq-sr, .dq-countsizer')) continue
            if (getComputedStyle(at).visibility === 'hidden') continue
            const range = document.createRange()
            range.selectNodeContents(n)
            for (const q of Array.from(range.getClientRects())) {
              if (q.height <= 1 || q.width <= 1) continue
              t = Math.min(t, q.top / z)
              b = Math.max(b, q.bottom / z)
            }
          }
          if (b > t) {
            r.topSeen = Math.round(t - top(panel) - p.top + p.ti)
            r.headSeen = Math.round(ink(sqlBox).top - b - p.head + p.hg)
            r.headBox = Math.round(top(sqlBox) - bottom(head) - p.head + p.hg)
            r.headMargin = parseFloat(getComputedStyle(sqlBox).marginTop) - p.head + p.hg
          }
        }
        if (mode === 'closed') {
          // The content lines: the raised panel's own lines under the SQL.
          kids.forEach((k, i) => {
            if (i === 0 || !k.matches('p.dq-line2')) return
            const j = r.lineGaps.length
            const added = p.lines[j] ?? 0
            r.lineMargins.push(parseFloat(getComputedStyle(k).marginTop) - added)
            r.lineGaps.push(Math.round(top(k) - bottom(kids[i - 1]!) - added))
            r.lineSeen.push(Math.round(ink(k).top - ink(kids[i - 1]!).bottom - added))
          })
        }
        const editor = panel.querySelector<HTMLElement>('.dq-full .dq-editor')
        if (mode === 'edit' && editor) {
          // BAND_SLIM's px: the head's gap above the SQL to HEAD_GAP_MIN, then the top inset to TOP_INSET_MIN.
          let text = 0
          for (const t of Array.from(
            panel.querySelectorAll(
              '.dq-head .dq-titletext, .dq-head .dq-count > span, .dq-head .dq-swap'
            )
          ))
            if (t.getBoundingClientRect().height > 0) text = Math.max(text, bottom(t))
          if (text) r.giveHg = Math.max(0, Math.floor(top(editor) - text + p.hg - HEAD_GAP_MIN))
          r.giveTi = Math.max(0, Math.floor(r.top - TOP_INSET_MIN))
          const note = editor.parentElement?.querySelector<HTMLElement>(':scope > .s5-line')
          if (note && shown(note)) {
            const words = note.querySelector(':scope > .s5-text, :scope > .s5-studio')
            const range = document.createRange()
            range.selectNodeContents(words ?? note)
            const t = range.getBoundingClientRect()
            r.noteMargin = parseFloat(getComputedStyle(note).marginTop) - p.note
            r.noteAbove = Math.round(t.top / z - bottom(editor) - p.note - p.slotDy)
            r.noteBelow = Math.round(bottom(panel) - t.bottom / z - p.gap - slotLow)
            r.noteWraps = t.height / z > 30
            r.noteWrite = note.matches('[data-write]')
            if (r.noteWrite && !r.noteWraps && words) {
              // The two-line note's box: its top padding, two lines, and the text's hang below (s5.css).
              const ncs = getComputedStyle(note)
              const wcs = getComputedStyle(words)
              r.noteBox = Math.round(note.getBoundingClientRect().height / z - p.slot)
              r.notePad = parseFloat(ncs.paddingTop)
              r.noteLine = parseFloat(wcs.lineHeight)
              const two = r.notePad + 2 * r.noteLine + parseFloat(wcs.marginBottom)
              r.slotNeed = Math.max(0, Math.round(two - r.noteBox))
            }
          }
          const pre = editor.querySelector('.dq-edpre')
          if (pre) {
            const range = document.createRange()
            range.selectNodeContents(pre)
            r.blank = Math.round(bottom(editor) - range.getBoundingClientRect().bottom / z - p.grow)
          }
        }
      }
      setM((q) => (sameRoom(q, r) ? q : r))
    })
    const ro = new ResizeObserver(read)
    ro.observe(card)
    for (const c of Array.from(card.children)) if (c !== el) ro.observe(c)
    read()
    // The card's plan is shared by both fillers (closed, edit); the one leaving gives it back.
    return () => {
      ro.disconnect()
      const panel = card.querySelector<HTMLElement>(':scope > .dq-receipt')
      if (panel) applyVars(panel, NO_PLAN, NO_ROOM)
      onPlan(NO_PLAN)
    }
  }, [])
  // The plan's px on the raised panel, then the slack is measured again against the committed layout.
  useLayoutEffect(() => {
    const panel = ref.current
      ?.closest('section.dq')
      ?.querySelector<HTMLElement>(':scope > .dq-receipt')
    if (panel) applyVars(panel, plan, m)
  }, [plan, m])
  useLayoutEffect(() => {
    readRef.current()
  }, [plan])
  const { slack } = m
  const n =
    mode === 'closed' && peekable
      ? Math.max(0, Math.min(max, Math.floor((slack - HEAD_H) / ROW_H)))
      : 0
  const usePeek = n >= 1
  const rich =
    mode === 'closed' && !usePeek && slack > 0 && richH > 0
      ? richTight && m.narrow
        ? { rich: true, tight: true }
        : slack >= richH + BAND_MIN
          ? { rich: true, tight: false }
          : { rich: false, tight: false }
      : { rich: false, tight: false }
  // A write card's one-line note takes its two-line slot first, where the frame has the px for it.
  const noteSlot = mode === 'edit' && m.slotNeed > 0 && slack >= m.slotNeed ? m.slotNeed : 0
  const room = slack - (rich.rich && !rich.tight ? richH : 0) - noteSlot
  const next: Plan =
    mode === 'edit'
      ? slack > 0
        ? planOf('edit', m, { ...rich, slot: noteSlot }, room)
        : NO_PLAN
      : usePeek || slack <= 0
        ? NO_PLAN
        : planOf('closed', m, { ...rich, slot: 0 }, room)
  useEffect(() => {
    if (!samePlan(next, plan)) onPlan(next)
  })
  const useBand = plan.band > 0 && !usePeek
  const steps = [
    plan.hg + plan.ti
      ? `${plan.hg + plan.ti} px from the head (${plan.hg} gap, ${plan.ti} inset)`
      : '',
    plan.slot ? `note slot +${plan.slot}` : '',
    plan.gap ? `gap +${plan.gap}` : '',
    plan.note ? `note up ${-plan.note} px` : '',
    plan.lines.length ? `lines +${plan.lines.join('/+')}` : '',
    plan.grow ? `editor +${plan.grow} px` : '',
    plan.top ? `inset +${plan.top}` : '',
    plan.head ? `head +${plan.head}` : ''
  ].filter(Boolean)
  const what = usePeek
    ? `peek ${n} ${n === 1 ? 'row' : 'rows'}${slack - HEAD_H - n * ROW_H > 0 ? ` +${slack - HEAD_H - n * ROW_H} px tray` : ''}`
    : useBand
      ? [
          `${plan.rich ? (plan.tight ? 'fix line on the hint’s line · ' : `+1 line (${richH} px) · `) : ''}band ${plan.band} px`,
          ...steps
        ].join(' · ')
      : steps.length
        ? steps.join(' · ')
        : 'none'
  useEffect(() => {
    onFilled(what.split(' ')[0])
  }, [what, onFilled])
  return (
    <div
      className="a17-fill"
      ref={ref}
      data-mode={mode}
      data-filled={what}
      data-band={useBand ? '' : undefined}
      data-slim={useBand && plan.band === BAND_SLIM ? '' : undefined}
      data-peek={usePeek ? '' : undefined}
      style={
        mode === 'edit'
          ? { flex: 'none', height: plan.band, minHeight: plan.band }
          : useBand
            ? { minHeight: plan.band }
            : undefined
      }
    >
      {usePeek && (
        // One target: the rows' own chevron stays closed (they are a picture of the first rows), and the whole peek
        // opens them, with the tray's hover / focus face.
        <div
          className="a17-fill-in a17-peekbtn"
          role="button"
          tabIndex={0}
          aria-label={label}
          title={label}
          onClick={onOpen}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            onOpen()
          }}
        >
          <div inert>{peek(n)}</div>
        </div>
      )}
      {/* The band keeps its one height; it is the card's last element, with nothing under it. */}
      {useBand && (
        <div className="a17-fill-in" style={{ bottom: 'auto', height: plan.band }}>
          {band}
        </div>
      )}
    </div>
  )
}
