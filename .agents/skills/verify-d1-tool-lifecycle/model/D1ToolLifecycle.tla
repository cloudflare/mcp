---------------------------- MODULE D1ToolLifecycle ----------------------------
(***************************************************************************)
(* The tool-call lifecycle of an MCP App view, as `mountMcpApp` in         *)
(* src/mcp-apps/app-shell/mount.tsx runs it for D1 Studio                  *)
(* (src/d1-studio/app/d1-studio-app.tsx: renderPending = <Pending>,         *)
(* renderError = <ToolError> with its "Try again" button).                 *)
(*                                                                         *)
(* Each action below is one JavaScript task: one host notification handler,*)
(* one promise settlement, or one click. JS runs each to completion, so    *)
(* each is one atomic step. `root.render(...)` is modelled as setting      *)
(* `screen`: React flushes a render started in a click before the next     *)
(* click, so the Try again button is gone once Retry has drawn pending.    *)
(*                                                                         *)
(* COMPLIANT = TRUE  : the host follows the MCP Apps order (ext-apps        *)
(*   AppBridge docs): tool-* notifications only after ui/initialize, the   *)
(*   tool-input once and before tool-result, at most one of tool-result /  *)
(*   tool-cancelled, nothing after them.                                   *)
(* COMPLIANT = FALSE : each host notification still arrives at most once,  *)
(*   but in any order, and any time before a failed connect closes the     *)
(*   transport (App.connect calls close() on failure).                     *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS COMPLIANT, MAX_RETRIES

VARIABLES
  conn,          \* app.connect(): "connecting" | "connected" | "failed"
  toolKnown,     \* app.getHostContext()?.toolInfo is set (toolName() defined)
  serverTools,   \* app.getHostCapabilities()?.serverTools
  inputSet,      \* `input` holds the host's tool-input arguments
  resultSent,    \* host has sent ui/notifications/tool-result
  cancelSent,    \* host has sent ui/notifications/tool-cancelled
  settled,       \* mount.tsx `settled`
  answered,      \* mount.tsx `answered`: set by `show`, never reset
  screen,        \* what `last` draws: "loading" | "answer" | "error" | "cancelled" | "disconnected"
  shownCall,     \* which call's answer is drawn: 0 = the host's call, k = k-th Retry, -1 = none
  drawnTool,     \* mount.tsx `drawnFor` is defined (the view was drawn knowing the tool name)
  drawnInput,    \* `input` was defined when `last` was last rendered (retryFor reads it then)
  calls,         \* Retry clicks so far; the latest call the user asked for
  inflight,      \* Retry callServerTool promises not yet settled
  \* history, only for the rules:
  by,            \* the handler whose `draw` is on screen
  over,          \* the screen that draw replaced
  noArgs,        \* the latest Try again called the tool with `input ?? {}` = {}
  cancelSeen,    \* "Cancelled." has been drawn
  retriedSince   \* the user clicked Try again after "Cancelled." was drawn

vars == <<conn, toolKnown, serverTools, inputSet, resultSent, cancelSent, settled, answered,
          screen, shownCall, drawnTool, drawnInput, calls, inflight,
          by, over, noArgs, cancelSeen, retriedSince>>

Answer == {"answer", "error"}

\* Host notifications reach the handlers only while the transport is open.
HostMayNotify == IF COMPLIANT THEN conn = "connected" ELSE conn /= "failed"
HostToolDone  == resultSent \/ cancelSent

Init ==
  /\ conn = "connecting"
  /\ toolKnown = FALSE /\ serverTools = FALSE
  /\ inputSet = FALSE /\ resultSent = FALSE /\ cancelSent = FALSE
  /\ settled = FALSE /\ answered = FALSE
  /\ screen = "loading"          \* mountMcpApp: `pending()` before connect
  /\ shownCall = -1
  /\ drawnTool = FALSE /\ drawnInput = FALSE
  /\ calls = 0 /\ inflight = {}
  /\ by = "mount" /\ over = "nothing"
  /\ noArgs = FALSE /\ cancelSeen = FALSE /\ retriedSince = FALSE

\* `draw(node)` from handler `who`: sets `last`, renders it, sets `drawnFor = toolName()`.
\* Every caller leaves toolKnown and inputSet unchanged (HostToolInput draws
\* only the pending view, which has no Try again, so drawnInput is moot there).
Draw(s, call, who) ==
  /\ screen' = s
  /\ shownCall' = call
  /\ drawnTool' = toolKnown
  /\ drawnInput' = inputSet
  /\ by' = who
  /\ over' = screen

\* followHost re-renders `last` (the same view, not a new draw).
NoDraw == UNCHANGED <<screen, shownCall, by, over>>

\* app.connect() resolves: App stores hostCapabilities and hostContext from the
\* ui/initialize result (replacing any earlier context), then the onOk callback
\* of `.then(onOk, onFail)`: followHost.
ConnectSucceeds ==
  /\ conn = "connecting"
  /\ conn' = "connected"
  /\ toolKnown' \in BOOLEAN
  /\ serverTools' \in BOOLEAN
  \* followHost: re-renders `last` when toolName() !== drawnFor (or the locale /
  \* display mode changed), which sets drawnFor and re-reads `input` in retryFor.
  /\ IF toolKnown' /= drawnTool
       THEN drawnTool' = toolKnown' /\ drawnInput' = inputSet
       ELSE \E rerender \in BOOLEAN :
              IF rerender THEN drawnTool' = toolKnown' /\ drawnInput' = inputSet
                          ELSE UNCHANGED <<drawnTool, drawnInput>>
  /\ NoDraw
  /\ UNCHANGED <<inputSet, resultSent, cancelSent, settled, answered, calls, inflight,
                 noArgs, cancelSeen, retriedSince>>

\* app.connect() rejects: App.close(), then onFail: `if (!answered) draw(disconnected)`.
ConnectFails ==
  /\ conn = "connecting"
  /\ conn' = "failed"
  /\ IF ~answered
       THEN Draw("disconnected", -1, "connectFails")
       ELSE UNCHANGED <<screen, shownCall, drawnTool, drawnInput, by, over>>
  /\ UNCHANGED <<toolKnown, serverTools, inputSet, resultSent, cancelSent, settled, answered,
                 calls, inflight, noArgs, cancelSeen, retriedSince>>

\* onhostcontextchanged = followHost, after App merges the new context.
\* Only a change that brings toolInfo matters to this lifecycle.
HostContextChanged ==
  /\ HostMayNotify
  /\ ~toolKnown
  /\ toolKnown' = TRUE
  /\ drawnTool' = TRUE           \* followHost: toolName() !== drawnFor, so re-render `last`
  /\ drawnInput' = inputSet      \* ... which re-reads `input` in retryFor
  /\ NoDraw
  /\ UNCHANGED <<conn, serverTools, inputSet, resultSent, cancelSent, settled, answered,
                 calls, inflight, noArgs, cancelSeen, retriedSince>>

\* ontoolinput: `input = params.arguments; if (!settled) pending(); else root.render(last())`.
HostToolInput ==
  /\ HostMayNotify
  /\ ~inputSet
  /\ COMPLIANT => ~HostToolDone
  /\ inputSet' = TRUE
  /\ IF ~settled
       THEN Draw("loading", -1, "toolInput")
       \* re-render `last` (not a new draw): sets drawnFor and re-reads `input` in retryFor
       ELSE /\ drawnTool' = toolKnown
            /\ drawnInput' = TRUE
            /\ NoDraw
  /\ UNCHANGED <<conn, toolKnown, serverTools, resultSent, cancelSent, settled, answered,
                 calls, inflight, noArgs, cancelSeen, retriedSince>>

\* ontoolresult: `followHost(); show(result)`. show sets settled and answered and draws the
\* result (render or malformed: "answer") or, for isError, renderError ("error").
HostToolResult ==
  /\ HostMayNotify
  /\ ~resultSent
  /\ COMPLIANT => (inputSet /\ ~cancelSent)
  /\ resultSent' = TRUE
  /\ settled' = TRUE
  /\ answered' = TRUE
  /\ \E s \in Answer : Draw(s, 0, "toolResult")
  /\ UNCHANGED <<conn, toolKnown, serverTools, inputSet, cancelSent, calls, inflight,
                 noArgs, cancelSeen, retriedSince>>

\* ontoolcancelled: `if (answered) return; settled = true; draw(cancelled)`.
HostToolCancelled ==
  /\ HostMayNotify
  /\ ~cancelSent
  /\ COMPLIANT => ~resultSent
  /\ cancelSent' = TRUE
  /\ IF answered
       THEN UNCHANGED <<settled, screen, shownCall, drawnTool, drawnInput, by, over,
                        cancelSeen, retriedSince>>
       ELSE /\ settled' = TRUE
            /\ cancelSeen' = TRUE
            /\ retriedSince' = FALSE
            /\ Draw("cancelled", -1, "toolCancelled")
  /\ UNCHANGED <<conn, toolKnown, serverTools, inputSet, resultSent, answered,
                 calls, inflight, noArgs>>

\* The user clicks "Try again" in <ToolError>. The button exists only when the
\* error view was last rendered with `retryFor(toolName())` defined: a tool
\* name, `input` defined, and the host's serverTools capability. The closure:
\* `settled = false; pending();
\* app.callServerTool({ name, arguments: input ?? {} })`.
UserRetries ==
  /\ screen = "error"
  /\ drawnTool /\ drawnInput /\ serverTools
  /\ calls < MAX_RETRIES
  /\ calls' = calls + 1
  /\ inflight' = inflight \cup {calls + 1}
  /\ settled' = FALSE
  /\ noArgs' = ~inputSet
  /\ retriedSince' = (retriedSince \/ cancelSeen)
  /\ Draw("loading", -1, "retry")
  /\ UNCHANGED <<conn, toolKnown, serverTools, inputSet, resultSent, cancelSent, answered,
                 cancelSeen>>

\* A Retry's callServerTool settles: `.then(show)` or `.catch(e => show(isError))`.
RetryReturns ==
  \E k \in inflight :
    /\ inflight' = inflight \ {k}
    /\ settled' = TRUE
    /\ answered' = TRUE
    /\ \E s \in Answer : Draw(s, k, "retryReturns")
    /\ UNCHANGED <<conn, toolKnown, serverTools, inputSet, resultSent, cancelSent,
                   calls, noArgs, cancelSeen, retriedSince>>

Moves ==
  \/ ConnectSucceeds \/ ConnectFails \/ HostContextChanged
  \/ HostToolInput \/ HostToolResult \/ HostToolCancelled
  \/ UserRetries \/ RetryReturns

\* Nothing more can happen (the lifecycle is over, or the Retry bound is hit).
Done == ~ENABLED Moves /\ UNCHANGED vars

Next == Moves \/ Done

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ conn \in {"connecting", "connected", "failed"}
  /\ screen \in {"loading", "answer", "error", "cancelled", "disconnected"}
  /\ shownCall \in -1..MAX_RETRIES
  /\ calls \in 0..MAX_RETRIES
  /\ inflight \subseteq 1..MAX_RETRIES

(***************************************************************************)
(* The rules, in the user's words.                                         *)
(***************************************************************************)

\* Once a result or error is on screen, a late tool-input never replaces it with "Loading…".
InputKeepsAnswer == ~(by = "toolInput" /\ over \in Answer)

\* After the host cancels the call, the view doesn't go back to "Loading…" unless you press Try again.
NoLoadingAfterCancel == (cancelSeen /\ screen = "loading") => retriedSince

\* What's on screen is the answer to the latest call you asked for.
LatestCallShown == screen \in Answer => shownCall = calls

\* A failed connect never hides a result already shown.
ConnectFailKeepsAnswer == ~(by = "connectFails" /\ over \in Answer)

\* A cancel from the host never hides a result already shown.
CancelKeepsAnswer == ~(by = "toolCancelled" /\ over \in Answer)

\* Try again runs the tool with the same arguments as the call that failed.
RetrySameArguments == ~(by = "retry" /\ noArgs)

\* When the host can run the tool again with the call's arguments, the error offers Try again
\* (also when the tool name or the arguments arrive after the error).
RetryOfferedWhenPossible ==
  (screen = "error" /\ conn = "connected" /\ toolKnown /\ serverTools /\ inputSet)
    => (drawnTool /\ drawnInput)

=============================================================================
