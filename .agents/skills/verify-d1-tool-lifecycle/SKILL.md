---
name: verify-d1-tool-lifecycle
description: "Model-check the tool-call lifecycle of the D1 Studio MCP App view (mountMcpApp in src/mcp-apps/app-shell/mount.tsx: pending/show/settled/answered, Try again via callServerTool, ontoolinput/ontoolresult/ontoolcancelled, connect().then(onOk, onFail), followHost/drawnFor). Use before and after any change to mount.tsx, to how D1 Studio calls mountMcpApp (renderPending/renderError/retry in src/d1-studio/app/d1-studio-app.tsx), or to the @modelcontextprotocol/ext-apps version, and whenever someone asks whether a late host event or a retry can put the wrong thing on screen."
---

# Verify the D1 Studio tool-call lifecycle

The view of an MCP App gets host events in an order it does not control: the
connect settling, `tool-input`, `tool-result`, `tool-cancelled`,
`host-context-changed`, and the user's Try again with its own
`callServerTool` that settles later. A TLA+ model checks every order of
those events and tells you which rules about the screen hold.

## Does your change touch this?

Yes if the diff touches any of these:

- `src/mcp-apps/app-shell/mount.tsx`, function `mountMcpApp`: `draw`, `last`,
  `drawnFor`, `followHost`, `pending`, `settled`, `answered`, `show`,
  `retryFor`, the `ontoolinput` / `ontoolresult` / `ontoolcancelled` /
  `onhostcontextchanged` handlers, and `app.connect().then(onOk, onFail)`.
- The `mountMcpApp({...})` call at the bottom of
  `src/d1-studio/app/d1-studio-app.tsx`, and `ToolError` (the Try again button
  appears exactly when `retry` is defined).
- The `@modelcontextprotocol/ext-apps` version in `package.json` (the model
  relies on `App.connect` storing hostContext/hostCapabilities from
  `ui/initialize` and calling `close()` when it fails, which ends notifications).

`reportSize`, `applyTheme`, `applyLocale` and what `render` draws are not
covered. `Studio` and its `useAnswerCard` (the answer card's own machine) are
what `render` draws, so they are outside this model.

## Coverage record

| Covered | Sync point | `git hash-object` at sync |
| --- | --- | --- |
| `src/mcp-apps/app-shell/mount.tsx` (`mountMcpApp`) | commit `1a0a9230` | `d9188fae061831d7dc414ab7ca1b7241436b6eb9` |
| `src/d1-studio/app/d1-studio-app.tsx` (`mountMcpApp` call, `ToolError`) | commit `1a0a9230` | `1ec41047aae192de47e285a8c96f5d0c51b80478` |
| `@modelcontextprotocol/ext-apps` | `2.0.4` | (package version) |

The sync point is commit `1a0a9230b359b622a21c7a668b5110c57ab264a7`. Check
with `git log 1a0a9230..HEAD -- src/mcp-apps/app-shell/mount.tsx src/d1-studio/app/d1-studio-app.tsx package.json`
(and, for uncommitted work, `git diff 1a0a9230 -- <file>`); the hashes are a
second check (`git hash-object src/mcp-apps/app-shell/mount.tsx src/d1-studio/app/d1-studio-app.tsx`).
`d1-studio-app.tsx` changes often for other reasons: only its `mountMcpApp`
call and `ToolError` are covered. If a covered part differs, read the diff of
`mountMcpApp` and decide whether the model still describes it. Move the sync
point (commit and hashes) forward only after you have confirmed the model
describes the code at the new point.

Checked with TLC 2.19 (via /statechart) and bun 1.3.5.

## Files

- `model/D1ToolLifecycle.tla`: the model. Each action is one handler or one
  promise settlement in `mountMcpApp`; its comment quotes the code.
- `model/AnyOrder.cfg`: host notifications in any order (each at most once).
- `model/Compliant.cfg`: the host follows the MCP Apps order (no `tool-*`
  before `ui/initialize` completes, `tool-input` before `tool-result`, at most
  one of `tool-result` / `tool-cancelled`, nothing after them).
- `model/view.mjs`: the chart's words, for /statechart.
- `replay/lifecycle.test.ts`: replays each path against the real
  `mountMcpApp` with a fake ext-apps `App` and a fake React root.

## Run

1. Run /statechart on `model/D1ToolLifecycle.tla` with `--view model/view.mjs`,
   once with `--config model/AnyOrder.cfg` and once with
   `--config model/Compliant.cfg`, each into a new scratch `--out` folder
   outside the repo. Each run takes a few seconds (about 160 and 37 states).
2. From the repo root: `bun test ./.agents/skills/verify-d1-tool-lifecycle/replay/lifecycle.test.ts`
   (the leading `./` matters: bun skips dot-folders otherwise). Do not run the
   whole `npm test` for this.

Read every TLC result through /statechart's report: it names each rule that
breaks and gives its shortest path in the chart's words.

## Rules (in the user's words) and expected results

Bounds: one host tool call, each host notification at most once, up to 3 Try
again clicks (`MAX_RETRIES`), every order of retry settlements.

| Rule | Sentence | AnyOrder | Compliant |
| --- | --- | --- | --- |
| `InputKeepsAnswer` | Once a result or error is on screen, a late tool-input never replaces it with "Loading". | holds | holds |
| `LatestCallShown` | What's on screen is the answer to the latest call you asked for. | holds | holds |
| `NoLoadingAfterCancel` | After the host cancels, the view doesn't go back to "Loading" unless you press Try again. | holds | holds |
| `ConnectFailKeepsAnswer` | A failed connect never hides a result already shown. | holds | holds |
| `CancelKeepsAnswer` | A cancel from the host never hides a result already shown. | holds | holds |
| `RetrySameArguments` | Try again runs the tool with the same arguments as the call that failed. | holds | holds |
| `RetryOfferedWhenPossible` | When the host can run the tool again with the call's arguments, the error offers Try again (also when the tool name or the arguments arrive after the error). | holds | holds |

A result that differs from this table means the code or the model changed.
`TypeOK` and `NoDeadlock` must always hold.

### History

- First sync (mount.tsx `15dcb4f5…`): `NoLoadingAfterCancel`,
  `ConnectFailKeepsAnswer`, `CancelKeepsAnswer` and `RetrySameArguments` broke
  in AnyOrder. Fixed in `e7f95219…` by the `answered` flag, `settled = true` in
  `ontoolcancelled`, the `!answered` check in the connect's onFail, and
  `input &&` in `retryFor`. That fix narrowed the Try again promise to "once the
  call's arguments are known", so `RetryOfferedWhenPossible` names the arguments.
- `e7f95219…`: `RetryOfferedWhenPossible` broke in AnyOrder (error before
  tool-input; `ontoolinput` saw `settled` and did not redraw, so Try again
  never appeared). Fixed in `d9188fae…` by `else root.render(last())` in
  `ontoolinput`.

All seven rules hold in both configs at the sync point (re-checked at
`1a0a9230`: 160 and 37 states). The replay tests under
"fixed" and "rules that hold" assert the rules on the paths that come closest.

## Is it a real bug or a modeling error?

When a rule breaks that the table says holds, take the shortest path from the
report and replay it in `replay/lifecycle.test.ts`, one handler call per step
(`connectSucceeds`, `connectFails`, `hostContextChanged`, `hostToolInput`,
`hostToolResult`, `hostToolCancelled`, `userRetries`, `retryReturns`).
If the real code shows the same screen, it is a bug in the code: report it with
the path, and do not weaken the rule or the model. If the real code does not,
the model is wrong until you show otherwise: find the action whose effect
differs from the handler and fix the model.

Things the model assumes, which a change can invalidate:
- One handler runs to completion; `root.render` takes effect before the next
  click (React flushes a render scheduled from a click before the next input
  event), so Try again is gone from the screen once it has drawn `pending()`.
- `followHost` re-renders `last`; it is not a new draw.
- The Try again button exists iff the error view was drawn with a tool name
  (`drawnFor`) and `getHostCapabilities().serverTools` (`retryFor`).
- `callServerTool` results arrive only through the retry promise, never as a
  host `tool-result`.
- A re-render of `last` (followHost) re-reads `toolName()` and `input` in
  `retryFor`; `drawnTool` / `drawnInput` are what that last render saw.
- Not modelled: `tool-input-partial`, teardown, the host connection dropping
  after connect, a throw inside the connect's onOk (since `.then(onOk, onFail)`
  it is not turned into "Could not connect"; it leaves the screen as is), and
  what `render` draws.

