---
name: verify-d1-console
description: "Model-check D1 Studio's fullscreen console (src/d1-studio/app/console.tsx: useConsoleHistory's entries/active/pending/land/track, Console's sameAs/ran/letGo/pick, Main's key and effects) and reads that outlive their editor (useRunEffects' letGo in d1-studio-app.tsx) with TLA+, across inline/fullscreen switches. Use before and after any change to useConsoleHistory, Console, Main, History or Schema onPick, consoleReducer, useRunEffects, initialCard/cardReducer's run events, or Studio's display-mode switch."
---

# Verify the D1 Studio console

The design (the user's decision, like the dashboard's D1 Studio): a console
read the user leaves keeps going and lands in the history. Its rules live in
React state, effects and promises that tests rarely drive in the bad orders: a
read landing after its editor went, a pick landing while another read runs,
an entry opened mid-read, fullscreen left and re-entered. `model/Console.tla`
models those steps; TLC checks every order within the bounds below.
`replay/console.test.ts` replays each path on the real pure code.

## Does my change touch this?

Yes, if it changes any of these (coverage record below):

- `src/d1-studio/app/console.tsx`: `useConsoleHistory` (`entries`, `active`,
  `pending`, the `count` ref, `land` with its `latestFrom` guard, `track`
  with `startedAt`), `Entry` (`ranAt`, `latest`, `latestFrom`),
  `Console` (`sameAs`, `ran`, `letGo`, `pick`), `History`'s `open` and its
  pending list, `Main`'s `key`, its `useReducer` init (opening on `latest`),
  its `sentAt` ref, its onRan effect (`opened`, the `entry.latest` skip), its
  effect on `[entry.latest]` (dispatch `reread`), `consoleReducer`, `titleOf`.
- `src/d1-studio/app/d1-studio-app.tsx`: `Studio` (`useConsoleHistory` above
  the display switch), `useRunEffects` (the `mounted` ref effect declared
  before the run effect, `startedAt`, `letGo` on unmount, abort on an id
  change, no dispatch after unmount).
- `src/d1-studio/app/machines.ts`: `initialCard`, `compareOutcomes`, and
  `cardReducer`'s `submit`, `run.done`, `run.error`, `reread`.
- `src/mcp-apps/app-shell/mount.tsx`: `applyDisplayMode` (`data-display`).

Not covered: styling, the grid, paging, sorting, copy, the editor's layout,
the inline answer card's machine (`useAnswerCard`), writes sent to the chat.

## Coverage record

Confirmed at commit `1a0a9230b359b622a21c7a668b5110c57ab264a7`, which contains
the covered code. The blobs there (`git hash-object <file>`) are a second check:

| File | blob |
|---|---|
| src/d1-studio/app/console.tsx | 8067a00417af11cf150311e91b33dfb7c0648caf |
| src/d1-studio/app/d1-studio-app.tsx | 1ec41047aae192de47e285a8c96f5d0c51b80478 |
| src/d1-studio/app/machines.ts | 1b7e8dadf75d2b7497153b468a705f458e7097cd |
| src/mcp-apps/app-shell/mount.tsx | d9188fae061831d7dc414ab7ca1b7241436b6eb9 |

First compare: run `git log --oneline 1a0a9230..HEAD -- <files>` and
`git diff 1a0a9230 -- <files>` (or `git hash-object` on each file). If a file
differs, read the diff against the model before trusting a pass. Move the
record (commit and blobs) forward only after you have confirmed that the model
still describes the code at the new state.

## The rules

Each is an INVARIANT in `model/Console.tla`.

