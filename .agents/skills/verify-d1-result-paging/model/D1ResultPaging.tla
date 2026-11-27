---------------------------- MODULE D1ResultPaging ----------------------------
(***************************************************************************)
(* Reading more of a D1 Studio result in the view: paging past the rows    *)
(* held, D1 sorting a partial result, the held blocks, interleaved with    *)
(* the user's runs, Revert, and reads that land late, out of order or fail. *)
(*                                                                         *)
(* Code (each action names the reducer case or effect it is):              *)
(*   src/d1-studio/app/machines.ts  cardReducer cases page, sort,          *)
(*     fetch.done, fetch.error, run.sql, run.done, run.error, revert;      *)
(*     heldBlocks, missingBlock, pageRows, isPartial, pageCount,           *)
(*     heldIsContiguous, nextSort.                                         *)
(*   src/d1-studio/app/d1-studio-app.tsx  useFetchEffects (keyed on the    *)
(*     fetch id; reads shownSql(state) and state.sort when it starts;      *)
(*     aborts on cleanup; drops an error once aborted, never a done).      *)
(*   src/d1-studio/app/run.ts  readSlice / sliceSql: a read returns block  *)
(*     offset/MAX_ROWS of the SQL it was given, in the sort it was given.  *)
(*                                                                         *)
(* A row is abstracted to its block's tag: which SQL it came from, in      *)
(* which order, and which block of that order it is. The data in D1 does   *)
(* not change between reads.                                               *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  MAX_ROWS,     \* contract.ts MAX_ROWS (200), scaled down
  PAGE,         \* state.pageSize: PAGE_ROWS (10) or CONSOLE_PAGE_ROWS (100), scaled down
  AGENT_ROWS,   \* rowCount of the agent's SQL: more than MAX_ROWS, so partial
  USER_ROWS,    \* rowCount of the user's SQL: at most MAX_ROWS, so held whole
  MaxId,        \* bound on nextId (the model's only bound on time)
  Variant       \* "none" = the code as it is; other values = a one-line broken variant (see README of each cfg)

ASSUME MAX_ROWS % PAGE = 0          \* true of both 200/10 and 200/100: a page never spans two blocks
ASSUME AGENT_ROWS > MAX_ROWS /\ USER_ROWS <= MAX_ROWS

SQLs  == {"agent", "user"}
Sorts == {"none", "asc", "desc"}   \* one column: null, {dir: 'asc'}, {dir: 'desc'}

Ceil(a, b) == (a + b - 1) \div b
RowCount(s) == IF s = "agent" THEN AGENT_ROWS ELSE USER_ROWS
\* isPartial: D1 returned more rows than the outcome holds (an outcome holds at most MAX_ROWS).
Partial(s) == RowCount(s) > MAX_ROWS
NB == Ceil(AGENT_ROWS, MAX_ROWS)
Blocks == 0 .. NB - 1
PageCount(s) == Ceil(RowCount(s), PAGE)            \* pageCount
BlockOf(p) == (p * PAGE) \div MAX_ROWS             \* the one block page p is in

\* nextSort on the same column: ascending, descending, then back to the query's order.
NextSort(o) == CASE o = "none" -> "asc" [] o = "asc" -> "desc" [] o = "desc" -> "none"

\* The rows of block b of SQL s's result in order o.
Tag(s, o, b) == [sql |-> s, sort |-> o, blk |-> b]

EmptyHeld == [b \in {} |-> Tag("agent", "none", 0)]

Idle == [status |-> "idle", id |-> 0, page |-> 0, blk |-> 0, sort |-> "none"]
NoRun == [status |-> "idle", id |-> 0, sql |-> "agent"]

VARIABLES
  shown,     \* shownSql(state): "agent" (the agent's result or its refresh) or "user"
  sort,      \* state.sort: the order the header says
  page,      \* state.page
  heldNull,  \* state.held === null
  held,      \* state.held when not null: block -> tag
  fetch,     \* state.fetch
  run,       \* state.run (failed collapsed into idle: neither is busy)
  nextId,    \* state.nextId
  started,   \* id whose useFetchEffects body has run and not been cleaned up (0: none)
  reqs,      \* reads in flight through the host: [id, sql, sort, blk, aborted]
  asked,     \* ghost: the page the user last asked for (a page; the page a sort keeps; page 0 by a run landing or Revert)
  left       \* ghost: the page on screen when they asked

vars == <<shown, sort, page, heldNull, held, fetch, run, nextId, started, reqs, asked, left>>

\* heldBlocks(state)
HeldBlocks ==
  IF ~heldNull THEN held
  ELSE IF ~Partial(shown) THEN (0 :> Tag(shown, sort, 0))   \* held whole: sorted in the view
  ELSE (0 :> Tag(shown, "none", 0))                         \* the outcome's first MAX_ROWS, in the query's order

\* missingBlock(state, page) for a page in one block: undefined when held, else the page's block
IsHeld(p) == BlockOf(p) \in DOMAIN HeldBlocks
Missing(p) == BlockOf(p)

BusyFetch == fetch.status \in {"paging", "sorting"}
FetchId(f) == IF f.status \in {"paging", "sorting"} THEN f.id ELSE 0

\* heldIsContiguous(state): keys.every((b) => b < keys.length)
HeldIsContiguous ==
  LET k == DOMAIN HeldBlocks IN
  IF Variant = "contiguous-off-by-one"
  THEN \A b \in k : b <= Cardinality(k)
  ELSE \A b \in k : b < Cardinality(k)

\* useFetchEffects cleanup: when the fetch id the effect is keyed on changes, the read it started is aborted.
Cleanup(rs) ==
  /\ started' = IF FetchId(fetch') = started THEN started ELSE 0
  /\ reqs' = IF FetchId(fetch') = started THEN rs
             ELSE {IF r.id = started THEN [r EXCEPT !.aborted = TRUE] ELSE r : r \in rs}

Init ==
  /\ shown = "agent" /\ sort = "none" /\ page = 0
  /\ heldNull = TRUE /\ held = EmptyHeld
  /\ fetch = Idle /\ run = NoRun /\ nextId = 1
  /\ started = 0 /\ reqs = {}
  /\ asked = 0 /\ left = 0

-----------------------------------------------------------------------------
(* The user. Go to row (PagerPos) is never disabled, so it can ask for any  *)
(* page; the arrows (PagerArrows) ask for page +/- 1 and only when enabled, *)
(* so they are a subset of it.                                              *)

\* cardReducer case 'page'
YouGoToPage ==
  \E p \in 0 .. PageCount(shown) - 1 :
    /\ asked' = p /\ left' = page
    /\ \/ /\ Variant = "sort-refuses-page" /\ fetch.status = "sorting"   \* the old refusal while D1 sorts
          /\ UNCHANGED <<page, fetch, nextId, started, reqs>>
       \/ /\ Variant # "sort-refuses-page" /\ fetch.status = "sorting"   \* while D1 sorts: the page the new order lands on
          /\ \/ /\ BlockOf(p) = fetch.blk                              \* same block: same read, same id
                /\ fetch' = [fetch EXCEPT !.page = p] /\ nextId' = nextId
             \/ /\ BlockOf(p) # fetch.blk /\ nextId <= MaxId           \* another block: sortingAt(state, fetch.sort, page)
                /\ fetch' = [status |-> "sorting", id |-> nextId, page |-> p, blk |-> BlockOf(p), sort |-> fetch.sort]
                /\ nextId' = nextId + 1
          /\ page' = page
          /\ Cleanup(reqs)
       \/ /\ fetch.status # "sorting" /\ IsHeld(p)         \* held: shows at once, drops a read in flight
          /\ page' = p /\ fetch' = Idle /\ nextId' = nextId
          /\ Cleanup(reqs)
       \/ /\ Variant = "paging-refuses"                      \* the old line: `if (state.fetch.status === 'paging') return state`
          /\ fetch.status = "paging" /\ ~IsHeld(p)
          /\ UNCHANGED <<page, fetch, nextId, started, reqs>>
       \/ /\ Variant # "paging-refuses"                      \* the block already on its way: it waits for it, same id
          /\ fetch.status = "paging" /\ ~IsHeld(p) /\ fetch.blk = Missing(p)
          /\ fetch' = [fetch EXCEPT !.page = p]
          /\ UNCHANGED <<page, nextId, started, reqs>>
       \/ /\ ~IsHeld(p)                                      \* nothing on its way, or another block: a new read replaces it
          /\ \/ fetch.status \in {"idle", "failed"}
             \/ Variant # "paging-refuses" /\ fetch.status = "paging" /\ fetch.blk # Missing(p)
          /\ nextId <= MaxId
          /\ fetch' = [status |-> "paging", id |-> nextId, page |-> p, blk |-> Missing(p), sort |-> "none"]
          /\ nextId' = nextId + 1 /\ page' = page
          /\ Cleanup(reqs)
    /\ UNCHANGED <<shown, sort, heldNull, held, run>>

\* cardReducer case 'sort'. The next order goes on from the one on its way (when D1 sorts); the page stays:
\* the one loading when a read is in flight, else the one on screen. A partial result: sortingAt (new id,
\* replaces any read in flight). A whole result: sorted in the view, page kept, fetch idle.
\* The header stays clickable while D1 sorts (Grid's `onClick={() => onSort(i)}`), so a click during a
\* sort is a path the UI has.
YouSort ==
  LET o  == NextSort(IF fetch.status = "sorting" THEN fetch.sort ELSE sort)
      kp == IF BusyFetch THEN fetch.page ELSE page IN
  /\ \/ /\ Partial(shown) /\ nextId <= MaxId
        /\ fetch' = [status |-> "sorting", id |-> nextId, page |-> kp, blk |-> BlockOf(kp), sort |-> o]
        /\ nextId' = nextId + 1
        /\ UNCHANGED <<sort, page>>
     \/ /\ ~Partial(shown)
        /\ sort' = o /\ page' = kp /\ fetch' = Idle
        /\ UNCHANGED nextId
  /\ asked' = kp /\ left' = page
  /\ Cleanup(reqs)
  /\ UNCHANGED <<shown, heldNull, held, run>>

\* cardReducer case 'run.sql' (also 'submit' and 'offset', which become a run the same way)
YouRun ==
  \E s \in SQLs :
    /\ run.status = "idle" /\ nextId <= MaxId
    /\ run' = [status |-> "running", id |-> nextId, sql |-> s]
    /\ nextId' = nextId + 1
    /\ UNCHANGED <<shown, sort, page, heldNull, held, fetch, started, reqs, asked, left>>

\* cardReducer case 'revert': initialCard, keeping nextId; abandons anything in flight.
YouRevert ==
  /\ shown' = "agent" /\ sort' = "none" /\ page' = 0
  /\ heldNull' = TRUE /\ held' = EmptyHeld
  /\ fetch' = Idle /\ run' = NoRun /\ nextId' = nextId
  /\ asked' = 0 /\ left' = page
  /\ Cleanup(reqs)

-----------------------------------------------------------------------------
(* The host.                                                                *)

\* cardReducer case 'run.done' (rows; a refused SQL keeps the agent's rows dimmed and is out of scope)
RunLands ==
  /\ run.status = "running"
  /\ shown' = run.sql /\ sort' = "none" /\ page' = 0
  /\ heldNull' = TRUE /\ held' = EmptyHeld
  /\ fetch' = IF Variant = "run-keeps-fetch" THEN fetch ELSE Idle
  /\ run' = NoRun /\ nextId' = nextId
  /\ asked' = 0 /\ left' = page
  /\ Cleanup(reqs)

\* cardReducer case 'run.error': the host failed the run; the result on screen stays.
RunFails ==
  /\ run.status = "running"
  /\ run' = NoRun
  /\ UNCHANGED <<shown, sort, page, heldNull, held, fetch, nextId, started, reqs, asked, left>>

\* useFetchEffects body: readSlice(shownSql(state), sorting ? {sort: fetch.sort, offset: fetch.offset} : {sort: state.sort, offset: fetch.offset})
TheReadStarts ==
  /\ BusyFetch /\ started # fetch.id
  /\ started' = fetch.id
  /\ reqs' = reqs \cup {[id |-> fetch.id, sql |-> shown,
                         sort |-> IF fetch.status = "sorting" THEN fetch.sort ELSE sort,
                         blk |-> fetch.blk,
                         aborted |-> FALSE]}
  /\ UNCHANGED <<shown, sort, page, heldNull, held, fetch, run, nextId, asked, left>>

\* readSlice resolves: dispatch fetch.done (also after an abort); cardReducer case 'fetch.done'
TheReadLands ==
  \E r \in reqs :
    LET hb == HeldBlocks
        rows == Tag(r.sql, r.sort, r.blk) IN
    /\ IF BusyFetch /\ fetch.id = r.id
       THEN IF fetch.status = "sorting"
            THEN /\ heldNull' = FALSE
                 /\ held' = IF Variant = "sorted-keeps-blocks" THEN (fetch.blk :> rows) @@ hb
                            ELSE (fetch.blk :> rows)
                 /\ sort' = fetch.sort /\ page' = fetch.page
            ELSE /\ heldNull' = FALSE
                 /\ held' = (r.blk :> rows) @@ hb
                 /\ page' = fetch.page /\ sort' = sort
       ELSE UNCHANGED <<heldNull, held, sort, page>>
    /\ fetch' = IF BusyFetch /\ fetch.id = r.id THEN Idle ELSE fetch
    /\ Cleanup(reqs \ {r})
    /\ UNCHANGED <<shown, run, nextId, asked, left>>

\* readSlice rejects, not aborted: dispatch fetch.error; cardReducer case 'fetch.error'
TheReadFails ==
  \E r \in reqs :
    /\ ~r.aborted
    /\ LET accepts == IF Variant = "error-ignores-sort" THEN fetch.status = "paging" ELSE BusyFetch IN
       fetch' = IF accepts /\ fetch.id = r.id
                THEN [status |-> "failed", id |-> 0, page |-> 0, blk |-> 0, sort |-> "none"]
                ELSE fetch
    /\ Cleanup(reqs \ {r})
    /\ UNCHANGED <<shown, sort, page, heldNull, held, run, nextId, asked, left>>

\* An aborted read rejects: the effect drops the error.
AnAbortedReadEnds ==
  \E r \in reqs :
    /\ r.aborted
    /\ reqs' = reqs \ {r}
    /\ UNCHANGED <<shown, sort, page, heldNull, held, fetch, run, nextId, started, asked, left>>

Next ==
  \/ YouGoToPage \/ YouSort \/ YouRun \/ YouRevert
  \/ RunLands \/ RunFails
  \/ TheReadStarts \/ TheReadLands \/ TheReadFails \/ AnAbortedReadEnds

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* The rules, in the user's words.                                          *)

\* 1. Every row on screen belongs to the result of the SQL shown, in the order the header says.
RowsOnScreenMatchHeader ==
  LET hb == HeldBlocks  b == BlockOf(page) IN
  b \in DOMAIN hb => hb[b] = Tag(shown, sort, b)

\* 2. The page on screen is the page the user last asked for, or the one they left while it loads
\*    (or while the card says the read failed).
PageIsTheOneAsked ==
  \/ page = asked
  \/ page = left /\ fetch.status \in {"paging", "sorting", "failed"}

\* 3. The card never shows a page as loading forever: a read in flight always has a reply that can land.
ReadCanLand ==
  BusyFetch => (started # fetch.id \/ \E r \in reqs : r.id = fetch.id /\ ~r.aborted)

\* 4. Copy: heldIsContiguous true means the held rows really are the first N, in the order the header says.
CopyFirstNIsTrue ==
  LET hb == HeldBlocks  k == DOMAIN hb IN
  HeldIsContiguous => (k = 0 .. Cardinality(k) - 1 /\ \A b \in k : hb[b] = Tag(shown, sort, b))

TypeOK ==
  /\ shown \in SQLs /\ sort \in Sorts /\ page \in 0 .. PageCount(shown) - 1
  /\ fetch.status \in {"idle", "paging", "sorting", "failed"}
  /\ run.status \in {"idle", "running"}
=============================================================================
