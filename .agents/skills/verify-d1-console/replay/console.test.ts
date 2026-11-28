/**
 * Replays the paths of model/Console.tla against the real code.
 *
 * console.tsx can't be imported here: it imports d1-studio-app.tsx, whose
 * module body mounts the app (mountMcpApp), and there is no DOM in `bun test`.
 * So this drives the real pure pieces (machines.ts: initialCard, cardReducer,
 * compareOutcomes, shownOutcome) in the order React runs Studio's, Console's
 * and Main's updates and effects, with their glue transcribed below. What is
 * simulated, exactly:
 *  - Reads are promises the test settles by hand (`Read.resolve/reject`); their
 *    `then` handlers run in the order they were attached, as in JS.
 *  - A commit of Main runs its passive effects in source order: useRunEffects'
 *    run effect on [id] (a new running read starts; the old one's cleanup runs
 *    with `mounted` still true, so it aborts), then the onRan effect on [shown].
 *  - An unmount runs the cleanups in declaration order: the `mounted` effect's
 *    (mounted = false), then the run effect's, which lets a running read go.
 *  - Studio's state updates (land, track's setPending) apply at once; when
 *    they change `active`, the next render remounts Main (key = entry.id).
 * The first tests check that every transcribed line is still, word for word,
 * in console.tsx and d1-studio-app.tsx: if one fails, the code moved and both
 * this file and the model need another look.
 *
 * `replays …` tests pass while a finding is there; `holds …` tests pass while
 * a rule the model proves holds also holds on the code.
 *
 * Run: bun test ./.agents/skills/verify-d1-console/replay/console.test.ts
 * D1_CONSOLE_SRC=<path> / D1_STUDIO_SRC=<path> point the source checks at copies.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { D1Outcome, D1Query } from '../../../../src/d1-studio/contract'
import {
  CONSOLE_PAGE_ROWS,
  cardReducer,
  compareOutcomes,
  initialCard,
  shownOutcome,
  type CardEvent,
  type CardState,
  type Shown
} from '../../../../src/d1-studio/app/machines'

const APP = join(import.meta.dir, '../../../../src/d1-studio/app')
const CONSOLE_SRC = process.env.D1_CONSOLE_SRC ?? join(APP, 'console.tsx')
const STUDIO_SRC = process.env.D1_STUDIO_SRC ?? join(APP, 'd1-studio-app.tsx')

/** The lines of console.tsx this file transcribes. */
const CONSOLE_LINES = [
  // useConsoleHistory
  `const [entries, setEntries] = useState<readonly Entry[]>(agent)`,
  `const [active, setActive] = useState(agent.length - 1)`,
  `const [pending, setPending] = useState<readonly PendingRead[]>([])`,
  `const count = useRef(agent.length)`,
  `const land = (query: D1Query, sameAs: string | undefined, open: boolean, startedAt: number) => {`,
  `e.id === sameAs && !(e.latestFrom !== undefined && startedAt < e.latestFrom)`,
  `? { ...e, ranAt: Date.now(), latest: query.outcome, latestFrom: startedAt }`,
  `const i = count.current++`,
  `setEntries((es) => [...es, { id: \`you-\${i}\`, who: 'you', query }])`,
  `if (open) setActive(i)`,
  `startedAt = Date.now()`,
  `setPending((p) => [...p, { key, title }])`,
  `const done = () => setPending((p) => p.filter((r) => r.key !== key))`,
  `land({ purpose: 'query', title, sql, outcome: o }, sameAs, open, startedAt)`,
  // Console
  `const entry = entries[active] ?? entries[entries.length - 1]!`,
  `entry.who === 'agent' && sql.trim() === entry.query.sql.trim() ? entry.id : undefined`,
  `const ran = (query: D1Query, startedAt: number) => land(query, sameAs(query.sql), true, startedAt)`,
  `const letGo = (sql: string, outcome: Promise<D1Outcome>, startedAt: number) =>`,
  `title: sameAs(sql) ? entry.query.title : titleOf(sql),`,
  `sameAs: sameAs(sql),`,
  `const sql = \`SELECT * FROM \${quote(t)} LIMIT 100;\``,
  `title: \`\${t}, first 100 rows\`,`,
  `outcome: runRead(env.app, env.database, sql),`,
  `open: true`,
  `key={entry.id}`,
  `onRan={ran}`,
  `onLetGo={letGo}`,
  // Main
  `useRunEffects(state, dispatch, env, onLetGo)`,
  `...initialCard(entry.query, { run: env.host.run, send: env.host.send }, Date.now()),`,
  `return entry.latest && entry.ranAt`,
  `found: compareOutcomes(entry.query.outcome, entry.latest)`,
  `const opened = useRef(shown)`,
  `if (shown.source !== 'rerun' || shown === opened.current || shown.outcome === entry.latest) return`,
  `const sentAt = useRef(0)`,
  `if (runId !== undefined) sentAt.current = Date.now()`,
  `sentAt.current`,
  `const latest = entry.latest`,
  `if (!latest || !entry.ranAt) return`,
  `if (state.shown.source === 'rerun' && state.shown.outcome === latest) return`,
  `dispatch({ type: 'reread', outcome: latest, at: entry.ranAt })`,
  `}, [latest])`,
  `const same = shown.sql.trim() === entry.query.sql.trim()`,
  `title: same ? entry.query.title : titleOf(shown.sql),`,
  `}, [shown])`,
  // consoleReducer
  `const next = cardReducer(state, event)`,
  `return next.pane === 'full' && next.rows === 'open'`
]
/** And useRunEffects / Studio in d1-studio-app.tsx. */
const STUDIO_LINES = [
  `const history = useConsoleHistory(result)`,
  `<Console result={result} env={env} history={history} />`,
  `const mounted = useRef(true)`,
  `mounted.current = false`,
  `const outcome = runRead(env.app, env.database, run.sql, abort.signal)`,
  `if (mounted.current) dispatch({ type: 'run.done', id: run.id, outcome: o, at: Date.now() })`,
  `const startedAt = Date.now()`,
  `if (!mounted.current && letGo) letGo(run.sql, outcome, startedAt)`,
  `else abort.abort()`,
  `}, [id])`
]

