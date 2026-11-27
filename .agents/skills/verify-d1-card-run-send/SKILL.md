---
name: verify-d1-card-run-send
description: Model-check the D1 Studio answer card's Run / Send-to-chat hand-off (cardReducer's submit, run.*, send.*, revert, run.sql, offset, draft.change, fold; useAnswerCard and useRunEffects; RunButton, submitKey's ⌘↵, Revert, copyIsPrimary; going fullscreen and back) in TLA+ through /statechart, and replay the paths against the real cardReducer. Use when a change touches src/d1-studio/app/machines.ts (Run, CardEvent, CardState.can, cardReducer, isBusy, isHandedOff, submitAction, canRevert, limitPaging, initialCard), verdict.ts (verdictOf), run.ts (runRead, sendToChat, hostAbilities), or the run/send effects and dispatch sites in d1-studio-app.tsx / console.tsx.
---

# Verify the D1 Studio card's run / send-to-chat hand-off

The answer card lets the user re-run a read in the view (`d1_raw` through `callServerTool`, no model turn) or hand a write to the chat (`ui/message`) for the user to approve. Host replies (run result, host error, send ok, send refused, the 5 s timeout) can arrive in any order, late, or never. A bad order here can post the same `DELETE` to the chat twice, or hide that the chat already has it. Tests check the orders someone thought of. This check covers every order of user steps and host replies, within the bounds below.

Tool: TLA+, checked by TLC through the `/statechart` skill. The question is whether events can happen in a bad order, and a model checker over a small model answers that. Read every result with `/statechart`: it gives the shortest path to each broken rule in plain words, and it draws the chart.

## Files

- `model/CardRunSend.tla`: the model. Each operator names the code it mirrors.
- `model/holds.cfg`: every rule, at the full bounds. At the sync commit all of them hold, so a break is a regression or a new finding.
- `model/chart.cfg`: smaller bounds, so `/statechart` can draw the whole flow for a reader.
- `model/view.mjs`: the reader's words for states and steps (the `--view` module).
- `replay/card-run-send.test.ts`: replays each path against the real `cardReducer`. The editor's ⌘↵ goes through `submitKey`, which, like `copyIsPrimary`, is mirrored in the test: d1-studio-app.tsx mounts the app when it is imported. Recheck both mirrors when that file's hash changes. A new finding goes in as `finding(...)` (bun `test.failing`).
- `check.sh`: runs both configs and the replay.

## Run it

From the repo root, with `STATECHART` set to the `/statechart` skill's command on this machine (read that skill to find it; it is not copied here):

```sh
STATECHART=<the /statechart command> .agents/skills/verify-d1-card-run-send/check.sh
```

It takes about 10 s. Expected at the sync commit:

- holds: `Rules that hold:` all seven (61,812 states).
- chart: the five rules in chart.cfg hold (416 states, 7 chart states, 13 arrows).
- replay: 12 pass, 0 fail.

Show the chart: `chart/chart.mmd` from that run, as a `mermaid` block.

## The rules (user words; never weaken one to make it pass)

| Invariant | Rule | Harm if broken | At sync commit |
|---|---|---|---|
| AbandonedReplyIgnored | A reply to a run or send the user abandoned (Revert, a new run) never changes the card. | A slow old answer overwrites what the user is now looking at. | holds |
| WriteReachesChatOnce | A write reaches the chat at most once unless the draft changes. | The same write sits in the chat twice; approving both runs it twice. | holds (was broken) |
| ChatGotItCardSaysSo | When the chat has received the write, the card doesn't claim nothing was sent. Until the card has shown Sent for it, the card stays on that hand-off (Sending / Waiting on host). **Exception, by design:** once the card has said it couldn't confirm (Waiting on host, Copy SQL offered), Revert or editing the draft may clear it. | The write is in the chat, the card looks as though it never left, and the user sends it again. | holds (was broken) |
| OnlyReadsRun | Only a read is ever run (handed to `runRead` / `d1_raw`). | A write would run with no approval. | holds (and `runRead` refuses a non-read anyway; in Code Mode the server refuses one too, outside the model: `rawCallRefusal` in src/d1-studio/tool.ts, run through `appToolCheck` / `appToolRefusal` by `registerAppGeneratedTools`) |
| RunsOnlyWhereHostRuns | The view calls `d1_raw` only on a host that advertised `serverTools`. | A host error, or a spinner that never stops, where the UI says the host can't run. | holds (was broken) |
| SendsOnlyWhereHostSends | The view posts `ui/message` only on a host that advertised `message`. | ⌘↵ posts to a host that never offered messages. | holds (was broken) |
| SendAlwaysTimed | The card never waits forever on a send: while it says Sending, a SEND_TIMEOUT_MS timer is armed (so it ends Sent / Refused / Waiting on host). | A spinner forever on hosts that never answer. | holds |

