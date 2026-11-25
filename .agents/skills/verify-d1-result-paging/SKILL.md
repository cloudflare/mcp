---
name: verify-d1-result-paging
description: "Model-check D1 Studio's reading more of a result (paging past the rows held, D1 sort of a partial result, held blocks, Copy's \"first N\") against runs, Revert and reads that land late, out of order or fail. Use when a change touches cardReducer's page, sort, fetch.done, fetch.error, offset, run.sql, run.done or revert cases, heldBlocks / pageRows / missingBlock / heldIsContiguous / isPartial / pageCount / nextSort in src/d1-studio/app/machines.ts, readSlice / sliceSql in src/d1-studio/app/run.ts, useFetchEffects or pagerOf in src/d1-studio/app/d1-studio-app.tsx, or the console pager in src/d1-studio/app/console.tsx."
---

# Verify D1 Studio result paging

A TLA+ model (`model/D1ResultPaging.tla`) of one D1 Studio card reading more of a result in the view, a block of `MAX_ROWS` at a time through `d1_raw`, while the user pages, sorts, runs SQL and reverts, and reads come back late, out of order, after an abort, or fail. TLC checks every order of those steps up to the bounds below. Read every result with the `/statechart` skill: it gives each broken rule as its shortest path in plain words.

## The rules

| Rule (INVARIANT) | In the user's words | Harm when it breaks |
|---|---|---|
| `RowsOnScreenMatchHeader` | Every row on screen belongs to the result of the SQL shown, in the order the header says. | The user reads rows of another query, or of another sort, as if they were this one's. |
| `PageIsTheOneAsked` | The page on screen is the page the user last asked for, or the one they left while it loads (or while the card says the read failed). | The user lands on a page they didn't ask for and reads the wrong rows' numbers as the ones they wanted. |
| `ReadCanLand` | The card never shows a page as loading forever: a read in flight always has a reply that can land. | The pager or the sort spins for good, and paging and sorting stay refused until a run or Revert. |
| `CopyFirstNIsTrue` | When `heldIsContiguous` is true, the held rows really are the first N, in the order the header says. | Copy labels a hole-y or mixed set of rows "the first N" and the user pastes them as such. |

`TypeOK` and `/statechart`'s `NoDeadlock` are also checked.

## Expected result at the sync commit