// ── Fixtures ──

const rows = (tag: string): D1Outcome => ({
  status: 'rows',
  columns: ['tag'],
  rows: [[tag]],
  rowCount: 1,
  meta: { durationMs: 1, rowsRead: 1, rowsWritten: 0 }
})
const q = (title: string, sql: string, tag: string): D1Query => ({
  purpose: 'query',
  title,
  sql,
  outcome: rows(tag)
})
const AGENT = [
  q('Signups by week', 'SELECT week, n FROM signups;', 'agent step 1'),
  q('Top customers', 'SELECT name FROM customers LIMIT 5;', 'agent answer')
]
const MINE = 'SELECT id FROM orders;'
const USERS = 'SELECT * FROM "users" LIMIT 100;'
const titleOf = (sql: string) => {
  const t = sql.match(/\bFROM\s+"?(\w+)"?/i)?.[1]
  return t ? `Your query on ${t}` : 'Your query'
}

/** A read in flight: a promise the test settles. */
class Read {
  aborted = false
  private handlers: [(o: D1Outcome) => void, (e: unknown) => void][] = []
  constructor(readonly sql: string) {}
  then(ok: (o: D1Outcome) => void, fail: (e: unknown) => void) {
    this.handlers.push([ok, fail])
  }
  resolve(o: D1Outcome) {
    for (const [ok] of this.handlers) ok(o)
  }
  reject(e: unknown) {
    for (const [, fail] of this.handlers) fail(e)
  }
}

interface Entry {
  readonly id: string
  readonly who: 'agent' | 'you'
  readonly query: D1Query
  readonly ranAt?: number
  readonly latest?: D1Outcome
  readonly latestFrom?: number
}

