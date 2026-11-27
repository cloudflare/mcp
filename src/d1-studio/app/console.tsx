import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import {
  ArrowClockwiseIcon,
  ArrowRightIcon,
  CaretRightIcon,
  ClockCounterClockwiseIcon,
  DatabaseIcon,
  KeyIcon,
  TableIcon,
  WarningCircleIcon
} from '@phosphor-icons/react'
import { CloudflareLogo } from '@cloudflare/kumo'
import type { D1Cell, D1Outcome, D1Query, D1StudioResult } from '../contract'
import {
  CopySql,
  Ghost,
  Grid,
  IconButton,
  PagerArrows,
  PagerPos,
  RunButton,
  S5Lines,
  StatsCompact,
  Trio,
  copyIsPrimary,
  messageOf,
  submitKey,
  useFetchEffects,
  useRunEffects,
  viewFix,
  type Env
} from './d1-studio-app'
import { toast } from './copy'
import { count } from './format'
import {
  CONSOLE_PAGE_ROWS,
  cardReducer,
  compareOutcomes,
  heldIsContiguous,
  heldRows,
  initialCard,
  isBusy,
  pageCount,
  pageRows,
  shownOutcome,
  shownSql,
  type CardEvent,
  type CardState
} from './machines'
import { readRows, runRead } from './run'
import { highlightSql } from './sql'
import { hasIdentifier, replaceIdentifier } from '../statement'
import { markOf, verdictOf } from './verdict'

/**
 * The fullscreen console: what the view becomes
 * when the host gives it the whole panel. On the left, the agent's queries in
 * order and the ones run here, then the database's tables; on the right,
 * Studio's editor over the result, 100 rows a page, and a foot with the
 * receipt, the pager and the copy trio. Everything runs through the same
 * card machine as the inline card: reads with `d1_raw`, writes to the chat.
 */

/** The editor's most lines before it scrolls, so the result keeps its room at 1100 × 720. */
const ED_LINES = 8
/** The editor's top padding and line height (d1-studio.css, `.cx-ed`). */
const ED_TOP = 12
const ED_LH = 20
/** The grid's row, in px. */
const ROW_H = 35

/** Every table and its columns, in one read. */
const SCHEMA_SQL = `SELECT m.name AS tbl, p.name AS col, p.type, p.pk
FROM sqlite_master m, pragma_table_info(m.name) p
WHERE m.type = 'table' AND m.name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
ORDER BY m.name, p.cid;`

interface SchemaTable {
  readonly name: string
  readonly cols: readonly { readonly name: string; readonly type: string; readonly pk: boolean }[]
}

/** One query in the history: the agent's (the steps, then the answer) or one run here. */
interface Entry {
  readonly id: string
  readonly who: 'agent' | 'you'
  readonly query: D1Query
  /** The agent's SQL read again here: when, and what D1 answered, which the entry shows from then on. */
  readonly ranAt?: number
  readonly latest?: D1Outcome
  /** When the read behind `latest` was sent: an older read landing later doesn't replace it. */
  readonly latestFrom?: number
}

/** A read still on its way that will land in the history: one left mid-read, or a table picked in the schema. */
export interface PendingRead {
  readonly key: string
  readonly title: string
}

/**
 * The console's history, held above the display switch (in `Studio`) so
 * leaving fullscreen keeps it. Reads the editor let go of land here too, as in
 * the dashboard's Studio, where a tab's run finishes while you're elsewhere.
 */
export interface ConsoleHistory {
  readonly entries: readonly Entry[]
  readonly active: number
  readonly setActive: Dispatch<SetStateAction<number>>
  /** How many of the entries are the agent's (its steps, then the answer). */
  readonly agentCount: number
  readonly pending: readonly PendingRead[]
  /**
   * A read landed: the agent's SQL unchanged marks its step (by id) as read
   * again here; anything else is a new entry, opened when `open`.
   */
  readonly land: (
    query: D1Query,
    sameAs: string | undefined,
    open: boolean,
    startedAt: number
  ) => void
  /** A read that goes on without an editor, listed as pending until it lands (or fails, said in the toast). */
  readonly track: (read: {
    title: string
    sql: string
    outcome: Promise<D1Outcome>
    sameAs?: string
    open?: boolean
    startedAt?: number
  }) => void
}

