/**
 * Replays of D1Copy.tla paths against the real copy.tsx and Trio, one call per
 * model step (the step name is in each comment). "reproduces" tests assert the
 * bad outcome the model found, so they fail once the code is fixed: then update
 * the model and SKILL.md. "holds" tests assert a rule the model says holds.
 *
 * Run: bun test ./.agents/skills/verify-d1-copy/replay/copy.test.ts
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { advance, host, mount, readToast, reset, settle, src } from './harness'

const copy = await import(`${src}/app/copy.tsx`)
const app = await import(`${src}/app/d1-studio-app.tsx`)

type Cell = string | number | null
type Toast = { text: string; busy?: boolean; failed?: boolean; action?: { label: string; run: () => void } } | null
const toastNow = () => readToast<Toast>(copy.useCopyToast)

const COLUMNS = ['id']
const HELD: Cell[][] = [[1]]
const REST: Cell[][] = [[2], [3]]
const TOTAL = 3

/** A trio on the page: the real Trio rendered by the hook runner, with fake buttons for `from`. */
function trio(readRest: (offset: number, limit: number) => Promise<Cell[][]>) {
  const buttons = new Map<string, object>()
  const group = { contains: (x: unknown) => [...buttons.values()].includes(x as object) }
  const m = mount(app.Trio, { columns: COLUMNS, rows: HELD, total: TOTAL, readRest }, group)
  const segments = () => (m.tree.props as { children: ReactElement[] }).children
  const segment = (f: string) =>
    segments().find((b) => b.key === f)!.props as Record<string, unknown> & { onClick: (e: unknown) => void }
  return {
    /** YouCopyRows: click the trio's segment for format f. */
    async click(f: 'markdown' | 'csv' | 'json') {
      const b = buttons.get(f) ?? { closest: () => null }
      buttons.set(f, b)
      segment(f).onClick({ currentTarget: b })
      await settle()
    },
    /** The ✓ the trio shows (data-on), or null. */
    mark() {
      m.render()
      return segments().find((b) => (b.props as Record<string, unknown>)['data-on'] === '')?.key ?? null
    },
    blocked(f: string) {
      m.render()
      return segment(f)['data-blocked'] === ''
    }
  }
}

/** A D1 read the test answers: D1Answers / D1Fails, or never (D1Hangs). */
function deferredRead() {
  let resolve!: (rows: Cell[][]) => void
  let reject!: (e: Error) => void
  const calls: [number, number][] = []
  const read = (offset: number, limit: number) => {
    calls.push([offset, limit])
    return new Promise<Cell[][]>((res, rej) => {
      resolve = res
      reject = rej
    })
  }
  return { read, calls, answer: () => resolve(REST), fail: (m: string) => reject(new Error(m)) }
}

beforeEach(async () => {
  // The toast is a module global: replace whatever the last test left and let it hide.
  copy.toast('reset')
  await advance(10_000)
  reset()
})

describe('holds (former findings, fixed by `latest` / `isLatest` and `marked` beside a failed toast)', () => {
  test('ClipboardHoldsLastCopy and ToastDescribesLatestCopy: a newer copy supersedes a slow Copy all', async () => {
    const d1 = deferredRead()
    const a = trio(d1.read)
    await a.click('csv') // 1. YouCopyRows
    await host.writes(1) // 2. HostWrites (copy 1)
    expect(toastNow()?.text).toBe('Copied the first 1 of 3 rows as CSV')
    toastNow()!.action!.run() // 3. YouCopyAll
    await settle()
    expect(toastNow()?.busy).toBe(true)
    await a.click('csv') // 4. YouCopyRows (copy 3)
    await host.writes(3) // 5. HostWrites (copy 3)
    expect(host.text).toBe('id\n1')
    d1.answer() // 6. D1Answers: all() is no longer the latest and throws Superseded into its text
    await settle()
    await host.itemRejects(2) // 7. ItemRejects: the item writes nothing, and all() shows nothing
    expect(host.text).toBe('id\n1')
    expect(toastNow()?.text).toBe('Copied the first 1 of 3 rows as CSV')
    expect(a.mark()).toBe('csv')
  })

  test('NoCheckDuringCopyAll and NoCheckOnTrioWhileItReads: the ✓ beside a superseded Copy all is the newer copy’s', async () => {
    const d1 = deferredRead()
    const a = trio(d1.read)
    await a.click('csv') // 1. YouCopyRows
    await host.writes(1) // 2. HostWrites
    toastNow()!.action!.run() // 3. YouCopyAll
    await settle()
    expect(a.mark()).toBeNull() // busy toast: no ✓
    await a.click('csv') // 4. YouCopyRows
    await host.writes(3) // 5. HostWrites (copy 3): Copy all is superseded, so it can no longer write
    expect(a.mark()).toBe('csv')
    d1.answer() // D1Answers: the superseded Copy all gives up
    await settle()
    await host.itemRejects(2)
    expect(host.text).toBe('id\n1')
  })

  test('NoCheckAfterFailure: no ✓ beside "D1 didn’t read the rest"', async () => {
    const d1 = deferredRead()
    const a = trio(d1.read)
    await a.click('csv') // 1. YouCopyRows
    await host.writes(1) // 2. HostWrites
    toastNow()!.action!.run() // 3. YouCopyAll
    await settle()
    d1.fail('D1_ERROR') // 4. D1Fails
    await settle()
    await host.itemRejects(2) // 5. ItemRejects
    expect(toastNow()).toMatchObject({ text: 'D1 didn’t read the rest: D1_ERROR', failed: true })
    expect(a.mark()).toBeNull()
  })
})

