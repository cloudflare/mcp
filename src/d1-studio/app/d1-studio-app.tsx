import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent,
  type ReactNode
} from 'react'
import {
  ArrowSquareOutIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  CheckIcon,
  CopyIcon,
  CornersOutIcon,
  InfoIcon,
  MinusCircleIcon,
  PaperPlaneRightIcon,
  PencilSimpleIcon,
  PlayIcon,
  SortAscendingIcon,
  SortDescendingIcon,
  WarningCircleIcon
} from '@phosphor-icons/react'
import { CloudflareLogo } from '@cloudflare/kumo'
import type { App } from '@modelcontextprotocol/ext-apps'
import { mountMcpApp } from '../../mcp-apps/app-shell/mount'
import {
  D1StudioInputSchema,
  D1StudioResultSchema,
  MODEL_ROWS,
  type D1Cell,
  type D1Outcome,
  type D1Query,
  type D1StudioResult
} from '../contract'
import { Console, useConsoleHistory } from './console'
import { CopyToastHost, copyRows, copyText, useCopyToast } from './copy'
import { FIX_H, Fill, NO_PLAN, RICH_H, type Plan } from './fill'
import { FORMAT_LABEL, columnType, count, duration } from './format'
import {
  PAGE_ROWS,
  SEND_TIMEOUT_MS,
  ageWords,
  canRevert,
  cardKind,
  cardReducer,
  copyReducer,
  foundWords,
  heldIsContiguous,
  heldRows,
  initialCard,
  isBusy,
  isEdited,
  isStale,
  keptOutcome,
  limitPaging,
  moved,
  pageCount,
  pageRows,
  shownOutcome,
  shownSql,
  sortRows,
  type CardEvent,
  type CardKind,
  type CardState,
  type Sort
} from './machines'
import {
  hostAbilities,
  readRows,
  readSlice,
  runRead,
  sendToChat,
  studioUrl,
  type HostAbilities
} from './run'
import { foldSql, widthOf, wrapOnlyAtClauses } from './sql-fold'
import { highlightSql } from './sql'
import { hasIdentifier, replaceIdentifier } from '../statement'
import { closest, fixOf, markOf, reasonOf, verdictOf } from './verdict'
import './d1-studio.css'

/**
 * D1 Studio: one card per `d1_studio` call, after the dashboard's Studio.
 * The card is compact by default: the Cloudflare mark as the title's first word, the row count and
 * the copy trio, then the query folded a clause per line on the editor's tray,
 * with Run (or Edit, when running it as is can't help) in the tray's corner.
 * The rows open under it as Studio's table. An open card ends in one recessed
 * band: the receipt on the left, the actions on the right, Run last. Earlier
 * queries that led to the answer sit below it as a train of steps.
 *
 * The answer's SQL can be edited and re-run in the view: a read goes through
 * the host (`callServerTool('d1_raw')`) with no model turn, and a write is
 * handed to the chat for the user to approve. The editor renders only once
 * the user opens the query. Past ten rows the band pages them (Go to row
 * included); a query's own small LIMIT pages by writing OFFSET into its SQL.
 * In a host frame taller than the card the card fills it (fill.tsx); in the
 * host's fullscreen the view is the console (console.tsx).
 */

/** What the card needs from the host, fixed for the card's life. */
export interface Env {
  readonly database: D1StudioResult['database']
  readonly tables: ReadonlySet<string>
  readonly host: HostAbilities
  readonly app: App
}

function Studio({ result, app }: { result: D1StudioResult; app: App }) {
  useKeyboardModality()
  const display = useDisplayMode()
  const env = useMemo<Env>(
    () => ({
      database: result.database,
      tables: new Set(result.tables.map((t) => t.toLowerCase())),
      host: hostAbilities(app),
      app
    }),
    [result, app]
  )
  // The answer card's machine and the console's history live here, above the display switch: a run or a send in
  // flight, and the console's runs, outlive going fullscreen and back.
  const answer = useAnswerCard(result.answer, result.readAt, env)
  const history = useConsoleHistory(result)
  // Back from fullscreen: the card is the closed card again (its draft kept), focus on the ⛶.
  const sectionRef = useRef<HTMLElement>(null)
  const was = useRef(display)
  const [, dispatchAnswer] = answer
  useEffect(() => {
    const back = was.current === 'fullscreen' && display !== 'fullscreen'
    was.current = display
    if (!back) return undefined
    dispatchAnswer({ type: 'fold' })
    const t = window.setTimeout(() => {
      const section = sectionRef.current
      const el =
        section?.querySelector<HTMLElement>('[data-fs]') ??
        section?.querySelector<HTMLElement>('.dq-glyph')
      el?.focus()
      // The ring shows where focus came back to, also where the host's frame isn't focused (no :focus-visible).
      el?.setAttribute('data-focus', '')
    }, 120)
    return () => window.clearTimeout(t)
  }, [display])
  return (
    <>
      {display === 'fullscreen' ? (
        <Console result={result} env={env} history={history} />
      ) : (
        <section
          className="dq"
          aria-label={`D1 query: ${result.answer.title}`}
          ref={sectionRef}
          key={display}
        >
          <Card state={answer[0]} dispatch={answer[1]} env={env} steps={result.steps} />
          {result.steps.length > 0 && (
            <Train steps={result.steps} answer={result.answer} env={env} />
          )}
        </section>
      )}
      <CopyToastHost />
    </>
  )
}

