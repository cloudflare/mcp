/**
 * User prompts and the threshold alert tool each should reach, or none.
 */
export type Route =
  | 'workers_usage_alert'
  | 'workers_billing_alert'
  | 'r2_storage_alert'
  | 'workers_spend_limit'
  | 'none'

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
  {
    prompt:
      'I keep worrying a bot will hammer our Workers overnight. is there a way to get told when that happens?',
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
  // None: a request count can't block anything, and an account-wide dollar budget is no tool's.
  { prompt: 'block traffic over 1M requests', route: 'none' },
  {
    prompt: "just shut off our Workers if they go over 1M requests, I don't want a surprise bill",
    route: 'none'
  },
  { prompt: 'warn me if we’re going to spend more than $500 this month', route: 'none' },
  // workers-spend: dollars of Workers charges, an email or a spending limit.
  { prompt: 'cap our Workers so we never pay more than $20', route: 'workers_spend_limit' },
  {
    prompt: 'warn me if Workers is going to cost more than $50 this month',
    route: 'workers_spend_limit'
  },
  {
    prompt: 'just shut off our Workers if they cost more than $100 this month',
    route: 'workers_spend_limit'
  },
  { prompt: 'set a spending limit on Workers', route: 'workers_spend_limit' },
  // r2-storage-billing: billed R2 storage in the billing period.
  { prompt: 'alert me when our R2 storage passes 1 TB', route: 'r2_storage_alert' },
  {
    prompt: 'email me before R2 storage starts costing real money',
    route: 'r2_storage_alert'
  },
  {
    prompt: 'set up a usage based billing notification for R2 storage',
    route: 'r2_storage_alert'
  },
  // Neither: the R2 alert only emails.
  { prompt: 'stop uploads to our R2 bucket once it hits 2 TB', route: 'none' },
  { prompt: 'alert me when R2 egress gets expensive', route: 'none' }
]
