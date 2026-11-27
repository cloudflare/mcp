---
name: verify-d1-copy
description: "Model-check the D1 Studio copy feedback (the one global copy toast, the trios' ✓ marks, Copy all, Copy SQL) with TLA+ and replay its counterexamples against the real code. Use when a change touches src/d1-studio/app/copy.tsx, copyReducer/CopyState in src/d1-studio/app/machines.ts, or Trio, CopySql or RunButton's Copy SQL path in src/d1-studio/app/d1-studio-app.tsx, or how readRest reads rows for Copy all."
---

# Verify the D1 Studio copy feedback

One toast (`current` in `copy.tsx`) serves every trio on the page: the answer
card, each step, the console. Copy all reads rows from D1 and writes them
later through a ClipboardItem that holds a promise. So copies overlap, and
tests rarely reach the order in which they finish. `model/D1Copy.tla` checks
every order of clicks, clipboard answers, D1 answers and timers, within the
bounds below. `replay/copy.test.ts` runs the paths the model found against the
real code.

## The rules

Every rule holds in the main, holds-4 and slow-host configs.

| Rule (TLA+ name) | Plain sentence |
|---|---|
| `ClipboardHoldsLastCopy` | Once every copy has finished, the clipboard holds the last copy that worked. |
| `ToastDescribesLatestCopy` | The toast never describes a copy older than one that has already finished. |
| `CheckOnlyOnCompletedCopy` | A ✓ shows only on a trio and format whose copy was written. |
| `NoCheckDuringCopyAll` | No trio shows a ✓ while a Copy all that can still write or show a toast is running. A superseded one (`Doomed`) can do neither. |
| `NoCheckOnTrioWhileItReads` | From useCopyToast's comment: no ✓ on a trio while its own live Copy all still reads. |
| `NoCheckAfterFailure` | When the user's latest copy failed, no trio shows a ✓. |
| `BlockedIsReported` | Every copy that fails is reported in the same step, except a superseded Copy all, which failed because it gave up and not because the clipboard is blocked. |
| `BlockedNeverShownCopied` | A failed copy is never shown as copied (toast, trio ✓, Copy SQL "Copied"). |
| `CopyAllMarksItsFormat` | From Trio's comment: once a Copy all that is still the latest copy has written, its trio marks its format. |
| `ReadingToastEnds` (liveness) | The "Reading rows…" toast always ends. It holds only because of the view's 35 s read timeout, `READ_TIMEOUT_MS` in run.ts (see below). |

Three rules are narrower than their first wording. Each was checked against the code:
- **`NoCheckDuringCopyAll` and `NoCheckOnTrioWhileItReads`** count only a live Copy all. The wider version (any Copy all not yet settled) breaks in 5 steps with a harmless ✓: a newer copy lands while the superseded Copy all's read is still out, and that Copy all can no longer write.
- **`CopyAllMarksItsFormat`** applies only to the latest copy. The wider version breaks with a slow host: the Copy all's text was ready before a newer click, so its write lands, but it is silent by design because the newer copy will speak.
- **`BlockedIsReported`** is wider again since `said`. Only the superseded Copy all is excluded. It relies on the sandbox's policy being fixed for a run.

History of findings, all fixed now. Each variant in "Proof each rule can fail" restores the old line and breaks again.
- **First sync** (no `latest`): a slow Copy all overwrote a later copy and toasted "Copied all". A ✓ showed during Copy all, and beside "D1 didn’t read the rest".
- **After `latest`/`isLatest`**, with a slow host:
  - (A) An older copy landed after a failed Copy all, and the Trio still dispatched `'copied'`. Its ✓ came back once the failure toast hid.
  - (B) A silent older copy left an even older toast up ("…as CSV" while the clipboard held JSON).
- **Fixed by `said`/`speaks`:** a copy speaks when it lands unless a newer copy already spoke, and a silent copy returns `undefined`, so its Trio or CopySql does not dispatch.

"Reading rows…" ends only because of the view's read timeout. `copy.tsx` itself has no timeout or abort. A `readRest` that never settles leaves the busy toast up and hides every ✓, unless a newer copy replaces it (replayed). What ends it is `READ_TIMEOUT_MS` (35 s) in `src/d1-studio/app/run.ts`: `readRest` → `readRows` → `readSlice` → `runRead`, which passes `{ signal, timeout: READ_TIMEOUT_MS }` to `App.callServerTool` (ext-apps adds `resetTimeoutOnProgress: true`), so `Protocol.request` in `@modelcontextprotocol/client` rejects after 35 s. `runRead` turns that into "No answer from D1 in 35 s.", and the toast becomes "D1 didn’t read the rest: No answer from D1 in 35 s.". The rule breaks without that timeout (`mutants/noSdkTimeout.cfg`), and in real use when a host keeps sending progress notifications, which the model leaves out.