/** The host's display mode, which mount.tsx keeps on the root as `data-display`. */
function useDisplayMode(): string {
  const read = () => document.documentElement.dataset.display ?? 'inline'
  const [mode, setMode] = useState(read)
  useEffect(() => {
    const mo = new MutationObserver(() => setMode(read()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-display'] })
    return () => mo.disconnect()
  }, [])
  return mode
}

/**
 * The view's own height, for the host: with what fills a taller frame turned
 * off for one synchronous layout (`data-measuring`), so the frame can shrink
 * back to the card when it closes. Nothing paints in between.
 */
function measureView(): number {
  const root = document.documentElement
  root.setAttribute('data-measuring', '')
  const prev = root.style.height
  root.style.height = 'max-content'
  const h = root.getBoundingClientRect().height
  root.style.height = prev
  root.removeAttribute('data-measuring')
  return h
}

/**
 * Keyboard modality, for hosts where `:focus-visible` can't tell (an
 * unfocused iframe): a Tab marks it, a pointer clears it. The tray's corner
 * action shows its focus ring only then.
 */
function useKeyboardModality() {
  useEffect(() => {
    const root = document.documentElement
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Tab') root.dataset.kbd = ''
    }
    const point = () => delete root.dataset.kbd
    window.addEventListener('keydown', key, true)
    window.addEventListener('pointerdown', point, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('pointerdown', point, true)
    }
  }, [])
}

/** While the agent's call runs: its title and SQL from the tool input, the trio in place but disabled. */
function Pending({ input }: { input: Record<string, unknown> | undefined }) {
  const parsed = D1StudioInputSchema.safeParse(input)
  const title = parsed.success
    ? (parsed.data.title ?? (parsed.data.sql ? 'Query' : 'Tables'))
    : 'Query'
  const sql = parsed.success ? (parsed.data.sql ?? '') : ''
  return (
    <section className="dq" aria-label={`D1 query: ${title}`} aria-busy="true">
      <div className="dq-receipt" data-kind="running">
        <Head
          kind="running"
          title={title}
          count={<CountText kind="running" rows={0} />}
          action={<Trio disabled />}
        />
        {sql && (
          <div className="dq-cell" aria-hidden="true">
            <div className="dq-sql dq-sql-cell">
              <ShortSql sql={sql} tables={new Set()} />
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

// ── The answer card: its own machine, editable when the host can run reads or send messages ──

function useAnswerCard(
  query: D1Query,
  readAt: number | undefined,
  env: Env
): [CardState, Dispatch<CardEvent>] {
  const [state, dispatch] = useReducer(cardReducer, undefined, () =>
    initialCard(
      query,
      query.purpose === 'query' && { run: env.host.run, send: env.host.send },
      Math.min(readAt ?? Date.now(), Date.now())
    )
  )
  useRunEffects(state, dispatch, env)
  useFetchEffects(state, dispatch, env)
  return [state, dispatch]
}

/**
 * Performs what the machine asked for: a `running` run sends the read, a
 * `sending` run posts the write to the chat. Each reply carries the run's id,
 * so a reply to a run the user reverted is ignored by the reducer. A host that
 * doesn't confirm a send in SEND_TIMEOUT_MS stops being waited for.
 */
export function useRunEffects(
  state: CardState,
  dispatch: Dispatch<CardEvent>,
  env: Env,
  /**
   * Where a read goes when the card unmounts mid-read (the console's editor, as
   * you open another entry): it isn't aborted, it lands there. Without it, the
   * read is aborted.
   */
  letGo?: (sql: string, outcome: Promise<D1Outcome>, startedAt: number) => void
) {
  const { run } = state
  const id = run.status === 'running' || run.status === 'sending' ? run.id : undefined
  // Before the run's effect, so its cleanup can tell an unmount from a new run or a Revert.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (run.status === 'running') {
      const abort = new AbortController()
      const startedAt = Date.now()
      const outcome = runRead(env.app, env.database, run.sql, abort.signal)
      outcome.then(
        (o) => {
          if (mounted.current) dispatch({ type: 'run.done', id: run.id, outcome: o, at: Date.now() })
        },
        (error: unknown) => {
          if (mounted.current && !abort.signal.aborted)
            dispatch({ type: 'run.error', id: run.id, error: messageOf(error) })
        }
      )
      return () => {
        if (!mounted.current && letGo) letGo(run.sql, outcome, startedAt)
        else abort.abort()
      }
    }
    if (run.status === 'sending') {
      const sid = run.id
      sendToChat(env.app, env.database, run.sql).then(
        () => dispatch({ type: 'send.done', id: sid }),
        (error: unknown) => dispatch({ type: 'send.error', id: sid, error: messageOf(error) })
      )
      const timer = window.setTimeout(
        () => dispatch({ type: 'send.timeout', id: sid }),
        SEND_TIMEOUT_MS
      )
      return () => window.clearTimeout(timer)
    }
    return undefined
    // Keyed on the run's id alone: the rest of `run` is fixed for that id, and `env` for the card's life.
  }, [id])
  // A re-run's rows also go to the model, so its next turn doesn't repeat the numbers the user no longer sees.
  const shown = state.shown
  useEffect(() => {
    if (shown.source !== 'rerun' || !env.host.context) return
    void env.app
      .updateModelContext({ content: [{ type: 'text', text: rerunContext(state) }] })
      .catch(() => undefined)
  }, [shown])
}

/** What the model is told after the user ran SQL in the view: the SQL, what it found, and the first rows. */
function rerunContext(state: CardState): string {
  const shown = state.shown
  if (shown.source !== 'rerun') return ''
  const o = shown.outcome
  const found = foundWords(state.found)
  const head = `The user ran this SQL in the D1 Studio view (no model turn)${found ? `; ${found}` : ''}:\n${shown.sql}`
  if (o.status === 'failed') return `${head}\nD1 refused it: ${o.error}`
  return `${head}\nIt returned ${o.rowCount} rows (columns: ${o.columns.join(', ')}). First ${Math.min(o.rows.length, MODEL_ROWS)}: ${JSON.stringify(o.rows.slice(0, MODEL_ROWS))}`
}

/** Reads what paging or a D1 sort asked for, `MAX_ROWS` at a time. Keyed on the read's id, like a run. */
export function useFetchEffects(state: CardState, dispatch: Dispatch<CardEvent>, env: Env) {
  const { fetch } = state
  const id = fetch.status === 'paging' || fetch.status === 'sorting' ? fetch.id : undefined
  useEffect(() => {
    if (fetch.status !== 'paging' && fetch.status !== 'sorting') return undefined
    const abort = new AbortController()
    const slice =
      fetch.status === 'sorting'
        ? { sort: fetch.sort, offset: fetch.offset }
        : { sort: state.sort, offset: fetch.offset }
    readSlice(env.app, env.database, shownSql(state), slice, abort.signal).then(
      (rows) => dispatch({ type: 'fetch.done', id: fetch.id, rows }),
      (error: unknown) => {
        if (!abort.signal.aborted)
          dispatch({ type: 'fetch.error', id: fetch.id, error: messageOf(error) })
      }
    )
    return () => abort.abort()
  }, [id])
}

export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** What the editor selects when it opens: a name to find, a range, or the caret at the end. */
type Focus = string | true | readonly [number, number]

/**
 * The closed tray's corner. Nothing at rest on a card that can run as it is:
 * the whole tray is the field, and pointer over or focus shows an Edit face
 * as a hint. `edit`: running it unchanged can't help (it failed or came back
 * empty), so an outlined Edit opens the editor on the likely culprit. `note`:
 * the tray no longer shows the agent's result ("Edited", "Ran here").
 */
type Cue =
  | { readonly kind: 'edit'; readonly onClick: () => void }
  | { readonly kind: 'note'; readonly label: string }

/** Re-renders once a minute, so the rows' age ("Read 3h ago") stays true while the card is on screen. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** The first page shown: rows 1–10, or (paged) "rows 1–10 of 1,284". */
const showLabel = (paged: boolean, total: number) =>
  paged ? `Show rows 1–${PAGE_ROWS} of ${count(total)}` : `Show ${count(total)} rows`

function Card({
  state,
  dispatch,
  env,
  steps
}: {
  state: CardState
  dispatch: Dispatch<CardEvent>
  env: Env
  steps: readonly D1Query[]
}) {
  const outcome = shownOutcome(state)
  const kind = cardKind(state.query.purpose, outcome)
  const rowsId = useId()
  const reasonId = `${useId()}-why`
  const rowsRef = useRef<HTMLDivElement>(null)
  const now = useMinute()
  const held = useMemo(() => heldRows(state), [state.shown, state.sort, state.held])
  // A read the user ran that D1 refused keeps the agent's rows under its error, dimmed.
  const kept = keptOutcome(state)
  const columns = outcome.status === 'rows' ? outcome.columns : (kept?.columns ?? [])
  const total = outcome.status === 'rows' ? outcome.rowCount : 0
  const [focus, setFocus] = useState<Focus>()
  const openEditor = (at: Focus) => {
    setFocus(at)
    if (state.pane === 'short') dispatch({ type: 'pane.toggle' })
  }
  // The card's share of a taller host frame (fill.tsx), shared by its two fillers.
  const [plan, setPlan] = useState<Plan>(NO_PLAN)
  const [filled, setFilled] = useState('none')

  const ranAny = state.found.kind !== 'agent'
  const changed = state.draft !== state.query.sql
  const agentKind = cardKind(state.query.purpose, state.query.outcome)
  const agentOutcome = state.query.outcome
  const cue: Cue | undefined = !state.editable
    ? undefined
    : (agentKind === 'error' || agentKind === 'none') && !ranAny && !changed
      ? {
          kind: 'edit',
          onClick: () =>
            openEditor(
              agentOutcome.status === 'failed'
                ? (agentOutcome.token ?? true)
                : (emptier(state.query.sql) ?? true)
            )
        }
      : changed
        ? { kind: 'note', label: 'Edited' }
        : moved(state.found) || state.found.kind === 'edited'
          ? { kind: 'note', label: 'Ran here' }
          : undefined

  const editorOpen = state.pane === 'full'
  const rowsBlock = kind === 'rows' || !!kept
  const rowsOpen = state.rows === 'open' && rowsBlock
  const resultOpen = rowsOpen && kind === 'rows'

  // ── The open table pages ten rows at a time. The gutter counts from the result's start. ──
  const paged = kind === 'rows' && total > PAGE_ROWS
  const limited = limitPaging(state)
  const from = state.page * PAGE_ROWS
  const visible = kept ? kept.rows : paged ? pageRows(state, state.page) : held
  // A short last page keeps ten rows' height: the pager never moves under the pointer.
  const pad = paged ? PAGE_ROWS - visible.length : 0
  const sorting = state.fetch.status === 'sorting'
  const pager = paged ? pagerOf(state, total, visible.length, dispatch) : undefined
  const contiguous = heldIsContiguous(state)

  // "2 values changed" brings a changed cell into view and shows its old value: the first one off the table's scroll
  // edge (at 352 a column can be), else the next, so every press shows something.
  const markAt = useRef(-1)
  const showMark = () => {
    const grid = rowsRef.current?.querySelector<HTMLElement>('.dq-grid')
    const cells = Array.from(grid?.querySelectorAll<HTMLElement>('td[data-changed]') ?? [])
    if (!grid || !cells.length) return
    const gutter = grid.querySelector<HTMLElement>('.dq-gutter')?.offsetWidth ?? 0
    const inView = (c: HTMLElement) =>
      c.offsetLeft >= grid.scrollLeft + gutter &&
      c.offsetLeft + c.offsetWidth <= grid.scrollLeft + grid.clientWidth - 8
    const hidden = cells.findIndex((c) => !inView(c))
    markAt.current = hidden >= 0 ? hidden : (markAt.current + 1) % cells.length
    const cell = cells[markAt.current]!
    if (!inView(cell))
      grid.scrollTo({
        left:
          cell.offsetLeft < grid.scrollLeft + gutter
            ? cell.offsetLeft - gutter
            : cell.offsetLeft + cell.offsetWidth - grid.clientWidth + 24,
        behavior: 'smooth'
      })
    for (const c of cells) c.removeAttribute('data-tip')
    cell.setAttribute('data-tip', '')
    cell.focus({ preventScroll: true })
  }

  /** "Copy all": `d1_raw`, `SELECT * FROM (<sql>) [ORDER BY …] LIMIT n OFFSET m`, one block at a time. */
  const readRest =
    env.host.run && outcome.status === 'rows' && total > held.length
      ? (offset: number, limit: number) =>
          readRows(env.app, env.database, shownSql(state), { sort: state.sort, offset, limit })
      : undefined
  const action =
    kind === 'rows' ? (
      <Trio
        columns={columns}
        rows={held}
        total={total}
        contiguous={contiguous}
        readRest={readRest}
        env={env}
      />
    ) : kind === 'error' && !(editorOpen && state.editable) ? (
      // With the editor open its band carries Copy SQL, so the title line doesn't repeat it.
      <CopySql sql={shownSql(state)} />
    ) : null

  // ── Filling a taller frame (fill.tsx). A closed card takes the slack; an edited card (editor open, rows closed)
  //    shows the agent's band under its action row. ──
  const closed = !editorOpen && state.rows === 'closed'
  const fillable = closed && (kind === 'rows' || kind === 'none' || kind === 'error')
  const editFill = editorOpen && !rowsOpen && state.editable
  // The one more line a closed card adds where the frame has room: a failed answer's fix (a read the view runs), or the
  // answer naming the failed step it fixes.
  const failedAt = steps.findIndex((s) => s.outcome.status === 'failed')
  const fix = outcome.status === 'failed' ? outcome.fix : undefined
  const fixSql =
    fix && outcome.status === 'failed' && outcome.token
      ? replaceIdentifier(shownSql(state), outcome.token, fix.use)
      : undefined
  const richKind: 'fix' | 'train' | undefined = !fillable
    ? undefined
    : kind === 'error' && fixSql && !changed && !ranAny && env.host.run
      ? 'fix'
      : kind === 'rows' && failedAt >= 0 && !ranAny
        ? 'train'
        : undefined
  const rich = fillable && plan.rich && !!richKind
  const trainRef = useRef<HTMLParagraphElement>(null)

  const stale = kind === 'rows' && isStale(state, now)
  const layered = editorOpen || rowsOpen
  const band = layered ? (
    <Band
      state={state}
      dispatch={dispatch}
      env={env}
      outcome={outcome}
      editorOpen={editorOpen}
      rowsOpen={resultOpen}
      kept={!!kept && rowsOpen}
      stale={stale}
      now={now}
      pager={pager}
      limited={limited}
      reasonId={reasonId}
      onShowMark={showMark}
    />
  ) : null
  const lastBand = useRef<ReactNode>(null)
  if (band) lastBand.current = band
  const links = <ResultLinks env={env} />

  return (
    <>
      <div
        className="dq-receipt"
        data-open={rowsOpen ? '' : undefined}
        data-kind={kind}
        data-layered={layered || filled === 'band' ? '' : undefined}
        style={editFill && plan.grow ? { ['--ed-grow' as string]: `${plan.grow}px` } : undefined}
      >
        <Head
          kind={kind}
          title={state.query.title}
          count={<CountText kind={kind} rows={total} />}
          action={action}
          disclosure={
            kind === 'rows'
              ? {
                  open: rowsOpen,
                  controls: rowsId,
                  label: showLabel(paged, total),
                  onToggle: () => dispatch({ type: 'rows.toggle' })
                }
              : undefined
          }
        />
        <SqlPane
          state={state}
          dispatch={dispatch}
          env={env}
          outcome={outcome}
          cue={cue}
          focus={focus}
          reasonId={reasonId}
          onFold={() => setFocus(undefined)}
        />
        {!editorOpen &&
          (rich && richKind === 'fix' && fix && fixSql && outcome.status === 'failed' ? (
            <FixLines
              outcome={outcome}
              fix={fix}
              busy={isBusy(state.run)}
              tight={plan.tight}
              onUse={() => dispatch({ type: 'run.sql', sql: fixSql })}
            />
          ) : (
            <StateLine outcome={outcome} kind={kind} env={env} />
          ))}
        {!editorOpen && <RunLine state={state} />}
        {rich && richKind === 'train' && (
          <p className="dq-line2 dq-line2-act b18-rich b18-trainfix" ref={trainRef}>
            <span className="dq-line2-text">
              {/* The answer succeeded: the error it fixes is quoted in plain ink, not as a new failure. */}
              Fixes query {failedAt + 1}:{' '}
              <span className="dq-mono">
                {(steps[failedAt]!.outcome as { error: string }).error}
              </span>
            </span>
            <Ghost
              outline
              onClick={() =>
                trainRef.current
                  ?.closest('section.dq')
                  ?.dispatchEvent(new CustomEvent(OPEN_STEP, { detail: failedAt }))
              }
            >
              Open {failedAt + 1}
            </Ghost>
          </p>
        )}
        {rowsBlock && (
          <div className="dq-rows" id={rowsId} ref={rowsRef} inert={!rowsOpen || undefined}>
            <div className="dq-rows-in">
              <Grid
                columns={columns}
                rows={visible}
                widthRows={kept ? kept.rows : held}
                offset={kept ? 0 : from + (limited?.offset ?? 0)}
                pad={kept ? 0 : pad}
                count={kept ? kept.rowCount : total + (limited?.offset ?? 0)}
                sort={sorting && state.fetch.status === 'sorting' ? state.fetch.sort : state.sort}
                busy={sorting}
                dim={!!kept}
                label={pager ? `Rows ${pager.label}` : undefined}
                onPage={pager && ((d) => dispatch({ type: 'page', page: state.page + d }))}
                was={state.found.kind === 'changed' ? state.found.was : undefined}
                onSort={(column) => !kept && dispatch({ type: 'sort', column })}
              />
            </div>
          </div>
        )}
      </div>
      {fillable && (
        <Fill
          mode="closed"
          peekable={kind === 'rows'}
          richH={richKind ? (richKind === 'fix' ? FIX_H : RICH_H) : 0}
          richTight={richKind === 'fix'}
          plan={plan}
          onPlan={setPlan}
          onFilled={setFilled}
          max={Math.min(2, held.length)}
          onOpen={() => dispatch({ type: 'rows.toggle' })}
          label={showLabel(paged, total)}
          peek={(n) => (
            <div className="dq-rows-in a17-peek">
              <Grid
                columns={columns}
                rows={held.slice(0, n)}
                widthRows={held}
                count={Math.min(PAGE_ROWS, total)}
                sort={state.sort}
                onSort={() => undefined}
              />
            </div>
          )}
          band={
            <div className="dq-layer" data-v="4">
              <span className="dq-rcpt">
                {outcome.status === 'rows' && <StatsCompact outcome={outcome} />}
              </span>
              <span className="dq-acts">{links}</span>
            </div>
          }
        />
      )}
      {/* Always mounted, holding its last content while it collapses, so it leaves the way it came. */}
      <div
        className="dq-layerwrap"
        data-on={layered ? '' : undefined}
        inert={!layered || undefined}
      >
        <div>{lastBand.current}</div>
      </div>
      {editFill && (
        <Fill
          mode="edit"
          peekable={false}
          plan={plan}
          onPlan={setPlan}
          onFilled={setFilled}
          max={0}
          onOpen={() => undefined}
          label=""
          peek={() => null}
          band={
            <div className="dq-layer" data-v="4">
              <span className="dq-rcpt">
                {ranAny && state.found.kind !== 'failed' && <RanMark />}
                {(outcome.status === 'rows' ? outcome : kept) && (
                  <StatsCompact
                    outcome={(outcome.status === 'rows' ? outcome : kept)!}
                    who={ranAny && outcome.status === 'rows' ? 'you' : 'agent'}
                  />
                )}
              </span>
              <span className="dq-acts">{links}</span>
            </div>
          }
        />
      )}
    </>
  )
}

/** The event the answer's "Open 3" sends its card's section, to open the train at that step. */
const OPEN_STEP = 'dq-open-step'

/** The receipt's first mark once a re-read's rows are on screen: ✓, "Ran here" in its name. */
function RanMark() {
  return (
    <span className="dq-ranmark" role="img" aria-label="Ran here" title="Ran here">
      <CheckIcon size={12} weight="bold" aria-hidden="true" />
    </span>
  )
}

/**
 * A failed card with room for one more line: D1's words on their own line,
 * then what the name likely meant and the fix the view can run (a read).
 */
function FixLines({
  outcome,
  fix,
  busy,
  tight,
  onUse
}: {
  outcome: Extract<D1Outcome, { status: 'failed' }>
  fix: { use: string; table?: string }
  busy: boolean
  tight: boolean
  onUse: () => void
}) {
  const name = fix.use.split('.').pop()!
  return (
    <>
      <p className="dq-line2" role="alert">
        <span className="dq-mono dq-danger">{outcome.error}</span>
      </p>
      <p className="dq-line2 dq-line2-act b18-rich" data-tight={tight ? '' : undefined}>
        <span className="dq-line2-text">
          {fix.table ? `${fix.table} has ${name}` : `Did you mean ${name}?`}
        </span>
        <Ghost outline onClick={onUse}>
          {busy ? 'Running…' : `Use ${name}`}
        </Ghost>
      </p>
    </>
  )
}

/**
 * The condition most likely to have emptied a result: the last
 * `AND col = 'literal'` in the WHERE clause, as a range over the predicate
 * alone (without its AND), so typing over the selection leaves valid SQL.
 */
export function emptier(sql: string): [number, number] | undefined {
  const m = [...sql.matchAll(/\bAND\s+([\w.]+\s*=\s*'[^']*')/gi)].at(-1)
  if (!m || m.index === undefined || !m[1]) return undefined
  const start = m.index + m[0].length - m[1].length
  return [start, start + m[1].length]
}

// ── The band pager: past ten rows the open band says where you are and carries ‹ › ──

export interface PagerState {
  readonly from: number
  readonly to: number
  readonly total: number
  readonly label: string
  readonly canPrev: boolean
  readonly canNext: boolean
  readonly prev: () => void
  readonly next: () => void
  /** Go to the page holding row `n` (1-based). */
  readonly toRow: (n: number) => void
  readonly busy?: 'next' | 'prev' | 'sort'
  readonly prevLabel: string
  readonly nextLabel: string
}

function pagerOf(
  state: CardState,
  total: number,
  shownRows: number,
  dispatch: Dispatch<CardEvent>
): PagerState {
  const pages = pageCount(state)
  const page = state.page
  const from = page * PAGE_ROWS
  const range = (a: number, b: number) => `${count(a + 1)}–${count(b)}`
  const span = (p: number) => [p * PAGE_ROWS, Math.min(total, (p + 1) * PAGE_ROWS)] as const
  const busy =
    state.fetch.status === 'paging'
      ? state.fetch.page < page
        ? 'prev'
        : 'next'
      : state.fetch.status === 'sorting'
        ? 'sort'
        : undefined
  return {
    from: from + 1,
    to: from + shownRows,
    total,
    label: `${range(from, from + shownRows)} of ${count(total)}`,
    canPrev: page > 0,
    canNext: page < pages - 1,
    prev: () => dispatch({ type: 'page', page: page - 1 }),
    next: () => dispatch({ type: 'page', page: page + 1 }),
    toRow: (n) =>
      dispatch({
        type: 'page',
        page: Math.max(0, Math.min(pages - 1, Math.floor((n - 1) / PAGE_ROWS)))
      }),
    busy,
    prevLabel:
      page > 0
        ? `Previous ${PAGE_ROWS} rows, ${range(...span(page - 1))}`
        : `Previous ${PAGE_ROWS} rows`,
    nextLabel:
      page < pages - 1
        ? `Next ${span(page + 1)[1] - span(page + 1)[0]} rows, ${range(...span(page + 1))}`
        : `Next ${PAGE_ROWS} rows`
  }
}

/**
 * "Rows 11–20 of 1,284" ("11–20 of 1,284" under 440 px), tabular. The first
 * number is a Go to row field: text at rest, a field outline on hover and
 * focus; type a row, Enter, and one `d1_raw` read lands its block. Home / End
 * go to the first / last rows. Announced when it changes.
 */
export function PagerPos({ p }: { p: PagerState }) {
  const [draft, setDraft] = useState<string>()
  const to = `–${count(p.to)} of ${count(p.total)}`
  const go = (n: number, el: HTMLInputElement) => {
    p.toRow(Math.max(1, Math.min(n, p.total)))
    setDraft(undefined)
    el.blur()
  }
  return (
    <span className="dq-pos" role="status" aria-live="polite">
      <span className="a17-posline">
        <span className="dq-wide-in">Rows </span>
        <input
          className="a17-rowfield"
          inputMode="numeric"
          aria-label={`Go to row, 1 to ${count(p.total)}. Showing rows ${count(p.from)}${to}`}
          title={`Go to row (Enter). Home: first ${PAGE_ROWS}, End: last`}
          data-typing={draft !== undefined ? '' : undefined}
          value={draft ?? count(p.from)}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setDraft(undefined)}
          onKeyDown={(e) => {
            const el = e.currentTarget
            if (e.key === 'Escape') {
              setDraft(undefined)
              el.blur()
            } else if (e.key === 'Home') {
              e.preventDefault()
              go(1, el)
            } else if (e.key === 'End') {
              e.preventDefault()
              go(p.total, el)
            } else if (e.key === 'Enter') {
              const n = Number((draft ?? '').replace(/[^\d]/g, ''))
              if (n >= 1) go(n, el)
              else {
                setDraft(undefined)
                el.blur()
              }
            }
          }}
        />
        {/* While a row is typed the range waits for Enter: "Rows [25,001] of 50,000 ↵". */}
        <span>{draft !== undefined ? ` of ${count(p.total)}` : to}</span>
        {draft !== undefined && <span className="a17-enter"> ↵</span>}
      </span>
    </span>
  )
}

type ArrowsState = Pick<
  PagerState,
  'canPrev' | 'canNext' | 'prev' | 'next' | 'busy' | 'prevLabel' | 'nextLabel'
>

/** ‹ ›: 26 px faces, 32 px targets. The one that asked spins while its rows are read. */
export function PagerArrows({ p }: { p: ArrowsState }) {
  const arrow = (
    which: 'prev' | 'next',
    label: string,
    can: boolean,
    on: () => void,
    icon: ReactNode
  ) => {
    const spin = p.busy === which
    const off = !can || p.busy === 'sort'
    // Back while the next rows are read drops the read, so ‹ stays live then.
    const blocked = off || (!!p.busy && !(which === 'prev' && p.busy === 'next'))
    return (
      <button
        key={which}
        type="button"
        className="dq-ib dq-pg"
        aria-label={label}
        title={label}
        aria-disabled={blocked || undefined}
        data-off={off && !spin ? '' : undefined}
        aria-busy={spin || undefined}
        onClick={() => !blocked && on()}
      >
        {spin ? <span className="dq-spin" aria-hidden="true" /> : icon}
      </button>
    )
  }
  return (
    <span className="dq-arrows">
      {arrow(
        'prev',
        `${p.prevLabel} (Page Up)`,
        p.canPrev,
        p.prev,
        <CaretLeftIcon size={14} weight="bold" aria-hidden="true" />
      )}
      {arrow(
        'next',
        `${p.nextLabel} (Page Down)`,
        p.canNext,
        p.next,
        <CaretRightIcon size={14} weight="bold" aria-hidden="true" />
      )}
    </span>
  )
}

/**
 * The open card's one recessed band: one band, one receipt.
 * Left, a receipt of what's on screen: `✓ Ran here · 2 values changed · 38.4
 * ms · 48,212 rows read`, `Read 3h ago`, `Sorting all 1,284 in D1`, or, past
 * ten rows, where you are (`Rows 11–20 of 1,284`, or `Rows 1–10 · LIMIT 10`
 * for a query's own LIMIT). Right, the actions: the editor's (Short form,
 * Copy SQL, then Run, last and bottom-right) or the table's (‹ ›, full
 * screen, Studio, and Run when the rows are old). With both open, the receipt
 * sits over the actions.
 */
function Band({
  state,
  dispatch,
  env,
  outcome,
  editorOpen,
  rowsOpen,
  kept,
  stale,
  now,
  pager,
  limited,
  reasonId,
  onShowMark
}: {
  state: CardState
  dispatch: Dispatch<CardEvent>
  env: Env
  outcome: D1Outcome
  editorOpen: boolean
  rowsOpen: boolean
  /** The agent's rows are open under a refused read. */
  kept: boolean
  stale: boolean
  now: number
  pager?: PagerState
  limited?: { limit: number; offset: number }
  reasonId: string
  onShowMark: () => void
}) {
  const ranAny = state.found.kind !== 'agent'
  const ranOk = ranAny && state.found.kind !== 'failed'
  const changed = state.draft !== state.query.sql
  const sql = state.editable ? state.draft : shownSql(state)
  const lines = sql.split('\n').length
  const words = foundWords(state.found)
  const total = outcome.status === 'rows' ? outcome.rowCount : 0
  const sorting = state.fetch.status === 'sorting'
  const fetchFailed = state.fetch.status === 'failed' ? state.fetch.error : undefined
  const status = sorting ? (
    <span className="dq-layer-note dq-sorting" role="status">
      <span className="dq-spin" aria-hidden="true" />
      Sorting all {count(total)} in D1
    </span>
  ) : fetchFailed ? (
    <span className="dq-layer-note dq-danger" role="alert">
      {fetchFailed}
    </span>
  ) : ranOk ? (
    <span className="dq-ranhere dq-ranhere-ok">
      <CheckIcon size={12} weight="bold" aria-hidden="true" />
      Ran here
      {words &&
        (state.found.kind === 'changed' ? (
          <>
            <span className="dq-dot">·</span>
            <button
              type="button"
              className="dq-diff"
              data-changed=""
              title="Show the changed values"
              onClick={onShowMark}
            >
              {words}
            </button>
          </>
        ) : (
          <span className="dq-diff" data-changed={moved(state.found) ? '' : undefined}>
            <span className="dq-dot">·</span>
            {words}
          </span>
        ))}
    </span>
  ) : editorOpen && changed ? (
    <span className="dq-layer-note">
      Edited
      {kept && <span className="dq-wide-in"> · the agent’s rows below</span>}
    </span>
  ) : stale && rowsOpen && !editorOpen ? (
    // Old rows: the age is said where the rows are looked at, beside the Run that renews them. Never on a closed card.
    <span className="dq-layer-note dq-readage">Read {ageWords(now - state.shown.readAt, now)}</span>
  ) : editorOpen && !rowsOpen && lines > 1 ? (
    // A one-line draft can still wrap to several lines on screen, so "1 line" would read wrong: the count is for drafts
    // written over several lines.
    <span className="dq-layer-note">
      {lines} {lines === 1 ? 'line' : 'lines'}
    </span>
  ) : null
  // The rows' band holds the primary Run (bottom-right, where the editor's band has it) only while the rows are old.
  const bandRun = !editorOpen && rowsOpen && state.editable && !changed && stale && env.host.run
  const revert = canRevert(state) && (
    <Ghost onClick={() => dispatch({ type: 'revert' })}>Revert</Ghost>
  )
  const links = <ResultLinks env={env} />
  // A re-read of the agent's own SQL says what it found where the position was, on the first page; paging on, the
  // position comes back.
  const foundFirst = !!words && ranOk && state.page === 0 && !limited?.offset

  // A query's own LIMIT: OFFSET is written into the SQL (old rows keep their age beside the Run that renews them).
  if (limited && rowsOpen && !editorOpen && !sorting && !bandRun && outcome.status === 'rows') {
    const { limit, offset } = limited
    return (
      <div className="dq-layer" data-v="4">
        <span className="dq-rcpt">
          {foundFirst ? (
            status
          ) : (
            <>
              {ranOk && <RanMark />}
              <span className="dq-pos" role="status" aria-live="polite">
                <span className="a17-posline">
                  <span className="dq-wide-in">Rows </span>
                  {count(offset + 1)}–{count(offset + outcome.rows.length)}
                  <span className="dq-dot dq-limdot">·</span>
                  <span className="dq-limit">LIMIT {limit}</span>
                </span>
              </span>
            </>
          )}
          <StatsCompact outcome={outcome} lead brief paged />
          {revert}
        </span>
        <span className="dq-acts">
          <PagerArrows
            p={{
              prevLabel: `Previous ${limit} rows, OFFSET ${Math.max(0, offset - limit)}`,
              nextLabel: `Next ${limit} rows: OFFSET ${offset + limit}, written into the SQL`,
              canPrev: offset > 0,
              canNext: outcome.rows.length === limit,
              prev: () => dispatch({ type: 'offset', offset: Math.max(0, offset - limit) }),
              next: () => dispatch({ type: 'offset', offset: offset + limit }),
              busy: state.run.status === 'running' ? 'next' : undefined
            }}
          />
          <span className="a17-sep" aria-hidden="true" />
          {links}
        </span>
      </div>
    )
  }

  // Past ten rows the pager is the band's receipt. A user's run that came back past ten rows pages too: the check
  // stays as the receipt's first mark, the position follows.
  const ranPaged = !!pager && rowsOpen && !editorOpen && !sorting && ranOk
  if (pager && rowsOpen && !editorOpen && (!status || sorting || ranPaged || !!fetchFailed))
    return (
      <div className="dq-layer" data-v="4">
        <span className="dq-rcpt">
          {/* While D1 sorts, the band says so where the position was; the arrows stay, dimmed. */}
          {sorting || foundFirst || fetchFailed ? (
            status
          ) : (
            <>
              {ranPaged && <RanMark />}
              <PagerPos p={pager} />
            </>
          )}
          {outcome.status === 'rows' && <StatsCompact outcome={outcome} lead brief paged />}
          {ranPaged && revert}
        </span>
        <span className="dq-acts">
          <PagerArrows p={pager} />
          <span className="a17-sep" aria-hidden="true" />
          {links}
        </span>
      </div>
    )

  return (
    // Both open: two rows in the one band, the receipt over the actions, so nothing crowds and Run stays bottom-right.
    <div className="dq-layer" data-v="4" data-two={editorOpen && rowsOpen ? '' : undefined}>
      <span className="dq-rcpt">
        {status}
        {rowsOpen && outcome.status === 'rows' && (
          <StatsCompact outcome={outcome} lead={!!status} brief={!!words || bandRun || sorting} />
        )}
        {/* Only when the SQL that ran differs from the agent's: a re-read of its own SQL has nothing to revert. */}
        {editorOpen && revert}
      </span>
      <span className="dq-acts">
        {editorOpen ? (
          <>
            {/* Always offered: it is the editor's way back to the folded SQL. A one-line draft can wrap and folds too,
                and without it the band had no way out but Escape. */}
            <Ghost
              icon={
                <CaretUpIcon size={12} weight="bold" className="dq-ico-narrow" aria-hidden="true" />
              }
              onClick={() => dispatch({ type: 'pane.toggle' })}
            >
              <span className="dq-lbl">Short form</span>
            </Ghost>
            {/* When Copy SQL is the primary (a write the chat can't take, or didn't confirm), the band doesn't repeat it. */}
            {!(state.editable && copyIsPrimary(state)) && <CopySql sql={sql} plain />}
            {state.editable && (
              <RunButton state={state} dispatch={dispatch} host={env.host} reasonId={reasonId} />
            )}
          </>
        ) : (
          <>
            {links}
            {bandRun && (
              <RunButton state={state} dispatch={dispatch} host={env.host} reasonId={reasonId} />
            )}
          </>
        )}
      </span>
    </div>
  )
}

function ResultLinks({ env }: { env: Env }) {
  return (
    <>
      {env.host.fullscreen && (
        <IconButton
          className="dq-wide-flex"
          label="Open full screen"
          fs
          onClick={() =>
            void env.app.requestDisplayMode({ mode: 'fullscreen' }).catch(() => undefined)
          }
        >
          <CornersOutIcon size={15} aria-hidden="true" />
        </IconButton>
      )}
      {env.host.openLinks && (
        <IconButton
          label="Open in D1 Studio on the dashboard"
          onClick={() =>
            void env.app.openLink({ url: studioUrl(env.database) }).catch(() => undefined)
          }
        >
          <ArrowSquareOutIcon size={15} aria-hidden="true" />
        </IconButton>
      )}
    </>
  )
}

// ── The title line: glyph · title · count · action, the same slots in every state ──

interface Disclosure {
  open: boolean
  controls: string
  /** What opening it shows: "Show 10 rows", "Show rows 1–10 of 47". */
  label: string
  onToggle: () => void
}

function Head({
  kind,
  title,
  count: countNode,
  action,
  disclosure
}: {
  kind: CardKind
  title: string
  count: ReactNode
  action: ReactNode
  disclosure?: Disclosure
}) {
  const trio = kind === 'rows' || kind === 'running'
  return (
    <div className="dq-head">
      {disclosure ? (
        <button
          type="button"
          className="dq-glyph"
          aria-expanded={disclosure.open}
          aria-controls={disclosure.controls}
          aria-label={disclosure.open ? 'Hide rows' : disclosure.label}
          onClick={disclosure.onToggle}
        >
          <Glyph kind={kind} />
        </button>
      ) : (
        <span className="dq-glyph">
          <Glyph kind={kind} />
        </span>
      )}
      {/* The mark is the title's first word: set like a capital, on the title's baseline. Once per card. */}
      <span
        className="dq-title"
        data-click={disclosure ? '' : undefined}
        onClick={disclosure?.onToggle}
        title={title}
      >
        <CloudflareLogo variant="glyph" className="dq-mark" aria-hidden />
        <span className="dq-titletext">{title}</span>
      </span>
      <span className="dq-meta" data-trio={trio ? '' : undefined}>
        {/* Beside the trio the count is sized by a hidden "Running", so its left edge holds from loading to data. */}
        <span
          className="dq-count"
          role={kind === 'running' ? 'status' : undefined}
          data-sized={trio ? '' : undefined}
        >
          {trio && (
            <span className="dq-countsizer" aria-hidden="true">
              Running
            </span>
          )}
          <span>{countNode}</span>
        </span>
        {action && <span className="dq-slot">{action}</span>}
      </span>
    </div>
  )
}

export function Glyph({ kind }: { kind: CardKind }) {
  if (kind === 'running') return <span className="dq-spin" aria-hidden="true" />
  if (kind === 'error')
    return <WarningCircleIcon size={16} weight="fill" className="dq-danger" aria-hidden="true" />
  if (kind === 'none' || kind === 'empty-db')
    return <MinusCircleIcon size={16} aria-hidden="true" />
  return <CaretRightIcon size={12} weight="bold" className="dq-caret" aria-hidden="true" />
}

function CountText({ kind, rows }: { kind: CardKind; rows: number }) {
  switch (kind) {
    case 'running':
      return <>Running</>
    case 'error':
      return <span className="dq-danger">Failed</span>
    case 'empty-db':
      return <>No tables</>
    case 'none':
      return <>No rows</>
    case 'rows':
      return <>{`${count(rows)} ${rows === 1 ? 'row' : 'rows'}`}</>
  }
}

/** One line under the SQL for the states that need words: the error, an empty result, an empty database. */
function StateLine({ outcome, kind, env }: { outcome: D1Outcome; kind: CardKind; env: Env }) {
  if (outcome.status === 'failed') {
    const name = outcome.fix?.use.split('.').pop()
    return (
      <p className="dq-line2" role="alert">
        <span className="dq-mono dq-danger">{outcome.error}</span>
        {outcome.fix && (
          <span className="dq-hint">
            <span className="dq-sep"> · </span>
            {outcome.fix.table ? `${outcome.fix.table} has ${name}` : `did you mean ${name}?`}
          </span>
        )}
      </p>
    )
  }
  if (kind === 'none')
    return (
      <p className="dq-line2">
        The query matched no rows
        {outcome.meta.rowsRead != null && ` after reading ${count(outcome.meta.rowsRead)}`}.
      </p>
    )
  if (kind === 'empty-db')
    return (
      <p className="dq-line2 dq-line2-act">
        <span className="dq-line2-text">{env.database.name} has no tables yet.</span>
        {env.host.send && (
          <Ghost
            outline
            onClick={() =>
              void env.app
                .sendMessage({
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: `Suggest a schema for the D1 database ${env.database.name}.`
                    }
                  ]
                })
                .catch(() => undefined)
            }
          >
            Suggest a schema
          </Ghost>
        )}
      </p>
    )
  return null
}

// ── The query: short (clause per line, cuts marked), as written, or the editor ──

function SqlPane({
  state,
  dispatch,
  env,
  outcome,
  cue,
  focus,
  reasonId,
  onFold
}: {
  state: CardState
  dispatch: Dispatch<CardEvent>
  env: Env
  outcome: D1Outcome
  cue?: Cue
  focus?: Focus
  /** The reason line's id, which a blocked Run is described by. */
  reasonId: string
  onFold: () => void
}) {
  const squiggle = outcome.status === 'failed' ? outcome.token : undefined
  if (state.pane === 'short')
    // The folded query on the editor's own tray, so it reads as a field before anyone opens it. Nothing in the corner
    // at rest: a click or tap anywhere opens the editor, and pointer over or keyboard focus shows an Edit face on the
    // lowest line with room for it. Failed and empty results keep an outlined Edit (fixing pays there); a tray that no
    // longer shows the agent's result says so in the corner.
    return (
      <div className="dq-cell" data-cue={cue?.kind}>
        <button
          type="button"
          className="dq-sql dq-sql-cell"
          aria-label={state.editable ? 'Edit and run this SQL' : 'Show the query as written'}
          title={
            state.editable ? 'Edit and run here. Reads only; the agent isn’t called.' : undefined
          }
          // Focus shown after keyboard use even where :focus-visible can't tell (see useKeyboardModality).
          onFocus={(e) =>
            document.documentElement.hasAttribute('data-kbd') &&
            e.currentTarget.setAttribute('data-focus', '')
          }
          onBlur={(e) => e.currentTarget.removeAttribute('data-focus')}
          onClick={() => {
            onFold()
            dispatch({ type: 'pane.toggle' })
          }}
        >
          <ShortSql
            sql={state.editable ? state.draft : shownSql(state)}
            tables={env.tables}
            squiggle={squiggle}
            tail={!!cue}
            hint={state.editable && !cue}
          />
        </button>
        {cue?.kind === 'note' && (
          <span className="dq-cue" data-kind="note">
            {cue.label}
          </span>
        )}
        {cue?.kind === 'edit' && <CueButton onClick={cue.onClick} />}
      </div>
    )
  return (
    <div className="dq-full">
      {state.editable ? (
        <Editor
          state={state}
          dispatch={dispatch}
          tables={env.tables}
          squiggle={squiggle}
          focus={focus}
        />
      ) : (
        <AsWritten sql={shownSql(state)} tables={env.tables} squiggle={squiggle} tray />
      )}
      {/* D1's own error for the user's read is the reason line's, in Studio's form. */}
      {!(state.editable && outcome.status === 'failed') && (
        <StateLine outcome={outcome} kind={cardKind(state.query.purpose, outcome)} env={env} />
      )}
      {state.editable ? (
        <S5Lines state={state} dispatch={dispatch} env={env} outcome={outcome} id={reasonId} />
      ) : (
        <RunLine state={state} />
      )}
    </div>
  )
}

/** The outlined "✎ Edit" in the corner of a failed or empty card: it opens the editor on the likely culprit. */
function CueButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="dq-cue"
      // Focus shown after keyboard use even where :focus-visible can't tell (see useKeyboardModality).
      onFocus={(e) =>
        document.documentElement.hasAttribute('data-kbd') &&
        e.currentTarget.setAttribute('data-focus', '')
      }
      onBlur={(e) => e.currentTarget.removeAttribute('data-focus')}
      data-kind="edit"
      aria-label="Edit the query to fix it, then run it here"
      title="Fix the query and run it here"
      onClick={onClick}
    >
      <PencilSimpleIcon size={12} weight="bold" aria-hidden="true" />
      Edit
    </button>
  )
}

