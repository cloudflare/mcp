# Threshold alerts

A threshold alert App charts the history of one number, previews an alert on it, and creates the alert when the user clicks. The card is the same for every alert of this shape: a chart, a draggable line, an email field and Create alert. `src/threshold-alert/` holds what they share; a **preset** says what one kind of alert is.

Every preset creates one notification policy, `POST /accounts/{account_id}/alerting/v3/policies`, with the generated `alerting_policies_create` (Save alert and Undo use `alerting_policies_update` and `alerting_policies_delete`). Only `alert_type`, the threshold filter and the history differ.

| Preset                     | Tool                    | `alert_type`           | Threshold field                                              | Measures                                                                        | Chart                                 |
| -------------------------- | ----------------------- | ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------- |
| `workers-requests-monitor` | `workers_usage_alert`   | `custom_analytics`     | `filters.alert_trigger_preferences_value`                    | Workers requests in a rolling 7 days, hourly SQL on `events.workersInvocations` | weeks of `workersInvocationsAdaptive` |
| `workers-requests-billing` | `workers_billing_alert` | `billing_usage_alert`  | `filters.limit`, with `filters.product: ["worker_requests"]` | billed Workers requests in the billing period                                   | calendar months of the same 89 days   |

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
| I keep worrying a bot will hammer our Workers overnight. is there a way to get told when that happens? | `workers_usage_alert` |
| email me before our Workers bill passes 50M requests                                  | `workers_billing_alert`                  |
| tell me when we go over 10 million billed Workers requests this month                 | `workers_billing_alert`                  |
| set up a usage based billing notification for Workers requests                        | `workers_billing_alert`                  |
| I want a heads-up when our Workers usage this billing cycle gets past 100M requests   | `workers_billing_alert`                  |
| block traffic over 1M requests                                                        | neither (alerts never block)             |
| just shut off our Workers if they go over 1M requests, I don't want a surprise bill   | neither (alerts never block)             |
| cap our Workers so we never pay more than $20                                         | neither (a spending limit, not an alert) |
| warn me if we're going to spend more than $500 this month                             | neither (dollars, not requests)          |
| alert me when our R2 storage passes 1 TB                                              | neither                                  |

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

- `npm run check`: the app build is fresh, then format, lint, both type checks and the tests.
- The shared view ran in a local `AppBridge` host for both presets at 352 and 560 px, light and dark, with no overflow and no errors. Create alert sent `alerting_policies_create` once with exactly the preset's body (`custom_analytics` or `billing_usage_alert` on `worker_requests`), and `updateModelContext` named the right tool.
- In ChatGPT desktop, each sample prompt went to a new chat with only the account named, and reached the tool in the table above, or neither.
