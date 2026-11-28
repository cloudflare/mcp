/**
 * The card copies the whole result from its two buttons and says how it went
 * on the button ({@link copyAllRows}): the inline card draws no toast, as
 * Claude allows no popovers inline. The fullscreen console keeps the toast.
 *
 * The copy toast. The trio copies every row the view holds, in the order
 * shown; when that is less than D1's count the toast says the scope and offers
 * the rest. "Copy all 1,284" reads the rows past those held with `d1_raw` in
 * blocks of COPY_BLOCK under a progress toast and writes them with a
 * promise-backed ClipboardItem, so the click's permission holds while D1
 * answers. Past COPY_CAP rows the offer is "Export in D1 Studio ↗". One toast
 * for every card on the page, and for the console (where it sits in the
 * console instead of at the frame's bottom).
 */
import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { MAX_ROWS, type D1Cell } from '../contract'
import { FORMAT_LABEL, count, serializeRows } from './format'
import type { CopyFormat } from './machines'

/** The most rows "Copy all" reads into the clipboard. */
export const COPY_CAP = 10_000
/** `d1_raw` block size for "Copy all". */
export const COPY_BLOCK = 1_000

type Rows = readonly (readonly D1Cell[])[]

interface ToastState {
  readonly id: number
  readonly text: string
  readonly busy?: boolean
  readonly failed?: boolean
  readonly action?: { readonly label: string; readonly run: () => void }
  /** The console the copy came from: the toast sits in it, not at the frame's bottom. */
  readonly inside?: HTMLElement | null
  /** The copy that completed and the button it came from, so its trio marks ✓ only once it has. */
  readonly done?: { readonly format: CopyFormat; readonly from?: HTMLElement | null }
}

let current: ToastState | null = null
let seq = 0
/**
 * The latest copy the user started. A copy that finishes after a newer one
 * started says nothing, and a Copy all still reading gives up: the clipboard
 * and the toast are the newer copy's.
 */
let latest = 0
const start = () => ++latest
const isLatest = (copy: number) => copy === latest
/**
 * The newest copy whose result the toast has said. Writes land in the order
 * the host answers them, which is the order the clipboard ends in, so a copy
 * speaks when it lands unless a newer one already has. Returns false when it
 * must stay silent (and its trio shows no ✓).
 */
let said = 0
const speaks = (copy: number) => {
  if (copy < said) return false
  said = copy
  return true
}

/** Thrown into a Copy all's text when a newer copy started: its clipboard item then writes nothing. */
class Superseded extends Error {}
let hideTimer = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
function show(s: Omit<ToastState, 'id'>, ms = 4000) {
  current = { ...s, id: ++seq }
  window.clearTimeout(hideTimer)
  if (!s.busy)
    hideTimer = window.setTimeout(() => {
      current = null
      emit()
    }, ms)
  emit()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
/** The toast on screen: no ✓ on a trio while its copy still reads, ✓ once it has written. */
export const useCopyToast = () => useSyncExternalStore(subscribe, () => current)

/** Say something in the toast, as the copy toasts do (Copy SQL, a blocked clipboard). */
export function toast(text: string, from?: HTMLElement | null, failed?: boolean) {
  show({ text, inside: insideOf(from), ...(failed && { failed }) })
}

const insideOf = (from?: HTMLElement | null) => from?.closest<HTMLElement>('.cx') ?? null

/** Write text that may still be on its way. False when the host's sandbox refuses the clipboard. */
async function write(text: Promise<string>): Promise<boolean> {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })
    ])
    return true
  } catch {
    // Older sandboxes allow the selection-based copy when the async API is blocked.
    const value = await text.catch(() => undefined)
    if (value === undefined) return false
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      const area = document.createElement('textarea')
      area.value = value
      area.setAttribute('readonly', '')
      area.style.cssText = 'position:fixed;opacity:0'
      document.body.append(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    }
  }
}

/** Copy text (the SQL) and say so in the toast. */
/** `undefined`: a newer copy has already spoken, so this one says nothing. */
export async function copyText(
  text: string,
  words: string,
  from?: HTMLElement | null
): Promise<boolean | undefined> {
  const copy = start()
  const ok = await write(Promise.resolve(text))
  if (!speaks(copy)) return undefined
  // Only in the console: the inline card says it on the button, with no popover.
  if (insideOf(from)) {
    if (ok) toast(words, from)
    else toast('The host blocked the clipboard', from, true)
  }
  return ok
}

/** How a card's copy of the whole result went. `undefined` from {@link copyAllRows}: a newer copy took over. */
export type CopiedAll =
  | { readonly status: 'copied'; readonly rows: number }
  | { readonly status: 'blocked' }
  | { readonly status: 'failed'; readonly error: string }

/**
 * The card's CSV and JSON: every row of the result and every column, up to
 * COPY_CAP rows. The rows held are written at once; the rest are read with
 * `readRest`, MAX_ROWS at a time, each block counted through `onProgress`
 * (the rows read so far), into one promise-backed ClipboardItem, so the
 * click's permission holds while D1 answers. Without `readRest` (a host
 * that can't run reads) only the rows held are copied, and the button's
 * name says so. A newer copy supersedes one still reading: it writes nothing
 * and resolves `undefined`.
 */