/** Room kept at the end of the last line for the tray's corner action, in px: the widest face ("✎ Edit") and a gap. */
const CUE_ROOM = 64

/** Measures how many mono characters fit, and folds the SQL to that. */
function ShortSql({
  sql,
  tables,
  squiggle,
  tail,
  hint
}: {
  sql: string
  tables: ReadonlySet<string>
  squiggle?: string
  /** Keep room at the last line's end for the corner's Edit or note. */
  tail?: boolean
  /** Draw the Edit face shown on pointer over and keyboard focus. */
  hint?: boolean
}) {
  const ref = useRef<HTMLElement>(null)
  const [cpl, setCpl] = useState(70)
  const [ch, setCh] = useState(7.2)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const cs = getComputedStyle(el)
      const ctx = document.createElement('canvas').getContext('2d')
      if (!ctx) return
      ctx.font = `${cs.fontSize} ${cs.fontFamily}`
      const w = ctx.measureText('0000000000').width / 10 || 7.2
      if (el.clientWidth) setCpl(Math.floor(el.clientWidth / w))
      setCh(w)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const tailCh = tail ? Math.ceil(CUE_ROOM / ch) : 0
  const folded = useMemo(() => foldSql(sql, cpl, tailCh, 'any'), [sql, cpl, tailCh])
  // The Edit face takes the lowest line with room for it, so it never costs height; only where no line has room does it
  // lie over the last line's end, on a fade.
  const lastI = folded.lines.length - 1
  const faceCh = Math.ceil(CUE_ROOM / ch)
  const roomy = folded.flow
    ? -1
    : folded.lines.map((l) => widthOf(l) <= cpl - faceCh).lastIndexOf(true)
  const hintLine = tail || roomy < 0 ? lastI : roomy
  const hintOver = !tail && roomy < 0
  return (
    <code ref={ref} className="dq-short" data-flow={folded.flow ? '' : undefined}>
      {folded.lines.map((line, i) => (
        <span key={i} className="dq-line" data-cont={folded.cont?.includes(i) ? '' : undefined}>
          {wrapOnlyAtClauses(line).map((tok, j) =>
            'fold' in tok ? (
              <span key={j} className="dq-fold" title={tok.hidden}>
                {tok.fold}
              </span>
            ) : (
              <span key={j}>{highlightSql(tok.text, { tables, squiggle })}</span>
            )
          )}
          {/* When the last line can't make room, this spacer wraps and the corner action takes its line. */}
          {tail && folded.over && i === folded.lines.length - 1 && (
            <span className="dq-cuespace" aria-hidden="true" />
          )}
        </span>
      ))}
      {hint && (
        <span
          className="dq-cue dq-cuehint"
          data-kind="edit"
          data-over={hintOver ? '' : undefined}
          data-line={hintLine === lastI ? 'last' : 'up'}
          style={{ bottom: `calc(4px + ${lastI - hintLine} * var(--sql-lh))` }}
          aria-hidden="true"
        >
          <PencilSimpleIcon size={12} weight="bold" />
          Edit
        </span>
      )}
    </code>
  )
}