function consoleReducer(state: CardState, event: CardEvent): CardState {
  const next = cardReducer(state, event)
  return next.pane === 'full' && next.rows === 'open'
    ? next
    : { ...next, pane: 'full', rows: 'open' }
}

// ── Studio and useConsoleHistory ──

class StudioSim {
  entries: readonly Entry[] = AGENT.map((query, i) => ({ id: `agent-${i}`, who: 'agent', query }))
  active = AGENT.length - 1
  pending: { key: string; title: string }[] = []
  count = AGENT.length
  seq = 0
  clock = 1_000
  toasts: string[] = []
  reads: Read[] = []
  console: ConsoleSim | undefined

  land(query: D1Query, sameAs: string | undefined, open: boolean, startedAt: number) {
    this.clock += 1
    if (sameAs) {
      const now = this.clock
      this.entries = this.entries.map((e) =>
        e.id === sameAs && !(e.latestFrom !== undefined && startedAt < e.latestFrom)
          ? { ...e, ranAt: now, latest: query.outcome, latestFrom: startedAt }
          : e
      )
      this.console?.render()
      return
    }
    const i = this.count++
    this.entries = [...this.entries, { id: `you-${i}`, who: 'you', query }]
    if (open) this.active = i
    this.console?.render()
  }
  track({ title, sql, outcome, sameAs, open = false, startedAt = ++this.clock }: {
    title: string
    sql: string
    outcome: Read
    sameAs?: string
    open?: boolean
    startedAt?: number
  }) {
    const key = `read-${++this.seq}`
    this.pending = [...this.pending, { key, title }]
    const done = () => (this.pending = this.pending.filter((r) => r.key !== key))
    outcome.then(
      (o) => {
        done()
        this.land({ purpose: 'query', title, sql, outcome: o }, sameAs, open, startedAt)
      },
      (error) => {
        done()
        this.toasts.push(`D1 didn’t run “${title}”: ${String(error)}`)
      }
    )
  }
  goFullscreen() {
    this.console = new ConsoleSim(this)
    return this.console
  }
  leaveFullscreen() {
    this.console!.unmountMain()
    this.console = undefined
  }
  read(sql: string) {
    const r = new Read(sql)
    this.reads.push(r)
    return r
  }
}

// ── Console and Main ──

class ConsoleSim {
  main!: {
    key: string
    state: CardState
    opened: Shown
    mounted: boolean
    read: Read | undefined
    readStartedAt: number
    entryAtRun: Entry | undefined
    sentAt: number
    latest: D1Outcome | undefined
  }
  /** Runs of the onRan effect that called onRan (to see the reread doesn't loop). */
  onRanCalls = 0
  constructor(readonly studio: StudioSim) {
    this.mountMain()
  }
  get entry(): Entry {
    const { entries, active } = this.studio
    return entries[active] ?? entries[entries.length - 1]!
  }
  /** Console's sameAs, closing over `entry` as the render that made it saw it. */
  sameAsFor = (entry: Entry) => (sql: string) =>
    entry.who === 'agent' && sql.trim() === entry.query.sql.trim() ? entry.id : undefined
  ran(query: D1Query, startedAt: number) {
    this.studio.land(query, this.sameAsFor(this.entry)(query.sql), true, startedAt)
  }
  /** letGo from the render that started the read (the run effect's closure). */
  letGoFor = (entry: Entry) => (sql: string, outcome: Read, startedAt: number) => {
    const sameAs = this.sameAsFor(entry)
    this.studio.track({
      title: sameAs(sql) ? entry.query.title : titleOf(sql),
      sql,
      outcome,
      sameAs: sameAs(sql),
      startedAt
    })
  }
  pick(t: string) {
    // console.tsx's `quote` always double-quotes (a plain name such as `users` too).
    const sql = `SELECT * FROM "${t.replaceAll('"', '""')}" LIMIT 100;`
    this.studio.track({ title: `${t}, first 100 rows`, sql, outcome: this.studio.read(sql), open: true })
  }