ChatGotItCardSaysSo was rephrased at the second sync, and on purpose. The first version exempted any write after the user typed a new draft, and Revert or a remount while Sending broke it. The product now promises what the table says. Revert is refused while Sending (`canRevert` false, `revert` a no-op), and fullscreen-and-back keeps the machine. The exception for "after Waiting on host" is a product decision, written into the rule, not hidden. Typing no longer exempts anything, so that part of the rule is now stricter.

History: at the first sync (same HEAD, earlier file hashes) the four "was broken" rules broke. The causes were ⌘↵ in Sent/unconfirmed re-sending; Revert or a display remount while Sending; the LIMIT pager and ⌘↵ running reads on a host without `serverTools`; and ⌘↵ posting on a host without `message`.

## Bounds and what the model leaves out

- holds.cfg: three runs or sends per card (`MaxId = 3`), any number of trips to fullscreen and back, every combination of `can.run` and `can.send`, and drafts of kind agent's read / other read / write / bad (typo, several statements, text after `;`, empty). `MaxId = 4` (548,340 states) also passed at the second sync. chart.cfg: one run or send, both abilities.
- SQL is abstracted to its `verdictOf` kind. `verdictOf` itself is not verified here.
- A reducer step plus the effects React runs after it count as one step.
- The model leaves out rows, sort, paging reads (`fetch`), `found`, the copy trio, and `updateModelContext`. They don't touch `run`. A copy changes no state.
- Revert is allowed whenever `canRevert`. The real UI shows it only in some bands, so this over-approximates.
- The model assumes browser timers fire. It doesn't prove liveness.
- A read the host never answers ends after `READ_TIMEOUT_MS` (35 s): `runRead` passes it to `callServerTool` and fails with "No answer from D1 in 35 s.", which `useRunEffects` dispatches as `run.error`. The model's `HostFailsRead` covers that failure at any time. It doesn't prove the timer fires (no liveness rule).
- WriteReachesChatOnce allows a new post after the draft changed. So "Waiting on host", then Revert (or an edit), then retyping the same write and sending can put it in the chat twice if the first copy lands late. The rule's "unless the draft changes" allows this, by the design decision above.
- If the user edits the draft while Sending, the send goes on and ends Sent for the old SQL. A different write then needs one more edit before it can be sent (`isHandedOff`). This is a UX detail, not a rule.
- The fullscreen Console's own cards (console.tsx `Main`) use the same reducer, effects and `submitKey`, but they aren't modeled.

## Does my change touch this?

Yes, if it changes any of these:
- machines.ts: `Run`, `CardEvent`, `CardState.can`, `initialCard`, `isBusy`, `isHandedOff`, `submitAction`, `canRevert`, `limitPaging`, or the `cardReducer` cases `submit`, `run.done`, `run.error`, `send.done`, `send.error`, `send.timeout`, `run.sql`, `offset`, `revert`, `draft.change`, `fold`.
- verdict.ts: `verdictOf`.
- run.ts: `runRead` (with `READ_TIMEOUT_MS`), `sendToChat`, `hostAbilities`.
- The server's refusal of the view's `d1_raw` (not modeled, but OnlyReadsRun cites it): `rawCallRefusal` in src/d1-studio/tool.ts, `appToolRefusal` in src/mcp-apps/registry.ts, `registerAppGeneratedTools` in src/tools/forge-tools.ts.
- d1-studio-app.tsx: `useAnswerCard`, `useRunEffects`, `SEND_TIMEOUT_MS`, `Studio`'s display switch and `fold`, `RunButton`, `copyIsPrimary`, `submitKey`, the Editor's onKeyDown, Revert, the fix line's `onUse`, or the LIMIT pager.
- console.tsx: its ⌘↵ or `consoleReducer`.