const unwrapped = (line: string) =>
  (wrapOnlyAtClauses([{ text: line }])[0] as { text: string }).text

/** The SQL as written, read-only: a wrapped line hangs past its own indent. */
function AsWritten({
  sql,
  tables,
  squiggle,
  tray
}: {
  sql: string
  tables: ReadonlySet<string>
  squiggle?: string
  /** On the editor's tray: the answer's SQL in a host that can't edit it. */
  tray?: boolean
}) {
  return (
    <code className="dq-pre" data-tray={tray ? '' : undefined}>
      {sql.split('\n').map((l, i) => {
        const indent = l.match(/^\s*/)![0].length
        return (
          <span
            key={i}
            className="dq-pl"
            style={{ paddingLeft: `${indent + 2}ch`, textIndent: '-2ch' }}
          >
            {/* The fold's wrap rule here too, so a wrapped line never splits a predicate or an alias. */}
            {l.trim() ? highlightSql(unwrapped(l.trimStart()), { tables, squiggle }) : ' '}
          </span>
        )
      })}
    </code>
  )
}

/**
 * The editor: the highlighted text with a transparent textarea over it, the
 * same metrics, so the caret sits on the coloured text. Rendered only when
 * the user opens the query.
 */
function Editor({
  state,
  dispatch,
  tables,
  squiggle,
  focus = true
}: {
  state: CardState
  dispatch: Dispatch<CardEvent>
  tables: ReadonlySet<string>
  squiggle?: string
  /** What to select on opening: the name an error is about, the filter that emptied the result, or the caret at the end. */
  focus?: Focus
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  // Opening the query is asking to edit it; opened from the corner's Edit, the culprit is selected.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    if (typeof focus === 'object') {
      el.setSelectionRange(focus[0], focus[1])
      return
    }
    const at = typeof focus === 'string' ? el.value.indexOf(focus) : -1
    if (at >= 0 && typeof focus === 'string') el.setSelectionRange(at, at + focus.length)
    else el.setSelectionRange(el.value.length, el.value.length)
    // Once, on opening.
  }, [])
  const sql = state.draft
  return (
    <div className="dq-editor">
      <code className="dq-pre dq-edpre" aria-hidden="true">
        <MarkedSql
          sql={sql}
          tables={tables}
          squiggle={state.draft === shownSql(state) ? squiggle : undefined}
        />
        {/* A textarea gives a trailing newline a line of its own; the mirror has to as well. */}
        {sql.endsWith('\n') || !sql ? ' ' : null}
      </code>
      <textarea
        ref={ref}
        className="dq-edinput"
        aria-label="SQL. Command or Control Enter runs it"
        // One row: the mirror under it sets the height; a textarea's default is two.
        rows={1}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        value={sql}
        onChange={(e) => dispatch({ type: 'draft.change', draft: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submitKey(state, dispatch, e.currentTarget)
          } else if (e.key === 'Escape' && !isEdited(state)) {
            dispatch({ type: 'pane.toggle' })
          }
        }}
      />
    </div>
  )
}