## When a change is intended

Change the action that mirrors the changed handler, keep its comment quoting
the code, and keep every rule as the user would state it. Then make sure the
check can still fail: apply each one-line break below to a copy of the model
(outside the repo) and confirm the named rule breaks; and to a copy of
`mount.tsx` (run the replay with `MOUNT_PATH=/abs/path/to/copy/mount.tsx`;
rewrite its `./apply-locale` and `./locale` imports to absolute paths, and
put a `node_modules` symlink to the repo's next to it) and confirm the named
replay test fails.

| Break in `mount.tsx` | Model change | Rule that must break (replay test that must fail) |
| --- | --- | --- |
| `ontoolinput`: `if (!settled) pending()` → `pending()` | `HostToolInput`: `IF ~settled` → `IF TRUE` | `InputKeepsAnswer` (AnyOrder) |
| `retryFor`: delete `pending()` | `UserRetries`: replace `Draw("loading", -1, "retry")` with `UNCHANGED <<screen, shownCall, drawnTool, drawnInput, by, over>>` | `LatestCallShown` (both) |
| `followHost`: drop `\|\| toolName() !== drawnFor` | `ConnectSucceeds` / `HostContextChanged`: the re-render becomes optional | `RetryOfferedWhenPossible` (both) |
| `ontoolcancelled`: delete `settled = true` | `HostToolCancelled`: `UNCHANGED settled` | `NoLoadingAfterCancel` (AnyOrder) |
| `ontoolcancelled`: delete `if (answered) return` | `HostToolCancelled`: `IF answered` → `IF FALSE` | `CancelKeepsAnswer` (AnyOrder) |
| connect onFail: `if (!answered) draw(...)` → `draw(...)` | `ConnectFails`: `IF ~answered` → `IF TRUE` | `ConnectFailKeepsAnswer` (AnyOrder) |
| `retryFor`: drop `input &&` | `UserRetries`: drop `drawnInput` | `RetrySameArguments` (AnyOrder) |
| `ontoolinput`: delete `else root.render(last())` | `HostToolInput`: ELSE becomes `UNCHANGED <<screen, shownCall, drawnTool, drawnInput, by, over>>` | `RetryOfferedWhenPossible` (AnyOrder) |

Then update the coverage record.
