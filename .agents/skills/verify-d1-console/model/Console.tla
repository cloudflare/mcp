---------------------------- MODULE Console ----------------------------
(***************************************************************************)
(* D1 Studio's fullscreen console and the switch between display modes:   *)
(* reads the user leaves keep going and land in the history.              *)
(*                                                                         *)
(* Code (each action names the lines it stands for):                       *)
(*   src/d1-studio/app/console.tsx    useConsoleHistory (entries, active,  *)
(*                                    pending, land, track, the `count`    *)
(*                                    ref), Console (sameAs, ran, letGo,   *)
(*                                    pick), Main (key={entry.id}, its     *)
(*                                    reducer init with `latest`, the      *)
(*                                    onRan effect with `opened`), History *)
(*   src/d1-studio/app/d1-studio-app.tsx  Studio (history above the        *)
(*                                    display switch), useRunEffects (the  *)
(*                                    `mounted` ref effect before the run  *)
(*                                    effect; on unmount a running read is *)
(*                                    let go, not aborted; dispatches after*)
(*                                    unmount are skipped)                 *)
(*   src/d1-studio/app/machines.ts    initialCard, cardReducer submit /    *)
(*                                    run.done / run.error                 *)
(*                                                                         *)
(* Abstractions (SKILL.md, "Model and bounds"):                            *)
(*  - A result is [rid, sql]: the read that produced it and its SQL; the   *)
(*    agent's own results have rid 0. ranAt is the rid that set it (the    *)
(*    code stores Date.now() when it lands).                               *)
(*  - The host can run reads. Writes are not modeled.                      *)
(*  - One step = one user or host event and React's commit: a landing in   *)
(*    Main runs run.done, the onRan effect, land(), and the remount its    *)
(*    setActive causes; an unmount runs the `mounted` cleanup, then the run*)
(*    effect's cleanup (declaration order), which calls letGo -> track.    *)
(*  - A read let go or picked is a background read: `track` lists it in    *)
(*    `pending`, and its promise settles later (BgLands / BgFails).        *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Tables,     \* tables the Schema lists
  MaxRuns,    \* bound: reads started over the whole behaviour
  Broken      \* {} = the code as it is; else the set of broken variants (SKILL.md, "Able to fail")

AgentSql   == <<"s1", "s2">>                 \* result.steps then result.answer
AgentTitle == <<"Agent step 1", "Agent answer">>
NAgent     == Len(AgentSql)
PickSql(t)   == "pick:" \o t                  \* `SELECT * FROM ${quote(t)} LIMIT 100;`
PickTitle(t) == t \o ", first 100 rows"      \* `${t}, first 100 rows`
MySql == "mine"                              \* SQL the user typed
TitleOf(s) ==                                \* titleOf(sql)
  IF \E t \in Tables : s = PickSql(t)
  THEN "Your query on " \o (CHOOSE t \in Tables : s = PickSql(t))
  ELSE "Your query"

None == "none"
NoRes == [rid |-> 0 - 1, sql |-> None]
Idle == [st |-> "idle", rid |-> 0, sql |-> None, kind |-> "main"]

\* Broken variants (each mirrors a line of the code; SKILL.md has the table).
AbortOnUnmount  == "abortOnUnmount" \in Broken   \* the cleanup always aborts (no letGo, or `mounted` declared after the run effect)
LetGoWhenMounted == "letGoWhenMounted" \in Broken \* cleanup `if (letGo) letGo(...)` without `!mounted.current &&`
PickThroughMain == "pickThroughMain" \in Broken   \* the old pick: Main's run.sql (refused while busy), landing through ran()
PickNoOpen      == "pickNoOpen" \in Broken        \* pick's track without `open: true`
BgOpens         == "bgOpens" \in Broken           \* letGo's track with `open: true`
SameAsAtLanding == "sameAsAtLanding" \in Broken   \* sameAs taken from the entry open when the read lands
KeepPending     == "keepPending" \in Broken       \* track's reject branch without `done()`
NoLatest        == "noLatest" \in Broken \/ "oldKeyNoLatest" \in Broken  \* land() setting only ranAt
OldHistory      == "historyInConsole" \in Broken  \* the history as state inside Console
OldKey          == "oldKeyNoLatest" \in Broken    \* key `${entry.id}:${entry.ranAt}` and land() without latest
NoWhoGuard      == "noWhoGuard" \in Broken        \* sameAs without `entry.who === 'agent' &&`
LetGoEntryTitle == "letGoEntryTitle" \in Broken   \* letGo's title: entry.query.title always
KeepOnLand      == "keepPendingOnLand" \in Broken \* track's resolve branch without `done()`
NoReread        == "noReread" \in Broken          \* Main without the effect on [entry.latest] (dispatch reread)
NoLatestFrom    == "noLatestFrom" \in Broken      \* land() without the `startedAt < e.latestFrom` guard

AgentEntries ==
  [i \in 1..NAgent |->
     [who |-> "agent", title |-> AgentTitle[i], sql |-> AgentSql[i],
      res |-> [rid |-> 0, sql |-> AgentSql[i]], ranAt |-> 0, latest |-> NoRes, latestFrom |-> 0]]

VARIABLES
  display,   \* data-display: "inline" | "fullscreen"
  entries,   \* useConsoleHistory's entries (in Studio)
  active,    \* useConsoleHistory's active (1-based)
  mRun,      \* Main's state.run: idle | running | failed
  mShown,    \* Main's state.shown: NoRes = the entry's own result, else a rerun's
  bg,        \* reads going on without an editor: useConsoleHistory's `pending`, with what land() gets
  nextRun,   \* rids handed out (nextId / Date.now())
  \* ghosts
  lastLanded,  \* rid of the read that just landed on screen (0 = none since the user moved)
  lastPick,    \* rid of the pick that just landed and opened (0 = none since)
  landedNow,   \* results landed this console visit (in Main or in the background)
  landedEver,  \* results landed in any visit
  landedReads, \* every landed read: [rid, sql, from (entry it ran on, 0 for picks)]
  twice,       \* a read landed a second time
  lost,        \* why reads were thrown away silently: subset of {"switch", "leave"}
  pickDropped, \* why a pick never got its read: subset of {"ignored", "aborted"}
  moved        \* a background read opened something the user didn't ask for

vars == <<display, entries, active, mRun, mShown, bg, nextRun, lastLanded, lastPick,
          landedNow, landedEver, landedReads, twice, lost, pickDropped, moved>>

E == entries[active]
Screen == IF mShown # NoRes THEN mShown ELSE E.res
IsSameAs(i, s) == (entries[i].who = "agent" \/ NoWhoGuard) /\ s = entries[i].sql   \* sameAs(sql) for entry i
\* land(query, sameAs = i, open, startedAt): marks step i with the read r, unless
\* a read sent after it (larger rid: rids follow send order) already did.
Stamp(es, i, r) ==
  IF ~NoLatestFrom /\ es[i].latestFrom # 0 /\ r.rid < es[i].latestFrom
  THEN es
  ELSE [es EXCEPT ![i].ranAt = r.rid,
                  ![i].latest = IF NoLatest THEN @ ELSE r,
                  ![i].latestFrom = r.rid]
FreshShown(es, a) == IF es[a].latest # NoRes /\ es[a].ranAt # 0 THEN es[a].latest ELSE NoRes

\* A read Main lets go of: letGo(sql, outcome) -> track({title, sql, outcome, sameAs}).
LetGoRead ==
  [rid |-> mRun.rid, sql |-> mRun.sql, from |-> IF mRun.kind = "pick" THEN 0 ELSE active,
   kind |-> mRun.kind,
   title |-> IF LetGoEntryTitle THEN E.title
             ELSE IF IsSameAs(active, mRun.sql) THEN E.title ELSE TitleOf(mRun.sql),
   sameAs |-> IF IsSameAs(active, mRun.sql) THEN active ELSE 0,
   open |-> BgOpens, settled |-> FALSE, failed |-> FALSE]

\* Main unmounts (another entry opened, or fullscreen left): its running read
\* is let go, or (abortOnUnmount) aborted.
Unmount(why) ==
  /\ bg' = IF mRun.st = "running" /\ ~AbortOnUnmount THEN bg \cup {LetGoRead} ELSE bg
  /\ lost' = IF mRun.st = "running" /\ AbortOnUnmount THEN lost \cup {why} ELSE lost
  /\ pickDropped' = IF mRun.st = "running" /\ AbortOnUnmount /\ mRun.kind = "pick"
                      THEN pickDropped \cup {"aborted"} ELSE pickDropped

Init ==
  /\ display = "inline"
  /\ entries = AgentEntries /\ active = NAgent
  /\ mRun = Idle /\ mShown = NoRes /\ bg = {} /\ nextRun = 0
  /\ lastLanded = 0 /\ lastPick = 0 /\ landedNow = {} /\ landedEver = {} /\ landedReads = {}
  /\ twice = FALSE /\ lost = {} /\ pickDropped = {} /\ moved = FALSE

YouGoFullscreen ==
  /\ display = "inline"
  /\ display' = "fullscreen"
  /\ mRun' = Idle /\ mShown' = FreshShown(entries, active)
  /\ lastLanded' = 0 /\ lastPick' = 0 /\ landedNow' = {}
  /\ UNCHANGED <<entries, active, bg, nextRun, landedEver, landedReads, twice, lost, pickDropped, moved>>

YouLeaveFullscreen ==
  /\ display = "fullscreen"
  /\ display' = "inline"
  /\ Unmount("leave")
  /\ IF OldHistory THEN entries' = AgentEntries /\ active' = NAgent ELSE UNCHANGED <<entries, active>>
  /\ mRun' = Idle /\ mShown' = NoRes
  /\ lastLanded' = 0 /\ lastPick' = 0
  /\ UNCHANGED <<nextRun, landedNow, landedEver, landedReads, twice, moved>>

\* Run (or Cmd-Enter): cardReducer 'submit', refused while a run is in flight.
YouRun(s) ==
  /\ display = "fullscreen"
  /\ mRun.st # "running"
  /\ nextRun < MaxRuns
  /\ mRun' = [st |-> "running", rid |-> nextRun + 1, sql |-> s, kind |-> "main"]
  /\ nextRun' = nextRun + 1
  /\ UNCHANGED <<display, entries, active, mShown, bg, lastLanded, lastPick, landedNow,
                 landedEver, landedReads, twice, lost, pickDropped, moved>>

\* Schema onPick -> pick(t): track({title, sql, outcome: runRead(...), open: true}),
\* beside whatever Main runs. pickThroughMain: Main's run.sql, refused while busy.
YouPick(t) ==
  /\ display = "fullscreen"
  /\ nextRun < MaxRuns
  /\ IF PickThroughMain
       THEN IF mRun.st # "running"
              THEN /\ mRun' = [st |-> "running", rid |-> nextRun + 1, sql |-> PickSql(t), kind |-> "pick"]
                   /\ nextRun' = nextRun + 1
                   /\ UNCHANGED <<bg, pickDropped>>
              ELSE /\ pickDropped' = pickDropped \cup {"ignored"}
                   /\ UNCHANGED <<mRun, nextRun, bg>>
       ELSE /\ bg' = bg \cup {[rid |-> nextRun + 1, sql |-> PickSql(t), from |-> 0, kind |-> "pick",
                              title |-> PickTitle(t), sameAs |-> 0, open |-> ~PickNoOpen,
                              settled |-> FALSE, failed |-> FALSE]}
            /\ nextRun' = nextRun + 1
            /\ UNCHANGED <<mRun, pickDropped>>
  /\ UNCHANGED <<display, entries, active, mShown, lastLanded, lastPick, landedNow, landedEver,
                 landedReads, twice, lost, moved>>

\* Main's read lands: run.done; the onRan effect calls ran(query) =
\* land(query, sameAs(sql), true): the agent's SQL unchanged marks the step
\* (no remount: key = id), else a 'you' entry is appended and opened (remount).
\* letGoWhenMounted: the run effect's cleanup on the id change also lets the
\* finished read go, so it lands a second time from `pending`.
MainLands ==
  /\ display = "fullscreen"
  /\ mRun.st = "running"
  /\ LET r     == [rid |-> mRun.rid, sql |-> mRun.sql]
         stamp == IsSameAs(active, mRun.sql)
         title == IF mRun.sql = E.sql THEN E.title ELSE TitleOf(mRun.sql)
         es    == IF stamp
                    THEN Stamp(entries, active, r)   \* ran(query, sentAt.current)
                    ELSE Append(entries, [who |-> "you", title |-> title, sql |-> mRun.sql,
                                          res |-> r, ranAt |-> 0, latest |-> NoRes, latestFrom |-> 0])
         a     == IF stamp THEN active ELSE Len(entries) + 1
     IN /\ entries' = es /\ active' = a
        /\ mShown' = IF stamp /\ ~OldKey THEN r ELSE FreshShown(es, a)
        /\ twice' = (twice \/ r \in landedEver)
        /\ landedNow' = landedNow \cup {r} /\ landedEver' = landedEver \cup {r}
        /\ landedReads' = landedReads \cup
              {[rid |-> mRun.rid, sql |-> mRun.sql, from |-> IF mRun.kind = "pick" THEN 0 ELSE active]}
        /\ bg' = IF LetGoWhenMounted THEN bg \cup {[LetGoRead EXCEPT !.settled = TRUE]} ELSE bg
  /\ mRun' = Idle
  /\ lastLanded' = mRun.rid
  /\ lastPick' = IF mRun.kind = "pick" THEN mRun.rid ELSE 0
  /\ UNCHANGED <<display, nextRun, lost, pickDropped, moved>>

\* The host couldn't run Main's read (run.error): the card says so.
MainFails ==
  /\ display = "fullscreen"
  /\ mRun.st = "running"
  /\ mRun' = [st |-> "failed", rid |-> 0, sql |-> None, kind |-> "main"]
  /\ UNCHANGED <<display, entries, active, mShown, bg, nextRun, lastLanded, lastPick, landedNow,
                 landedEver, landedReads, twice, lost, pickDropped, moved>>

\* A background read resolves: track's then: done() removes it from pending,
\* land(query, sameAs, open). With open, setActive(i) remounts Main (whose
\* own read, if any, is let go in turn).
BgLand(b) ==
  /\ ~b.failed
  /\ LET r     == [rid |-> b.rid, sql |-> b.sql]
         same  == IF SameAsAtLanding
                    THEN (IF display = "fullscreen" /\ IsSameAs(active, b.sql) THEN active ELSE 0)
                    ELSE b.sameAs
         es    == IF same # 0
                    THEN Stamp(entries, same, r)      \* startedAt: when the read was sent
                    ELSE Append(entries, [who |-> "you", title |-> b.title, sql |-> b.sql,
                                          res |-> r, ranAt |-> 0, latest |-> NoRes, latestFrom |-> 0])
         opens == same = 0 /\ b.open
         a     == IF opens THEN Len(entries) + 1 ELSE active
         fs    == display = "fullscreen"
     IN /\ entries' = es /\ active' = a
        /\ bg' = (IF KeepOnLand THEN {[b EXCEPT !.failed = TRUE]} ELSE {}) \cup
                 (IF opens /\ fs THEN (bg \ {b}) \cup
                    (IF mRun.st = "running" /\ ~AbortOnUnmount THEN {LetGoRead} ELSE {})
                  ELSE bg \ {b})
        /\ lost' = IF opens /\ fs /\ mRun.st = "running" /\ AbortOnUnmount THEN lost \cup {"switch"} ELSE lost
        /\ IF opens /\ fs
             THEN /\ mRun' = Idle /\ mShown' = FreshShown(es, a)
                  /\ lastLanded' = b.rid
                  /\ lastPick' = IF b.kind = "pick" THEN b.rid ELSE 0
             \* lastPick: a pick that lands is meant to open (PickOpensItsEntry checks it)
             ELSE /\ lastPick' = IF b.kind = "pick" /\ fs THEN b.rid ELSE lastPick
                  \* Main's effect on [entry.latest]: the step it shows got a newer read
                  \* -> dispatch reread (shown = that read; the run in flight untouched;
                  \* onRan skips it: shown.outcome === entry.latest)
                  /\ mShown' = IF fs /\ same # 0 /\ same = active /\ ~NoReread
                                   /\ es[same].latest # entries[same].latest /\ es[same].latest # NoRes
                                THEN es[same].latest ELSE mShown
                  /\ UNCHANGED <<mRun, lastLanded>>
        /\ moved' = (moved \/ (opens /\ b.kind = "main"))
        /\ twice' = (twice \/ r \in landedEver)
        /\ landedNow' = IF fs THEN landedNow \cup {r} ELSE landedNow
        /\ landedEver' = landedEver \cup {r}
        /\ landedReads' = landedReads \cup {[rid |-> b.rid, sql |-> b.sql, from |-> b.from]}
  /\ UNCHANGED <<display, nextRun, pickDropped>>

\* A background read rejects: done() and a failure toast (not silent).
\* keepPending: no done(), the item stays in `pending` for good.
BgFail(b) ==
  /\ ~b.settled /\ ~b.failed
  /\ bg' = IF KeepPending THEN (bg \ {b}) \cup {[b EXCEPT !.failed = TRUE]} ELSE bg \ {b}
  /\ UNCHANGED <<display, entries, active, mRun, mShown, nextRun, lastLanded, lastPick, landedNow,
                 landedEver, landedReads, twice, lost, pickDropped, moved>>

\* By rid, over a constant range, so TLC names the steps BgLands / BgFails.
BgLands(n) == \E b \in bg : b.rid = n /\ BgLand(b)
BgFails(n) == \E b \in bg : b.rid = n /\ BgFail(b)

\* History open={setActive}: Main remounts on the new id; its read is let go.
YouOpen(i) ==
  /\ display = "fullscreen"
  /\ i \in 1..Len(entries) /\ i # active
  /\ active' = i
  /\ Unmount("switch")
  /\ mRun' = Idle /\ mShown' = FreshShown(entries, i)
  /\ lastLanded' = 0 /\ lastPick' = 0
  /\ UNCHANGED <<display, entries, nextRun, landedNow, landedEver, landedReads, twice, moved>>


Next ==
  \/ YouGoFullscreen
  \/ YouLeaveFullscreen
  \/ \E s \in {"same", "mine"} : YouRun(IF s = "same" THEN E.sql ELSE MySql)
  \/ \E t \in Tables : YouPick(t)
  \/ MainLands
  \/ MainFails
  \/ \E n \in 1..MaxRuns : BgLands(n)
  \/ \E n \in 1..MaxRuns : BgFails(n)
  \/ \E i \in 1..(NAgent + MaxRuns) : YouOpen(i)

Spec == Init /\ [][Next]_vars
\* Background promises settle eventually; the user's own steps need no fairness.
FairSpec == Spec /\ WF_vars(\E n \in 1..MaxRuns : BgLands(n) \/ BgFails(n))

----------------------------------------------------------------------------
\* The rules, in the reader's words (SKILL.md has the one-line versions).

Sqls == {MySql} \cup {AgentSql[i] : i \in 1..NAgent} \cup {PickSql(t) : t \in Tables}
Result == [rid : 0..MaxRuns, sql : Sqls]

TypeOK ==
  /\ display \in {"inline", "fullscreen"}
  /\ active \in 1..Len(entries)
  /\ \A i \in 1..Len(entries) : entries[i].res \in Result /\ entries[i].latest \in Result \cup {NoRes}
  /\ mRun.st \in {"idle", "running", "failed"}
  /\ mShown \in Result \cup {NoRes}

TitleFits(title, sql) ==
  \/ \E i \in 1..NAgent : sql = AgentSql[i] /\ title = AgentTitle[i]
  \/ sql = MySql /\ title = "Your query"
  \/ \E t \in Tables : sql = PickSql(t) /\ title \in {PickTitle(t), TitleOf(sql)}

InHistory(r) ==
  \E i \in 1..Len(entries) :
    \/ entries[i].res = r
    \/ entries[i].who = "agent" /\ entries[i].sql = r.sql /\ entries[i].ranAt # 0

\* 1. After a run lands on screen (in the editor, or a pick that opens), the result on screen is its result.
ShowsTheRunThatLanded == (display = "fullscreen" /\ lastLanded # 0) => Screen.rid = lastLanded
\* 1b. An agent step read again here shows what D1 answered from then on.
ReReadStaysOnItsStep ==
  (display = "fullscreen" /\ E.who = "agent" /\ E.ranAt # 0) => Screen = E.latest
\* 1c. A step read again several times keeps the newest read (by when it was sent), whatever order they land in.
Max(S) == CHOOSE m \in S : \A x \in S : x <= m
NewestReReadWins ==
  \A i \in 1..NAgent :
    LET rs == {x.rid : x \in {y \in landedReads : y.from = i /\ y.sql = AgentSql[i]}}
    IN (rs # {} /\ entries[i].ranAt # 0) => entries[i].latest.rid = Max(rs)
\* 2a / 2b. Every run the user did stays in the history, in this visit and across visits.
RunsStayInHistory == (display = "fullscreen") => \A r \in landedNow : InHistory(r)
RunsSurviveLeavingFullscreen == (display = "fullscreen") => \A r \in landedEver : InHistory(r)
\* 2c. No run becomes two entries; 2d. no read lands twice (a let-go read never also lands via Main).
OneEntryPerRun ==
  \A i, j \in 1..Len(entries) : (i # j /\ entries[i].res.rid # 0) => entries[i].res # entries[j].res
LandsOnce == ~twice
\* 2e. A let-go re-read of an agent step marks that step (by id), not the one open when it lands.
LetGoMarksItsStep ==
  \A x \in landedReads :
    (x.from # 0 /\ entries[x.from].who = "agent" /\ x.sql = entries[x.from].sql)
      => entries[x.from].ranAt # 0
\* 3. A pick runs its table's query (3a not ignored, 3b not aborted), lands as
\*    one entry titled for the table (3c), and opens it (3d).
PickIsNotIgnored == "ignored" \notin pickDropped
PickIsNotAborted == "aborted" \notin pickDropped
PickLandsAsItsEntry ==
  \A x \in landedReads :
    (\E t \in Tables : x.sql = PickSql(t) /\ x.from = 0) =>
      Cardinality({i \in 1..Len(entries) :
                     entries[i].res = [rid |-> x.rid, sql |-> x.sql] /\ entries[i].who = "you"
                     /\ entries[i].title = PickTitle(CHOOSE t \in Tables : x.sql = PickSql(t))}) = 1
PickOpensItsEntry == (display = "fullscreen" /\ lastPick # 0) => (Screen.rid = lastPick /\ E.res.rid = lastPick)
\* 4. No entry shows one query's result under another's title.
ShownUnderItsOwnTitle == (display = "fullscreen") => TitleFits(E.title, Screen.sql)
\* 5. A read in flight is never lost silently when the user switches entries, or leaves fullscreen.
NoRunLostOnSwitch == "switch" \notin lost
NoRunLostOnLeave == "leave" \notin lost
\* 6. A read that lands in the background doesn't change what the user is looking at.
BackgroundLandingKeepsView == ~moved
\* 7. A pending item never outlives its read (safety), and always goes (liveness, under FairSpec).
NoStalePending == \A b \in bg : ~(\E x \in landedReads : x.rid = b.rid) \/ b.settled
\* PendingClears: every item still in `pending` can still settle (its read hasn't
\* settled yet, so BgLands/BgFails is enabled for it); with promises that settle,
\* each item goes. Checked as an invariant: a liveness PROPERTY's stuttering loop
\* can't be drawn by /statechart.
PendingClears == \A b \in bg : ~b.failed

\* For Chart.cfg only: TLC stops exploring past a host failure, a second
\* background read, a fourth entry, or the inline card with something going on,
\* so the chart fits the 500-state budget. Console.cfg has no constraint.
DrawBound == mRun.st # "failed" /\ Cardinality(bg) <= 1 /\ Len(entries) <= 3
               /\ (display = "inline" => mRun.st = "idle" /\ landedEver = {})

=============================================================================