/** The run's state in words, where the user is looking: under the editor. */
function RunLine({ state }: { state: CardState }) {
  const { run } = state
  const text =
    run.status === 'failed'
      ? run.error
      : run.status === 'sent'
        ? 'Sent to the chat. The agent runs it once you approve.'
        : run.status === 'running'
          ? 'Running…'
          : run.status === 'sending'
            ? 'Sending to the chat…'
            : ''
  return (
    <p
      className="dq-runline"
      role={run.status === 'failed' ? 'alert' : 'status'}
      data-status={run.status}
    >
      {text}
    </p>
  )
}

/** A step's bar under its SQL as written: back to the short form, and Copy SQL. */
function StepBar({ sql, onFold }: { sql: string; onFold: () => void }) {
  return (
    <div className="dq-fullbar">
      <span className="dq-grow" />
      {sql.includes('\n') && <Ghost onClick={onFold}>Short form</Ghost>}
      <CopySql sql={sql} plain />
    </div>
  )
}

/** The draft, with the span the reason line is about wavy-underlined, as a compiler marks it. */
export function MarkedSql({
  sql,
  tables,
  squiggle
}: {
  sql: string
  tables: ReadonlySet<string>
  squiggle?: string
}) {
  const mark = markOf(verdictOf(sql))
  if (!mark) return <>{highlightSql(sql, { tables, squiggle })}</>
  return (
    <>
      {highlightSql(sql.slice(0, mark[0]), { tables, squiggle })}
      <span className="s5-mark">{highlightSql(sql.slice(mark[0], mark[1]), { tables })}</span>
      {highlightSql(sql.slice(mark[1]), { tables, squiggle })}
    </>
  )
}