export function useConsoleHistory(result: D1StudioResult): ConsoleHistory {
  const agent = useMemo<readonly Entry[]>(
    () =>
      [...result.steps, result.answer].map((query, i) => ({
        id: `agent-${i}`,
        who: 'agent',
        query
      })),
    [result]
  )
  const [entries, setEntries] = useState<readonly Entry[]>(agent)
  const [active, setActive] = useState(agent.length - 1)
  const [pending, setPending] = useState<readonly PendingRead[]>([])
  // The next entry's index, counted as entries are added (several can land in one tick).
  const count = useRef(agent.length)
  const seq = useRef(0)
  const land = (query: D1Query, sameAs: string | undefined, open: boolean, startedAt: number) => {
    if (sameAs) {
      // The step keeps its place and now shows what D1 just answered, unless a read sent after this one already did.
      setEntries((es) =>
        es.map((e) =>
          e.id === sameAs && !(e.latestFrom !== undefined && startedAt < e.latestFrom)
            ? { ...e, ranAt: Date.now(), latest: query.outcome, latestFrom: startedAt }
            : e
        )
      )
      return
    }
    const i = count.current++
    setEntries((es) => [...es, { id: `you-${i}`, who: 'you', query }])
    if (open) setActive(i)
  }
  const track: ConsoleHistory['track'] = ({
    title,
    sql,
    outcome,
    sameAs,
    open = false,
    startedAt = Date.now()
  }) => {
    const key = `read-${++seq.current}`
    setPending((p) => [...p, { key, title }])
    const done = () => setPending((p) => p.filter((r) => r.key !== key))
    outcome.then(
      (o) => {
        done()
        land({ purpose: 'query', title, sql, outcome: o }, sameAs, open, startedAt)
      },
      (error: unknown) => {
        done()
        toast(
          `D1 didn’t run “${title}”: ${messageOf(error)}`,
          document.querySelector<HTMLElement>('.cx'),
          true
        )
      }
    )
  }
  return { entries, active, setActive, agentCount: agent.length, pending, land, track }
}

const linesOf = (sql: string) => Math.max(1, sql.split('\n').length)
/** A table name as SQL: always quoted, so a keyword (`index`) or a leading digit (`2024_orders`) still reads. */
const quote = (t: string) => `"${t.replaceAll('"', '""')}"`
/** A query you wrote gets a title from its first table: there is no agent's title for it. */
const titleOf = (sql: string) => {
  const t = sql.match(/\bFROM\s+"?(\w+)"?/i)?.[1]
  return t ? `Your query on ${t}` : 'Your query'
}

export function Console({
  result,
  env,
  history
}: {
  result: D1StudioResult
  env: Env
  history: ConsoleHistory
}) {
  const { entries, active, setActive, agentCount, pending, land, track } = history
  const entry = entries[active] ?? entries[entries.length - 1]!

  const sideRef = useRef<HTMLElement>(null)
  const [sideMore, setSideMore] = useState(false)
  useLayoutEffect(() => {
    const el = sideRef.current
    if (!el) return undefined
    const read = () => setSideMore(el.scrollTop + el.clientHeight < el.scrollHeight - 2)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    for (const c of Array.from(el.children)) ro.observe(c)
    el.addEventListener('scroll', read, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', read)
    }
  }, [])

  // The agent's SQL read again unchanged marks its step; anything else run here is an entry of its own.
  const sameAs = (sql: string) =>
    entry.who === 'agent' && sql.trim() === entry.query.sql.trim() ? entry.id : undefined
  // A run that lands in the open editor opens as its entry (an agent step read again stays put: Main's key is the id).
  const ran = (query: D1Query, startedAt: number) => land(query, sameAs(query.sql), true, startedAt)
  // A run the editor let go of (you opened another entry, or left fullscreen) still lands, in the background.
  const letGo = (sql: string, outcome: Promise<D1Outcome>, startedAt: number) =>
    track({
      title: sameAs(sql) ? entry.query.title : titleOf(sql),
      sql,
      outcome,
      sameAs: sameAs(sql),
      startedAt
    })
  // A table clicked in the schema: its first 100 rows, read at once beside whatever runs, opened when they land.
  const pick = (t: string) => {
    if (!env.host.run) return
    const sql = `SELECT * FROM ${quote(t)} LIMIT 100;`
    track({
      title: `${t}, first 100 rows`,
      sql,
      outcome: runRead(env.app, env.database, sql),
      open: true
    })
  }
  // A failed step of the agent's points at the step that fixed it.
  const fixIndex =
    entry.who === 'agent' && entry.query.outcome.status === 'failed'
      ? entries.findIndex(
          (e, i) => i > active && e.who === 'agent' && e.query.outcome.status !== 'failed'
        )
      : -1

  return (
    <section
      className="dq cx"
      data-display="fullscreen"
      aria-label={`D1 Studio: ${result.answer.title}`}
    >
      <header className="cx-head">
        <h1 className="cx-title">
          <CloudflareLogo variant="glyph" className="dq-mark cx-mark" aria-hidden="true" />
          <span>{result.answer.title}</span>
        </h1>
        <span className="dq-grow" />
        <span className="cx-db">
          <DatabaseIcon size={14} aria-hidden="true" />
          {result.database.name}
        </span>
      </header>
      <div className="cx-body">
        <aside className="cx-side" ref={sideRef} data-more={sideMore ? '' : undefined}>
          <History
            entries={entries}
            active={active}
            open={setActive}
            agentCount={agentCount}
            pending={pending}
          />
          <Schema env={env} onPick={pick} />
        </aside>
        <Main
          key={entry.id}
          entry={entry}
          env={env}
          step={entry.who === 'agent' ? [active + 1, agentCount] : undefined}
          onRan={ran}
          onLetGo={letGo}
          fixed={
            fixIndex >= 0
              ? {
                  n: fixIndex + 1,
                  open: () => setActive(fixIndex),
                  with: fixedWith(entry.query.outcome, entries[fixIndex]!.query.sql)
                }
              : undefined
          }
        />
      </div>
    </section>
  )
}