## Reading a result

- A rule breaks: read its path in the report. Replay it as a test in `replay/card-run-send.test.ts`, with one dispatch per step. If the real reducer does the same thing, it is a real bug. Report it as a `finding(...)`, and don't change the rule. If the reducer does not, the model is wrong (an operator no longer matches the code): fix the model and say so.
- "Rules not checked" in a report: a run hit `/statechart`'s state bound after a break. Check those rules in a config without the breaking rule.
- An intended behavior change: change the matching operator in CardRunSend.tla, and cite the code in its comment. Update view.mjs and the replay mirrors, then rerun.

## Proof that the check can fail (done at the second sync)

Each rule was broken by restoring the old line, on copies of the model, and each break was caught (statechart report, holds.cfg bounds):

- WriteReachesChatOnce: drop `|| isHandedOff(state.run)` from `submit`. It breaks in 6 steps: open editor, type a write, ⌘↵, the chat confirms (Sent), ⌘↵ (sending again), the chat confirms. The same change on a /tmp copy of `src/d1-studio/app`, run through the replay (`D1_STUDIO_APP=<copy> bun test <replay file>`), fails both WriteReachesChatOnce tests.
- ChatGotItCardSaysSo: restore Revert during Sending, both lines (`canRevert`'s sending check and `revert`'s guard). It breaks in 5 steps: open editor, type a write, ⌘↵, Revert, the chat confirms. Restoring only the reducer's guard is **not** caught, because `canRevert` still hides Revert. That is defense in depth. The old display remount was a structural change, so it has no one-line variant.
- RunsOnlyWhereHostRuns: put back `!state.editable` in `run.sql` / `limitPaging`, and it breaks in 1 step (the LIMIT pager). Separately, drop `submit`'s `can.run` check, and it breaks in 2 steps (open editor, ⌘↵).
- SendsOnlyWhereHostSends: dropping `submit`'s `!state.can.send` alone is **not** caught, because `submitKey` and `RunButton` copy instead. Also restoring the old ⌘↵ (always `submit`) breaks it in 3 steps.
- AbandonedReplyIgnored (drop `run.done`'s id check): breaks in 4 steps. OnlyReadsRun (`submitAction` runs writes): breaks in 3 steps. SendAlwaysTimed (no `setTimeout`): breaks in 3 steps.

To repeat on the real code, copy `src/d1-studio/{contract,statement}.ts` and `src/d1-studio/app/{machines,verdict}.ts` to a scratch folder (with `node_modules` linked), make the one-line change there, and run the replay with `D1_STUDIO_APP`. Never edit `src/` for this.

## Coverage record

Last confirmed (third sync) at commit `1a0a9230b359b622a21c7a668b5110c57ab264a7`, which contains the covered code. The blobs there (`git hash-object`) are a second check:

```
1b7e8dadf75d2b7497153b468a705f458e7097cd src/d1-studio/app/machines.ts
8358e927a38f96c994aa311526cf42fa08ab5306 src/d1-studio/app/verdict.ts
1ec41047aae192de47e285a8c96f5d0c51b80478 src/d1-studio/app/d1-studio-app.tsx
8067a00417af11cf150311e91b33dfb7c0648caf src/d1-studio/app/console.tsx
6b93f137a34084c89f17a9fbe8a05b2c2d58e0f5 src/d1-studio/app/run.ts
6ca9db13ad3c5b6b01be0e40059c4b594b6301be src/d1-studio/statement.ts
564e134b78fe4a3a6044a65c410ebf52a2ecbbc0 src/d1-studio/tool.ts
11c4133133a4b884a7f2785db69a33153fe6a2af src/mcp-apps/registry.ts
a56597195698a6bb9a692bdb12a26c8352dd59ee src/tools/forge-tools.ts
```

The last three are the server-side refusal OnlyReadsRun cites; the model doesn't describe them.

Before you trust a result, run `git log --oneline 1a0a9230..HEAD -- <files>` and `git diff 1a0a9230 -- <files>` (or compare `git hash-object` with the blobs). If a file differs, read the diff of the functions listed under "Does my change touch this?" against the model's operators and the replay's mirrors (`copyIsPrimary`, `submitKey`). Move this record (commit and blobs) forward only after you confirm that the model describes the code at the new commit.
