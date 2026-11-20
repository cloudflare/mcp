# Threshold alerts

A threshold alert App charts the history of one number, previews an alert on it, and creates the alert when the user clicks. The card is the same for every alert of this shape: a chart, a draggable line, an email field and Create alert. `src/threshold-alert/` holds what they share; a **preset** says what one kind of alert is.

Every preset creates one notification policy, `POST /accounts/{account_id}/alerting/v3/policies`, with the generated `alerting_policies_create` (Save alert and Undo use `alerting_policies_update` and `alerting_policies_delete`). Only `alert_type`, the threshold filter and the history differ.

| Preset                     | Tool                    | `alert_type`           | Threshold field                                              | Measures                                                                        | Chart                                 | Status          |
| -------------------------- | ----------------------- | ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------- | --------------- |
| `workers-requests-monitor` | `workers_usage_alert`   | `custom_analytics`     | `filters.alert_trigger_preferences_value`                    | Workers requests in a rolling 7 days, hourly SQL on `events.workersInvocations` | weeks of `workersInvocationsAdaptive` | registered      |
| `workers-requests-billing` | `workers_billing_alert` | `billing_usage_alert`  | `filters.limit`, with `filters.product: ["worker_requests"]` | billed Workers requests in the billing period                                   | calendar months of the same 89 days   | registered      |
| `account-budget`           | —                       | `billing_budget_alert` | `filters.total_spend_dollars`: one string > 0                | account-wide usage-based spend in the billing period, USD                       | —                                     | documented only |

## What generalised

Read from `usage-alert-app.tsx`, `model.ts` and `contract.ts` before extracting anything:

- **Generalised as is:** the axis (nice 1-2-5 steps, ticks, the axis growing when the line is dragged past the top, the one-outlier rule that keeps a spike from flattening the rest), the drag and keyboard slider, the hot overlay above the line, the typical-period line, the tooltip, the email field, Create alert → Alert on → Undo/Edit/Save alert, the refused and handed-off states, `updateModelContext` after every write, and the policy writes (`create.ts`). None of it knew it was counting Workers requests.
- **Workers-specific, beyond copy:** the alert's rule. The monitor measures a _rolling 7 days_ and emails again every 7 days while over (`alert_interval: 168h`); the chart's buckets, "typical week" (median day × 7), "last 7 days", the busiest 7 days the suggestion sits above, and the "would have emailed" replay all follow from that rule. A billing alert measures the _total since the billing period began_ and emails once per period, so those had to become a parameter. That is `Cadence` (`rolling` 7 days, or calendar `month`) in `src/threshold-alert/model.ts`: it decides what is measured each day (`measured`), the buckets (Monday weeks or calendar months), the typical period (median day × 7, or × 30.44), what "now" is, the busiest period and the replay.
- **Also specific:** the history reader (89 days of `workersInvocationsAdaptive` in three aliased windows), the existing-policy recognition (`tool.ts:78` before), the output's field names (`typicalWeek`, `last7Days`), and the copy.
- **Didn't generalise, and stays a constant:** the suggestion works for every preset in its own unit, so it is shared rather than per preset. The line opens a tenth above the tallest thing on the chart (the busiest period, or a taller bar such as this month's estimate), rounded up on the axis step, so nothing in the history would have emailed. A number the user named moves it only when that number is above the busiest period. A lower one would already have emailed and would open the card with every bar over the line, so it is noted in `limitations` and the suggestion is kept. Count formatting (K/M/B) is shared too; a dollar preset would need a currency format (see `account-budget`).

The monitor preset reproduces the old model: the old `deriveModel`, `replayEmails` and `fitTop` and the new ones with the default cadence agree on 3,000 random histories. The only difference is `suggested`, which in 516 of them now sits above this week's estimated bar where that bar was taller than the busiest 7 days. In addition, and the `workers_usage_alert` input and output JSON Schemas are byte-identical to before.

## The shape

```ts
// src/threshold-alert/presets.ts: pure, so the view imports it too
interface ThresholdAlertPreset {
  id: PresetId
  toolName: string                 // the tool that serves it
  alertType: string                // checked against available_alerts
  existingKind: 'monitor' | 'billing'
  cadence: Cadence                 // { kind: 'rolling', days: 7 } | { kind: 'month' }
  unit: { noun: string }           // 'requests'
  copy: PresetCopy                 // title, slider/chart labels, 'in 7 days', 'week', …
  policy(accountId, limit, email, name): PolicyBody   // exactly what Create alert sends
  name(limit: string): string
  recognise(policy): { limit: number } | null         // an existing policy of this kind
}

// src/threshold-alert/define.ts: server only
defineThresholdAlertApp({
  preset, related,                 // related: presets whose policies count as "already on this account"
  title, description, annotations, input, output, resource, limitations,
  readHistory(accountId, today, reader, signal): Promise<HistoryOutcome>,
  shape(collected): Output         // names the shared facts in the App's own output
})
```

