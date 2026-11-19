# Workers usage alert App

`workers_usage_alert` is an MCP App, served in both tool modes at `ui://cloudflare/workers-usage-alert.html`. It previews a monitor that emails when a rolling 7 days of Workers requests passes a threshold. The user drags the threshold over a weekly chart of the last 89 days, enters an email, and confirms.

**The tool reads; the button writes.** The `workers_usage_alert` tool only reads. Clicking Create alert is the user's confirmation: the card shows the threshold, the email and that the alert only emails, and creating it adds one policy the user can delete. The App creates exactly the policy it shows (`monitorPolicy()`) with the generated `alerting_policies_create`, through the host's `callServerTool`, in one call (`src/workers-usage-alert/create.ts`). No tool is added for it: the direct tools list it already, and Code Mode lists it for the App only (`appTools`; see `docs/mcp-apps.md`). It goes through the session's credential with the usual refusal explanations and step-up, and the App never holds a token.

- **Created:** the card shows "Alert on", and the App tells the model with `updateModelContext` that the alert exists, so it neither asks to confirm it nor creates it again. No second model turn is needed. The tool description says the same.
- **Refused:** the field says "Didn’t save" at its trailing edge, the button reads Try again, and screen readers hear Cloudflare's message ("Didn’t save: this account can have at most 5 custom analytics policies"), which is also the hint's tooltip.
- **No `serverTools`:** the App sends the policy to the chat with `sendMessage`, and a host without `message` shows the body for review.

Why not `execute`, or the hand-off to the chat: OpenAI's directory guidelines refuse writes through a generic executor ("Do not use … a generic executor to enable operations not individually exposed for review"), and the hand-off cost a second model turn that asked the user to confirm what they had just confirmed. The MCP Apps spec meant app-only tools for this ("UI-only interactions (refresh buttons, form submissions)"), and neither ChatGPT nor Claude prompts again for a call the view makes ("When your view calls your own server's tools with `app.callServerTool`, the user doesn't see the prompt", Claude).

Verified against real accounts through the local adapter, which allows this POST only for one named test account, in ChatGPT and in both tool modes: one click created the policy with one `alerting_policies_create` call, Cloudflare stored the `168h` window, `1h` interval, threshold, SQL and email as sent, and each policy was deleted. The refusal path was checked on an account already at its five `custom_analytics` policies.

## What it reads

- `POST /graphql`, `workersInvocationsAdaptive` summed by date, for the 89 complete UTC days before today, in one query. Workers analytics refuse anything older than `12w6d` ("cannot request data older than 12w6d"), which is 89 complete days plus today, and one field accepts at most about 32 days (`4w4d`, measured). So the query has three aliased fields of up to 30 days each (`src/workers-usage-alert/history.ts`). Today is still counting, so it isn't read.
- `GET /accounts/{account_id}/alerting/v3/available_alerts`: whether the account can create `custom_analytics`.
- `GET /accounts/{account_id}/alerting/v3/policies`: existing alerts on Workers requests, either `custom_analytics` monitors on `events.workersInvocations` or `billing_usage_alert` on `worker_requests`, with their limit. Other policies are only counted by type. Destinations and email addresses are not returned.

The App's server code sends these reads with the session's credential (`apiReader`), so it gets all 89 days in both tool modes. It doesn't depend on `execute` or on any tool the model can call.

Usage is required. Without it the call is a tool error, explained as missing Account Analytics Read when GraphQL says so. The alerting reads only add context: a refusal becomes a limitation and `null`, never "no alerts exist".

## The proposed monitor

`monitorPolicy()` in `src/workers-usage-alert/model.ts` builds a `custom_analytics` policy on the SQL API:

- `SELECT COUNT(*) AS value FROM events.workersInvocations WHERE accountTag = '<account>' AND timestamp >= NOW() - INTERVAL '7' DAY`
- `threshold`, `>=`, the chosen limit, a `168h` short window, run every `1h`, and `alert_interval: 168h`, so it emails at most once a week while traffic stays over.

The chart's "would have emailed" facts replay that rule over the 89 days (`replayEmails`). The SQL API's daily `COUNT(*)` matches the GraphQL `sum.requests` the chart shows.

## The output

`nextStep` (how to reply: the App collects the threshold and email, so end without a question), `today`, `days` (complete days `[date, requests]`, oldest first, from the first day with traffic, missing days as 0), `summary` (`typicalWeek` = median day × 7, `last7Days`, `busiestWeek`, `suggestedLimit` = a tenth above the busiest 7 days, rounded up, so nothing in the history would have emailed, or the input `limit`), `alertAvailable`, `existingAlerts`, `otherPolicies` and `limitations`.

## What it doesn't prove

Request counts come from Workers analytics, not billing, and are not dollar cost. The alert sends email and never blocks traffic. Whether Cloudflare accepts `168h` as the monitor's window is only proved by creating one.

## Implementation

- `contract.ts`: the input (`account_id`, `limit`, `as_of`) and the `workers_usage_alert_preview` output.
- `history.ts`: the query windows and missing-day filling.
- `model.ts`: the axis, rolling 7-day totals, typical week, email replay and the proposed policy, shared by the collector and the view.
- `tool.ts`: `workersUsageAlertApp`, a `defineMcpApp` whose collector reads with `apiReader`.
- `app/`: the React/Kumo view, mounted with `mountMcpApp`. While the tool runs it shows a skeleton in the card's own boxes; empty history and a failed read (a tool error) share Stratus's NotFoundPage drawing on the plot's floor, the failed read with Try again, which calls the tool again through the host. Field messages ("Invalid email", "Didn’t save") sit inside the field, so the footer never grows. The design reference is the fuzzy-input mockup, kept outside this repository.

## Verification

Tests cover both tool modes, the three windows of one query, the policy classification, refused and quota GraphQL errors, a refused policy read, missing days, short and empty history and the static resource.

Live, against real accounts through the built Worker over stdio:

- The chart's 89 days matched, to the request, an independent GraphQL read with different date ranges, and the SQL API's `COUNT(*)` on the 30 days it holds. Day 90 is refused by the API.
- Direct tools (`?codemode=false`) and Code Mode returned the same 89 days.
- The built HTML ran in an `AppBridge` host at 352, 560 and 736 px, light and dark, for traffic from thousands to billions a week, a spike week, 21 days, 8 days and none. Keyboard, drag past the top, hover, invalid email, confirm and Edit were checked with no overflow.
- ChatGPT desktop rendered the App from a natural prompt, and a terminal client with no MCP Apps support got the text result.