/** The name the step that fixed a failed one used in place of D1's missing one, when its SQL has it. */
function fixedWith(bad: D1Outcome, goodSql: string): string | undefined {
  if (bad.status !== 'failed' || !bad.fix) return undefined
  return goodSql.includes(bad.fix.use) ? bad.fix.use : undefined
}

/** The console keeps its editor open and its result shown, whatever the card machine would fold. */
function consoleReducer(state: CardState, event: CardEvent): CardState {
  const next = cardReducer(state, event)
  return next.pane === 'full' && next.rows === 'open'
    ? next
    : { ...next, pane: 'full', rows: 'open' }
}

function Main({
  entry,
  env,
  step,
  onRan,
  onLetGo,
  fixed
}: {
  entry: Entry
  env: Env
  step?: readonly [number, number]
  onRan: (query: D1Query, startedAt: number) => void
  /** A read still running when this editor goes (another entry opened, fullscreen left): it lands in the history. */
  onLetGo: (sql: string, outcome: Promise<D1Outcome>, startedAt: number) => void
  fixed?: { n: number; open: () => void; with?: string }
}) {
  const [state, dispatch] = useReducer(consoleReducer, undefined, () => {
    const card = {
      ...initialCard(entry.query, { run: env.host.run, send: env.host.send }, Date.now()),
      pane: 'full' as const,
      rows: 'open' as const,
      pageSize: CONSOLE_PAGE_ROWS
    }
    // An agent step read again here opens on what D1 answered then, compared with the agent's rows.
    return entry.latest && entry.ranAt
      ? {
          ...card,
          shown: {
            source: 'rerun' as const,
            sql: entry.query.sql,
            outcome: entry.latest,
            readAt: entry.ranAt
          },
          found: compareOutcomes(entry.query.outcome, entry.latest)
        }
      : card
  })
  useRunEffects(state, dispatch, env, onLetGo)
  useFetchEffects(state, dispatch, env)

  // When this editor's own read was sent, so the history keeps the newest of a step's re-reads.
  const sentAt = useRef(0)
  const runId = state.run.status === 'running' ? state.run.id : undefined
  useEffect(() => {
    if (runId !== undefined) sentAt.current = Date.now()
  }, [runId])
  // A run that lands becomes an entry of the history (the agent's SQL unchanged only marks its step as ran here).
  const shown = state.shown
  const opened = useRef(shown)
  useEffect(() => {
    // The re-read an entry opens on (above) already landed, and one shown from the history (below) is already there.
    if (shown.source !== 'rerun' || shown === opened.current || shown.outcome === entry.latest) return
    const same = shown.sql.trim() === entry.query.sql.trim()
    onRan(
      {
        purpose: 'query',
        title: same ? entry.query.title : titleOf(shown.sql),
        sql: shown.sql,
        outcome: shown.outcome
      },
      sentAt.current
    )
    // Once per landed run.
  }, [shown])
  // A re-read of this step that lands from the history (one you let go of earlier) shows here too.
  const latest = entry.latest
  useEffect(() => {
    if (!latest || !entry.ranAt) return
    if (state.shown.source === 'rerun' && state.shown.outcome === latest) return
    dispatch({ type: 'reread', outcome: latest, at: entry.ranAt })
  }, [latest])

  const taRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    taRef.current?.focus({ preventScroll: true })
  }, [])

  const outcome = shownOutcome(state)
  const total = outcome.status === 'rows' ? outcome.rowCount : 0
  const pages = pageCount(state)
  const page = state.page
  const from = page * CONSOLE_PAGE_ROWS
  const rows = pageRows(state, page)
  const held = heldRows(state)
  const sorting = state.fetch.status === 'sorting'
  const paging =
    state.fetch.status === 'paging' ? (state.fetch.page > page ? 'next' : 'prev') : undefined
  const goTo = (p: number) => dispatch({ type: 'page', page: p })
  const range = (a: number, b: number) => `${count(a + 1)}–${count(Math.min(total, b))}`

  // The editor's height is set when the console opens and when a run lands, never while the user types.
  const [edSet, setEdSet] = useState(() => linesOf(entry.query.sql))
  const [edExtra, setEdExtra] = useState(0)
  const edLines =
    outcome.status === 'rows' ? Math.min(edSet, ED_LINES + edExtra) : Math.min(edSet, 2 * ED_LINES)

  const readRest =
    env.host.run && outcome.status === 'rows' && total > held.length
      ? (offset: number, limit: number) =>
          readRows(env.app, env.database, shownSql(state), { sort: state.sort, offset, limit })
      : undefined

  return (
    <div className="cx-main">
      <Editor
        taRef={taRef}
        state={state}
        dispatch={dispatch}
        env={env}
        entry={entry}
        step={step}
        lines={edLines}
        focusToken={outcome.status === 'failed' ? outcome.token : undefined}
        onMeasure={setEdSet}
      />
      <Result
        state={state}
        outcome={outcome}
        rows={rows}
        held={held}
        offset={from}
        dim={isBusy(state.run) || sorting || !!paging}
        sorting={sorting}
        fixed={fixed}
        onFix={(sql) => dispatch({ type: 'draft.change', draft: sql })}
        onSpare={(px, shownExtra) =>
          setEdExtra(Math.max(0, Math.min(edSet - ED_LINES, shownExtra + Math.floor(px / ED_LH))))
        }
        edExtra={edExtra}
        dispatch={dispatch}
      />
      {state.fetch.status === 'failed' && (
        <p className="dq-errtext cx-fetcherr" role="alert">
          D1 didn’t read those rows: {state.fetch.error}
        </p>
      )}
      {/* A failed read has no stats, pages or rows to copy, so it has no foot: the error is the whole result. */}
      {outcome.status === 'rows' && (
        <footer className="cx-foot">
          <StatsCompact outcome={outcome} paged={total > CONSOLE_PAGE_ROWS} />
          <span className="dq-grow" />
          {total > CONSOLE_PAGE_ROWS && (
            <span className="cx-pager">
              <PagerPos
                p={{
                  from: Math.min(total, from + 1),
                  to: from + rows.length,
                  total,
                  label: '',
                  canPrev: page > 0,
                  canNext: page < pages - 1,
                  prev: () => goTo(page - 1),
                  next: () => goTo(page + 1),
                  toRow: (n) => goTo(Math.floor((n - 1) / CONSOLE_PAGE_ROWS)),
                  prevLabel: 'Previous 100 rows',
                  nextLabel: 'Next 100 rows'
                }}
              />
              <PagerArrows
                p={{
                  canPrev: page > 0,
                  canNext: page < pages - 1,
                  prev: () => goTo(page - 1),
                  next: () => goTo(page + 1),
                  busy: paging ?? (sorting ? 'sort' : undefined),
                  prevLabel:
                    page > 0
                      ? `Previous 100 rows, ${range(from - CONSOLE_PAGE_ROWS, from)}`
                      : 'Previous 100 rows',
                  nextLabel:
                    page < pages - 1
                      ? `Next rows, ${range(from + CONSOLE_PAGE_ROWS, from + 2 * CONSOLE_PAGE_ROWS)}`
                      : 'Next 100 rows'
                }}
              />
            </span>
          )}
          {total > CONSOLE_PAGE_ROWS && <span className="cx-sep" aria-hidden="true" />}
          <Trio
            columns={outcome.columns}
            rows={held}
            total={total}
            contiguous={heldIsContiguous(state)}
            readRest={readRest}
            env={env}
          />
        </footer>
      )}
    </div>
  )
}

