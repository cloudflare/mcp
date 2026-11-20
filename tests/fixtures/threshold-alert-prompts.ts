/**
 * User prompts and the threshold alert tool each should reach, or none.
 * `docs/threshold-alerts.md` lists the same prompts; the ChatGPT runs it
 * records were made with them. Keep both in step.
 */
export type Route = 'workers_usage_alert' | 'workers_billing_alert' | 'none'

export const ROUTING_PROMPTS: readonly { readonly prompt: string; readonly route: Route }[] = [
  // workers-requests-monitor: traffic clearly above normal, in any 7 days.
  { prompt: 'ping me if our Workers traffic gets way out of hand', route: 'workers_usage_alert' },
  {
    prompt: 'let me know if our Workers suddenly get a lot more requests than usual',
    route: 'workers_usage_alert'
  },
  {
    prompt: 'alert me when a week of Worker requests passes 2 billion',
    route: 'workers_usage_alert'
  },
  {
    prompt: 'set up a spike alert for our Workers, not every bump, just clearly bigger than normal',
    route: 'workers_usage_alert'
  },
  // workers-requests-billing: billed requests in the billing period.
  {
    prompt: 'email me before our Workers bill passes 50M requests',
    route: 'workers_billing_alert'
  },
  {
    prompt: 'tell me when we go over 10 million billed Workers requests this month',
    route: 'workers_billing_alert'
  },
  {
    prompt: 'set up a usage based billing notification for Workers requests',
    route: 'workers_billing_alert'
  },
  {
    prompt: 'I want a heads-up when our Workers usage this billing cycle gets past 100M requests',
    route: 'workers_billing_alert'
  },
  // Neither: alerts never block, and neither tool measures dollars or other products.
  { prompt: 'block traffic over 1M requests', route: 'none' },
  { prompt: 'cap our Workers so we never pay more than $20', route: 'none' },
  { prompt: 'warn me if we’re going to spend more than $500 this month', route: 'none' },
  { prompt: 'alert me when our R2 storage passes 1 TB', route: 'none' }
]