One preset, in full:

```ts
export const WORKERS_REQUESTS_BILLING: ThresholdAlertPreset = {
  id: 'workers-requests-billing',
  toolName: 'workers_billing_alert',
  alertType: 'billing_usage_alert',
  existingKind: 'billing',
  cadence: CALENDAR_MONTH,
  unit: { noun: 'requests' },
  copy: { title: 'Email me when billed Workers requests pass the line', per: 'in a billing period', bucket: 'month', … },
  policy: (_account, limit, email, name) => ({
    name, alert_type: 'billing_usage_alert', enabled: true,
    filters: { product: ['worker_requests'], limit: [String(limit)] },
    mechanisms: { email: [{ id: email }] }
  }),
  name: (limit) => `Billed Workers requests over ${limit}`,
  recognise: (p) => p.alert_type === 'billing_usage_alert' && p.filters?.product?.includes('worker_requests')
    ? { limit: Number(p.filters.limit?.[0]) } : null
}
```

`defineThresholdAlertApp` does what every preset's collector did by hand: resolve the account, read the history (a failure is the tool's error), read `available_alerts` and the policies (a refusal is a limitation, never "no alerts"), classify policies with `related`, derive the model with the preset's cadence, clamp a limit the user named, and pass the step-up `_meta` through. It registers the three generated `alerting_policies_*` tools as `appTools`, so Code Mode lists them app-only, once, however many presets exist. Nothing writes through `execute`, and the tools stay read-only; the click is the confirmation, and the card shows the exact body when the host can't call tools.

The two Workers Apps share one view (`src/workers-usage-alert/app/`). It picks the preset from the result's `kind` (`workers_usage_alert_preview` or `workers_billing_alert_preview`), and each tool has its own resource URI.

## Tool surface: a tool per preset

The choice was between one tool with a `preset` input and a thin tool per preset sharing the view. The deciding factor is how reliably the model picks the right one, and a tool per preset wins:

- **The name and description route; an enum argument doesn't.** Hosts choose a tool from its name and description before they fill in arguments. With one tool, "ping me if traffic gets out of hand" and "email me before the bill passes 50M" both reach the same tool, and the model then has to pick `preset` from a schema enum's description, which is the step models skip or default. With two tools, each description carries its own example prompt and names the other for the other case ("For a threshold on billed requests … use `workers_billing_alert`"), which is where models read routing.
- **Each result has its own shape.** `typicalWeek`/`last7Days` against `typicalMonth`/`thisMonth`: the model reads the right unit, and the output schema stays honest instead of a union every caller has to discriminate.
- **Backwards compatible.** `workers_usage_alert` keeps its name, input, output and behaviour; its description gains one routing sentence at the end.
- **Cost.** Each tool is one more description in `tools/list` (~1.3 KB). The write tools are shared, so a preset adds no write surface.

The view, the model, the reads of alerting state and the writes are shared, so a new preset is a preset object, a contract and a `defineThresholdAlertApp` call.

## Sample prompts

`tests/fixtures/threshold-alert-prompts.ts` holds these; `tests/threshold-alert.test.ts` checks every tool's description names its own example and points to the other, and that both say they never block traffic and aren't dollars.

| Prompt                                                                                | Should reach                             |
| ------------------------------------------------------------------------------------- | ---------------------------------------- |
| ping me if our Workers traffic gets way out of hand                                   | `workers_usage_alert`                    |
| let me know if our Workers suddenly get a lot more requests than usual                | `workers_usage_alert`                    |
| alert me when a week of Worker requests passes 2 billion                              | `workers_usage_alert`                    |
| set up a spike alert for our Workers, not every bump, just clearly bigger than normal | `workers_usage_alert`                    |
| email me before our Workers bill passes 50M requests                                  | `workers_billing_alert`                  |
| tell me when we go over 10 million billed Workers requests this month                 | `workers_billing_alert`                  |
| set up a usage based billing notification for Workers requests                        | `workers_billing_alert`                  |
| I want a heads-up when our Workers usage this billing cycle gets past 100M requests   | `workers_billing_alert`                  |
| block traffic over 1M requests                                                        | neither (alerts never block)             |
| cap our Workers so we never pay more than $20                                         | neither (a spending limit, not an alert) |
| warn me if we're going to spend more than $500 this month                             | neither, until `account-budget` ships    |
| alert me when our R2 storage passes 1 TB                                              | neither                                  |

## `account-budget`: documented, not registered

The preset would be `billing_budget_alert` with `filters: { total_spend_dollars: ["<n>"] }` (the spec: "Takes exactly one value, the budget threshold in US dollars, as a string greater than zero"), the same body the dashboard's `BudgetAlertDialog` sends through `toAPIv2`. Its cadence is `month` (Cloudflare's docs: cumulative usage-based spend for the current billing period, one email per crossing, reset each period, Pay-as-you-go accounts only), and its unit dollars. It isn't registered because its history couldn't be verified:

