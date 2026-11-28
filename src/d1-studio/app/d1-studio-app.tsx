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
  CaretLeftIcon,
  CaretRightIcon,
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
import { CopyToastHost, copyAllRows, copyRows, copyScope, copyText, useCopyToast } from './copy'
import { FORMAT_LABEL, columnType, count, duration, fitColumns } from './format'
import {
  PAGE_ROWS,
  SEND_TIMEOUT_MS,
  ageWords,
  canRevert,
  cardKind,
  cardReducer,
  copyReducer,
  foundWords,
  heldRows,
  initialCard,
  isBusy,
  isEdited,
  isStale,
  keptOutcome,
  moved,
  shownOutcome,
  shownSql,
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
 * D1 Studio: one card per `d1_studio` call, after the dashboard's Studio,
 * within ChatGPT's and Claude's inline card rules: the title and the row
 * count, the query folded a clause per line on the editor's tray, the first
 * ten rows when open (columns that don't fit leave; nothing scrolls), and a
 * band at the bottom with at most two actions and ⛶. No logo (the host draws
 * the declared icon), no popovers, the host's colours, fonts and frame.
 *
 * The answer's SQL can be edited and re-run in the view: a read goes through
 * the host (`callServerTool('d1_raw')`) with no model turn, and a write is
 * handed to the chat for the user to approve. The editor renders only once
 * the user opens the query, in the card, or on Claude in fullscreen. Paging,
 * sorting, Markdown, the dashboard link and the earlier queries are in the
 * host's fullscreen, where the view is the console (console.tsx).
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
          <Card state={answer[0]} dispatch={answer[1]} env={env} />
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

/**
 * While the agent's call runs: its title and SQL from the tool input, then
 * skeleton rows and band in the card's own layout. No spinner inline.
 */
function Pending({ input }: { input: Record<string, unknown> | undefined }) {
  const parsed = D1StudioInputSchema.safeParse(input)
  const title = parsed.success
    ? (parsed.data.title ?? (parsed.data.sql ? 'Query' : 'Tables'))
    : 'Query'
  const sql = parsed.success ? (parsed.data.sql ?? '') : ''
  return (
    <section className="dq" aria-label={`D1 query: ${title}`} aria-busy="true">
      <div className="dq-receipt" data-kind="running">
        <Head kind="running" title={title} count={<CountText kind="running" rows={0} />} />
        {sql && (
          <div className="dq-cell" aria-hidden="true">
            <div className="dq-sql dq-sql-cell">
              <ShortSql sql={sql} tables={new Set()} />
            </div>
          </div>
        )}
        <div className="dq-skel" aria-hidden="true">
          {[64, 48, 56].map((w, i) => (
            <i key={i} style={{ width: `${w}%` }} />
          ))}
        </div>
      </div>
      <div className="dq-band" aria-hidden="true">
        <span className="dq-cap">
          <i className="dq-skelbar" />
        </span>
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
          if (mounted.current)
            dispatch({ type: 'run.done', id: run.id, outcome: o, at: Date.now() })
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

/** What opening the rows shows: "Show 10 rows", "Show the first 10 of 1,284 rows". */
const showLabel = (total: number) =>
  total > PAGE_ROWS
    ? `Show the first ${PAGE_ROWS} of ${count(total)} rows`
    : `Show ${count(total)} ${total === 1 ? 'row' : 'rows'}`

/** The most columns the inline table shows; the rest are fullscreen's (and every copy's). */
const FIT_COLUMNS = 5

/** Open the host's fullscreen: the console, with paging, sorting, the earlier queries and the editor. */
const openFullscreen = (env: Env) =>
  void env.app.requestDisplayMode({ mode: 'fullscreen' }).catch(() => undefined)

/**
 * The answer card, inline: the title line, the SQL on its tray, a state line
 * when one is needed, the first PAGE_ROWS rows when open (columns that don't
 * fit leave, nothing scrolls), and the band. No paging, sorting or earlier
 * queries inline: fullscreen has them, one tap away.
 */
function Card({
  state,
  dispatch,
  env
}: {
  state: CardState
  dispatch: Dispatch<CardEvent>
  env: Env
}) {
  const outcome = shownOutcome(state)
  const kind = cardKind(state.query.purpose, outcome)
  const rowsId = useId()
  const reasonId = `${useId()}-why`
  const now = useMinute()
  const held = useMemo(() => heldRows(state), [state.shown, state.sort, state.held])
  // A read the user ran that D1 refused keeps the agent's rows under its error, dimmed.
  const kept = keptOutcome(state)
  const columns = outcome.status === 'rows' ? outcome.columns : (kept?.columns ?? [])
  const total = outcome.status === 'rows' ? outcome.rowCount : 0
  const [focus, setFocus] = useState<Focus>()
  const [hidden, setHidden] = useState(0)
  // On Claude the SQL is edited in fullscreen (freeform text entry belongs to the chat or fullscreen there).
  const editElsewhere = state.editable && env.host.editInFullscreen
  const openEditor = (at: Focus) => {
    if (editElsewhere) return openFullscreen(env)
    setFocus(at)
    if (state.pane === 'short') dispatch({ type: 'pane.toggle' })
  }

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
  const visible = (kept ? kept.rows : held).slice(0, PAGE_ROWS)

  // A failed answer whose missing name has a close match offers the read that uses it.
  const fix = outcome.status === 'failed' ? outcome.fix : undefined
  const fixSql =
    fix && outcome.status === 'failed' && outcome.token
      ? replaceIdentifier(shownSql(state), outcome.token, fix.use)
      : undefined
  const offerFix = kind === 'error' && !!fixSql && !changed && !ranAny && env.host.run

  /** The copy's rows past those held: `d1_raw`, `SELECT * FROM (<sql>) LIMIT n OFFSET m`, one block at a time. */
  const readRest =
    env.host.run && outcome.status === 'rows' && total > held.length
      ? (offset: number, limit: number) =>
          readRows(env.app, env.database, shownSql(state), { sort: state.sort, offset, limit })
      : undefined

  return (
    <>
      <div className="dq-receipt" data-open={rowsOpen ? '' : undefined} data-kind={kind}>
        <Head
          kind={kind}
          title={state.query.title}
          count={<CountText kind={kind} rows={total} />}
          disclosure={
            kind === 'rows'
              ? {
                  open: rowsOpen,
                  controls: rowsId,
                  label: showLabel(total),
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
          onEdit={editElsewhere ? () => openFullscreen(env) : undefined}
        />
        {!editorOpen &&
          (offerFix && fix && fixSql && outcome.status === 'failed' ? (
            <FixLines
              outcome={outcome}
              fix={fix}
              busy={isBusy(state.run)}
              onUse={() => dispatch({ type: 'run.sql', sql: fixSql })}
            />
          ) : (
            <StateLine outcome={outcome} kind={kind} env={env} />
          ))}
        {!editorOpen && <RunLine state={state} />}
        {rowsBlock && (
          <div className="dq-rows" id={rowsId} inert={!rowsOpen || undefined}>
            <div className="dq-rows-in">
              <Grid
                columns={columns}
                rows={visible}
                widthRows={kept ? kept.rows : held}
                count={kept ? kept.rowCount : total}
                sort={null}
                dim={!!kept}
                label={`${count(visible.length)} of ${count(kept ? kept.rowCount : total)} rows`}
                was={state.found.kind === 'changed' ? state.found.was : undefined}
                onSort={() => undefined}
                fit={{ max: FIT_COLUMNS, onHidden: setHidden }}
              />
            </div>
          </div>
        )}
      </div>
      <Band
        state={state}
        dispatch={dispatch}
        env={env}
        outcome={outcome}
        kind={kind}
        editing={editorOpen && state.editable}
        rowsOpen={rowsOpen}
        shown={visible.length}
        hidden={rowsOpen ? hidden : 0}
        stale={kind === 'rows' && isStale(state, now)}
        now={now}
        held={held}
        readRest={readRest}
        reasonId={reasonId}
      />
    </>
  )
}

/**
 * A failed card whose missing name has a close match: D1's words on their own
 * line, then what the name likely meant and the fix the view can run (a read).
 */
function FixLines({
  outcome,
  fix,
  busy,
  onUse
}: {
  outcome: Extract<D1Outcome, { status: 'failed' }>
  fix: { use: string; table?: string }
  busy: boolean
  onUse: () => void
}) {
  const name = fix.use.split('.').pop()!
  return (
    <>
      <p className="dq-line2" role="alert">
        <span className="dq-mono dq-danger">{outcome.error}</span>
      </p>
      <p className="dq-line2 dq-line2-act">
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

// ── The fullscreen console's pager: where you are, and ‹ › ──

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
 * The card's band, always its last element. Left, one line of what is on
 * screen: `10 of 1,284 rows · 42.7 ms`, `✓ Ran here · 2 values changed · …`,
 * `Read 3h ago · …`, `Editing · rows below are from the last run`. D1's rows
 * read and the copy's scope are in its hover hint (the browser's own, never a
 * popover the card draws). Right, at most two actions, then ⛶: a result's CSV
 * and JSON (the whole result), a failed query's Copy SQL, and while editing
 * Revert (Cancel when there is nothing to revert) and Run.
 */
function Band({
  state,
  dispatch,
  env,
  outcome,
  kind,
  editing,
  rowsOpen,
  shown,
  hidden,
  stale,
  now,
  held,
  readRest,
  reasonId
}: {
  state: CardState
  dispatch: Dispatch<CardEvent>
  env: Env
  outcome: D1Outcome
  kind: CardKind
  /** The editor is open on an editable card. */
  editing: boolean
  rowsOpen: boolean
  /** The rows the open table shows, and the columns it left out. */
  shown: number
  hidden: number
  stale: boolean
  now: number
  held: readonly (readonly D1Cell[])[]
  readRest?: (offset: number, limit: number) => Promise<readonly (readonly D1Cell[])[]>
  reasonId: string
}) {
  const ranOk = state.found.kind !== 'agent' && state.found.kind !== 'failed'
  const words = foundWords(state.found)
  const changed = state.draft !== state.query.sql
  const total = outcome.status === 'rows' ? outcome.rowCount : 0
  const meta = outcome.status === 'rows' ? outcome.meta : undefined
  const time = meta?.durationMs != null ? duration(meta.durationMs) : undefined
  const lead = ranOk ? (
    <span className="dq-ranhere dq-ranhere-ok">
      <CheckIcon size={12} weight="bold" aria-hidden="true" />
      Ran here
      {words && (
        <span className="dq-diff" data-changed={moved(state.found) ? '' : undefined}>
          {` · ${words}`}
        </span>
      )}
    </span>
  ) : editing ? (
    `${changed ? 'Edited' : 'Editing'}${rowsOpen ? ' · rows below are from the last run' : ''}`
  ) : stale ? (
    `Read ${ageWords(now - state.shown.readAt, now)}`
  ) : null
  const rowsWords =
    kind === 'none'
      ? 'No rows'
      : kind !== 'rows'
        ? undefined
        : rowsOpen && total > shown
          ? `${count(shown)} of ${count(total)} rows`
          : `${count(total)} ${total === 1 ? 'row' : 'rows'}`
  const tail =
    editing && !ranOk
      ? []
      : [rowsWords, hidden > 0 && `+${hidden} ${hidden === 1 ? 'column' : 'columns'}`, time].filter(
          (p): p is string => !!p
        )
  const copies = copyScope(held.length, total, !!readRest)
  const hint =
    kind === 'rows' && !editing
      ? `${[time, meta?.rowsRead != null && `${count(meta.rowsRead)} rows read`].filter(Boolean).join(' · ')}. CSV and JSON copy ${copyWords(copies, total)} and every column.`
      : undefined

  const sep = <span className="dq-bsep" aria-hidden="true" />
  const expand = env.host.fullscreen && (
    <IconButton className="dq-ex" label="Open full screen" fs onClick={() => openFullscreen(env)}>
      <CornersOutIcon size={16} aria-hidden="true" />
    </IconButton>
  )
  const withExpand = (acts: ReactNode) => (
    <>
      {acts}
      {expand && (
        <>
          {sep}
          {expand}
        </>
      )}
    </>
  )
  const back = canRevert(state)
  const actions = editing
    ? withExpand(
        <>
          <Ghost
            onClick={() => {
              if (back) dispatch({ type: 'revert' })
              dispatch({ type: 'pane.toggle' })
            }}
          >
            {back ? 'Revert' : 'Cancel'}
          </Ghost>
          <RunButton state={state} dispatch={dispatch} host={env.host} reasonId={reasonId} />
        </>
      )
    : kind === 'rows' && outcome.status === 'rows'
      ? withExpand(
          <>
            {(['csv', 'json'] as const).map((f, i) => (
              <span key={f} className="dq-actg">
                {i > 0 && sep}
                <CopyAll
                  format={f}
                  columns={outcome.columns}
                  rows={held}
                  total={total}
                  readRest={readRest}
                />
              </span>
            ))}
          </>
        )
      : kind === 'error'
        ? withExpand(<CopySql sql={shownSql(state)} plain />)
        : expand || null
  if (!lead && !tail.length && !actions) return null
  return (
    <div className="dq-band" data-editing={editing ? '' : undefined}>
      <span className="dq-cap" title={hint}>
        {lead}
        {tail.map((t, i) => (
          <span key={i}>{lead || i > 0 ? ` · ${t}` : t}</span>
        ))}
      </span>
      <span className="dq-acts">{actions}</span>
    </div>
  )
}

/** What the card's copy takes, in words: "all 1,284 rows", "the first 10,000 of 50,000 rows". */
function copyWords(copies: number, total: number): string {
  if (copies >= total) return total === 1 ? 'the 1 row' : `all ${count(total)} rows`
  return `the first ${count(copies)} of ${count(total)} rows`
}

// ── The title line: glyph · title · count, the same slots in every state (actions are the band's) ──

interface Disclosure {
  open: boolean
  controls: string
  /** What opening it shows: "Show 10 rows", "Show the first 10 of 47 rows". */
  label: string
  onToggle: () => void
}

function Head({
  kind,
  title,
  count: countNode,
  disclosure
}: {
  kind: CardKind
  title: string
  count: ReactNode
  disclosure?: Disclosure
}) {
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
      {/* No mark: the host draws the tool's declared icon. */}
      <span
        className="dq-title"
        data-click={disclosure ? '' : undefined}
        onClick={disclosure?.onToggle}
        title={title}
      >
        <span className="dq-titletext">{title}</span>
      </span>
      <span className="dq-count" role={kind === 'running' ? 'status' : undefined}>
        {countNode}
      </span>
    </div>
  )
}

/** The title's glyph. Running is the caret in inactive ink: the card skeletons, it doesn't spin. */
export function Glyph({ kind }: { kind: CardKind }) {
  if (kind === 'error')
    return <WarningCircleIcon size={16} weight="fill" className="dq-danger" aria-hidden="true" />
  if (kind === 'none' || kind === 'empty-db')
    return <MinusCircleIcon size={16} aria-hidden="true" />
  return (
    <CaretRightIcon
      size={12}
      weight="bold"
      className={kind === 'running' ? 'dq-caret dq-wait' : 'dq-caret'}
      aria-hidden="true"
    />
  )
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
  onFold,
  onEdit
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
  /** The SQL is edited elsewhere (Claude: fullscreen): the tray opens that, not the editor in place. */
  onEdit?: () => void
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
          aria-label={
            onEdit
              ? 'Edit the SQL in full screen'
              : state.editable
                ? 'Edit and run this SQL'
                : 'Show the query as written'
          }
          title={
            onEdit
              ? 'Edit and run it in full screen. Reads only; the agent isn’t called.'
              : state.editable
                ? 'Edit and run here. Reads only; the agent isn’t called.'
                : undefined
          }
          // Focus shown after keyboard use even where :focus-visible can't tell (see useKeyboardModality).
          onFocus={(e) =>
            document.documentElement.hasAttribute('data-kbd') &&
            e.currentTarget.setAttribute('data-focus', '')
          }
          onBlur={(e) => e.currentTarget.removeAttribute('data-focus')}
          onClick={() => {
            if (onEdit) return onEdit()
            onFold()
            dispatch({ type: 'pane.toggle' })
          }}
        >
          <ShortSql
            sql={state.editable ? state.draft : shownSql(state)}
            tables={env.tables}
            squiggle={squiggle}
            tail={!!cue}
            hint={state.editable && !cue ? (onEdit ? 'fullscreen' : 'edit') : undefined}
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
/** The face's room where Edit opens fullscreen ("⛶ Edit in full screen"). */
const CUE_ROOM_FS = 148

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
  /** Draw the Edit face shown on pointer over and keyboard focus: in place, or in fullscreen (Claude). */
  hint?: 'edit' | 'fullscreen'
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
  const faceCh = Math.ceil((hint === 'fullscreen' ? CUE_ROOM_FS : CUE_ROOM) / ch)
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
          {hint === 'fullscreen' ? (
            <>
              <CornersOutIcon size={12} weight="bold" />
              Edit in full screen
            </>
          ) : (
            <>
              <PencilSimpleIcon size={12} weight="bold" />
              Edit
            </>
          )}
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
  if (run.status === 'running') return line('quiet', info, 'Running…')
  if (verdict.kind === 'write')
    return !env.host.send
      ? line(
          'note',
          info,
          'This chat doesn’t take messages from the view. Copy the SQL and paste it to the agent.'
        )
      : run.status === 'sending'
        ? line('quiet', info, 'Sending to the chat…')
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
        {!sending && <PaperPlaneRightIcon size={12} weight="fill" aria-hidden="true" />}
        {sending ? 'Sending…' : 'Send to chat'}
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
        'Running…'
      ) : (
        <>
          <PlayIcon size={12} weight="fill" aria-hidden="true" />
          Run
          <span className="dq-kbd" aria-hidden="true">
            ⌘↵
          </span>
        </>
      )}
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

/**
 * One of the card's two copy buttons: the whole result as CSV or JSON, every
 * column, not just the rows shown. Its name says the scope ("Copy all 1,284
 * rows as CSV"), as the pointer's hover hint and to a screen reader. While D1
 * reads the rows past those held it counts in place ("Copying 600 of
 * 1,284"), then confirms ("Copied 1,284"); there is no toast inline.
 */
function CopyAll({
  format,
  columns,
  rows,
  total,
  readRest
}: {
  format: 'csv' | 'json'
  columns: readonly string[]
  rows: readonly (readonly D1Cell[])[]
  total: number
  readRest?: (offset: number, limit: number) => Promise<readonly (readonly D1Cell[])[]>
}) {
  type Face =
    | { readonly kind: 'idle' }
    | { readonly kind: 'busy'; readonly n: number }
    | { readonly kind: 'done'; readonly n: number }
    | { readonly kind: 'blocked' }
    | { readonly kind: 'failed'; readonly error: string }
  const [face, setFace] = useState<Face>({ kind: 'idle' })
  useEffect(() => {
    if (face.kind === 'idle' || face.kind === 'busy') return undefined
    const t = window.setTimeout(() => setFace({ kind: 'idle' }), COPY_FEEDBACK_MS)
    return () => window.clearTimeout(t)
  }, [face])
  const want = copyScope(rows.length, total, !!readRest)
  const label = FORMAT_LABEL[format]
  const name = `Copy ${copyWords(want, total)} as ${label}`
  return (
    <button
      type="button"
      className="dq-act"
      aria-label={name}
      title={face.kind === 'failed' ? `D1 didn’t read the rest: ${face.error}` : name}
      aria-disabled={face.kind === 'busy' || undefined}
      data-face={face.kind}
      onClick={() => {
        if (face.kind === 'busy') return
        if (want > rows.length) setFace({ kind: 'busy', n: rows.length })
        void copyAllRows({
          format,
          columns,
          rows,
          total,
          readRest,
          onProgress: (n) => setFace({ kind: 'busy', n })
        }).then((r) =>
          setFace(
            !r
              ? { kind: 'idle' }
              : r.status === 'copied'
                ? { kind: 'done', n: r.rows }
                : r.status === 'blocked'
                  ? { kind: 'blocked' }
                  : { kind: 'failed', error: r.error }
          )
        )
      }}
    >
      <span aria-live="polite">
        {face.kind === 'busy' ? (
          `Copying ${count(face.n)} of ${count(want)}`
        ) : face.kind === 'done' ? (
          <>
            <CheckIcon size={14} weight="bold" aria-hidden="true" />
            {`Copied ${count(face.n)}`}
          </>
        ) : face.kind === 'blocked' ? (
          'Clipboard blocked'
        ) : face.kind === 'failed' ? (
          'Copy failed'
        ) : (
          label
        )}
      </span>
    </button>
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
  padPx,
  fit
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
  /**
   * The inline card's table: nothing scrolls. Columns that don't fit leave
   * from the right (at most `max` stay; the first text column gives way with an ellipsis),
   * `onHidden` hears how many left, and the headers don't sort.
   */
  fit?: { readonly max: number; readonly onHidden?: (n: number) => void }
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chRef = useRef<HTMLSpanElement>(null)
  const [more, setMore] = useState(false)
  const cells = useMemo(
    () =>
      columns.map((c, i) => ({
        name: c.length,
        cell: Math.min(
          38,
          widthRows.reduce((m, r) => {
            const v = r[i]
            return Math.max(m, v === null || v === undefined ? 4 : String(v).split('\n')[0]!.length)
          }, 0)
        )
      })),
    [columns, widthRows]
  )
  const digits = count(total ?? offset + rows.length).length
  // The inline table's column that gives way: the first text column (a name, a title), never a number.
  const flex = useMemo(
    () => (fit ? columns.findIndex((_, i) => columnType(widthRows, i) === 'TEXT') : -1),
    [columns, widthRows, !!fit]
  )
  const [fitted, setFitted] = useState(() =>
    fit ? Math.min(fit.max, columns.length) : columns.length
  )
  useLayoutEffect(() => {
    const el = ref.current
    if (!fit || !el) return undefined
    const measure = () => {
      const ch = (chRef.current?.getBoundingClientRect().width ?? 72) / 10 || 7.2
      const k = fitColumns(cells, ch, el.clientWidth, Math.max(34, digits * ch + 16), fit.max, flex)
      setFitted((n) => (n === k ? n : k))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [cells, digits, flex, !!fit])
  const hiddenCols = fit ? columns.length - fitted : 0
  const onHidden = fit?.onHidden
  useEffect(() => onHidden?.(hiddenCols), [hiddenCols, onHidden])
  const shownCols = fit ? columns.slice(0, fitted) : columns
  useEffect(() => {
    const el = ref.current
    if (!el || fit) return
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
  const widths = cells.map(
    ({ name, cell }) => `max(calc(${name}ch + ${fit ? 16 : 26}px), calc(${cell}ch + 16px))`
  )
  const gutterW = `max(34px, calc(${digits}ch + 16px))`
  return (
    <div className="dq-gridwrap" data-more={more ? '' : undefined} data-fit={fit ? '' : undefined}>
      {fit && (
        <span className="dq-chm" ref={chRef} aria-hidden="true">
          0000000000
        </span>
      )}
      <div
        className="dq-grid"
        ref={ref}
        tabIndex={fit ? undefined : 0}
        role="region"
        aria-label={
          fit
            ? `${label ?? `${count(rows.length)} rows`}${hiddenCols ? `, ${hiddenCols} more ${hiddenCols === 1 ? 'column' : 'columns'} in full screen` : ''}`
            : label
              ? `${label}. Page Down and Page Up turn the page`
              : `${count(rows.length)} rows`
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
              {shownCols.map((c, i) => {
                if (fit)
                  return (
                    <th
                      key={i}
                      className={i === flex ? 'dq-flex' : undefined}
                      style={i === flex ? undefined : { minWidth: widths[i] }}
                      title={`${c} · ${columnType(widthRows, i)}`}
                    >
                      <span className="dq-thname">{c}</span>
                    </th>
                  )
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
                  {shownCols.map((_, c) =>
                    old?.has(c) ? (
                      // The old value is in the browser's own hint and the cell's name: no tip drawn over the card.
                      <td
                        key={c}
                        className={c === flex ? 'dq-flex' : undefined}
                        data-changed=""
                        title={`Was ${cellText(old.get(c))}`}
                        aria-label={`${cellText(r[c])}, was ${cellText(old.get(c))}`}
                      >
                        <Cell value={r[c]} />
                      </td>
                    ) : (
                      <td key={c} className={c === flex ? 'dq-flex' : undefined}>
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
                {shownCols.map((_, c) => (
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

function ToolError({ text, retry }: { text: string; retry?: () => void }) {
  return (
    <section className="dq dq-toolerror" aria-label="D1 Studio error">
      <div className="dq-receipt" data-kind="error">
        <Head
          kind="error"
          title="D1 Studio couldn’t run the query"
          count={<CountText kind="error" rows={0} />}
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
