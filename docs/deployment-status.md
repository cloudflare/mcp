# Worker deployment status App

`workers_deployment_status` is a read-only tool in both Code Mode and direct mode. It serves a self-contained MCP App at `ui://cloudflare/deployment-status.html`; clients without Apps can read the same evidence as text and structured content.

## What it proves

Given an exact Worker name and account (or the connection's sole account), the collector reads the accessible scripts, the latest active deployment and up to 25 build records. An optional `build_id` selects a historical build, whose trigger must belong to this Worker. It links active version IDs to build IDs and re-reads the deployment before claiming traffic for a successful build.

The card distinguishes live (100% linked traffic), partial traffic, a successful build not serving traffic, queued/running builds, failed/stopped builds, missing build history and unverified reads. Missing access, unsupported responses and deployment races must not appear as a successful deployment or an offline site.

**Live means deployment traffic, not HTTP health.** This tool does not inspect DNS, make website requests, establish content correctness, cover Pages, or diagnose failure causes from log text. A failed build does not establish the cause, nor imply the previously deployed site is down. The five Stratus stages—Initializing, Cloning, Installing, Building and Deploying—come from structured `events` on the selected build's logs response, with durations and millisecond start timestamps. The collector retains only those events, not log text. Missing events are unavailable rather than inferred; the final started stage of a failed build carries the failure marker, as in Stratus. Stage-read failures do not override independently collected deployment evidence. The server derives one `failureStage` from a terminal failed run and its last started event, matching Stratus's attribution rule. Message, badge and red timeline marker consume that same field. This is stage attribution, not a root-cause error from the API; missing or ambiguous events keep failure wording generic.

## Implementation

Built on the shared MCP Apps foundation (`docs/mcp-apps.md`).

- `src/deployment-status/contract.ts`: validated input/output and tool metadata.
- `src/deployment-status/tool.ts`: `deploymentStatusApp`, a `defineMcpApp` whose collector reads through `apiReader` (bounded, read-only, existing refusal and scope-challenge handling).
- `src/deployment-status/app/`: React/Kumo App, Details and copy summary, mounted with the shared `mountMcpApp`.
- `npm run app:build` regenerates `app-html.generated.ts`; `npm run check` checks generated HTML freshness and both TypeScript configurations.

API bodies are limited to 1 MB per read and parsed with Zod. Only selected metadata is returned; build environment variables are not copied. No credentials enter the App and it makes no Cloudflare requests itself.

## Verification

The full repository check passed with 47 test files / 719 tests. Deployment tests exercise both tool modes, traffic linking, failed builds, missing version links, partial traffic, inaccessible Workers, missing history, concurrent deployment changes, cross-Worker historical builds, refused API reads and static App resources. Both Worker bundles passed Wrangler dry runs.

A local-only stdio adapter connected this branch to the ChatGPT desktop host using real, read-only Cloudflare API requests. Natural-language conversations (no tool names or card requests) selected the tool and rendered:

1. Latest build deployed to 100% traffic, with the answer explicitly distinguishing routing from availability.
2. A historical failed build, with the answer declining to invent a failure cause without logs.
3. A deliberately nonexistent Worker, rendered as Unverified rather than an offline site.

The third case is a synthetic negative target, not a production API outage. API refusals are covered in integration tests, not claimed as a captured live permission failure. Screenshots include the host conversation and rendered card; Details expansion was also checked. Raw Braintrust research, replay inputs, real account output and screenshots are retained outside this public repository. They must not be committed. Braintrust language was adapted to an authorized Worker target; this does not establish support for Pages scenarios.

After visual feedback, a fresh ChatGPT conversation rendered the polished timeline tracks with completion checks, a failed-build indicator and an explicitly unverified deployment stage. The success prompt asked only whether the latest build went out (plus account context); the historical failure prompt asked why that build failed. Neither named a tool, requested a card, or appended mutation restrictions. The failed-build question also led the host to seek build logs through another available connector; the status card itself is outcome evidence, not a failure diagnosis. Mobile layouts, dark host theme and clipboard permissions have not been manually verified in the target host.

### Receipt-style visual verification

The App now follows the local deployment-receipt reference: a quiet identity header, inset content surface, compact commit hierarchy, failure banner, wider building-stage track and expandable evidence. It retains the collector's stage attribution and never imports the prototype's illustrative error diagnoses.

Fresh read-only tool calls for `kumo-docs` verified the latest build's 100% linked traffic and a historical deployment-stage failure. The generated App was rendered through its real `ui/initialize` / tool-result handshake in a local browser host, at 736, 390 and 352 px in light and dark themes. All 18 renders passed overflow, runtime-error, theme and evidence-disclosure checks; screenshots and raw results remain outside the repository at `/tmp/deployment-style-verification/`. A separate unsuccessful historical-build read exercised Unverified; that target was deliberately invalid, not a production outage. The initial pass used the local browser host only. A follow-up rebuilt the ChatGPT stdio adapter (which still held the earlier bundle), started a new ChatGPT desktop conversation and verified the updated Deployed receipt and its evidence disclosure using a fresh API read. The same conversation also verified a fresh historical deployment-stage failure without inventing a failure cause. Screenshots are `chatgpt-success.png`, `chatgpt-failure.png` and `chatgpt-evidence.png` in that private directory. ChatGPT initially tried the generic execute tool; after its approval was declined, clarifying the exact Worker name led it to select the deployment-status tool. This is a recorded tool-selection limitation, not an unqualified first-turn success. Full `npm run check` passed (47 files, 719 tests).

`npm audit` reports an existing moderate Hono advisory on the unchanged dependency; no unrelated dependency upgrade is included here.