  private mountMain() {
    const entry = this.entry
    const card: CardState = {
      ...initialCard(entry.query, { run: true, send: true }, this.studio.clock),
      pane: 'full',
      rows: 'open',
      pageSize: CONSOLE_PAGE_ROWS
    }
    const state: CardState =
      entry.latest && entry.ranAt
        ? {
            ...card,
            shown: { source: 'rerun', sql: entry.query.sql, outcome: entry.latest, readAt: entry.ranAt },
            found: compareOutcomes(entry.query.outcome, entry.latest)
          }
        : card
    this.main = {
      key: entry.id,
      state,
      opened: state.shown,
      mounted: true,
      read: undefined,
      readStartedAt: 0,
      entryAtRun: undefined,
      sentAt: 0,
      latest: entry.latest
    }
    this.rereadEffect() // the effect on [entry.latest] runs on mount too
  }
  /** Unmount: the `mounted` cleanup, then the run effect's (lets a running read go). */
  unmountMain() {
    const m = this.main
    m.mounted = false
    if (m.read) {
      const letGo = this.letGoFor(m.entryAtRun!)
      letGo(m.read.sql, m.read, m.readStartedAt)
      m.read = undefined
    }
  }
  /** Console's render: Main remounts when the active entry's id changed. */
  render() {
    if (this.entry.id !== this.main.key) {
      this.unmountMain()
      this.mountMain()
      return
    }
    // Main re-renders with the new entry: its effect on [entry.latest]
    if (this.entry.latest !== this.main.latest) {
      this.main.latest = this.entry.latest
      this.rereadEffect()
    }
  }
  /** Main's effect on [entry.latest]. */
  private rereadEffect() {
    const entry = this.entry
    const latest = entry.latest
    const s = this.main.state
    if (!latest || !entry.ranAt) return
    if (s.shown.source === 'rerun' && s.shown.outcome === latest) return
    this.dispatch({ type: 'reread', outcome: latest, at: entry.ranAt })
  }
  dispatch(event: CardEvent) {
    const m = this.main
    if (!m.mounted) return
    const before = m.state
    m.state = consoleReducer(before, event)
    const s = m.state
    // the run effect, on [id]
    const idOf = (x: CardState) => (x.run.status === 'running' ? x.run.id : undefined)
    if (idOf(s) !== idOf(before)) {
      if (m.read) {
        m.read.aborted = true // cleanup with mounted.current true
        m.read = undefined
      }
      if (s.run.status === 'running') {
        const run = s.run
        const read = this.studio.read(run.sql)
        m.readStartedAt = ++this.studio.clock // useRunEffects' startedAt
        m.sentAt = m.readStartedAt // Main's sentAt effect on [runId], same commit
        m.read = read
        m.entryAtRun = this.entry
        read.then(
          (o) => {
            if (m.mounted) this.dispatch({ type: 'run.done', id: run.id, outcome: o, at: this.studio.clock })
          },
          (error) => {
            if (m.mounted && !read.aborted) this.dispatch({ type: 'run.error', id: run.id, error: String(error) })
          }
        )
      }
    }
    // the onRan effect, on [shown]
    if (
      s.shown !== before.shown &&
      !(s.shown.source !== 'rerun' || s.shown === m.opened || s.shown.outcome === this.entry.latest)
    ) {
      const entry = this.entry
      const same = s.shown.sql.trim() === entry.query.sql.trim()
      this.onRanCalls++
      this.ran(
        {
          purpose: 'query',
          title: same ? entry.query.title : titleOf(s.shown.sql),
          sql: s.shown.sql,
          outcome: s.shown.outcome
        },
        m.sentAt
      )
    }
    this.render()
  }

