/**
 * A stand-in browser for replaying D1Copy.tla paths against the real code:
 * fake window timers, a fake clipboard whose calls the test answers one at a
 * time, and a one-component hook runner that renders the real Trio (no DOM).
 */
import { mock } from 'bun:test'
import * as React from 'react'

const repo = new URL('../../../../', import.meta.url).pathname
/** src/d1-studio under test; D1_COPY_SRC points the replay at a scratch copy. */
export const src = process.env.D1_COPY_SRC ?? `${repo}src/d1-studio`
// The app module mounts itself on import; the replay renders Trio by hand instead.
mock.module(`${src}/../mcp-apps/app-shell/mount.tsx`, () => ({ mountMcpApp: () => {} }))

// ── timers (window.setTimeout in copy.tsx and Trio) ──
let now = 0
let nextTimer = 1
const timers = new Map<number, { at: number; fn: () => void }>()
const fakeWindow = {
  setTimeout: (fn: () => void, ms = 0) => {
    const id = nextTimer++
    timers.set(id, { at: now + ms, fn })
    return id
  },
  clearTimeout: (id: number) => void timers.delete(id)
}
/** Let every pending promise continuation run (one JavaScript task's microtasks, and the next few). */
export const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r))
}
/** Advance the clock, firing due timers in time order. */
export async function advance(ms: number) {
  const end = now + ms
  for (;;) {
    const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
    if (!due) break
    timers.delete(due[0])
    now = due[1].at
    due[1].fn()
    await settle()
  }
  now = end
}

// ── clipboard ──
export type Sandbox = 'open' | 'noWrite' | 'closed'
interface Call {
  readonly item: Record<string, Promise<Blob>>
  resolve: () => void
  reject: (e: unknown) => void
  answered: boolean
}
export const host = {
  sandbox: 'open' as Sandbox,
  calls: [] as Call[],
  /** What the clipboard holds. */
  text: undefined as string | undefined,
  /** HostWrites: write call k (1-based) once its item's text has resolved. */
  async writes(k: number) {
    const c = host.calls[k - 1]!
    if (c.answered) throw new Error(`write ${k} already answered`)
    c.answered = true
    try {
      const blob = await c.item['text/plain']!
      host.text = await blob.text()
      c.resolve()
    } catch (e) {
      c.reject(e)
    }
    await settle()
  },
  /** ItemRejects: the item's text rejected, so the host rejects the write. */
  async itemRejects(k: number) {
    const c = host.calls[k - 1]!
    c.answered = true
    await c.item['text/plain']!.then(
      () => {
        throw new Error(`write ${k}'s text resolved`)
      },
      (e) => c.reject(e)
    )
    await settle()
  },
  /** HostRefuses: the sandbox refuses write call k; write() falls back to writeText / execCommand. */
  async refuses(k: number) {
    const c = host.calls[k - 1]!
    c.answered = true
    c.reject(new DOMException('Write permission denied.', 'NotAllowedError'))
    await settle()
  }
}
class FakeClipboardItem {
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}
const clipboard = {
  write: (items: FakeClipboardItem[]) =>
    new Promise<void>((resolve, reject) => {
      const item = items[0]!.items
      // A rejected item text that nobody awaits yet must not crash the run.
      item['text/plain']!.catch(() => undefined)
      host.calls.push({ item, resolve, reject, answered: false })
    }),
  writeText: async (t: string) => {
    if (host.sandbox !== 'noWrite') throw new DOMException('Blocked', 'NotAllowedError')
    host.text = t
  }
}
const fakeDocument = {
  body: { append: () => {} },
  createElement: () => ({
    value: '',
    style: {} as Record<string, string>,
    setAttribute: () => {},
    select: () => {},
    remove: () => {}
  }),
  execCommand: () => false
}
Object.assign(globalThis, { window: fakeWindow, ClipboardItem: FakeClipboardItem, document: fakeDocument })
Object.defineProperty(globalThis.navigator, 'clipboard', { value: clipboard, configurable: true })

export function reset() {
  timers.clear()
  now = 0
  host.sandbox = 'open'
  host.calls = []
  host.text = undefined
}

// ── a one-component hook runner (useReducer, useEffect, useRef, useState, useSyncExternalStore) ──
type Hook = { value?: unknown; deps?: readonly unknown[]; cleanup?: (() => void) | void; unsub?: () => void }
const internals = (React as unknown as Record<string, { H: unknown }>)
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!

export interface Mounted<P> {
  /** The element tree of the last render. */
  tree: React.ReactElement
  render: () => void
  props: P
}

export function mount<P>(component: (p: P) => React.ReactNode, props: P, ref?: unknown): Mounted<P> {
  const hooks: Hook[] = []
  let i = 0
  let effects: (() => void)[] = []
  const m = { props } as Mounted<P>
  const rerender = () => m.render()
  const dispatcher = {
    useReducer(reducer: (s: unknown, e: unknown) => unknown, init: unknown) {
      const h = (hooks[i++] ??= { value: init })
      const dispatch = (e: unknown) => {
        h.value = reducer(h.value, e)
        rerender()
      }
      return [h.value, dispatch]
    },
    useState(init: unknown) {
      const h = (hooks[i++] ??= { value: typeof init === 'function' ? (init as () => unknown)() : init })
      const set = (v: unknown) => {
        h.value = typeof v === 'function' ? (v as (x: unknown) => unknown)(h.value) : v
        rerender()
      }
      return [h.value, set]
    },
    useRef(init: unknown) {
      const h = (hooks[i++] ??= { value: { current: ref ?? init } })
      return h.value
    },
    useEffect(fn: () => (() => void) | void, deps?: readonly unknown[]) {
      const h = (hooks[i++] ??= {})
      const changed = !deps || !h.deps || deps.some((d, k) => !Object.is(d, h.deps![k]))
      if (!changed) return
      h.deps = deps
      effects.push(() => {
        if (typeof h.cleanup === 'function') h.cleanup()
        h.cleanup = fn()
      })
    },
    useSyncExternalStore(subscribe: (l: () => void) => () => void, get: () => unknown) {
      const h = (hooks[i++] ??= {})
      h.unsub ??= subscribe(rerender)
      return get()
    }
  }
  m.render = () => {
    const prev = internals.H
    internals.H = dispatcher
    i = 0
    try {
      m.tree = component(m.props) as React.ReactElement
    } finally {
      internals.H = prev
    }
    const run = effects
    effects = []
    run.forEach((e) => e())
  }
  m.render()
  return m
}

/** Read the global toast through the real useCopyToast hook. */
export function readToast<T>(useCopyToast: () => T): T {
  const prev = internals.H
  internals.H = { useSyncExternalStore: (_s: unknown, get: () => T) => get() }
  try {
    return useCopyToast()
  } finally {
    internals.H = prev
  }
}