export async function copyAllRows({
  format,
  columns,
  rows,
  total,
  readRest,
  onProgress
}: {
  format: CopyFormat
  columns: readonly string[]
  rows: Rows
  total: number
  readRest?: (offset: number, limit: number) => Promise<Rows>
  onProgress?: (copied: number) => void
}): Promise<CopiedAll | undefined> {
  const copy = start()
  // Its own words from now on: an older copy that lands while this one reads stays silent.
  speaks(copy)
  const want = copyScope(rows.length, total, !!readRest)
  const out: (readonly D1Cell[])[] = rows.slice(0, want)
  const text = (async () => {
    for (let off = out.length; off < want; off += MAX_ROWS) {
      if (!isLatest(copy)) throw new Superseded()
      onProgress?.(off)
      out.push(...(await readRest!(off, Math.min(MAX_ROWS, want - off))))
    }
    if (!isLatest(copy)) throw new Superseded()
    return serializeRows(format, columns, out)
  })()
  const written = await write(text)
  const read = await text.then(
    () => true as const,
    (error: unknown) => error
  )
  if (!isLatest(copy) || !speaks(copy) || read instanceof Superseded) return undefined
  if (read !== true)
    return { status: 'failed', error: read instanceof Error ? read.message : String(read) }
  return written ? { status: 'copied', rows: out.length } : { status: 'blocked' }
}

/** How many rows the card's copy takes: every row, up to COPY_CAP, or only those held when no more can be read. */
export const copyScope = (held: number, total: number, canRead: boolean) =>
  canRead ? Math.max(held, Math.min(total, COPY_CAP)) : held

/**
 * Copy what is held; say the scope; offer the rest.
 *
 * @param readRest - `d1_raw` for one block past what is held, or absent where the host can't run reads.
 * @param openStudio - The dashboard's Studio, or absent where the host can't open links.
 */
export function copyRows({
  format,
  columns,
  rows,
  total,
  contiguous = true,
  readRest,
  openStudio,
  from
}: {
  format: CopyFormat
  columns: readonly string[]
  rows: Rows
  total: number
  contiguous?: boolean
  readRest?: (offset: number, limit: number) => Promise<Rows>
  openStudio?: () => void
  from?: HTMLElement | null
}): Promise<boolean | undefined> {
  const label = FORMAT_LABEL[format]
  const inside = insideOf(from)
  const copy = start()
  return write(Promise.resolve(serializeRows(format, columns, rows))).then((ok) => {
    if (!speaks(copy)) return undefined
    if (!ok) {
      show({ text: 'The host blocked the clipboard', inside, failed: true })
      return false
    }
    if (total <= rows.length) {
      show({
        text: `Copied ${count(rows.length)} ${rows.length === 1 ? 'row' : 'rows'} as ${label}`,
        inside,
        done: { format, from }
      })
      return true
    }
    const scope = `${contiguous ? 'the first ' : ''}${count(rows.length)} of ${count(total)} rows`
    const all = () => {
      const copyAll = start()
      // Its "Reading rows…" speaks now: an older copy landing while it reads stays silent.
      speaks(copyAll)
      show({
        text: `Reading rows ${count(rows.length + 1)}–${count(total)} from D1…`,
        busy: true,
        inside
      })
      const text = (async () => {
        const out = [...rows]
        for (let off = rows.length; off < total; off += COPY_BLOCK) {
          if (!isLatest(copyAll)) throw new Superseded()
          out.push(...(await readRest!(off, Math.min(COPY_BLOCK, total - off))))
        }
        if (!isLatest(copyAll)) throw new Superseded()
        return serializeRows(format, columns, out)
      })()
      void write(text).then(async (written) => {
        const read = await text.then(
          () => true,
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        )
        if (!isLatest(copyAll) || !speaks(copyAll)) return
        if (read !== true) show({ text: `D1 didn’t read the rest: ${read}`, inside, failed: true })
        else if (!written) show({ text: 'The host blocked the clipboard', inside, failed: true })
        else
          show({
            text: `Copied all ${count(total)} rows as ${label}`,
            inside,
            done: { format, from }
          })
      })
    }
    const action =
      total <= COPY_CAP && contiguous && readRest
        ? { label: `Copy all ${count(total)}`, run: all }
        : openStudio
          ? { label: 'Export in D1 Studio ↗', run: openStudio }
          : undefined
    show(
      {
        text: `Copied ${scope} as ${label}`,
        inside,
        done: { format, from },
        ...(action && { action })
      },
      6000
    )
    return true
  })
}

/** The one toast. Mounted once, by the view's root. */
export function CopyToastHost() {
  const t = useSyncExternalStore(subscribe, () => current)
  if (!t) return null
  return createPortal(
    <div
      className="cp-toast"
      key={t.id}
      role="status"
      aria-live="polite"
      data-inside={t.inside ? '' : undefined}
      data-failed={t.failed ? '' : undefined}
    >
      {t.busy ? (
        <span className="dq-spin cp-spin" aria-hidden="true" />
      ) : t.failed ? (
        <WarningCircleIcon size={14} weight="fill" aria-hidden="true" />
      ) : (
        <CheckIcon size={14} weight="bold" aria-hidden="true" />
      )}
      <span className="cp-text">{t.text}</span>
      {t.action && (
        <>
          <span className="cp-dot" aria-hidden="true">
            ·
          </span>
          <button type="button" className="cp-act" onClick={t.action.run}>
            {t.action.label}
          </button>
        </>
      )}
    </div>,
    t.inside ?? document.body
  )
}
