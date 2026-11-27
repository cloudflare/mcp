---------------------------- MODULE CardRunSend ----------------------------
(***************************************************************************)
(* The D1 Studio answer card's run / send-to-chat hand-off.                *)
(*                                                                         *)
(* The answer card's machine (`useAnswerCard`, called by `Studio` in       *)
(* src/d1-studio/app/d1-studio-app.tsx): its reducer (`cardReducer` in     *)
(* src/d1-studio/app/machines.ts), the effects that perform what it asks   *)
(* (`useRunEffects`), the UI that dispatches (the editor's ⌘↵ through      *)
(* `submitKey`, `RunButton`, Revert, the fix line, the LIMIT pager), the   *)
(* display switch, and a host whose replies arrive in any order, late, or  *)
(* never.                                                                  *)
(*                                                                         *)
(* The machine lives in `Studio`, above the display switch, so going       *)
(* fullscreen and back does not remount it: a run or send in flight keeps  *)
(* going and its reply lands. While fullscreen the answer card is not on   *)
(* screen (the Console is); back from fullscreen `Studio` dispatches       *)
(* `fold`. (`key={display}` still remounts the section's DOM, not the      *)
(* machine.)                                                               *)
(*                                                                         *)
(* Abstractions (each is named again in the SKILL.md):                     *)
(*  - SQL text is its `verdictOf` kind: "agent" (the agent's own SQL, a    *)
(*    read), "read" (another read), "write", "bad" (typo / multiple /      *)
(*    tail / empty: `submitAction` kind "none").                           *)
(*  - A reducer step plus the effects React runs after it are one step     *)
(*    (React flushes passive effects before it handles the next event).    *)
(*  - Rows, sort, paging (`fetch`), found, and the copy trio are left out: *)
(*    they don't touch `run`. Copying (Copy SQL) changes no state here.    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxId,          \* bound on `nextId` (runs + sends the card starts)
    RunAbilities,   \* subset of BOOLEAN: `can.run` (host serverTools) values to try
    SendAbilities,  \* subset of BOOLEAN: `can.send` (host message) values to try
    Drafts          \* draft kinds the user can type: subset of
                    \* {"agent", "read", "write", "bad"}

VARIABLES
    hostRun, hostSend,  \* `state.can` = hostAbilities(app).run / .send, fixed
    display,            \* "card" (inline / pip) or "fullscreen" (the Console)
    card,               \* the parts of `CardState` this flow reads or writes
    requests,           \* calls in the host: d1_raw reads and ui/message sends
    timers,             \* run ids with an armed SEND_TIMEOUT_MS timer
    \* ghost variables: what the rules talk about, not in the code
    posts,              \* ui/message posts so far (serial numbers)
    postOf,             \* which post each run id's send made
    chatGot,            \* posts the chat received
    shownSent,          \* posts the card showed as "Sent"
    toldUnsure,         \* posts the card said it couldn't confirm (unconfirmed)
    sameDraftPosts,     \* posts made since the draft last changed (any cause)
    runStarts,          \* SQL kinds a run asked runRead / d1_raw to run
    rawOffHost,         \* a d1_raw call was made on a host without serverTools
    postOffHost,        \* a ui/message was posted on a host without message
    staleMoved          \* a reply to an abandoned run/send changed the card

vars == <<hostRun, hostSend, display, card, requests, timers, posts, postOf,
          chatGot, shownSent, toldUnsure, sameDraftPosts, runStarts,
          rawOffHost, postOffHost, staleMoved>>

\* verdictOf(draft).kind, folded the way submitAction folds it.
Verdict(d) == IF d \in {"agent", "read"} THEN "read"
              ELSE IF d = "write" THEN "write" ELSE "none"

Idle == [status |-> "idle", id |-> 0, sql |-> "none"]

\* initialCard: editable = can.run || can.send (the answer card's purpose is 'query')
Editable == hostRun \/ hostSend

\* isBusy(run)
IsBusy(c) == c.run.status \in {"running", "sending"}

\* isHandedOff(run): the chat has this draft, or may
IsHandedOff(c) == c.run.status \in {"sent", "unconfirmed"}

\* canRevert(state): false while sending; else draft or shown SQL differs from the agent's
CanRevert(c) == c.run.status # "sending" /\ (c.draft # "agent" \/ c.shown # "agent")

\* copyIsPrimary(state) in d1-studio-app.tsx
CopyIsPrimary(c) == Verdict(c.draft) = "write" /\
                    (~hostSend \/ c.run.status \in {"unconfirmed", "refused"})

\* initialCard(query, can): pane short, draft = the agent's SQL, nextId 1
InitCard == [pane |-> "short", draft |-> "agent", shown |-> "agent",
             run |-> Idle, nextId |-> 1]

(***************************************************************************)
(* cardReducer, one operator per case this flow uses.                      *)
(***************************************************************************)
RDraftChange(c, d) ==
    IF ~Editable \/ c.pane # "full" THEN c
    ELSE [c EXCEPT !.draft = d, !.run = IF IsBusy(c) THEN c.run ELSE Idle]

RSubmit(c) ==
    IF ~Editable \/ IsBusy(c) \/ Verdict(c.draft) = "none" THEN c
    ELSE IF Verdict(c.draft) = "read" /\ ~hostRun THEN c
    ELSE IF Verdict(c.draft) = "write" /\ (~hostSend \/ IsHandedOff(c)) THEN c
    ELSE [c EXCEPT !.run = [status |-> IF Verdict(c.draft) = "read"
                                       THEN "running" ELSE "sending",
                            id |-> c.nextId, sql |-> c.draft],
                   !.nextId = c.nextId + 1]

\* ok = FALSE: D1 refused the SQL (a re-run outcome, not a host error).
RRunDone(c, id, ok) ==
    IF c.run.status # "running" \/ c.run.id # id THEN c
    ELSE [c EXCEPT !.shown = c.run.sql, !.run = Idle,
                   !.pane = IF ~ok THEN "full"
                            ELSE IF c.run.sql = "agent" THEN "short"
                            ELSE c.pane]

RRunError(c, id) ==
    IF c.run.status # "running" \/ c.run.id # id THEN c
    ELSE [c EXCEPT !.run = [status |-> "failed", id |-> 0, sql |-> "none"]]

RSendDone(c, id) ==
    IF c.run.status \notin {"sending", "unconfirmed"} \/ c.run.id # id THEN c
    ELSE [c EXCEPT !.run = [status |-> "sent", id |-> 0, sql |-> c.run.sql]]

RSendError(c, id) ==
    IF c.run.status \notin {"sending", "unconfirmed"} \/ c.run.id # id THEN c
    ELSE [c EXCEPT !.run = [status |-> "refused", id |-> 0, sql |-> c.run.sql]]

RSendTimeout(c, id) ==
    IF c.run.status # "sending" \/ c.run.id # id THEN c
    ELSE [c EXCEPT !.run.status = "unconfirmed"]

RRunSql(c, sql) ==
    IF ~hostRun \/ IsBusy(c) \/ Verdict(sql) # "read" THEN c
    ELSE [c EXCEPT !.draft = sql,
                   !.run = [status |-> "running", id |-> c.nextId, sql |-> sql],
                   !.nextId = c.nextId + 1]

\* 'offset': limitPaging(state) needs state.can.run; then run.sql with OFFSET.
ROffset(c) == IF ~hostRun THEN c ELSE RRunSql(c, "read")

RRevert(c) ==
    IF c.run.status = "sending" THEN c
    ELSE [InitCard EXCEPT !.nextId = c.nextId, !.pane = c.pane]

\* 'fold': rows closed, SQL folded; the draft and anything in flight stay.
RFold(c) == [c EXCEPT !.pane = "short"]

(***************************************************************************)
(* useRunEffects: keyed on the run's id while running or sending.          *)
(***************************************************************************)
Key(c) == IF IsBusy(c) THEN c.run.id ELSE 0

PostOf(id) == IF \E t \in postOf : t.id = id
              THEN (CHOOSE t \in postOf : t.id = id).post ELSE 0

\* The post of the send the card is on (sending or unconfirmed), else 0.
LivePost(c) == IF c.run.status \in {"sending", "unconfirmed"}
               THEN PostOf(c.run.id) ELSE 0

\* card becomes c2 and React runs the effect cleanup + body.
\* reqs / tims / got: requests, timers, chatGot before the effect.
Commit(c2, reqs, tims, stale, got) ==
    LET c == card
        changed == Key(c2) # Key(c)
        \* cleanup of a read: abort.abort(); of a send: clearTimeout only
        reqs1 == IF changed /\ c.run.status = "running"
                 THEN {IF r.kind = "read" /\ r.id = c.run.id
                       THEN [r EXCEPT !.aborted = TRUE] ELSE r : r \in reqs}
                 ELSE reqs
        tims1 == IF changed /\ c.run.status = "sending"
                 THEN tims \ {c.run.id} ELSE tims
        startRead == changed /\ c2.run.status = "running"
        startSend == changed /\ c2.run.status = "sending"
        p == posts + 1
        newReqs == (IF startRead
                    THEN {[kind |-> "read", id |-> c2.run.id, sql |-> c2.run.sql,
                           post |-> 0, aborted |-> FALSE]}
                    ELSE {})
                   \cup
                   (IF startSend
                    THEN {[kind |-> "send", id |-> c2.run.id, sql |-> c2.run.sql,
                           post |-> p, aborted |-> FALSE]}
                    ELSE {})
    IN /\ card' = c2
       /\ requests' = reqs1 \cup newReqs
       /\ timers' = tims1 \cup (IF startSend THEN {c2.run.id} ELSE {})
       /\ posts' = IF startSend THEN p ELSE posts
       /\ postOf' = IF startSend THEN postOf \cup {[id |-> c2.run.id, post |-> p]}
                    ELSE postOf
       /\ shownSent' = IF c2.run.status = "sent" /\ c.run.status # "sent"
                       THEN shownSent \cup {LivePost(c)} ELSE shownSent
       /\ toldUnsure' = IF c2.run.status = "unconfirmed" /\ c.run.status # "unconfirmed"
                        THEN toldUnsure \cup {LivePost(c)} ELSE toldUnsure
       /\ sameDraftPosts' = (IF c2.draft # c.draft THEN {} ELSE sameDraftPosts)
                            \cup (IF startSend THEN {p} ELSE {})
       \* runRead throws before callServerTool unless isReadStatement(sql)
       /\ runStarts' = IF startRead THEN runStarts \cup {c2.run.sql} ELSE runStarts
       /\ rawOffHost' = (rawOffHost \/ (startRead /\ Verdict(c2.run.sql) = "read"
                                                  /\ ~hostRun))
       /\ postOffHost' = (postOffHost \/ (startSend /\ ~hostSend))
       /\ staleMoved' = (staleMoved \/ (stale /\ c2 # c))
       /\ chatGot' = got
       /\ UNCHANGED <<hostRun, hostSend, display>>

\* A user step on the card: the reducer's answer, then the effects.
User(c2) == /\ display = "card"
            /\ Commit(c2, requests, timers, FALSE, chatGot)

(***************************************************************************)
(* What the user does (the dispatch sites). The card is on screen only     *)
(* while not fullscreen.                                                   *)
(***************************************************************************)

\* Tray click / "Short form" / Escape: pane.toggle
YouOpenOrFoldEditor ==
    /\ card.pane \in {"short", "full"}
    /\ User([card EXCEPT !.pane = IF card.pane = "short" THEN "full" ELSE "short"])

\* Editor textarea onChange (Editor ~l.1628): draft.change. Only rendered
\* when the pane is full and the card is editable.
YouType(d) ==
    /\ card.pane = "full" /\ Editable /\ d # card.draft
    /\ User(RDraftChange(card, d))

\* Editor onKeyDown ⌘↵ / Ctrl+Enter: submitKey (~l.1710): Copy SQL when
\* copyIsPrimary (no state change), else dispatch submit.
YouPressCmdEnter ==
    /\ card.pane = "full" /\ Editable
    /\ ~CopyIsPrimary(card)
    /\ User(RSubmit(card))

\* RunButton (~l.1850): in the editor band when editable, or in the rows
\* band (bandRun) on stale rows of the agent's unchanged SQL with host.run.
\* Its onClick guards: Copy SQL when copyIsPrimary (no dispatch); a write:
\* no button when sent, no-op while sending; a read: no-op when busy or
\* blocked (not a read, or !host.run).
YouClickRunOrSend ==
    /\ \/ card.pane = "full" /\ Editable
       \/ card.pane = "short" /\ card.draft = "agent" /\ hostRun
    /\ ~CopyIsPrimary(card)
    /\ \/ Verdict(card.draft) = "write" /\ card.run.status \notin {"sent", "sending"}
       \/ Verdict(card.draft) = "read" /\ ~IsBusy(card) /\ hostRun
    /\ User(RSubmit(card))

\* The fix line's "Use …" (onUse ~l.584): run.sql, offered only with host.run.
YouUseFix ==
    /\ hostRun
    /\ User(RRunSql(card, "read"))

\* The LIMIT pager's arrows (~l.1079): 'offset'; shown with the pane short
\* (limitPaging, which needs can.run: the reducer's guard is modeled).
YouPageLimit ==
    /\ card.pane = "short"
    /\ User(ROffset(card))

\* Revert (~l.1040), offered when canRevert.
YouRevert ==
    /\ CanRevert(card)
    /\ User(RRevert(card))

\* Going fullscreen: Studio renders the Console; the answer card's machine
\* and its effects stay (useAnswerCard is called by Studio).
YouGoFullscreen ==
    /\ display = "card"
    /\ display' = "fullscreen"
    /\ UNCHANGED <<hostRun, hostSend, card, requests, timers, posts, postOf,
                   chatGot, shownSent, toldUnsure, sameDraftPosts, runStarts,
                   rawOffHost, postOffHost, staleMoved>>

\* Back from fullscreen: Studio's effect dispatches 'fold'.
YouLeaveFullscreen ==
    /\ display = "fullscreen"
    /\ display' = "card"
    /\ card' = RFold(card)
    /\ UNCHANGED <<hostRun, hostSend, requests, timers, posts, postOf,
                   chatGot, shownSent, toldUnsure, sameDraftPosts, runStarts,
                   rawOffHost, postOffHost, staleMoved>>

(***************************************************************************)
(* What the host does. Replies dispatch into the one machine.              *)
(***************************************************************************)

\* Is the card no longer on the run/send this reply belongs to?
Abandoned(r) == ~(card.run.status \in {"running", "sending", "unconfirmed"}
                  /\ card.run.id = r.id)

Reply(r, c2, reqs, tims, got) == Commit(c2, reqs, tims, Abandoned(r), got)

\* d1_raw answers (callServerTool resolves). runRead never called it for a
\* statement that isn't a read. The success handler doesn't check abort.
HostReturnsRead(r, ok) ==
    /\ r \in requests /\ r.kind = "read" /\ Verdict(r.sql) = "read"
    /\ Reply(r, RRunDone(card, r.id, ok), requests \ {r}, timers, chatGot)

\* The host fails the read (or runRead throws). After abort, nothing is dispatched.
HostFailsRead(r) ==
    /\ r \in requests /\ r.kind = "read"
    /\ IF r.aborted
       THEN /\ requests' = requests \ {r}
            /\ UNCHANGED <<hostRun, hostSend, display, card, timers, posts, postOf,
                           chatGot, shownSent, toldUnsure, sameDraftPosts,
                           runStarts, rawOffHost, postOffHost, staleMoved>>
       ELSE Reply(r, RRunError(card, r.id), requests \ {r}, timers, chatGot)

\* The chat takes the message and sendMessage resolves without isError: send.done.
HostTakesSend(r) ==
    /\ r \in requests /\ r.kind = "send" /\ hostSend
    /\ Reply(r, RSendDone(card, r.id), requests \ {r}, timers, chatGot \cup {r.post})

\* The chat takes the message, but the host never answers.
HostTakesSendSilently(r) ==
    /\ r \in requests /\ r.kind = "send" /\ hostSend
    /\ chatGot' = chatGot \cup {r.post}
    /\ requests' = requests \ {r}
    /\ UNCHANGED <<hostRun, hostSend, display, card, timers, posts, postOf,
                   shownSent, toldUnsure, sameDraftPosts, runStarts,
                   rawOffHost, postOffHost, staleMoved>>

\* sendMessage resolves with isError (or rejects): send.error.
HostRefusesSend(r) ==
    /\ r \in requests /\ r.kind = "send"
    /\ Reply(r, RSendError(card, r.id), requests \ {r}, timers, chatGot)

\* SEND_TIMEOUT_MS passes: send.timeout.
SendTimerFires(t) ==
    /\ t \in timers
    /\ Reply([kind |-> "timer", id |-> t, sql |-> "none", post |-> 0, aborted |-> FALSE],
             RSendTimeout(card, t), requests, timers \ {t}, chatGot)

(***************************************************************************)
Init ==
    /\ hostRun \in RunAbilities
    /\ hostSend \in SendAbilities
    /\ display = "card"
    /\ card = InitCard
    /\ requests = {}
    /\ timers = {}
    /\ posts = 0
    /\ postOf = {}
    /\ chatGot = {}
    /\ shownSent = {}
    /\ toldUnsure = {}
    /\ sameDraftPosts = {}
    /\ runStarts = {}
    /\ rawOffHost = FALSE
    /\ postOffHost = FALSE
    /\ staleMoved = FALSE

\* One named action per kind of step, so the checker names each step.
HostAnswersRead == \E r \in requests, ok \in BOOLEAN : HostReturnsRead(r, ok)
HostFailsARead == \E r \in requests : HostFailsRead(r)
HostTakesASend == \E r \in requests : HostTakesSend(r)
HostTakesASendSilently == \E r \in requests : HostTakesSendSilently(r)
HostRefusesASend == \E r \in requests : HostRefusesSend(r)
ASendTimerFires == \E t \in timers : SendTimerFires(t)
YouTypeADraft == \E d \in Drafts : YouType(d)

Next ==
    \/ YouOpenOrFoldEditor
    \/ YouTypeADraft
    \/ YouPressCmdEnter
    \/ YouClickRunOrSend
    \/ YouUseFix
    \/ YouPageLimit
    \/ YouRevert
    \/ YouGoFullscreen
    \/ YouLeaveFullscreen
    \/ HostAnswersRead
    \/ HostFailsARead
    \/ HostTakesASend
    \/ HostTakesASendSilently
    \/ HostRefusesASend
    \/ ASendTimerFires

Spec == Init /\ [][Next]_vars

Bounded == card.nextId <= MaxId + 1

(***************************************************************************)
(* The rules, in the user's words (SKILL.md has the one-line harm of each).*)
(***************************************************************************)

\* 1. A reply to a run or send the user abandoned never changes the card.
AbandonedReplyIgnored == ~staleMoved

\* 2. A write reaches the chat at most once unless the draft changes.
WriteReachesChatOnce == Cardinality(chatGot \cap sameDraftPosts) <= 1

\* 3. When the chat has received the write, the card doesn't claim nothing
\*    was sent: until the card has shown Sent for it, it stays on that
\*    hand-off (Sending / Waiting on host). The one exception, by design:
\*    once the card has said it couldn't confirm (Waiting on host, Copy SQL
\*    offered), Revert or editing the draft may clear it.
ChatGotItCardSaysSo ==
    \A p \in chatGot \ (shownSent \cup toldUnsure) : p = LivePost(card)

\* 4. Only a read is ever run (sent to d1_raw).
OnlyReadsRun == \A s \in runStarts : Verdict(s) = "read"

\* 4b. The view calls d1_raw only on a host that can run reads ...
RunsOnlyWhereHostRuns == ~rawOffHost

\* 4c. ... and posts to the chat only on a host that takes messages.
SendsOnlyWhereHostSends == ~postOffHost

\* 5. The card never waits forever on a send: while it says Sending, a
\*    SEND_TIMEOUT_MS timer is armed that will end it (sent / refused /
\*    unconfirmed). Assumes browser timers fire.
SendAlwaysTimed == card.run.status = "sending" => card.run.id \in timers
=============================================================================