  // ── The user ──
  run(sql: string) {
    this.dispatch({ type: 'draft.change', draft: sql })
    this.dispatch({ type: 'submit' })
  }
  open(i: number) {
    this.studio.active = i
    this.render()
  }
  running() {
    const r = this.main.state.run
    return r.status === 'running' ? r.sql : undefined
  }
  screen() {
    const o = shownOutcome(this.main.state)
    return { title: this.entry.query.title, tag: o.status === 'rows' ? o.rows[0]?.[0] : o.error }
  }
}

const last = (s: StudioSim) => s.reads[s.reads.length - 1]!

// ── Source checks ──

describe('the transcription still matches the code', () => {
  const ignoreWrapping = (text: string) => text.replace(/\s+/g, ' ')

  it('has every transcribed line of console.tsx', () => {
    const src = ignoreWrapping(readFileSync(CONSOLE_SRC, 'utf8'))
    expect(CONSOLE_LINES.filter((line) => !src.includes(ignoreWrapping(line)))).toEqual([])
  })
  it('has every transcribed line of d1-studio-app.tsx', () => {
    const src = ignoreWrapping(readFileSync(STUDIO_SRC, 'utf8'))
    expect(STUDIO_LINES.filter((line) => !src.includes(ignoreWrapping(line)))).toEqual([])
  })
})

// ── Findings: pass while the bug is there ──

describe('the former ReReadStaysOnItsStep findings, now holding', () => {
  it('holds ReReadStaysOnItsStep: a re-read you left lands on the step you came back to, and shows there', () => {
    const s = new StudioSim()
    const c = s.goFullscreen() // 1. you open fullscreen
    c.run(c.entry.query.sql) // 2. you run its SQL unchanged
    const r = last(s)
    s.leaveFullscreen() // 3. you leave fullscreen: the read is let go
    const d = s.goFullscreen() // 4. you open fullscreen: a fresh Main on the same step
    expect(d.screen().tag).toBe('agent answer')
    r.resolve(rows('fresh rows')) // 5. a read you left lands, marking its step
    expect(d.entry.latest).toEqual(rows('fresh rows'))
    expect(d.screen().tag).toBe('fresh rows') // the reread effect shows it
    expect(d.onRanCalls).toBe(0) // and it doesn't come back through onRan
    expect(s.entries).toHaveLength(AGENT.length)
  })

  it('holds NewestReReadWins: an older let-go re-read landing after a newer one is skipped', () => {
    const s = new StudioSim()
    const c = s.goFullscreen()
    c.run(c.entry.query.sql)
    const older = last(s)
    c.open(0) // let go
    c.open(1)
    c.run(c.entry.query.sql)
    last(s).resolve(rows('newer'))
    expect(c.screen().tag).toBe('newer')
    older.resolve(rows('older'))
    expect(c.entry.latest).toEqual(rows('newer'))
    expect(c.screen().tag).toBe('newer')
  })

  it('holds NewestReReadWins: an older let-go re-read landing first shows, then your newer read replaces it', () => {
    const s = new StudioSim()
    const c = s.goFullscreen()
    c.run(c.entry.query.sql)
    const older = last(s)
    c.open(0)
    c.open(1)
    c.run(c.entry.query.sql)
    const newer = last(s)
    older.resolve(rows('older'))
    expect(c.screen().tag).toBe('older') // shown while your read still runs
    expect(c.running()).toBe(AGENT[1]!.sql)
    newer.resolve(rows('newer'))
    expect(c.entry.latest).toEqual(rows('newer'))
    expect(c.screen().tag).toBe('newer')
    expect(c.onRanCalls).toBe(1)
  })
})

// ── Rules that hold, on the code ──

