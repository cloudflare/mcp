# Workers usage alert App

`workers_usage_alert` is a read-only MCP App in both tool modes, served at `ui://cloudflare/workers-usage-alert.html`. It previews a `billing_usage_alert` notification policy on Workers requests. The user drags a threshold over this month's and last month's cumulative requests, enters an email, and reviews the policy the App would create.

**It creates nothing yet.** Review shows the exact `POST /accounts/{account_id}/alerting/v3/policies` body. Creating the policy will be a separate, non-read-only tool that the user confirms in the host (see Rules in `docs/mcp-apps.md`).

## What it reads

- `POST /graphql`, `workersInvocationsAdaptive` summed by date: the whole previous UTC month and the current month to date, as two aliases in one query. The dataset refuses ranges wider than about 32 days (`4w4d`, measured), so a single six-week range fails.
- `GET /accounts/{account_id}/alerting/v3/available_alerts`: whether the account can create `billing_usage_alert`.
- `GET /accounts/{account_id}/alerting/v3/policies`: existing billing usage alerts on `worker_requests` (name, enabled, limit), with the other policy types counted. Destinations and email addresses are not returned.

Usage is required. Without it the call is a tool error, explained as missing Account Analytics Read when GraphQL says so. The alerting reads only add context: a refusal becomes a limitation and `null`, never "no alerts exist".

## What it doesn't prove

Months are UTC calendar months, which may not match the account's billing period. Request counts come from Workers analytics, not billing, and are not dollar cost. The projection, shown dashed, is the last seven days' average. The alert sends email and never blocks traffic.

## Implementation

- `src/workers-usage-alert/contract.ts`: the input (`account_id`, `as_of`) and the `workers_usage_alert_preview` output.
- `src/workers-usage-alert/periods.ts`: UTC month arithmetic and threshold rounding.
- `src/workers-usage-alert/tool.ts`: `workersUsageAlertApp`, a `defineMcpApp` whose collector reads with `apiReader`.
- `src/workers-usage-alert/app/`: the React/Kumo chart, mounted with `mountMcpApp`. The design reference is the fuzzy-input mockup, kept outside this repository.

## Verification

Tests cover both tool modes, period arithmetic, the GraphQL variables, refused and quota GraphQL errors, a refused policy read, missing days and the static resource. Locally, `wrangler dev` served a read-only call against a real account. The built HTML rendered through an `AppBridge` host at 390 and 560 px in light and dark, and keyboard threshold changes and the review payload were checked.