/**
 * Copy SQL takes the primary's place when a write can't reach the chat: the
 * host takes no messages, or it didn't confirm in time, or refused.
 */
export function copyIsPrimary(state: CardState): boolean {
  return (
    verdictOf(state.draft).kind === 'write' &&
    (!state.can.send || state.run.status === 'unconfirmed' || state.run.status === 'refused')
  )
}

/** ⌘↵ in an editor: what the primary button does (Copy SQL where it has taken Run's place). */
export function submitKey(state: CardState, dispatch: Dispatch<CardEvent>, from: HTMLElement) {
  if (copyIsPrimary(state)) void copyText(state.draft, 'Copied the SQL', from)
  else dispatch({ type: 'submit' })
}

/**
 * The lines under the editor: what the draft is when Run
 * can't take it, with the fix ("Remove it", "Keep the first", "Use SELECT");
 * how a send to the chat went; D1's own error for a read it refused, in
 * Studio's form, with the column it likely meant. A polite live region, so
 * the reason is heard once, not on every keystroke.
 */
export function S5Lines({
  state,
  dispatch,
  env,
  outcome,
  id,
  errorElsewhere
}: {
  state: CardState
  dispatch: Dispatch<CardEvent>
  env: Env
  outcome: D1Outcome
  id: string
  /** D1's error has a pane of its own (the console's result), so the line doesn't repeat it. */
  errorElsewhere?: boolean
}) {
  const verdict = verdictOf(state.draft)
  const { run } = state
  const setDraft = (draft: string) => dispatch({ type: 'draft.change', draft })
  const line = (
    tone: 'quiet' | 'note' | 'danger' | 'ok',
    icon: ReactNode,
    text: ReactNode,
    action?: ReactNode
  ) => (
    // A write card's note is marked so a taller frame can reserve its two-line slot in every send state.
    <p
      className="s5-line"
      id={id}
      role="status"
      aria-live="polite"
      data-tone={tone}
      data-write={verdict.kind === 'write' ? '' : undefined}
    >
      <span className="s5-ico">{icon}</span>
      <span className="s5-text">{text}</span>
      {action}
    </p>
  )
  const info = <InfoIcon size={13} weight="bold" aria-hidden="true" />
  const warn = <WarningCircleIcon size={13} weight="fill" aria-hidden="true" />
  // The host couldn't run the read (not a SQL error): its own words.
  if (run.status === 'failed') return line('danger', warn, run.error)
  if (run.status === 'running')
    return line('quiet', <span className="dq-spin" aria-hidden="true" />, 'Running…')
  if (verdict.kind === 'write')
    return !env.host.send
      ? line(
          'note',
          info,
          'This chat doesn’t take messages from the view. Copy the SQL and paste it to the agent.'
        )
      : run.status === 'sending'
        ? line('quiet', <span className="dq-spin" aria-hidden="true" />, 'Sending to the chat…')
        : run.status === 'unconfirmed'
          ? line(
              'note',
              info,
              `The chat hasn’t confirmed after ${SEND_TIMEOUT_MS / 1000} s. If your message isn’t there, copy the SQL and paste it.`
            )
          : run.status === 'refused'
            ? line(
                'danger',
                warn,
                'The chat didn’t take the message. Copy the SQL and paste it to the agent.'
              )
            : run.status === 'sent'
              ? line(
                  'ok',
                  <CheckIcon size={13} weight="bold" aria-hidden="true" />,
                  'Sent to the chat. The agent runs it once you approve.'
                )
              : line('note', info, reasonOf(verdict))
  if (verdict.kind === 'read' && outcome.status === 'failed' && !errorElsewhere) {
    const { token } = outcome
    const fix = outcome.fix ?? viewFix(outcome, state.query.outcome)
    const name = fix?.use
    return (
      <p className="s5-line s5-d1err" id={id} role="alert" data-tone="danger">
        <span className="s5-studio">Error: {outcome.error}</span>
        {name && token && hasIdentifier(state.draft, token) && (
          <Ghost outline onClick={() => setDraft(replaceIdentifier(state.draft, token, name))}>
            Use {name.split('.').pop()}
          </Ghost>
        )}
      </p>
    )
  }
  if (verdict.kind === 'read' || verdict.kind === 'empty') return null
  const fix = fixOf(verdict, state.draft)
  return line(
    'danger',
    warn,
    reasonOf(verdict),
    fix && (
      <Ghost outline onClick={() => setDraft(fix.sql)}>
        {fix.label}
      </Ghost>
    )
  )
}

/**
 * For a read the user ran here that D1 refused over a name: the close name
 * among the columns the agent's result has (the server's own lookup only
 * covers the agent's query). `a.start_at` → `a.starts_at`.
 */
export function viewFix(
  failed: Extract<D1Outcome, { status: 'failed' }>,
  agent: D1Outcome
): { use: string } | undefined {
  const token = failed.token
  const bare = token?.split('.').pop()
  if (!token || !bare || agent.status !== 'rows') return undefined
  const to = closest(bare, agent.columns)
  return to ? { use: token.slice(0, token.length - bare.length) + to } : undefined
}

/**
 * Studio's Run, the card's one primary button. Run stays Run: disabled, with
 * the reason under the SQL, when the draft isn't one read; Send to chat only
 * when it really writes; Copy SQL when the chat can't take it.
 */
export function RunButton({
  state,
  dispatch,
  host,
  reasonId
}: {
  state: CardState
  dispatch: Dispatch<CardEvent>
  host: HostAbilities
  reasonId: string
}) {
  const verdict = verdictOf(state.draft)
  const busy = isBusy(state.run)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const t = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
    return () => window.clearTimeout(t)
  }, [copied])
  const submit = () => dispatch({ type: 'submit' })
  if (copyIsPrimary(state))
    return (
      <button
        type="button"
        className="dq-run"
        title="Copy the SQL to paste it to the agent (⌘↵)"
        onClick={(e) =>
          void copyText(state.draft, 'Copied the SQL', e.currentTarget).then(
            (ok) => ok !== undefined && setCopied(ok)
          )
        }
      >
        {copied ? (
          <CheckIcon size={13} weight="bold" aria-hidden="true" />
        ) : (
          <CopyIcon size={13} weight="bold" aria-hidden="true" />
        )}
        <span aria-live="polite">{copied ? 'Copied' : 'Copy SQL'}</span>
      </button>
    )
  if (verdict.kind === 'write') {
    // Sent is a state, said in the line under the SQL, not a button.
    if (state.run.status === 'sent') return null
    const sending = state.run.status === 'sending'
    return (
      <button
        type="button"
        className="dq-run"
        data-s5="send"
        aria-disabled={sending || undefined}
        aria-describedby={reasonId}
        title={`${reasonOf(verdict)} It goes to the chat as your message (⌘↵).`}
        onClick={() => !sending && submit()}
      >
        {sending ? (
          <span className="dq-spin dq-spin-on" aria-hidden="true" />
        ) : (
          <PaperPlaneRightIcon size={12} weight="fill" aria-hidden="true" />
        )}
        {sending ? 'Sending' : 'Send to chat'}
      </button>
    )
  }
  const blocked = verdict.kind !== 'read' || !host.run
  const reason =
    verdict.kind === 'empty'
      ? 'Write a query to run.'
      : verdict.kind !== 'read'
        ? reasonOf(verdict)
        : !host.run
          ? 'This host can’t run queries from the view.'
          : 'Run (⌘↵). Reads only; the agent isn’t called.'
  return (
    <button
      type="button"
      className="dq-run"
      data-blocked={blocked ? '' : undefined}
      aria-disabled={busy || blocked || undefined}
      aria-describedby={blocked && verdict.kind !== 'empty' ? reasonId : undefined}
      title={reason}
      onClick={() => !busy && !blocked && submit()}
    >
      {busy ? (
        <span className="dq-spin dq-spin-on" aria-hidden="true" />
      ) : (
        <PlayIcon size={12} weight="fill" aria-hidden="true" />
      )}
      Run
    </button>
  )
}

// ── Copy ──

const COPY_FEEDBACK_MS = 2500