## Does a change touch this?

It does if it touches any of these:
- `src/d1-studio/app/copy.tsx`: `show`, `toast`, `write`, `copyText`, `copyRows` (and `all` inside it), `useCopyToast`, `CopyToastHost`.
- `src/d1-studio/app/machines.ts`: `copyReducer`, `CopyState`, `CopyEvent`.
- `src/d1-studio/app/d1-studio-app.tsx`: `Trio` (its `useReducer(copyReducer)`, the reset effect, `mine`/`marked`), `CopySql`, the Copy SQL branch of `RunButton`, `COPY_FEEDBACK_MS`.
- How `readRest` is built (`d1-studio-app.tsx` and `console.tsx`), and `readRows` / `readSlice` / `runRead` / `READ_TIMEOUT_MS` in `src/d1-studio/app/run.ts`, if it adds or removes a timeout or signal.
- A bump of `@modelcontextprotocol/client` or `@modelcontextprotocol/ext-apps` that changes how a request's `timeout` option is honored.

## Run it

Read every result with the `/statechart` skill. Run it from the repo root on `.agents/skills/verify-d1-copy/model/D1Copy.tla` with the view `model/view.mjs`, once for each config, each with its own new output folder:

| Config | What it checks | Expected at the sync commit |
|---|---|---|
| `model/D1Copy.cfg` | Every rule. 2 trios, 2 formats, Copy SQL, 3 sandboxes, 3 copies. About 10,500 states, under 15 s. | Every rule holds, including `NoDeadlock` and `ReadingToastEnds`. |
| `model/holds-4.cfg` | Every rule, with 4 copies (about 104,000 states). | All hold. |
| `model/slow-host.cfg` | The same as D1Copy.cfg, but the host may answer a ready write after your next click (about 16,500 states). | All hold. |
| `model/chart.cfg` | One trio, CSV, open sandbox, no Copy SQL (84 states), for the chart. | All hold. The chart has 8 states and 15 arrows. |
| `model/mutants/*.cfg` | Broken variants. Each must break its rule (see "Proof each rule can fail"). | See the table below. |

Then replay against the real code (about 1 s):

```sh
bun test ./.agents/skills/verify-d1-copy/replay/copy.test.ts
```

