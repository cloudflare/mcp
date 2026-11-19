# Workers usage alert App

`workers_usage_alert` is a read-only MCP App, served in both tool modes at `ui://cloudflare/workers-usage-alert.html`. It previews a monitor that emails when a rolling 7 days of Workers requests passes a threshold. The user drags the threshold over a weekly chart of the last 89 days, enters an email, and confirms.

**It creates nothing.** On confirm, the App sends the exact `POST /accounts/{account_id}/alerting/v3/policies` body to the chat with `sendMessage` (and `updateModelContext` when the host has it). The model then creates it only with a write the user approves. A host without the `message` capability shows the body for review instead.

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

`today`, `days` (complete days `[date, requests]`, oldest first, from the first day with traffic, missing days as 0), `summary` (`typicalWeek` = median day × 7, `last7Days`, `busiestWeek`, `suggestedLimit` = a typical week plus a quarter, rounded, or the input `limit`), `alertAvailable`, `existingAlerts`, `otherPolicies` and `limitations`.

## What it doesn't prove

Request counts come from Workers analytics, not billing, and are not dollar cost. The alert sends email and never blocks traffic. Whether Cloudflare accepts `168h` as the monitor's window is only proved by creating one.

## Implementation

- `contract.ts`: the input (`account_id`, `limit`, `as_of`) and the `workers_usage_alert_preview` output.
- `history.ts`: the query windows and missing-day filling.
- `model.ts`: the axis, rolling 7-day totals, typical week, email replay and the proposed policy, shared by the collector and the view.
- `tool.ts`: `workersUsageAlertApp`, a `defineMcpApp` whose collector reads with `apiReader`.
- `app/`: the React/Kumo view, mounted with `mountMcpApp`. The design reference is the fuzzy-input mockup, kept outside this repository.

## Verification

Tests cover both tool modes, the three windows of one query, the policy classification, refused and quota GraphQL errors, a refused policy read, missing days, short and empty history and the static resource.

Live, against real accounts through the built Worker over stdio:

- The chart's 89 days matched, to the request, an independent GraphQL read with different date ranges, and the SQL API's `COUNT(*)` on the 30 days it holds. Day 90 is refused by the API.
- Direct tools (`?codemode=false`) and Code Mode returned the same 89 days.
- The built HTML ran in an `AppBridge` host at 352, 560 and 736 px, light and dark, for traffic from thousands to billions a week, a spike week, 21 days, 8 days and none. Keyboard, drag past the top, hover, invalid email, confirm and Edit were checked with no overflow.
- ChatGPT desktop rendered the App from a natural prompt, and a terminal client with no MCP Apps support got the text result.