/**
 * Ghost trio with hairline seams. The pressed segment reads "✓ CSV"; widths
 * never change. It copies every row the view holds, in the order shown, never
 * just the page. When that is less than D1's count the toast says the scope
 * ("the first 200 of 1,284 rows") and offers the rest: Copy all (read from D1
 * in blocks), or past COPY_CAP, Export in D1 Studio.
 */
export function Trio({
  columns = [],
  rows = [],
  total,
  contiguous = true,
  readRest,
  env,
  disabled
}: {
  columns?: readonly string[]
  rows?: readonly (readonly D1Cell[])[]
  /** D1's row count, when the view may hold fewer. */
  total?: number
  /** False once going to a row left holes in what is held: then it isn't "the first N". */
  contiguous?: boolean
  /** `d1_raw` for the rows past those held ("Copy all"). */
  readRest?: (offset: number, limit: number) => Promise<readonly (readonly D1Cell[])[]>
  env?: Env
  disabled?: boolean
}) {
  const [state, dispatch] = useReducer(copyReducer, { status: 'idle' })
  useEffect(() => {
    if (state.status === 'idle') return
    const at = state.at
    const timer = window.setTimeout(() => dispatch({ type: 'reset', at }), COPY_FEEDBACK_MS)
    return () => window.clearTimeout(timer)
  }, [state])
  const partial = total !== undefined && total > rows.length
  const what = partial
    ? `${contiguous ? 'the first ' : ''}${count(rows.length)} of ${count(total)} rows`
    : `${count(rows.length)} ${rows.length === 1 ? 'row' : 'rows'}`
  // The ✓ marks a copy that has completed: while "Copy all" still reads from D1 nothing is marked; once it has
  // written, its format is.
  const groupRef = useRef<HTMLSpanElement>(null)
  const t = useCopyToast()
  const mine = !!t?.done?.from && !!groupRef.current?.contains(t.done.from)
  // No ✓ beside a toast that says a copy is still running or failed.
  const marked =
    t?.busy || t?.failed
    ? null
    : mine
      ? t.done!.format
      : state.status === 'copied'
        ? state.format
        : null
  const openStudio =
    env?.host.openLinks &&
    (() => void env.app.openLink({ url: studioUrl(env.database) }).catch(() => undefined))
  return (
    <span
      ref={groupRef}
      className="dq-trio"
      role="group"
      aria-label={disabled ? 'Copy, available when the query finishes' : `Copy ${what}`}
      data-disabled={disabled ? '' : undefined}
    >
      {(['markdown', 'csv', 'json'] as const).map((f) => (
        <button
          key={f}
          type="button"
          className="dq-fmt"
          data-on={marked === f ? '' : undefined}
          data-blocked={state.status === 'blocked' && state.format === f ? '' : undefined}
          aria-disabled={disabled || undefined}
          aria-label={
            disabled ? `Copy as ${FORMAT_LABEL[f]}` : `Copy ${what} as ${FORMAT_LABEL[f]}`
          }
          // Only when part is held: the pointer learns the scope before the click; the toast says it after.
          title={!disabled && partial ? `Copy ${what} as ${FORMAT_LABEL[f]}` : undefined}
          onClick={(e) => {
            if (disabled) return
            void copyRows({
              format: f,
              columns,
              rows,
              total: total ?? rows.length,
              contiguous,
              ...(readRest && { readRest }),
              ...(openStudio && { openStudio }),
              from: e.currentTarget
            }).then(
              // A copy a newer one already spoke over marks nothing.
              (ok) =>
                ok !== undefined &&
                dispatch({ type: ok ? 'copied' : 'blocked', format: f, at: Date.now() })
            )
          }}
        >
          {/* Both faces share one grid cell sized to the wider ("✓ CSV"); only one is visible. */}
          <span className="dq-swap">
            <span>{FORMAT_LABEL[f]}</span>
            <span aria-hidden="true">
              <CheckIcon size={13} weight="bold" />
              {FORMAT_LABEL[f]}
            </span>
          </span>
        </button>
      ))}
    </span>
  )
}

export function CopySql({ sql, plain }: { sql: string; plain?: boolean }) {
  const [state, setState] = useState<'idle' | 'copied' | 'blocked'>('idle')
  useEffect(() => {
    if (state === 'idle') return undefined
    const t = window.setTimeout(() => setState('idle'), COPY_FEEDBACK_MS)
    return () => window.clearTimeout(t)
  }, [state])
  const label =
    state === 'copied' ? 'Copied' : state === 'blocked' ? 'Clipboard blocked' : 'Copy SQL'
  return (
    <Ghost
      outline={!plain}
      icon={state === 'copied' ? <CheckIcon size={13} weight="bold" /> : <CopyIcon size={13} />}
      onClick={(e) =>
        void copyText(sql, 'Copied the SQL', e?.currentTarget).then(
          (ok) => ok !== undefined && setState(ok ? 'copied' : 'blocked')
        )
      }
    >
      <span aria-live="polite">{label}</span>
    </Ghost>
  )
}

export function Ghost({
  icon,
  children,
  onClick,
  outline
}: {
  icon?: ReactNode
  children: ReactNode
  onClick: (e?: MouseEvent<HTMLButtonElement>) => void
  outline?: boolean
}) {
  return (
    <button
      type="button"
      className="dq-ghost"
      data-outline={outline ? '' : undefined}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  )
}