- **No chartable spend history was readable.** With the OAuth scopes this session has (analytics and notifications read/write), every candidate refused with `10000: Authentication error`: `GET /accounts/{id}/billing/history`, `/billing/usage`, `/billable-usage`, `/billable-usage/info` and `/billable/usage`. Their shapes, from the spec: `billing/history` is invoice and charge items (`amount`, `occurred_at`), not per-day spend; `billable-usage` (v1, alpha) returns FOCUS records with `BilledCost` and `ChargePeriodStart`, but only for a range that includes the subscription's billing-cycle anchor day (from `billable-usage/info`), so a reader has to fetch the anchor first; `billable/usage` (v2, alpha, restricted) serves usage without cost fields. The dashboard sums `CumulatedContractedCost` per service from the paygo pool to get period spend (`useSustainedHighSpend.ts`), which a reader would have to reproduce.
- **Permissions are unmapped.** The pinned `permissions.json` lists no `x-api-token-group` for `billable-usage`, `billable-usage/info` or `billable/usage` (`billable/usage` says `#billing:read` in prose), so a refusal couldn't be explained or stepped up. The policy write is `Notifications Write`, like the others, but whether creating a `billing_budget_alert` also needs a billing permission isn't recorded anywhere this repository can read.
- **The card needs a currency format.** `fmt`/`sig` format counts; dollars need `$` and cents below $1.

Open questions before registering it: which spend endpoint is stable enough to chart (and its OAuth scope); whether the billing-period anchor or calendar months is the right bucket; whether Enterprise contract accounts should get a "not available" card (they can't create the alert); and the permission the budget write needs.

## Card copy

- **Title:** "Email me when [what is counted] [over the alert's own window] pass the line". Name the window the alert measures, not the chart's buckets: the monitor counts a rolling 7 days ("7 days of Workers requests"), billing counts the billing period. "pass the line" stays fixed while the user drags, so the title never rewraps. A level that isn't summed over a window drops the window ("…when R2 storage passes the line").
- **Facts:** the two facts sit under the month axis as the chart's legend (grey dot: past periods, blue dot: now), verdict first: whether the line would have emailed, then the current period.
- **What the model says:** bottom line up front (BLUF). `nextStep` asks for the suggested threshold and whether it would have emailed as the first sentence, or, when a named number was replaced, that replacement. The App's `updateModelContext` messages lead with the outcome ("Alert created: it emails …") before how it happened.

## Adding a preset

1. A `ThresholdAlertPreset` in `src/threshold-alert/presets.ts`, and its id in `PresetId` and `PRESETS`.
2. A contract: the input from `thresholdAlertInput()`, an output with its own `kind`, and a description that names its example prompt and points to its neighbours.
3. `defineThresholdAlertApp({ preset, related, …, readHistory, shape })`, and the App in `MCP_APPS`.
4. If it shares the Workers view, add its `kind` to `WorkersThresholdPreviewSchema` and to `presetOf` in the view; otherwise give it a view that mounts the same card.
5. Tests: the policy body, `recognise`, the App in both tool modes, and its prompts in the routing fixture.

## Verification

- `npm run check`'s steps: app build fresh, format, lint, both type checks, and 928 tests in 51 files.
- The shared view ran in a local `AppBridge` host for both presets at 352 and 560 px, light and dark, with no overflow and no errors. Create alert sent `alerting_policies_create` once with exactly the preset's body (`custom_analytics` or `billing_usage_alert` on `worker_requests`), and `updateModelContext` named the right tool.
- In ChatGPT desktop, through the local read-only adapter (creates refused), each prompt went to a new chat, with only the account named:

| Prompt | Tool ChatGPT called |
|---|---|
| email me before our Workers bill passes 50M requests | `workers_billing_alert` |
| ping me if our Workers traffic gets way out of hand | `workers_usage_alert` |
| tell me when we go over 10 million billed Workers requests this month | `workers_billing_alert` |
| set up a usage based billing notification for Workers requests | `workers_billing_alert` |
| I want a heads-up when our Workers usage this billing cycle gets past 100M requests | `workers_billing_alert` |
| let me know if our Workers suddenly get a lot more requests than usual | `workers_usage_alert` |
| block traffic over 1M requests | neither; it asked what scope to rate-limit, created nothing |
| warn me if we're going to spend more than $500 this month | neither; it said the alerts count requests, not dollars, created nothing |

In the first run of the 10M prompt, the line opened at the named 10M, under every bar, with the card already firing. The suggestion now ignores a named number at or below the busiest period and says why in `limitations`. The re-run opened a tenth above the tallest bar, and the reply pointed to the card.