describe('reproduces (the model says these rules break)', () => {
  test('copy.tsx alone never ends "Reading rows…" when the read never answers (only runRead\'s 35 s READ_TIMEOUT_MS does)', async () => {
    const d1 = deferredRead()
    const a = trio(d1.read)
    await a.click('csv') // YouCopyRows
    await host.writes(1) // HostWrites
    toastNow()!.action!.run() // YouCopyAll; then D1Hangs
    await settle()
    await advance(10 * 60_000)
    expect(toastNow()).toMatchObject({ text: 'Reading rows 2–3 from D1…', busy: true })
    expect(a.mark()).toBeNull()
  })

})

describe('holds (former slow-host findings, fixed by `said` / `speaks`)', () => {
  test('NoCheckAfterFailure: an older copy that lands after a failed Copy all stays silent and marks nothing', async () => {
    const d1 = deferredRead()
    const a = trio(d1.read)
    await a.click('csv') // 1. YouCopyRows (copy 1)
    await host.writes(1) // 2. HostWrites
    await a.click('csv') // 3. YouCopyRows (copy 2; the host has not answered yet)
    toastNow()!.action!.run() // 4. YouCopyAll (copy 3): speaks as "Reading rows…" shows
    await settle()
    d1.fail('D1_ERROR') // 5. D1Fails
    await settle()
    await host.itemRejects(3) // 6. ItemRejects: "D1 didn’t read the rest" (hides in 4 s)
    expect(a.mark()).toBeNull()
    await advance(2_000)
    await host.writes(2) // 7. HostWrites (copy 2): older than what spoke, so copyRows gives undefined
    expect(toastNow()).toMatchObject({ text: 'D1 didn’t read the rest: D1_ERROR', failed: true })
    await advance(2_100) // 8. ToastHides
    expect(toastNow()).toBeNull()
    expect(a.mark()).toBeNull()
  })

  test('an older copy landing while Copy all reads keeps "Reading rows…" up', async () => {
    const d1 = deferredRead()
    const a = trio(d1.read)
    await a.click('csv') // YouCopyRows (copy 1)
    await host.writes(1) // HostWrites
    await a.click('json') // YouCopyRows (copy 2, pending)
    toastNow()!.action!.run() // YouCopyAll (copy 3)
    await settle()
    await host.writes(2) // HostWrites (copy 2): silent
    expect(toastNow()?.busy).toBe(true)
    expect(a.mark()).toBeNull()
  })

  test('ToastDescribesLatestCopy: the toast follows the order copies land', async () => {
    const a = trio(deferredRead().read)
    await a.click('csv') // 1. YouCopyRows (copy 1)
    await host.writes(1) // 2. HostWrites
    await a.click('json') // 3. YouCopyRows (copy 2)
    await a.click('markdown') // 4. YouCopyRows (copy 3)
    await host.writes(2) // 5. HostWrites (copy 2): newer than what spoke, so it speaks
    expect(JSON.parse(host.text!)).toEqual([{ id: 1 }])
    expect(toastNow()?.text).toBe('Copied the first 1 of 3 rows as JSON')
    expect(a.mark()).toBe('json')
    await host.writes(3)
    expect(toastNow()?.text).toBe('Copied the first 1 of 3 rows as Markdown')
  })
})

describe('holds (the model says these rules hold)', () => {
  test('BlockedIsReported and BlockedNeverShownCopied: a closed sandbox', async () => {
    host.sandbox = 'closed'
    const a = trio(deferredRead().read)
    await a.click('json') // YouCopyRows
    await host.refuses(1) // HostRefuses; then FallbackFails (writeText throws, execCommand is false)
    expect(toastNow()).toMatchObject({ text: 'The host blocked the clipboard', failed: true })
    expect(a.mark()).toBeNull()
    expect(a.blocked('json')).toBe(true)
    const said = copy.copyText('SELECT 1', 'Copied the SQL') // YouCopySql
    await settle()
    await host.refuses(2) // HostRefuses; FallbackFails
    expect(await said).toBe(false)
    expect(toastNow()).toMatchObject({ text: 'The host blocked the clipboard', failed: true })
  })

  test('CopyAllMarksItsFormat: once Copy all has written, its format is marked', async () => {
    const d1 = deferredRead()
    const a = trio(d1.read)
    await a.click('json') // YouCopyRows
    await host.writes(1) // HostWrites
    toastNow()!.action!.run() // YouCopyAll
    await settle()
    d1.answer() // D1Answers
    await settle()
    await host.writes(2) // HostWrites (Copy all)
    expect(toastNow()?.text).toBe('Copied all 3 rows as JSON')
    await advance(3_000) // the trio's own ✓ has timed out; the toast's done still marks it
    expect(a.mark()).toBe('json')
  })
})