export function IconButton({
  label,
  onClick,
  children,
  className,
  fs
}: {
  label: string
  onClick: () => void
  children: ReactNode
  className?: string
  /** The ⛶: focus comes back here from fullscreen. */
  fs?: boolean
}) {
  return (
    <button
      type="button"
      className={`dq-ib ${className ?? ''}`}
      aria-label={label}
      title={label}
      data-fs={fs ? '' : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

// ── Rows: Studio's result table (ResultTable + Table/*), in miniature ──

/** Studio types a cell by the value stored, not the column's declared type: SQLite columns hold anything. */
function Cell({ value }: { value: D1Cell | undefined }) {
  if (value === null || value === undefined) return <span className="dq-null">NULL</span>
  if (typeof value === 'number') return <span className="dq-numv">{String(value)}</span>
  if (typeof value === 'boolean') return <span className="dq-numv">{value ? '1' : '0'}</span>
  const br = value.indexOf('\n')
  return (
    <span className="dq-textv" title={value.length > 32 || br !== -1 ? value : undefined}>
      {br === -1 ? value : value.slice(0, br)}
      {br !== -1 && <span className="dq-nl"> ⏎</span>}
    </span>
  )
}

/**
 * Studio's result table. `rows` is the page shown; `offset` numbers the
 * gutter from the result's start; `pad` rows of empty height keep a short last
 * page as tall as a full one. Columns are as wide as their widest value among
 * `widthRows` (every row held), so turning a page never moves a column line.
 */
export function Grid({
  columns,
  rows,
  widthRows = rows,
  offset = 0,
  pad = 0,
  count: total,
  sort,
  busy,
  label,
  onPage,
  was,
  onSort,
  dim,
  padPx
}: {
  columns: readonly string[]
  rows: readonly (readonly D1Cell[])[]
  widthRows?: readonly (readonly D1Cell[])[]
  offset?: number
  pad?: number
  /** The result's row count, which sizes the gutter. */
  count?: number
  sort: Sort
  /** D1 is sorting the whole result: the rows dim and the sorted header spins. */
  busy?: boolean
  label?: string
  onPage?: (d: 1 | -1) => void
  /** A re-read's moved cells: each row's old values by column. */
  was?: ReadonlyMap<readonly D1Cell[], ReadonlyMap<number, D1Cell>>
  onSort: (column: number) => void
  /** The agent's rows, kept under a read of the user's that D1 refused. */
  dim?: boolean
  /** An empty row this tall under the last, so the column rules run on to the pane's foot (the console). */
  padPx?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
    check()
    el.addEventListener('scroll', check, { passive: true })
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', check)
      ro.disconnect()
    }
  }, [])
  const widths = useMemo(
    () =>
      columns.map((c, i) => {
        const cell = Math.min(
          38,
          widthRows.reduce((m, r) => {
            const v = r[i]
            return Math.max(m, v === null || v === undefined ? 4 : String(v).split('\n')[0]!.length)
          }, 0)
        )
        return `max(calc(${c.length}ch + 26px), calc(${cell}ch + 16px))`
      }),
    [columns, widthRows]
  )
  const gutterW = `max(34px, calc(${count(total ?? offset + rows.length).length}ch + 16px))`
  return (
    <div className="dq-gridwrap" data-more={more ? '' : undefined}>
      <div
        className="dq-grid"
        ref={ref}
        tabIndex={0}
        role="region"
        aria-label={
          label ? `${label}. Page Down and Page Up turn the page` : `${count(rows.length)} rows`
        }
        aria-busy={busy || undefined}
        data-dim={busy || dim ? '' : undefined}
        onKeyDown={(e) => {
          // The table turns its own pages from the keyboard; the arrow keys keep scrolling it sideways.
          if (!onPage || (e.key !== 'PageDown' && e.key !== 'PageUp')) return
          e.preventDefault()
          onPage(e.key === 'PageDown' ? 1 : -1)
        }}
      >
        <table>
          <thead>
            <tr>
              <th className="dq-gutter" aria-hidden="true" style={{ minWidth: gutterW }} />
              {columns.map((c, i) => {
                const dir = sort?.column === i ? sort.dir : undefined
                const next = !dir
                  ? 'ascending'
                  : dir === 'asc'
                    ? 'descending'
                    : 'the original order'
                const spinning = busy && sort?.column === i
                return (
                  <th
                    key={i}
                    style={{ minWidth: widths[i] }}
                    aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
                    data-busy={spinning ? '' : undefined}
                  >
                    <button
                      type="button"
                      className="dq-th"
                      title={`${c} · ${columnType(widthRows, i)} · Sort ${next}`}
                      // Clickable while D1 sorts: the next order goes on from the one on its way, as the header shows it.
                      onClick={() => onSort(i)}
                    >
                      <span className="dq-thname">{c}</span>
                      {/* The icon's slot is always there, so sorting a column never changes its width. While D1 sorts by
                          it, the pending direction's icon gives way to a spinner. */}
                      <span className="dq-sorticon" aria-hidden="true">
                        {spinning ? (
                          <span className="dq-spin dq-spin-th" />
                        ) : dir === 'asc' ? (
                          <SortAscendingIcon size={12} />
                        ) : dir === 'desc' ? (
                          <SortDescendingIcon size={12} />
                        ) : null}
                      </span>
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const old = was?.get(r)
              return (
                // A re-read that moved values marks the row in the gutter too, so at 352 a changed cell scrolled out of
                // view still has a mark on screen.
                <tr key={offset + i} data-changed={old ? '' : undefined}>
                  <td className="dq-gutter">{count(offset + i + 1)}</td>
                  {columns.map((_, c) =>
                    old?.has(c) ? (
                      // The old value is reachable without hover: the cell takes focus (Tab, tap, or "2 values
                      // changed") and its tip shows while it has it.
                      <td
                        key={c}
                        data-changed=""
                        tabIndex={0}
                        aria-label={`${cellText(r[c])}, was ${cellText(old.get(c))}`}
                        onFocus={(e) => e.currentTarget.setAttribute('data-tip', '')}
                        onBlur={(e) => e.currentTarget.removeAttribute('data-tip')}
                      >
                        <Cell value={r[c]} />
                        <span className="dq-was" aria-hidden="true">
                          Was {cellText(old.get(c))}
                        </span>
                      </td>
                    ) : (
                      <td key={c}>
                        <Cell value={r[c]} />
                      </td>
                    )
                  )}
                </tr>
              )
            })}
            {(pad > 0 || (padPx ?? 0) > 0) && (
              <tr className="dq-padrow" aria-hidden="true">
                <td className="dq-gutter" style={{ height: padPx ?? pad * 30 }} />
                {columns.map((_, c) => (
                  <td key={c} />
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const cellText = (v: D1Cell | undefined) => (v === null || v === undefined ? 'NULL' : String(v))

/** A help mark beside a stat, like Studio's TooltipMark: opens on hover and on focus. */
function Help({ label, children }: { label: string; children: string }) {
  const id = useId()
  return (
    <>
      <button type="button" className="dq-help" aria-label={`About ${label}`} aria-describedby={id}>
        <InfoIcon size={13} aria-hidden="true" />
      </button>
      <span role="tooltip" id={id} className="dq-helptip">
        {children}
      </span>
    </>
  )
}

/**
 * D1's two numbers as one phrase, `42.7 ms · 48,212 rows read`, so they share
 * a line with the actions even at 352 px. The same wording in the answer's
 * band and a step's footer.
 */
export function StatsCompact({
  outcome,
  lead,
  brief,
  paged,
  who
}: {
  outcome: Extract<D1Outcome, { status: 'rows' }>
  /** Something precedes it in the receipt, so it starts with a dot. */
  lead?: boolean
  /** The receipt also says what a re-read found, holds Run, or says D1 is sorting: under 440 px rows read gives way. */
  brief?: boolean
  /** The band says where you are: rows read moves into the ⓘ tip, with its number. */
  paged?: boolean
  /** An edited card's band says whose run its numbers are. */
  who?: 'agent' | 'you'
}) {
  const { meta } = outcome
  const parts = [
    meta.durationMs != null && <span key="t">{duration(meta.durationMs)}</span>,
    meta.rowsRead != null && (
      <span key="r" className="dq-rd">
        {count(meta.rowsRead)} <span className="dq-wide-in">rows </span>read
      </span>
    )
  ].filter(Boolean)
  if (!parts.length) return null
  return (
    <span
      className="dq-statsc"
      data-brief={brief ? '' : undefined}
      data-paged={paged ? '' : undefined}
      data-lead={lead ? '' : undefined}
    >
      {lead && <span className="dq-dot">·</span>}
      {parts.flatMap((p, i) =>
        i
          ? [
              <span key={`d${i}`} className="dq-dot dq-rd">
                ·
              </span>,
              p
            ]
          : [p]
      )}
      <Help label="these numbers">
        {`${who === 'agent' ? 'The agent’s run, before your edit. ' : who === 'you' ? 'Your run here. ' : ''}Time: how long D1 took to run the SQL, without the network. Rows read${paged && meta.rowsRead != null ? ` (${count(meta.rowsRead)})` : ''}: the rows D1 scanned; D1 bills reads by rows read.`}
      </Help>
    </span>
  )
}

/** A step's footer under its rows: the same receipt as the answer's band, flat (a band mid-card is a stripe). */
function Footer({ outcome, env }: { outcome: Extract<D1Outcome, { status: 'rows' }>; env: Env }) {
  return (
    <div className="dq-foot">
      <StatsCompact outcome={outcome} />
      <span className="dq-grow" />
      <ResultLinks env={env} />
    </div>
  )
}

// ── The train: the earlier queries that led to the answer, in order, one line per step ──

function Train({ steps, answer, env }: { steps: readonly D1Query[]; answer: D1Query; env: Env }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const k = steps.length
  const failed = steps.filter((s) => s.outcome.status === 'failed').length
  const fixed = failed > 0 && answer.outcome.status !== 'failed'
  // The answer's "Open 3" opens the train at that step and moves focus to it.
  const trainRef = useRef<HTMLDivElement>(null)
  const [opened, setOpened] = useState<{ i: number }>()
  useEffect(() => {
    const section = trainRef.current?.closest('section.dq')
    if (!section) return undefined
    const on = (e: Event) => {
      setOpen(true)
      setOpened({ i: (e as CustomEvent<number>).detail })
    }
    section.addEventListener(OPEN_STEP, on)
    return () => section.removeEventListener(OPEN_STEP, on)
  }, [])
  return (
    <div className="dq-train" data-open={open ? '' : undefined} ref={trainRef}>
      <button
        type="button"
        className="dq-trainbar"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dq-glyph">
          <CaretRightIcon size={12} weight="bold" className="dq-caret" aria-hidden="true" />
        </span>
        <span className="dq-traintext">
          <span className="dq-trainlead">
            {k} {k === 1 ? 'query' : 'queries'} led here
          </span>
          <span className="dq-pips" aria-hidden="true">
            {steps.map((s, i) => (
              <i key={i} data-bad={s.outcome.status === 'failed' ? '' : undefined} />
            ))}
          </span>
          {failed > 0 && (
            <span className="dq-trainfail">
              {failed} failed{fixed ? ', then fixed' : ''}
            </span>
          )}
        </span>
      </button>
      {/* Always mounted, so the list opens and closes on the rows' curve (and aria-controls points at something). */}
      <div className="dq-collapse" inert={!open || undefined}>
        <div>
          <ol
            className="dq-steps"
            id={listId}
            aria-label="Queries the agent ran before the answer, in order"
          >
            {steps.map((s, i) => (
              <Step key={i} query={s} env={env} opened={opened?.i === i ? opened : undefined} />
            ))}
          </ol>
        </div>
      </div>
    </div>
  )
}

/**
 * One step: the agent's note and its count on one line, opening into the
 * step's own card body. A step is a receipt: it reads, sorts and copies, but
 * isn't edited (only the answer is).
 */
function Step({ query, env, opened }: { query: D1Query; env: Env; opened?: { i: number } }) {
  const [state, dispatch] = useReducer(cardReducer, undefined, () => initialCard(query, false))
  const [open, setOpen] = useState(false)
  // Opened from the answer's "Open 3": the step opens and its row takes focus, ringed (the button that asked is gone
  // from view, so the ring says where focus went).
  const rowRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!opened) return undefined
    setOpen(true)
    const t = window.setTimeout(() => {
      const row = rowRef.current
      if (!row) return
      row.focus({ preventScroll: true })
      row.setAttribute('data-focus', '')
      row.scrollIntoView({ block: 'nearest' })
    }, 260)
    return () => window.clearTimeout(t)
  }, [opened])
  const bodyId = useId()
  const outcome = state.query.outcome
  const kind = cardKind(query.purpose, outcome)
  const rows = useMemo(
    () => (outcome.status === 'rows' ? sortRows(outcome.rows, state.sort) : []),
    [outcome, state.sort]
  )
  const copy =
    outcome.status === 'rows' && kind === 'rows' ? (
      <Trio columns={outcome.columns} rows={rows} total={outcome.rowCount} env={env} />
    ) : kind === 'error' ? (
      <CopySql sql={query.sql} />
    ) : null
  return (
    <li className="dq-step" data-open={open ? '' : undefined} data-kind={kind}>
      <button
        ref={rowRef}
        type="button"
        className="dq-steprow"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dq-glyph">
          {kind === 'error' ? (
            <Glyph kind="error" />
          ) : (
            <CaretRightIcon size={12} weight="bold" className="dq-caret" aria-hidden="true" />
          )}
        </span>
        <span className="dq-say">
          <span className="dq-saytext">{query.note ?? query.title}</span>
          <span className="dq-count">
            <CountText kind={kind} rows={outcome.status === 'rows' ? outcome.rowCount : 0} />
          </span>
        </span>
      </button>
      <div className="dq-collapse" inert={!open || undefined}>
        <div>
          <div id={bodyId} className="dq-stepbody">
            <div className="dq-stepsub">
              <span className="dq-steptitle">{query.title}</span>
              {/* The row count, as the closed step shows it; at 352 it moves beside the trio. */}
              {outcome.status === 'rows' && kind === 'rows' && (
                <span className="dq-steprun">
                  <CountText kind={kind} rows={outcome.rowCount} />
                </span>
              )}
              {copy && <span className="dq-slot">{copy}</span>}
            </div>
            {/* A failed step opens as written: the full statement, the token underlined, the error under it. */}
            {kind === 'error' || state.pane === 'full' ? (
              <div className="dq-full">
                <AsWritten
                  sql={query.sql}
                  tables={env.tables}
                  squiggle={outcome.status === 'failed' ? outcome.token : undefined}
                />
                <StateLine outcome={outcome} kind={kind} env={env} />
                {kind !== 'error' && (
                  <StepBar sql={query.sql} onFold={() => dispatch({ type: 'pane.toggle' })} />
                )}
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="dq-sql"
                  aria-label="Show the query as written"
                  onClick={() => dispatch({ type: 'pane.toggle' })}
                >
                  <ShortSql sql={query.sql} tables={env.tables} />
                </button>
                <StateLine outcome={outcome} kind={kind} env={env} />
              </>
            )}
            {kind === 'rows' && outcome.status === 'rows' && (
              <div className="dq-rows-in dq-rows-step">
                <Grid
                  columns={outcome.columns}
                  rows={rows}
                  sort={state.sort}
                  onSort={(column) => dispatch({ type: 'sort', column })}
                />
                <Footer outcome={outcome} env={env} />
              </div>
            )}
          </div>
        </div>
      </div>
    </li>
  )
}

function ToolError({ text, retry }: { text: string; retry?: () => void }) {
  return (
    <section className="dq dq-toolerror" aria-label="D1 Studio error">
      <div className="dq-receipt" data-kind="error">
        <Head
          kind="error"
          title="D1 Studio couldn’t run the query"
          count={<CountText kind="error" rows={0} />}
          action={null}
        />
        <p className="dq-line2 dq-line2-act" role="alert">
          <span className="dq-line2-text dq-errtext">{text}</span>
          {retry && (
            <Ghost outline onClick={retry}>
              Try again
            </Ghost>
          )}
        </p>
      </div>
    </section>
  )
}

mountMcpApp({
  name: 'D1 Studio',
  measure: measureView,
  output: D1StudioResultSchema,
  copy: { pending: 'Running the query…' },
  renderPending: (_tool, input) => <Pending input={input} />,
  renderError: (text, retry) => <ToolError text={text} retry={retry} />,
  render: (result, { app }) => <Studio result={result} app={app} />
})
