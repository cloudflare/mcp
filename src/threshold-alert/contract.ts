/**
 * The schemas every threshold alert's contract is built from. Pure: the
 * App's view imports them, so nothing here may reach server code.
 */
import { z } from 'zod'

/** What the shared input carries; every threshold alert takes these. */
export interface ThresholdAlertInput {
  readonly account_id?: string
  readonly limit?: number
  readonly as_of?: string
}

/**
 * The input every threshold alert takes. `limit` is described in the
 * preset's unit, so the model passes a number the user named.
 */
export function thresholdAlertInput(limitDescription: string, historyDays: number) {
  return z.strictObject({
    account_id: z
      .string()
      .regex(/^[a-f0-9]{32}$/i)
      .optional()
      .describe('Account to read. Optional when the connection has exactly one account.'),
    limit: z.number().int().positive().optional().describe(limitDescription),
    as_of: z.iso
      .date()
      .optional()
      .describe(
        `Treat this UTC date as today. Defaults to the current date. Analytics older than ${historyDays} complete days cannot be read.`
      )
  })
}

/** An alert already on the account that watches the same number. */
export const ExistingAlertSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  /** `monitor`: a `custom_analytics` policy on `events.workersInvocations`. `billing`: a `billing_usage_alert` on `worker_requests`. */
  kind: z.enum(['monitor', 'billing']),
  /** Its threshold, when it has one. */
  limit: z.number().optional()
})
export type ExistingAlert = z.infer<typeof ExistingAlertSchema>

/** One complete UTC day's value. */
export const DaySchema = z.tuple([z.iso.date(), z.number().int().nonnegative()])
