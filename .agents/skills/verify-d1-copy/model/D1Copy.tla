---------------------------- MODULE D1Copy ----------------------------
(***************************************************************************)
(* The D1 Studio copy feedback: the one global toast in                    *)
(* src/d1-studio/app/copy.tsx, the trios' ✓ marks (Trio in                 *)
(* src/d1-studio/app/d1-studio-app.tsx with copyReducer from machines.ts), *)
(* and CopySql. Several trios share the one toast.                         *)
(*                                                                         *)
(* One step = one JavaScript task: the click handler, or the host's /      *)
(* D1's reply plus every microtask it runs (write()'s await, copyRows's    *)
(* .then, the Trio's .then dispatch). Nothing else runs inside a task.     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Trios,      \* the trios on the page (answer card, steps, console)
  Formats,    \* CopyFormat values the model clicks
  MaxCopies,  \* bound on copies the user starts (trio clicks, Copy all, Copy SQL)
  SlowHost,   \* FALSE: the host answers a write whose text is ready before your next click
  SdkTimeout, \* TRUE: the 35 s request timeout runRead gives callServerTool rejects a silent read
  WithSql,    \* TRUE: a Copy SQL button (CopySql / the Run button's Copy SQL) is on the page
  Sandboxes,  \* the host clipboard policies to try (see sandbox below)
  Mutation    \* "none", or the name of a one-line code change (see SKILL.md)

None == "none"
Ids == 1..MaxCopies

VARIABLES
  n,        \* copies started; copy n is the user's latest
  cp,       \* cp[i]: copy i (kind, src, fmt, read, write)
  clip,     \* the copy whose text the clipboard holds (0: none of ours)
  toast,    \* `current` in copy.tsx: [kind |-> none|busy|copied|failed, of |-> copy id]
  local,    \* each Trio's useReducer(copyReducer) state
  sqlLocal, \* CopySql's useState: idle|copied|blocked
  just,     \* the copy whose write settled in the last step (0: none)
  sandbox,  \* the host's clipboard policy, fixed for the run
  quiet,    \* trios (and "sql") whose ✓ timer started after the toast's last show()
  said      \* copy.tsx's `said`: the newest copy whose result the toast has said

vars == <<n, cp, clip, toast, local, sqlLocal, just, sandbox, quiet, said>>

\* "open": navigator.clipboard.write works. "noWrite": write is refused, the
\* fallbacks (writeText, execCommand) work for text that is ready at once.
\* "closed": everything is refused.
ASSUME Sandboxes \subseteq {"open", "noWrite", "closed"}

NoCopy == [kind |-> None, src |-> None, fmt |-> None, read |-> None, write |-> None]

Init ==
  /\ n = 0
  /\ cp = [i \in Ids |-> NoCopy]
  /\ clip = 0
  /\ toast = [kind |-> None, of |-> 0]
  /\ local = [t \in Trios |-> [st |-> "idle", fmt |-> None]]
  /\ sqlLocal = "idle"
  /\ just = 0
  /\ sandbox \in Sandboxes
  /\ quiet = {}
  /\ said = 0

\* --- helpers -------------------------------------------------------------
Started(i)  == i \in 1..n
Settled(i)  == cp[i].write \in {"written", "failed"}
Written(i)  == cp[i].write = "written"
\* The text handed to the ClipboardItem has resolved.
Ready(i)    == cp[i].kind # "all" \/ cp[i].read = "ok"
TextFailed(i) == cp[i].kind = "all" /\ cp[i].read = "failed"
InFlightAll(i) == Started(i) /\ cp[i].kind = "all" /\ ~Settled(i)
\* copy.tsx's `latest`: every copyText, copyRows and all() calls start(), so copy n is the latest.
IsLatest(i) == i = n
\* all() throws Superseded into its text at its next isLatest check (after a block read):
\* a superseded Copy all still reading will write nothing and show nothing.
SupersedeChecks == Mutation # "noSupersede"
\* Once its text has failed it writes nothing either, and its toast is skipped (isLatest).
Doomed(i) ==
  /\ ~IsLatest(i)
  /\ \/ SupersedeChecks /\ cp[i].read \in {"reading", "hung"}
     \/ cp[i].read = "failed" /\ Mutation # "noLatestCheckAll"
\* A Copy all that can still write the clipboard or show a toast.
LiveAll(i) == InFlightAll(i) /\ ~Doomed(i)

\* Trio's `marked`: t?.busy || t?.failed ? null : mine ? t.done.format : state.status === 'copied' ? state.format : null
HasDone == toast.kind = "copied" /\ cp[toast.of].kind \in {"rows", "all"}
NoMarkBeside == IF Mutation = "trioMarksBesideFailed" THEN {"busy"} ELSE {"busy", "failed"}
Mark(t) ==
  IF toast.kind \in NoMarkBeside THEN None
  ELSE IF HasDone /\ cp[toast.of].src = t THEN cp[toast.of].fmt
  ELSE IF local[t].st = "copied" THEN local[t].fmt
  ELSE None

Show(kind, i) == toast' = [kind |-> kind, of |-> i] /\ quiet' = {}
\* speaks(copy): a copy speaks when it lands unless a newer copy already spoke.
\* Mutation "latestNotSpeaks" restores the old `if (!isLatest(copy)) return ok`.
Speaks(i) == IF Mutation = "latestNotSpeaks" THEN IsLatest(i) ELSE i >= said
\* A silent copyRows/copyText returns undefined, so its Trio / CopySql does not dispatch.
\* Mutation "silentStillDispatches" restores the old `return ok` (the Trio then dispatches).
SilentDispatch(i, ok) ==
  IF Mutation = "silentStillDispatches" THEN
    /\ quiet' = quiet \cup {cp[i].src}
    /\ IF cp[i].kind = "rows"
       THEN local' = [local EXCEPT ![cp[i].src] = [st |-> IF ok THEN "copied" ELSE "blocked", fmt |-> cp[i].fmt]]
            /\ UNCHANGED sqlLocal
       ELSE sqlLocal' = (IF ok THEN "copied" ELSE "blocked") /\ UNCHANGED local
  ELSE UNCHANGED <<quiet, local, sqlLocal>>

\* write() settled with `ok`; its continuation runs in the same task.
Settle(i, ok) ==
  /\ cp' = [cp EXCEPT ![i].write = IF ok THEN "written" ELSE "failed"]
  /\ just' = i
  /\ CASE cp[i].kind \in {"rows", "sql"} /\ ~Speaks(i) ->
          UNCHANGED <<toast, said>> /\ SilentDispatch(i, ok)
       [] cp[i].kind = "rows" ->
          /\ said' = i
          \* copyRows .then: blocked toast, or "Copied the first N of M rows" (done, Copy all offer)
          /\ IF ok THEN Show("copied", i)
             ELSE IF Mutation = "copyRowsNoBlockedToast" THEN UNCHANGED <<toast, quiet>>
             ELSE Show("failed", i)
          \* Trio: .then((ok) => ok !== undefined && dispatch({ type: ok ? 'copied' : 'blocked', ... }))
          /\ local' = [local EXCEPT ![cp[i].src] =
               [st |-> IF ok \/ Mutation = "trioDispatchesCopiedAlways" THEN "copied" ELSE "blocked",
                fmt |-> cp[i].fmt]]
          /\ UNCHANGED sqlLocal
       [] cp[i].kind = "sql" ->
          /\ said' = i
          \* copyText: toast(words) or toast('The host blocked the clipboard'); CopySql setState
          /\ Show(IF ok \/ Mutation = "copyTextAlwaysSaysCopied" THEN "copiedSql" ELSE "failed", i)
          /\ sqlLocal' = IF ok THEN "copied" ELSE "blocked"
          /\ UNCHANGED local
       [] cp[i].kind = "all" ->
          \* all(): if (!isLatest(copyAll) || !speaks(copyAll)) return
          /\ IF ~((IsLatest(i) \/ Mutation = "noLatestCheckAll") /\ i >= said)
             THEN UNCHANGED <<toast, quiet, said>>
             ELSE /\ said' = i
                  \* D1 didn't read the rest / blocked / "Copied all N rows" (done)
                  /\ IF TextFailed(i) THEN Show("failed", i)
                     ELSE IF ~ok THEN Show("failed", i)
                     ELSE IF Mutation = "copyAllNoDone" THEN Show("copiedNoDone", i)
                     ELSE Show("copied", i)
          /\ UNCHANGED <<local, sqlLocal>>

\* No clipboard call whose text is ready is still waiting for the host.
HostCaughtUp == \A i \in 1..n : ~(cp[i].write \in {"asked", "refused"} /\ Ready(i))

NewCopy(kind, src, fmt, read) ==
  /\ SlowHost \/ HostCaughtUp
  /\ n < MaxCopies
  /\ n' = n + 1
  /\ cp' = [cp EXCEPT ![n + 1] =
       [kind |-> kind, src |-> src, fmt |-> fmt, read |-> read, write |-> "asked"]]

\* --- the user ------------------------------------------------------------
\* A trio segment's onClick: copyRows -> write(Promise.resolve(rows)) -> navigator.clipboard.write.
\* Every trio holds fewer rows than D1's count, so its toast offers "Copy all".
YouCopyRows(t, f) ==
  /\ NewCopy("rows", t, f, None)
  /\ UNCHANGED <<clip, toast, local, sqlLocal, sandbox, quiet, said>> /\ just' = 0

\* The toast's "Copy all N": show(busy); text = reads; write(text) at once.
YouCopyAll ==
  /\ toast.kind = "copied" /\ cp[toast.of].kind = "rows"
  /\ NewCopy("all", cp[toast.of].src, cp[toast.of].fmt, "reading")
  /\ Show("busy", n + 1)
  \* speaks(copyAll) as its "Reading rows…" shows (Mutation "allNoSpeakAtStart" drops it)
  /\ said' = IF Mutation = "allNoSpeakAtStart" THEN said ELSE n + 1
  /\ UNCHANGED <<clip, local, sqlLocal, sandbox>> /\ quiet' = {} /\ just' = 0

\* CopySql (and the Run button's Copy SQL path): copyText -> write(Promise.resolve(sql)).
YouCopySql ==
  /\ WithSql
  /\ NewCopy("sql", "sql", "sql", None)
  /\ UNCHANGED <<clip, toast, local, sqlLocal, sandbox, quiet, said>> /\ just' = 0

\* --- D1 (readRest -> readRows -> app.callServerTool), one block ----------
\* The loop's continuation runs in the same task: isLatest(copyAll), or throw Superseded.
D1Answers(i) ==
  /\ Started(i) /\ cp[i].read = "reading"
  /\ cp' = [cp EXCEPT ![i].read = IF SupersedeChecks /\ ~IsLatest(i) THEN "failed" ELSE "ok"]
  /\ UNCHANGED <<n, clip, toast, local, sqlLocal, sandbox, quiet, said>> /\ just' = 0

D1Fails(i) ==
  /\ Started(i) /\ cp[i].read = "reading"
  /\ cp' = [cp EXCEPT ![i].read = "failed"]
  /\ UNCHANGED <<n, clip, toast, local, sqlLocal, sandbox, quiet, said>> /\ just' = 0

\* The read never answers (a host that drops the call).
D1Hangs(i) ==
  /\ Started(i) /\ cp[i].read = "reading"
  /\ cp' = [cp EXCEPT ![i].read = "hung"]
  /\ UNCHANGED <<n, clip, toast, local, sqlLocal, sandbox, quiet, said>> /\ just' = 0

\* run.ts runRead: callServerTool(..., { signal, timeout: READ_TIMEOUT_MS }) (35 s); @modelcontextprotocol/client
\* Protocol.request rejects "Request timed out", which runRead rethrows as "No answer from D1 in 35 s.".
SdkTimesOut(i) ==
  /\ SdkTimeout
  /\ Started(i) /\ cp[i].read \in {"reading", "hung"}
  /\ cp' = [cp EXCEPT ![i].read = "failed"]
  /\ UNCHANGED <<n, clip, toast, local, sqlLocal, sandbox, quiet, said>> /\ just' = 0

\* --- the host's clipboard --------------------------------------------------
\* Assumption: the host answers clipboard calls whose text is ready in the
\* order the copies started; an item whose text is still on its way (Copy all)
\* is answered once that text settles.
FirstInLine(i) ==
  \A j \in 1..(i - 1) : ~(cp[j].write \in {"asked", "refused"} /\ Ready(j))

HostWrites(i) ==
  /\ sandbox = "open"
  /\ Started(i) /\ cp[i].write = "asked" /\ Ready(i) /\ FirstInLine(i)
  /\ clip' = i
  /\ Settle(i, TRUE)
  /\ UNCHANGED <<n, sandbox>>

\* The sandbox refuses navigator.clipboard.write: write() falls back.
HostRefuses(i) ==
  /\ sandbox # "open"
  /\ Started(i) /\ cp[i].write = "asked" /\ FirstInLine(i)
  /\ cp' = [cp EXCEPT ![i].write = "refused"]
  /\ UNCHANGED <<n, clip, toast, local, sqlLocal, sandbox, quiet, said>> /\ just' = 0

\* The ClipboardItem's text rejected (D1 failed): write rejects, text.catch -> undefined -> false.
ItemRejects(i) ==
  /\ Started(i) /\ cp[i].write = "asked" /\ TextFailed(i)
  /\ Settle(i, FALSE)
  /\ UNCHANGED <<n, clip, sandbox>>

\* After a refusal: writeText, then the textarea + execCommand('copy').
\* For Copy all the click's activation may have lapsed by then, so it may fail.
FallbackCopies(i) ==
  /\ sandbox = "noWrite"
  /\ Started(i) /\ cp[i].write = "refused" /\ Ready(i) /\ FirstInLine(i)
  /\ clip' = i
  /\ Settle(i, TRUE)
  /\ UNCHANGED <<n, sandbox>>

FallbackFails(i) ==
  /\ Started(i) /\ cp[i].write = "refused"
  /\ \/ TextFailed(i)
     \/ Ready(i) /\ FirstInLine(i) /\ (sandbox = "closed" \/ cp[i].kind = "all")
  /\ Settle(i, FALSE)
  /\ UNCHANGED <<n, clip, sandbox>>

\* --- timers --------------------------------------------------------------
\* show(): a non-busy toast hides after 4 s (6 s with an offer); a busy one never does.
\* A ✓ timer (2.5 s) that started no later than the toast's show() (4 s or 6 s)
\* fires first. One that started later, by a silent older copy, may not (`quiet`).
ToastHides ==
  /\ toast.kind \notin {None, "busy"}
  /\ \A t \in Trios : local[t].st = "idle" \/ t \in quiet
  /\ sqlLocal = "idle" \/ "sql" \in quiet
  /\ toast' = [kind |-> None, of |-> 0]
  /\ UNCHANGED <<n, cp, clip, local, sqlLocal, sandbox, quiet, said>> /\ just' = 0

\* Trio's effect: COPY_FEEDBACK_MS after the last dispatch, reset at that `at`.
TrioResets(t) ==
  /\ local[t].st # "idle"
  /\ local' = [local EXCEPT ![t] = [st |-> "idle", fmt |-> None]]
  /\ UNCHANGED <<n, cp, clip, toast, sqlLocal, sandbox, quiet, said>> /\ just' = 0

SqlResets ==
  /\ sqlLocal # "idle"
  /\ sqlLocal' = "idle"
  /\ UNCHANGED <<n, cp, clip, toast, local, sandbox, quiet, said>> /\ just' = 0

\* Every copy settled and every timer fired: the end of the bounded run.
AllQuiet ==
  /\ n = MaxCopies
  /\ \A i \in Ids : Settled(i)
  /\ toast.kind = None /\ sqlLocal = "idle"
  /\ \A t \in Trios : local[t].st = "idle"
  /\ UNCHANGED vars

Next ==
  \/ \E t \in Trios, f \in Formats : YouCopyRows(t, f)
  \/ YouCopyAll
  \/ YouCopySql
  \/ \E i \in Ids : D1Answers(i) \/ D1Fails(i) \/ D1Hangs(i) \/ SdkTimesOut(i)
  \/ \E i \in Ids : HostWrites(i) \/ HostRefuses(i) \/ ItemRejects(i)
                    \/ FallbackCopies(i) \/ FallbackFails(i)
  \/ ToastHides
  \/ \E t \in Trios : TrioResets(t)
  \/ SqlResets
  \/ AllQuiet

\* The code's steps and the host's answers happen; D1 answers, fails or hangs
\* (D1Hangs is the "never answers" case); the user need not act.
Fairness ==
  /\ \A i \in Ids : WF_vars(D1Answers(i) \/ D1Fails(i) \/ D1Hangs(i))
  /\ \A i \in Ids : WF_vars(HostWrites(i)) /\ WF_vars(ItemRejects(i))
                    /\ WF_vars(HostRefuses(i))
                    /\ WF_vars(FallbackCopies(i) \/ FallbackFails(i))
                    /\ WF_vars(SdkTimesOut(i))
  /\ WF_vars(ToastHides) /\ WF_vars(SqlResets)
  /\ \A t \in Trios : WF_vars(TrioResets(t))

Spec == Init /\ [][Next]_vars /\ Fairness

\* --- rules -----------------------------------------------------------------
TypeOK ==
  /\ n \in 0..MaxCopies /\ clip \in 0..MaxCopies /\ just \in 0..MaxCopies /\ said \in 0..MaxCopies
  /\ toast.kind \in {None, "busy", "copied", "copiedSql", "copiedNoDone", "failed"}

\* 1. The clipboard ends up holding what the user copied last (the latest copy that worked).
ClipboardHoldsLastCopy ==
  (\A i \in 1..n : Settled(i)) =>
    LET ok == {i \in 1..n : Written(i)} IN
      clip = IF ok = {} THEN 0 ELSE CHOOSE i \in ok : \A j \in ok : j <= i

\* 2. The toast describes the user's latest copy: never one older than a copy that has finished.
ToastDescribesLatestCopy ==
  toast.kind # None => \A j \in 1..n : j > toast.of => ~Settled(j)

\* 3. A ✓ appears only on the trio and format whose copy completed ...
CheckOnlyOnCompletedCopy ==
  \A t \in Trios : Mark(t) # None =>
    \E i \in 1..n : cp[i].src = t /\ cp[i].fmt = Mark(t) /\ Written(i)

\* ... never during a busy Copy all ...
NoCheckDuringCopyAll ==
  (\E i \in Ids : LiveAll(i)) => \A t \in Trios : Mark(t) = None

\* ... (useCopyToast's comment: "no ✓ on a trio while its copy still reads") ...
NoCheckOnTrioWhileItReads ==
  \A i \in Ids : LiveAll(i) => Mark(cp[i].src) = None

\* ... never after a failure (the user's latest copy failed).
NoCheckAfterFailure ==
  (n > 0 /\ cp[n].write = "failed") => \A t \in Trios : Mark(t) = None

\* 5. A blocked clipboard is reported, never shown as copied.
\* Every failed copy, except a superseded Copy all (it failed because it gave up,
\* not because the clipboard is blocked).
BlockedIsReported ==
  (just # 0 /\ ~Written(just) /\ ~(cp[just].kind = "all" /\ ~IsLatest(just)))
    => toast = [kind |-> "failed", of |-> just]

BlockedNeverShownCopied ==
  /\ toast.kind \in {"copied", "copiedSql", "copiedNoDone"} => Written(toast.of)
  /\ \A t \in Trios : local[t].st = "copied" =>
       LET mine == {i \in 1..n : cp[i].kind = "rows" /\ cp[i].src = t /\ Settled(i)}
           last == CHOOSE i \in mine : \A j \in mine : j <= i
       IN mine # {} /\ Written(last)
  /\ sqlLocal = "copied" =>
       LET mine == {i \in 1..n : cp[i].kind = "sql" /\ Settled(i)}
           last == CHOOSE i \in mine : \A j \in mine : j <= i
       IN mine # {} /\ Written(last)

\* Trio's comment: once Copy all "has written, its format is" marked (if it is still the latest copy).
CopyAllMarksItsFormat ==
  (just # 0 /\ IsLatest(just) /\ cp[just].kind = "all" /\ Written(just)) => Mark(cp[just].src) = cp[just].fmt

\* 4. The "Reading rows…" toast always ends.
ReadingToastEnds == (toast.kind = "busy") ~> (toast.kind # "busy")
=============================================================================