| Rule | Sentence | Harm when it breaks |
|---|---|---|
| ShowsTheRunThatLanded | After a run lands on screen (in the editor, or a pick that opens), the result on screen is that run's result. | Old rows labelled as just read. |
| ReReadStaysOnItsStep | An agent step read again here shows what D1 answered from then on (its `latest`), also when a read you left lands while you look at it. | The step says "ran here" over other rows. |
| NewestReReadWins | A step read again several times keeps the newest read (by when it was sent), whatever order they land in. | Older rows replace newer ones. |
| RunsStayInHistory | Every run the user did stays in the history while they're in the console. | A result vanishes. |
| RunsSurviveLeavingFullscreen | ...and after leaving fullscreen and coming back. | Leaving loses work. |
| OneEntryPerRun | No run becomes two entries. | Duplicated history. |
| LandsOnce | No read lands twice (a let-go read never also lands via the remounted Main). | Duplicates, a step marked twice. |
| LetGoMarksItsStep | A let-go re-read of an agent step marks that step (by id), not the one open when it lands. | The wrong step says "ran here". |
| PickIsNotIgnored | Picking a table runs its query, whatever else runs. | The click does nothing. |
| PickIsNotAborted | A pick's read is never thrown away (switching entries, leaving fullscreen). | Same. |
| PickLandsAsItsEntry | A pick's read lands as exactly one entry titled `<table>, first 100 rows`. | Missing or mislabelled rows. |
| PickOpensItsEntry | A pick that lands (in fullscreen) opens its entry. | The user doesn't see what they asked for. |
| ShownUnderItsOwnTitle | No entry shows one query's result under another's title. | Rows attributed to the wrong query. |
| NoRunLostOnSwitch / NoRunLostOnLeave | A read in flight is never lost silently when the user opens another entry / leaves fullscreen. | A read vanishes without result or error. |
| BackgroundLandingKeepsView | A read that lands in the background doesn't change what the user is looking at. | The screen jumps under the user. |
| NoStalePending / PendingClears | A pending item ("Run here", spinner) never outlives its read, and always goes once its read settles. | A spinner forever. |

PickIsNotSuperseded (a pick waiting replaced by a newer one) is gone with the
`ask` slot: each pick is its own read and lands as its own entry (replayed).
It was recorded as intended ("the last click wins") under the earlier design.

## Run it

1. Check the model with the pstack `/statechart` skill: spec
   `model/Console.tla`, config `model/Console.cfg`, view `model/view.mjs`,
   output to a new folder outside the repo. Read the result with `/statechart`:
   its report gives each broken rule's shortest path in plain words. About
   10 s, 59,302 states (under the 100,000 the command allows its re-runs, so
   every rule is checked; keep it under that when you change the model).
2. For the drawn chart, run `/statechart` with `model/Chart.cfg` and view
   `model/chart-view.mjs` (one table, two reads, and `DrawBound`; 424 states, 11 states, 28 arrows).
   Use `Console.cfg` for verdicts. `chart-view.mjs` hides: opening another
   entry when no read runs in the editor, leaving fullscreen from anything but
   an idle agent step or a running read, background failures (a toast), a pick
   while another read goes on, and running from a non-agent state with a read
   in the background. `view.mjs` hides nothing (a hidden step on a bug path is
   an error). Both take their words from `model/labels.mjs`.
3. Replay on the real code: `bun test ./.agents/skills/verify-d1-console/replay/console.test.ts`
   (the leading `./` is needed; under 1 s; 11 tests).

### Expected result at the sync point

`Console.cfg`: every rule holds (59,302 states).

Was a finding until the `reread` fix (both forms replayed as holding now):
ReReadStaysOnItsStep — run the agent's SQL unchanged, leave fullscreen (the
read is let go), come back to the step, the read lands: Main is keyed on the
id, so only its effect on `[entry.latest]` (dispatch `reread`) brings the rows
on screen; and an older let-go re-read landing after a newer one used to
overwrite `latest` — `land`'s `latestFrom` guard skips it. The reread doesn't
come back through onRan (`shown.outcome === entry.latest`; the replay counts
onRan calls). The model takes the reread as part of the landing step.

The replay has `holds …` tests for every rule (the former findings first)
and two first tests checking that every transcribed line of `console.tsx` and
`d1-studio-app.tsx` is still there word for word.

## Reading a result

- A new break, or an expected one gone: replay it with one call per step. If
  the real code does not do it, suspect the model first (a step that isn't
  atomic in the code, an effect order, which closure a callback reads).
- A rule that holds suspiciously: check its step is reachable. TLA+ silently
  disables an action that assigns one primed variable twice with different
  values. TLC names a step `Next` when its `\E` ranges over a variable; the
  model quantifies over constant ranges (`BgLands(n)`) for that reason.