/** The receipt's glyph: the step's number, a warning where it failed, a clock for a query run here. */
function StepGlyph({ e, n }: { e: Entry; n: number }) {
  if (e.query.outcome.status === 'failed')
    return (
      <WarningCircleIcon size={15} weight="fill" className="dq-danger cx-gl" aria-label="Failed" />
    )
  if (e.who === 'you')
    return <ClockCounterClockwiseIcon size={14} className="cx-gl" aria-hidden="true" />
  return <span className="cx-n">{n}</span>
}

const countLine = (o: D1Outcome) =>
  o.status !== 'rows' || o.rowCount === 0
    ? 'No rows'
    : `${count(o.rowCount)} ${o.rowCount === 1 ? 'row' : 'rows'}`

/**
 * The agent's queries in order, then yours. Each opens its SQL and rows in the
 * editor and result. A failed step's second line is D1's own words, so it
 * never reads like the step that fixed it.
 */
function History({
  entries,
  active,
  open,
  agentCount,
  pending
}: {
  entries: readonly Entry[]
  active: number
  open: (i: number) => void
  agentCount: number
  pending: readonly PendingRead[]
}) {
  const mine = entries.slice(agentCount)
  const fixedIn = (i: number) => {
    const j = entries.findIndex(
      (e, k) => k > i && k < agentCount && e.query.outcome.status !== 'failed'
    )
    return j >= 0 ? j + 1 : undefined
  }
  const item = (e: Entry, i: number) => {
    const o = e.query.outcome
    return (
      <li key={e.id}>
        <button
          type="button"
          className="cx-hi"
          aria-current={i === active || undefined}
          data-bad={o.status === 'failed' ? '' : undefined}
          onClick={() => open(i)}
        >
          <StepGlyph e={e} n={i + 1} />
          <span className="cx-hitext">
            <span className="cx-hititle">{e.query.title}</span>
            <span className="cx-hisub" data-rail={o.status === 'failed' ? 'line' : undefined}>
              {o.status === 'failed' ? (
                <>
                  <span className="dq-danger">Failed</span>
                  {e.who === 'agent' && fixedIn(i) && <span> · fixed in {fixedIn(i)}</span>}
                  <span className="c18-hierr">
                    <ErrWords text={o.error} token={o.token} />
                  </span>
                </>
              ) : (
                countLine(o)
              )}
              {e.who === 'agent' && i === agentCount - 1 && <span> · the answer</span>}
              {e.who === 'agent' && e.ranAt && <span> · ran here</span>}
            </span>
          </span>
        </button>
      </li>
    )
  }
  return (
    <nav className="cx-sec cx-hist" aria-label="Queries">
      <p className="cx-label">
        <span>The agent’s queries</span>
        <span className="cx-labeln">{agentCount}</span>
      </p>
      <ol className="cx-hlist">{entries.slice(0, agentCount).map((e, i) => item(e, i))}</ol>
      {mine.length + pending.length > 0 && (
        <>
          <p className="cx-label">
            <span>Run here</span>
            <span className="cx-labeln">{mine.length + pending.length}</span>
          </p>
          <ol className="cx-hlist">
            {mine.map((e, i) => item(e, agentCount + i))}
            {/* Reads still on their way: each becomes its entry when D1 answers. */}
            {pending.map((r) => (
              <li key={r.key}>
                <span className="cx-hi" aria-busy="true" data-pending="">
                  <span className="dq-spin dq-spin-on" aria-hidden="true" />
                  <span className="cx-hitext">
                    <span className="cx-hititle">{r.title}</span>
                    <span className="cx-hisub">Reading from D1…</span>
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </nav>
  )
}

/** D1's words for the rail, with the name it is about kept whole on one line. */
function ErrWords({ text, token }: { text: string; token?: string }) {
  const at = token ? text.lastIndexOf(token) : -1
  if (!token || at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <span className="c18-tok">{token}</span>
      {text.slice(at + token.length)}
    </>
  )
}

/** The database's tables (sqlite_master), each opening into its columns (pragma_table_info): one `d1_raw` read. */
function Schema({ env, onPick }: { env: Env; onPick: (table: string) => void }) {
  const [tables, setTables] = useState<readonly SchemaTable[] | { error: string } | null>(null)
  const [reads, setReads] = useState(0)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (!env.host.run) return undefined
    const abort = new AbortController()
    setTables(null)
    runRead(env.app, env.database, SCHEMA_SQL, abort.signal).then(
      (o) => {
        if (o.status === 'failed') return setTables({ error: o.error })
        const by = new Map<string, { name: string; type: string; pk: boolean }[]>()
        for (const [tbl, col, type, pk] of o.rows) {
          const name = String(tbl)
          if (!by.has(name)) by.set(name, [])
          by.get(name)!.push({ name: String(col), type: String(type ?? ''), pk: Number(pk) > 0 })
        }
        setTables([...by].map(([name, cols]) => ({ name, cols })))
      },
      (error: unknown) => {
        if (!abort.signal.aborted) setTables({ error: messageOf(error) })
      }
    )
    return () => abort.abort()
  }, [reads])
  if (!env.host.run) return null
  const flip = (t: string) => {
    const s = new Set(open)
    if (s.has(t)) s.delete(t)
    else s.add(t)
    setOpen(s)
  }
  const list = Array.isArray(tables) ? (tables as readonly SchemaTable[]) : null
  return (
    <div className="cx-sec cx-schema">
      <p className="cx-label">
        <span>Tables</span>
        {list ? (
          <span className="cx-labeln">{list.length}</span>
        ) : !tables ? (
          <span className="cx-reading" role="status">
            <span className="dq-spin" aria-hidden="true" />
            Reading
          </span>
        ) : null}
        <span className="dq-grow" />
        <IconButton
          label="Read the tables again"
          onClick={() => setReads((n) => n + 1)}
          className="cx-mini"
        >
          <ArrowClockwiseIcon size={13} />
        </IconButton>
      </p>
      {!tables ? (
        <ul className="cx-tlist" aria-busy="true" aria-label="Reading the tables">
          {[72, 54, 64, 48, 60, 40].map((w, i) => (
            <li key={i} className="cx-skel">
              <i style={{ width: 14 }} />
              <i style={{ width: `${w}%` }} />
            </li>
          ))}
        </ul>
      ) : !list ? (
        <p className="dq-errtext cx-schemaerr" role="alert">
          {(tables as { error: string }).error}
        </p>
      ) : (
        <ul className="cx-tlist">
          {list.map((t) => {
            const on = open.has(t.name)
            return (
              <li key={t.name} data-open={on ? '' : undefined}>
                <div className="cx-trow">
                  <button
                    type="button"
                    className="cx-tcaret"
                    aria-expanded={on}
                    aria-label={`${on ? 'Hide' : 'Show'} the columns of ${t.name}`}
                    onClick={() => flip(t.name)}
                  >
                    <CaretRightIcon size={11} weight="bold" />
                  </button>
                  <button
                    type="button"
                    className="cx-tname"
                    title={`Run SELECT * FROM ${t.name} LIMIT 100 here`}
                    onClick={() => onPick(t.name)}
                  >
                    <TableIcon size={15} aria-hidden="true" />
                    <span>{t.name}</span>
                  </button>
                </div>
                {on && (
                  <ul className="cx-cols">
                    {t.cols.map((x) => (
                      <li key={x.name}>
                        {x.pk && <KeyIcon size={11} aria-label="Primary key" className="cx-pk" />}
                        <span className="cx-cname">{x.name}</span>
                        <span className="cx-ctype">{x.type}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** One editor line, with the reason's span (what the reason is about) wavy-underlined where it falls on this line. */
function EdLine({
  text,
  at,
  mark,
  token,
  tables
}: {
  text: string
  at: number
  mark?: readonly [number, number]
  token?: string
  tables: ReadonlySet<string>
}) {
  if (!text) return <span className="cx-l"> </span>
  const a = mark ? Math.max(0, mark[0] - at) : -1
  const b = mark ? Math.min(text.length, mark[1] - at) : -1
  const hl = (t: string, squiggle?: string) => highlightSql(t, { tables, squiggle })
  if (!mark || b <= 0 || a >= text.length) return <span className="cx-l">{hl(text, token)}</span>
  return (
    <span className="cx-l">
      {hl(text.slice(0, a), token)}
      <span className="s5-mark">{hl(text.slice(a, b))}</span>
      {hl(text.slice(b), token)}
    </span>
  )
}

/** Studio's editor: line numbers, the SQL highlighted under a transparent textarea, the reason line, then its bar with Run. */
function Editor({
  taRef,
  state,
  dispatch,
  env,
  entry,
  step,
  lines: edLines,
  focusToken,
  onMeasure
}: {
  taRef: RefObject<HTMLTextAreaElement | null>
  state: CardState
  dispatch: Dispatch<CardEvent>
  env: Env
  entry: Entry
  step?: readonly [number, number]
  lines: number
  /** A failed step's marked name, scrolled into view when the step opens. */
  focusToken?: string
  /** The SQL's lines as drawn (a long line wraps), measured when the step opens. */
  onMeasure: (lines: number) => void
}) {
  const [pos, setPos] = useState<[number, number]>([1, 1])
  const draft = state.draft
  const edited = draft.trim() !== entry.query.sql.trim()
  const running = state.run.status === 'running'
  const track = () => {
    const el = taRef.current
    if (!el) return
    const before = el.value.slice(0, el.selectionStart).split('\n')
    setPos([before.length, before.at(-1)!.length + 1])
  }
  const mark = markOf(verdictOf(draft))
  const outcome = shownOutcome(state)
  const token = !edited && outcome.status === 'failed' ? outcome.token : undefined
  let at = 0
  const whose = running
    ? 'Reading from D1…'
    : edited
      ? 'Edited'
      : entry.who === 'you'
        ? 'Your query'
        : step
          ? `The agent’s query ${step[0]} of ${step[1]}`
          : 'The agent’s query'
  const reasonId = 'cx-why'
  const edBox = useRef<HTMLDivElement>(null)
  // The lines as drawn, not as typed: a one-line read that wraps to three gets three, so its mark is in view.
  useLayoutEffect(() => {
    const pre = edBox.current?.querySelector('.cx-edpre')
    if (!pre) return
    const drawn = Array.from(pre.children).reduce(
      (n, l) => n + Math.max(1, Math.round((l as HTMLElement).offsetHeight / ED_LH)),
      0
    )
    onMeasure(Math.max(1, drawn))
  }, [])
  // A failed step opens with D1's marked name in view, scrolled by whole lines, a line of context under it.
  useLayoutEffect(() => {
    const box = edBox.current
    if (!box) return
    const all = draft.split('\n')
    const i = focusToken ? all.findIndex((l) => l.includes(focusToken)) : -1
    if (i < 0 || all.length <= edLines) {
      box.scrollTo({ top: 0 })
      return
    }
    const first = Math.max(0, Math.min(i - (edLines - 2), all.length - edLines - 1))
    box.scrollTo({ top: first ? ED_TOP + first * ED_LH : 0 })
  }, [edLines])
  return (
    <div className="cx-edpane" style={{ ['--ed-lines' as string]: edLines }}>
      <div className="cx-ed" ref={edBox}>
        <code className="cx-edpre" aria-hidden="true">
          {draft.split('\n').map((l, i) => {
            const start = at
            at += l.length + 1
            return (
              <EdLine key={i} text={l} at={start} mark={mark} token={token} tables={env.tables} />
            )
          })}
        </code>
        <textarea
          ref={taRef}
          className="cx-edinput"
          aria-label="SQL. Command or Control Enter runs it"
          aria-describedby={reasonId}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          readOnly={!state.editable}
          value={draft}
          onChange={(e) => {
            dispatch({ type: 'draft.change', draft: e.target.value })
            track()
          }}
          onSelect={track}
          onKeyUp={track}
          onClick={track}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              submitKey(state, dispatch, e.currentTarget)
            }
          }}
        />
      </div>
      <div className="cx-s5">
        <S5Lines
          state={state}
          dispatch={dispatch}
          env={env}
          outcome={outcome}
          id={reasonId}
          errorElsewhere
        />
      </div>
      <div className="cx-edbar">
        <span className="cx-whose">{whose}</span>
        {edited && !running && (
          <Ghost onClick={() => dispatch({ type: 'draft.change', draft: entry.query.sql })}>
            Revert
          </Ghost>
        )}
        {!edited && entry.who === 'agent' && entry.ranAt && (
          <span className="cx-ran">· ran here just now</span>
        )}
        <span className="cx-lncol">
          Ln {pos[0]}, Col {pos[1]}
        </span>
        <span className="dq-grow" />
        {!copyIsPrimary(state) && <CopySql sql={draft} plain />}
        {state.editable && (
          <span className="cx-run">
            <RunButton state={state} dispatch={dispatch} host={env.host} reasonId={reasonId} />
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The result: Studio's table filling the rest, or D1's own error in Studio's
 * form with the fix. Rows share the leftover px (at most 2 each) so every
 * resting view ends on a whole row flush with the foot; a short result gives
 * its room to the SQL first, then the column rules run on to the foot.
 */
function Result({
  state,
  outcome,
  rows,
  held,
  offset,
  dim,
  sorting,
  fixed,
  onFix,
  onSpare,
  edExtra,
  dispatch
}: {
  state: CardState
  outcome: D1Outcome
  rows: readonly (readonly D1Cell[])[]
  held: readonly (readonly D1Cell[])[]
  offset: number
  dim: boolean
  sorting: boolean
  fixed?: { n: number; open: () => void; with?: string }
  onFix: (sql: string) => void
  onSpare: (px: number, shownExtra: number) => void
  edExtra: number
  dispatch: Dispatch<CardEvent>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const extra = useRef(edExtra)
  extra.current = edExtra
  const [lay, setLay] = useState<{ rowh?: number; pad?: number }>({})
  const [more, setMore] = useState({ top: false, bottom: false })
  // A new page starts at its top.
  useEffect(() => {
    ref.current?.querySelector('.dq-grid')?.scrollTo({ top: 0 })
  }, [offset, outcome])
  useLayoutEffect(() => {
    const box = ref.current
    const grid = box?.querySelector<HTMLElement>('.dq-grid')
    if (!box || !grid) return undefined
    const measure = () => {
      const head = grid.querySelector<HTMLElement>('thead')?.offsetHeight ?? ROW_H
      const bar = grid.offsetHeight - grid.clientHeight
      const avail = box.clientHeight - head - bar
      const k = Math.max(1, Math.floor(avail / ROW_H))
      if (rows.length > k) {
        setLay({ rowh: avail / k })
        return
      }
      const pad = Math.max(0, Math.floor(avail - rows.length * ROW_H))
      onSpare(pad, extra.current)
      setLay({ pad })
    }
    const scroll = () =>
      setMore({
        top: grid.scrollTop > 0,
        bottom: grid.scrollTop + grid.clientHeight < grid.scrollHeight - 2
      })
    measure()
    scroll()
    const ro = new ResizeObserver(() => {
      measure()
      scroll()
    })
    ro.observe(box)
    grid.addEventListener('scroll', scroll, { passive: true })
    return () => {
      ro.disconnect()
      grid.removeEventListener('scroll', scroll)
    }
  }, [outcome, rows.length])
  useLayoutEffect(() => {
    const grid = ref.current?.querySelector<HTMLElement>('.dq-grid')
    if (!grid) return
    const bottom = grid.scrollTop + grid.clientHeight < grid.scrollHeight - 2
    setMore((m) => (m.bottom === bottom ? m : { ...m, bottom }))
  }, [lay])

  if (outcome.status === 'failed') {
    const { token } = outcome
    const fix = outcome.fix ?? viewFix(outcome, state.query.outcome)
    const draft = state.draft
    const useBtn = fix && token && hasIdentifier(draft, token) && (
      <Ghost outline onClick={() => onFix(replaceIdentifier(draft, token, fix.use))}>
        Use {fix.use.split('.').pop()}
      </Ghost>
    )
    return (
      <div className="cx-result cx-err" role="alert">
        <p className="cx-errhead">D1 couldn’t run this query</p>
        <p className="cx-errmono">Error: {outcome.error}</p>
        {fixed && (
          <p className="c18-fixline">
            <span>
              The agent fixed it in query {fixed.n}
              {fixed.with && (
                <>
                  {' '}
                  with <code className="c18-code">{fixed.with}</code>
                </>
              )}
            </span>
            <button type="button" className="c18-link" onClick={fixed.open}>
              Open query {fixed.n}
              <ArrowRightIcon size={12} aria-hidden="true" />
            </button>
          </p>
        )}
        {useBtn && <p className="cx-erracts c18-erracts">{useBtn}</p>}
      </div>
    )
  }
  if (outcome.rowCount === 0)
    return (
      <div className="cx-result cx-err">
        <p className="cx-errhead">No rows</p>
        <p className="cx-none">The query ran and matched nothing.</p>
      </div>
    )
  return (
    <div
      className="cx-result"
      ref={ref}
      data-edge="share"
      data-top={more.top ? '' : undefined}
      data-bottom={more.bottom ? '' : undefined}
      style={{ ['--rowh' as string]: lay.rowh ? `${lay.rowh}px` : undefined }}
    >
      <Grid
        columns={outcome.columns}
        rows={rows}
        widthRows={held}
        offset={offset}
        count={outcome.rowCount}
        sort={sorting && state.fetch.status === 'sorting' ? state.fetch.sort : state.sort}
        busy={sorting}
        dim={dim}
        padPx={lay.pad}
        label={`Rows ${count(offset + 1)}–${count(offset + rows.length)} of ${count(outcome.rowCount)}`}
        onSort={(column) => dispatch({ type: 'sort', column })}
      />
    </div>
  )
}