All 9 tests pass at the sync commit. The one `reproduces` test asserts that `copy.tsx` alone never ends "Reading rows…" (only `runRead`'s 35 s `READ_TIMEOUT_MS` does). The `holds` tests replay the former findings and assert the fixed behavior. To run the replay against a scratch copy, copy `src/d1-studio` and `src/mcp-apps` into `<dir>/src/`, symlink `<dir>/node_modules` to the repo's, and set `D1_COPY_SRC=<dir>/src/d1-studio`. Never edit `src/` to try a break.

## Real bug or modeling error?

When a rule breaks on a path that is not listed above, replay it before you report it. Add a test to `replay/copy.test.ts` that makes one harness call per model step: `trio(...).click`, `host.writes(k)`, `host.refuses(k)`, `host.itemRejects(k)`, `toastNow().action.run()`, `d1.answer()`, `d1.fail()`, `advance(ms)`. Write call `k` is the k-th `navigator.clipboard.write` call. A fallback (`writeText` or `execCommand`) makes no new write call. If the real code does not do what the model did, the model is wrong. Check the step's map entry below, the atomicity (one model step is one JavaScript task with all its microtasks), and the assumptions.

When a `reproduces` test starts to fail, the code changed the behavior. Either the bug is fixed (rerun the model, then move the rule to holds in the table above and turn the test into a `holds` test), or the replay drifted from the code.

## Model to code

| Model | Code |
|---|---|
| `toast` | `current` in copy.tsx. `kind` "busy" is `busy: true`, "copied" is a toast with `done`, "copiedSql" is copyText's success toast, "failed" is `failed: true`. |
| `Show` | `show()`. A non-busy toast hides after 4 s, or 6 s with an offer (`ToastHides`). A busy one never hides. |
| `local[t]` | Trio's `useReducer(copyReducer)`. `TrioResets` is the effect's timer, which fires `COPY_FEEDBACK_MS` after the last dispatch. |
| `Mark(t)` | Trio's `marked`: `t?.busy \|\| t?.failed ? null : mine ? t.done.format : state.status === 'copied' ? state.format : null` |
| `n`, `IsLatest(i)` | copy.tsx's `latest`. `start()` runs at the start of every copyText, copyRows and `all()`, so copy `n` is the latest. |
| `said`, `Speaks(i)` | copy.tsx's `said` and `speaks(copy)`: a copy speaks unless `copy < said`, and speaking sets `said = copy`. `YouCopyAll` speaks as "Reading rows…" shows. At its end, all() speaks only if `isLatest(copyAll) && speaks(copyAll)`. |
| `SilentDispatch` | A silent copyRows/copyText returns `undefined`. Trio (`ok !== undefined && dispatch(...)`), CopySql and RunButton's Copy SQL then do nothing. |
| `Doomed(i)` | A Copy all that is no longer the latest and is still reading (it will throw `Superseded` at its next `isLatest` check), or whose text already failed. It will write nothing and show nothing. |
| `quiet` | The trios (and "sql") whose ✓ timer was started by a silent copy after the toast's last `show()`. Their timer may outlive the toast. |
| `sqlLocal` | CopySql's `useState`. RunButton's Copy SQL has the same shape. |
| `YouCopyRows` | A trio segment's `onClick`: `copyRows` → `write(Promise.resolve(...))` → `navigator.clipboard.write`. |
| `YouCopyAll` | The toast action `all()`: `show(busy)`, the `readRest` loop, and `write(text)` called at once. |
| `YouCopySql` | `CopySql` / `RunButton` / the editor's ⌘↵ in Copy-SQL mode → `copyText`. |
| `D1Answers` / `D1Fails` / `D1Hangs` / `SdkTimesOut` | `readRest` (`readRows` → `app.callServerTool`) resolves, rejects, never answers, or is rejected by the 35 s request timeout `runRead` gives `callServerTool` (`READ_TIMEOUT_MS`). When `D1Answers` lands on a superseded Copy all, the loop's `isLatest` check throws `Superseded`, in the same task, so `read` becomes "failed". |
| `HostWrites` | `navigator.clipboard.write` resolves after the item's text resolved. Then `write()` returns true and its continuation runs: copyRows' `.then`, or all()'s `.then`, and the Trio's dispatch. |
| `HostRefuses` → `FallbackCopies` / `FallbackFails` | `write()`'s catch: `writeText`, then the textarea with `execCommand('copy')`. |
| `ItemRejects` | The item's text rejected (D1 failed), so `write` rejects, `text.catch` gives `undefined`, and `write()` returns false. |
| `Settle` | The continuation that each finished write runs in the same task. |

### Assumptions and what the model leaves out

- The host answers clipboard calls whose text is ready in the order the copies started (`FirstInLine`). It answers an item whose text is still pending (Copy all) when that text settles. `SlowHost = FALSE` adds that the host answers a ready write before your next click. `slow-host.cfg` drops that assumption.
- The sandbox's policy is fixed for a run: `open`, `noWrite` (write is refused, the fallbacks work), or `closed`. For Copy all in `noWrite`, the fallback may fail, because the click's activation may have lapsed.
- A ✓ timer (2.5 s) that started no later than the toast's `show()` (4 s, or 6 s) fires first, so `ToastHides` waits for it. A ✓ timer that a silent older copy started later (`quiet`) may outlive the toast. Other timings are free: D1 can answer at any moment.
- Copy all reads one block, so its `isLatest` checks are the one before the first read (always the latest at the click) and the one after the last read, before serializing.
- Every trio holds fewer rows than D1's count, so its toast offers Copy all. It is contiguous, with at most COPY_CAP rows and a `readRest`. Later blocks are sequential awaits, each after another `isLatest` check, and add no new order. The model leaves out "Export in D1 Studio ↗", `inside` (where the toast is placed), the row contents, and React rendering delays.
- `ReadingToastEnds` assumes fairness: the host answers, timers fire, and D1 answers, fails or hangs. The user need not act. It also assumes the host sends no endless progress notifications.
- Bounds: 3 copies (4 for `holds-4.cfg`), 2 trios, 2 formats, one Copy SQL button. A pass covers only these bounds.

## Proof each rule can fail

Each broken variant sets `Mutation` (or `SdkTimeout`) to mirror a one-line code change. Each was run, and each broke exactly these rules:

| Config | Mirrors this code change | Rules it breaks |
|---|---|---|
| `mutants/noSupersede.cfg` | all(): no `if (!isLatest(copyAll)) throw new Superseded()` | `ClipboardHoldsLastCopy`, `NoCheckDuringCopyAll`, `NoCheckOnTrioWhileItReads` |
| `mutants/noLatestCheckAll.cfg` | all()'s end: `if (!speaks(copyAll)) return`, without `isLatest` | `NoCheckDuringCopyAll`, `NoCheckOnTrioWhileItReads` |
| `mutants/trioMarksBesideFailed.cfg` | Trio: `const marked = t?.busy ? null : ...` | `NoCheckAfterFailure` |
| `mutants/slowHost-latestNotSpeaks.cfg` | copyRows/copyText: `if (!isLatest(copy)) return ...` in place of `speaks` (old B) | `ToastDescribesLatestCopy`, `BlockedIsReported` |
| `mutants/slowHost-silentStillDispatches.cfg` | copyRows/copyText: a silent copy `return ok` in place of `undefined`, so Trio dispatches (old A) | `NoCheckAfterFailure` |
| `mutants/slowHost-allNoSpeakAtStart.cfg` | all(): no `speaks(copyAll)` as "Reading rows…" shows | `NoCheckDuringCopyAll`, `NoCheckOnTrioWhileItReads` |
| `mutants/trioDispatchesCopiedAlways.cfg` | Trio: `dispatch({ type: 'copied', ... })` whatever `ok` is | `BlockedNeverShownCopied` |
| `mutants/copyRowsNoBlockedToast.cfg` | copyRows: `if (!ok) return false`, without the blocked `show` | `BlockedIsReported`, `ToastDescribesLatestCopy` |
| `mutants/copyAllNoDone.cfg` | all(): the "Copied all" `show` without `done` | `CopyAllMarksItsFormat` |
| `mutants/copyTextAlwaysSaysCopied.cfg` | copyText: `if (ok \|\| !ok) toast(words, from)` | `BlockedIsReported`, `BlockedNeverShownCopied` |
| `mutants/noSdkTimeout.cfg` | No request timeout on the read: `runRead` without `timeout: READ_TIMEOUT_MS` (and the SDK's own 60 s default gone too) | `ReadingToastEnds`, `NoDeadlock` |

`CheckOnlyOnCompletedCopy` has no variant that breaks it now. The `t?.failed` check in `marked` hides the ✓ that `trioDispatchesCopiedAlways` leaves, so only `BlockedNeverShownCopied` catches that variant.

Scratch edits on a copy of `src/d1-studio` in /tmp, run with `D1_COPY_SRC`, were caught by the replay:
- copyText always says copied.
- `marked` without `t?.failed`.
- copyRows `if (!speaks(copy)) return ok`: the old-A `holds` test failed.

## When the code changes on purpose

Mirror the change in `D1Copy.tla`, one action for each JavaScript task, and give each new step a label in `view.mjs`. Never weaken a rule to make it pass. A rule that breaks is a finding to report. Rerun every config and the replay. When a fix lands, add a broken variant that undoes it, so that the rule still has a check that is seen to fail.

## Coverage record

Last confirmed that the model and the replay describe the code at: **commit `1a0a9230b359b622a21c7a668b5110c57ab264a7`**, which contains the covered code (after the `said`/`speaks` fix and the 35 s read timeout). The blobs there (`git hash-object`) are a second check:

| File | Covers | Blob |
|---|---|---|
| `src/d1-studio/app/copy.tsx` | `latest`, `start`, `isLatest`, `said`, `speaks`, `Superseded`, `show`, `toast`, `write`, `copyText`, `copyRows`/`all`, `useCopyToast`, `CopyToastHost` | `98d3f9c8e92d0874b2a1cb2bb412e68df6c79a48` |
| `src/d1-studio/app/machines.ts` | `copyReducer`, `CopyState`, `CopyEvent` (the rest of the file is not covered and changes often) | `1b7e8dadf75d2b7497153b468a705f458e7097cd` |
| `src/d1-studio/app/d1-studio-app.tsx` | `Trio`, `CopySql`, `RunButton` Copy SQL, the editor's ⌘↵ `copyText`, `COPY_FEEDBACK_MS`, `readRest` | `1ec41047aae192de47e285a8c96f5d0c51b80478` |
| `src/d1-studio/app/run.ts` | `readRows` → `readSlice` → `runRead` (`READ_TIMEOUT_MS` = 35 s, passed as `timeout` to `callServerTool`; no signal from Copy all) | `6b93f137a34084c89f17a9fbe8a05b2c2d58e0f5` |
| `node_modules/@modelcontextprotocol/client` 2.3.1, `@modelcontextprotocol/ext-apps` 2.0.4 | `Protocol.request` honors the `timeout` option (`DEFAULT_REQUEST_TIMEOUT_MSEC = 6e4` only when none is given); `App.callServerTool` adds `resetTimeoutOnProgress: true` | (package versions) |

Before you trust a result, compare: run `git log --oneline 1a0a9230..HEAD -- <file>` and `git diff 1a0a9230 -- <file>` for each file above (or `git hash-object`). Other parts of machines.ts and d1-studio-app.tsx change for other reasons. When a file differs, diff only the covered functions against the map above. Move this record forward (the new commit and blobs) only after you confirm that the model and the replay describe the code at the new commit.