- The transcription test fails: re-read the changed lines, update
  `StudioSim`/`ConsoleSim` and the line lists, then `Console.tla`.
- A fix that makes a broken rule hold: flip its replays into `holds …` tests,
  add a variant restoring the old line, update "Expected result", and move
  the coverage record.
- Never weaken a rule to make it pass. Drop or reword one only on the user's word.

## Able to fail

No rule fails on the code. Every rule was seen to fail on a variant: the `Broken` constant (a set) in `model/Broken-<name>.cfg`, which
lists the rules that hold on the code. Run it with `/statechart` like step 1.

| Config | Mirrors | Breaks |
|---|---|---|
| Broken-abortOnUnmount | the old useRunEffects: the cleanup always aborts (also: the `mounted` effect declared after the run effect) | NoRunLostOnSwitch, NoRunLostOnLeave |
| Broken-pickThroughMain | the old pick: Main's `run.sql`, refused while busy, landing through `ran()` | PickIsNotIgnored, PickLandsAsItsEntry |
| Broken-oldPick | that and abortOnUnmount | PickIsNotAborted (and the above) |
| Broken-letGoWhenMounted | cleanup `if (letGo) letGo(…)` without `!mounted.current &&` | LandsOnce, OneEntryPerRun |
| Broken-sameAsAtLanding | sameAs taken from the entry open when the read lands | LetGoMarksItsStep |
| Broken-pickNoOpen | pick's `track` without `open: true` | PickOpensItsEntry |
| Broken-bgOpens | letGo's `track` with `open: true` | BackgroundLandingKeepsView |
| Broken-keepPending | track's reject branch without `done()` | PendingClears |
| Broken-keepPendingOnLand | track's resolve branch without `done()` | NoStalePending |
| Broken-historyInConsole | the history as state inside `Console` | RunsSurviveLeavingFullscreen |
| Broken-oldKeyNoLatest | key `${entry.id}:${entry.ranAt}` and land() without `latest` | ShowsTheRunThatLanded |
| Broken-noWhoGuard | sameAs without `entry.who === 'agent' &&` | RunsStayInHistory |
| Broken-letGoEntryTitle | letGo's title `entry.query.title` always | ShownUnderItsOwnTitle |
| Broken-noReread | Main without the effect on `[entry.latest]` | ReReadStaysOnItsStep |
| Broken-noLatestFrom | land() without `!(e.latestFrom !== undefined && startedAt < e.latestFrom)` | NewestReReadWins, ShowsTheRunThatLanded |

On the real code, dropping the `latestFrom` guard in a copy of console.tsx
(pointed at with `D1_CONSOLE_SRC=<copy>`; `D1_STUDIO_SRC` for
d1-studio-app.tsx) fails the transcription test.

## Model and bounds

- `Console.cfg`: one table, at most 3 reads in the whole behaviour, any number
  of fullscreen visits; agent history: one step and the answer. PendingClears
  ("a pending item always goes") is checked as the invariant that every item
  in `pending` can still settle (its read is unsettled, so BgLands/BgFails is
  enabled): with promises that settle, each goes. (`FairSpec` states the
  liveness form; /statechart can't draw its stuttering counterexample.)
- One step = one event and React's commit: a landing in Main runs run.done,
  the onRan effect, `land()` and the remount its `setActive` causes; an
  unmount runs the `mounted` cleanup, then the run effect's (declaration
  order), which calls `letGo` → `track`. `letGo` and `sameAs` close over the
  entry of the render that started the read (Main is keyed on that id).
  `startedAt`/`sentAt` are the read's rid (rids follow send order; the code's
  `Date.now()` can tie only for reads sent in the same millisecond, which one
  step can't do). A background landing on the step Main shows includes
  Main's `reread` in the same step.
- A result is the read that produced it plus its SQL; agent results are read 0.
- Left out: a promise that never settles (`runRead` now fails a read after
  `READ_TIMEOUT_MS`, 35 s, so a console read settles anyway), the inline card's own runs,
  picture-in-picture, the draft beyond "the entry's SQL" or "your own SQL",
  the "fixed in" link (same as opening an entry), a new tool result into the
  same Studio, paging, sorting, copy, focus, and the model context update.