describe('rules that hold, on the code', () => {
  it('holds NoRunLostOnSwitch / LetGoMarksItsStep / BackgroundLandingKeepsView: a re-read you leave marks its step, by id', () => {
    const s = new StudioSim()
    const c = s.goFullscreen()
    c.run(c.entry.query.sql) // on the answer (agent-1)
    const r = last(s)
    c.open(0) // let go, not aborted
    expect(r.aborted).toBe(false)
    expect(s.pending.map((p) => p.title)).toEqual(['Top customers'])
    r.resolve(rows('fresh'))
    expect(s.pending).toEqual([])
    expect(s.active).toBe(0) // you still see what you opened
    expect(s.entries[1]).toMatchObject({ id: 'agent-1', latest: rows('fresh') })
    expect(s.entries[0]!.ranAt).toBeUndefined()
    c.open(1)
    expect(c.screen().tag).toBe('fresh')
  })

  it('holds NoRunLostOnLeave / LandsOnce: your query left mid-read lands once, in the background', () => {
    const s = new StudioSim()
    const c = s.goFullscreen()
    c.run(MINE)
    const r = last(s)
    s.leaveFullscreen()
    r.resolve(rows('orders ids'))
    expect(s.entries.slice(AGENT.length).map((e) => e.query.title)).toEqual(['Your query on orders'])
    expect(s.active).toBe(AGENT.length - 1) // open: false
    const d = s.goFullscreen()
    expect(d.screen().tag).toBe('agent answer')
  })

  it('holds PickIsNotIgnored / PickLandsAsItsEntry / PickOpensItsEntry: a pick beside a run lands and opens; the run is let go', () => {
    const s = new StudioSim()
    const c = s.goFullscreen()
    c.run(MINE)
    const mine = last(s)
    c.pick('users')
    const users = last(s)
    expect(s.reads.map((r) => r.sql)).toEqual([MINE, USERS])
    users.resolve(rows('users rows'))
    expect(c.screen()).toEqual({ title: 'users, first 100 rows', tag: 'users rows' })
    expect(mine.aborted).toBe(false) // let go by the remount
    mine.resolve(rows('orders ids'))
    expect(c.screen().tag).toBe('users rows') // a background landing doesn't move you
    expect(s.entries.slice(AGENT.length).map((e) => e.query.title)).toEqual([
      'users, first 100 rows',
      'Your query on orders'
    ])
  })

  it('holds (formerly intended PickIsNotSuperseded): two picks both land as their own entries', () => {
    const s = new StudioSim()
    const c = s.goFullscreen()
    c.pick('users')
    const a = last(s)
    c.pick('orders')
    const b = last(s)
    b.resolve(rows('orders'))
    a.resolve(rows('users'))
    expect(s.entries.slice(AGENT.length).map((e) => e.query.title)).toEqual([
      'orders, first 100 rows',
      'users, first 100 rows'
    ])
  })

  it('holds PickIsNotAborted / NoStalePending: a pick survives leaving fullscreen; a failed one leaves pending with a toast', () => {
    const s = new StudioSim()
    const c = s.goFullscreen()
    c.pick('users')
    const a = last(s)
    c.pick('orders')
    const b = last(s)
    s.leaveFullscreen()
    a.resolve(rows('users'))
    b.reject(new Error('timeout'))
    expect(s.pending).toEqual([])
    expect(s.toasts).toHaveLength(1)
    expect(s.goFullscreen().screen().title).toBe('users, first 100 rows')
  })

  it('holds ShowsTheRunThatLanded / RunsSurviveLeavingFullscreen / OneEntryPerRun', () => {
    const s = new StudioSim()
    const c = s.goFullscreen()
    c.run(c.entry.query.sql)
    last(s).resolve(rows('fresh rows'))
    expect(c.screen().tag).toBe('fresh rows')
    c.run(MINE)
    last(s).resolve(rows('orders ids'))
    expect(c.screen()).toEqual({ title: 'Your query on orders', tag: 'orders ids' })
    s.leaveFullscreen()
    const d = s.goFullscreen()
    expect(d.studio.entries.map((e) => e.who)).toEqual(['agent', 'agent', 'you'])
    d.open(1)
    expect(d.screen().tag).toBe('fresh rows')
  })
})