- `model/D1ResultPaging.cfg`: every rule holds, about 84,000 states, a few seconds.
  - Paging: a page in the block already on its way waits for that read (`fetch.page` updated, same id). A page in another block starts a new read with a new id, and the old reply is ignored.
  - D1 sort (as in the dashboard's Studio, where sort and offset are both inputs of one query): `sort` keeps the page and reads the block it is in, in the new order. It is accepted while any read is in flight, replaces that read, and goes on from `fetch.sort` while D1 sorts. A page asked while D1 sorts either updates `fetch.page` (same block) or starts `sortingAt` for its block. `fetch.done` holds only that block.
- `model/D1ResultPagingDeep.cfg`: all rules at a deeper bound, all hold, about 660,000 states, under 20 s.
- `model/D1ResultPagingChart.cfg` with `model/chart-view.mjs`: the full chart, at a bound small enough for the chart budget (353 states, 5 chart states, 15 arrows). It hides Revert, a reset every state has.
- `model/broken/*.cfg`: each is a one-line broken variant of the code, named in its first line, and must break the rule that line names:
  - `sort-refuses-page` (the old `|| state.fetch.status === 'sorting'` in `page`): `PageIsTheOneAsked`. Path: click the header → go to page 2 while D1 sorts → read goes to D1 → rows land on page 1.
  - `paging-refuses` (the old `if (state.fetch.status === 'paging') return state`): `PageIsTheOneAsked`. Path: go to page 3 → go to page 4 while page 3 loads → read goes to D1 → rows land on page 3.
  - `run-keeps-fetch`: `RowsOnScreenMatchHeader`, `CopyFirstNIsTrue` (and `TypeOK`, `PageIsTheOneAsked`)
  - `sorted-keeps-blocks` (sorted `fetch.done` keeps the old blocks next to the sorted one): `RowsOnScreenMatchHeader`, `CopyFirstNIsTrue`
  - `error-ignores-sort`: `ReadCanLand`
  - `contiguous-off-by-one`: `CopyFirstNIsTrue`
- `replay/paging.test.ts`: 12 pass.

If you get anything else and did not mean to change behaviour, it is a bug until shown otherwise.

## Does my change touch this?

Yes if the diff touches any of these (`git diff 1a0a9230 -- <file>`):
- `src/d1-studio/app/machines.ts`: `Fetch`, `CardState` fields `held`, `sort`, `page`, `pageSize`, `nextId`, `fetch`, `shown`, `can`; `cardReducer` cases `page`, `sort`, `fetch.done`, `fetch.error`, `offset`, `run.sql`, `submit`, `run.done`, `run.error`, `revert`, `fold`; `heldBlocks`, `heldRows`, `heldIsContiguous`, `pageRows`, `missingBlock`, `isPartial`, `pageCount`, `nextSort`, `shownSql`, `shownOutcome`, `initialCard`.
- `src/d1-studio/app/d1-studio-app.tsx`: `useFetchEffects` (what it reads, its key, its abort), `pagerOf`, `PagerPos`, `PagerArrows` (what is enabled while busy), the sort header's `onClick` in `Grid` (clickable while D1 sorts).
- `src/d1-studio/app/console.tsx`: the pager (`goTo`, `PagerPos`, `PagerArrows` props), `consoleReducer`.
- `src/d1-studio/app/run.ts`: `readSlice`, `sliceSql` (which SQL, sort, offset and limit a read reads).
- `src/d1-studio/contract.ts` `MAX_ROWS`, `PAGE_ROWS` / `CONSOLE_PAGE_ROWS` (the model needs pageSize to divide `MAX_ROWS`).

## Run it

1. Run `/statechart` on `.agents/skills/verify-d1-result-paging/model/D1ResultPaging.tla` with the config `model/D1ResultPaging.cfg` and the view `model/view.mjs`, writing to a new folder outside the repo. Compare its report with "Expected result" above. Show the chart (`chart.mmd`) and each path.
2. Same with `model/D1ResultPagingDeep.cfg`, and with `model/D1ResultPagingChart.cfg` using the view `model/chart-view.mjs` for the full chart.
3. If you changed the model, run it with each `model/broken/*.cfg`: each must still break its named rule. A variant that stops breaking means the model no longer reaches that code path.
4. `bun test ./.agents/skills/verify-d1-result-paging/replay/paging.test.ts` (the `./` matters: bun skips dot folders otherwise). Set `MACHINES_PATH=/abs/path/to/machines.ts` to run the same replays against a scratch copy (put it under a copy of `src/d1-studio/` with `contract.ts`, `statement.ts`, `app/verdict.ts`, and a `node_modules` symlink to the repo's, so its imports resolve).

## Model ↔ code

| Model | Code |
|---|---|
| `shown` | `shownSql(state)`; `"agent"` = the agent's SQL (its result, or a refresh of it), partial: `AGENT_ROWS` > `MAX_ROWS`; `"user"` = the user's SQL, held whole |
| `sort` ∈ none/asc/desc | `state.sort` on one column, cycled by `nextSort` |
| `heldNull`, `held`, `HeldBlocks` | `state.held`, `heldBlocks(state)` |
| `IsHeld` / `Missing` | `missingBlock` (one block a page: `MAX_ROWS % pageSize = 0`, true of 200/10 and 200/100) |
| `fetch`, `run`, `nextId` | `state.fetch`, `state.run` (`failed` merged into `idle`: neither is busy), `state.nextId` |
| a block's value `Tag(sql, sort, blk)` | the rows `readSlice` returns: `sliceSql(sql, {sort, limit: MAX_ROWS, offset: blk*MAX_ROWS})` |
| `YouGoToPage` | `page` event from Go to row, ‹ or › (any page: Go to row is never disabled); same block in flight → `fetch.page` updated, same id; other block → new read |
| `YouSort` | `sort` event: next order from `fetch.sort` when sorting, else `state.sort`; page kept (`fetch.page` when a read is busy); partial → `sortingAt` (new id); whole → sorted in the view, page kept, fetch idle. The table header stays clickable while D1 sorts (Grid's `onClick={() => onSort(i)}`, as in the dashboard's Studio), so a click during a D1 sort is a path the UI has, not only the model |
| `YouRun` | `run.sql` / `submit` / `offset` (a read) |
| `YouRevert` | `revert` |
| `RunLands`, `RunFails` | `run.done` (rows), `run.error` |
| `TheReadStarts` | the body of `useFetchEffects`: `readSlice(shownSql(state), sorting ? {sort: fetch.sort, offset: fetch.offset} : {sort: state.sort, offset: fetch.offset})` |
| `Cleanup` | the effect's cleanup when the fetch id it is keyed on changes: `abort.abort()` |
| `TheReadLands` | `readSlice` resolves → `fetch.done` (dispatched even after an abort) |
| `TheReadFails`, `AnAbortedReadEnds` | rejects → `fetch.error`, or dropped when `abort.signal.aborted` |
| `asked`, `left` | ghosts: the page last asked for (the page a sort keeps; page 1 after a run lands or Revert) and the page on screen then |
| `Variant` | `"none"` = the code; other values switch on the one-line broken variants in `model/broken/` |

## Bounds and what is left out

- `MAX_ROWS` = 2 rows a block, a page = 1 row (two pages a block, as the console's 100 of 200; the card has 20), the agent's result 5 rows (3 blocks, the last short), the user's 2 rows (held whole), at most 4 reads or runs (`MaxId`; 5 in the deep config).
- D1's data does not change between reads; a read returns exactly its block. A short block mid-result (rows deleted since) is out of scope.
- The host can run reads (`state.can.run` true; `limitPaging` and `run.sql` need it). `fold`, which only closes the rows and folds the pane, and Revert's refusal while a write is `sending` (no sends here) are not modelled.
- A SQL error run (`keptOutcome`: the agent's rows dimmed under the error, no pager, no sort) and writes sent to the chat are out of scope. So are the copy trio's own reads (`readRows` for Copy all) and LIMIT paging's rewrite of the SQL (it is a run here).
- One card; the console's `Main` is the same reducer with `pageSize` 100. The host is assumed to answer every read eventually (`ReadCanLand` is about the card, not the host).
- The effect's read is a separate step from the event that asked for it, reading the state then; that over-approximates React (whose effect reads the render that committed the id), which is safe.

## A break: bug or model error?

Replay the path against the real reducer: add a test to `replay/paging.test.ts`, one event per model step (`TheReadStarts` is `readStarts(s)` in the test). If the real code does what the path says, it is a bug: report the rule, the harm and the path in the code's words; do not weaken the rule or the model, and do not change product code unless asked. If the real code does not, the model is wrong: fix the action that disagrees, with the code line it mirrors.

## When you change the behaviour on purpose

Change the matching action in the model (comment the code it mirrors), rerun all configs and the broken variants, update the replays and "Expected result", then the coverage record.

## Coverage record

Last confirmed that the model describes the code at commit `1a0a9230b359b622a21c7a668b5110c57ab264a7` (the commit that contains it). The blobs there (`git hash-object <file>`) are a second check:

| File | Blob |
|---|---|
| `src/d1-studio/app/machines.ts` | `1b7e8dadf75d2b7497153b468a705f458e7097cd` |
| `src/d1-studio/app/run.ts` | `6b93f137a34084c89f17a9fbe8a05b2c2d58e0f5` |
| `src/d1-studio/app/d1-studio-app.tsx` | `1ec41047aae192de47e285a8c96f5d0c51b80478` |
| `src/d1-studio/app/console.tsx` | `8067a00417af11cf150311e91b33dfb7c0648caf` |

Run `git log --oneline 1a0a9230..HEAD -- <file>` and `git diff 1a0a9230 -- <file>` for each (or compare `git hash-object`). A file that differs needs its diff read against the "Does my change touch this?" list. Move this record forward (to the commit and blobs you checked) only after you have confirmed the model describes the code there and the runs match "Expected result".
