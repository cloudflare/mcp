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

/** A setting already on the account that watches the same number. */
export const ExistingAlertSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  /**
   * `monitor`: a `custom_analytics` policy on `events.workersInvocations`.
   * `billing`: a `billing_usage_alert` on the same product. `spend_alert` and
   * `spend_limit`: a spend policy on the same product that emails, or that
   * also stops the product (`usage_block`).
   */
  kind: z.enum(['monitor', 'billing', 'spend_alert', 'spend_limit']),
  /** Its threshold, when it has one, as the policy stores it: requests, bytes, or a spend policy's US cents. */
  limit: z.number().optional()
})
export type ExistingAlert = z.infer<typeof ExistingAlertSchema>

/** One complete UTC day's value. */
export const DaySchema = z.tuple([z.iso.date(), z.number().int().nonnegative()])

/** The fields every threshold alert's result starts with. */
export const previewHead = {
  /** How to reply: the App's next-step guidance for the model. */
  nextStep: z.string(),
  checkedAt: z.iso.datetime(),
  accountId: z.string(),
  /**
   * The account's name, when the session knows it. The card names the account
   * Create writes to, since the model may have picked it.
   */
  accountName: z.string().optional(),
  /** The signed-in user's own email, for a user credential: the view's default recipient. */
  userEmail: z.string().optional(),
  /** The day treated as today, `YYYY-MM-DD`. It is still counting, so it isn't in `days`. */
  today: z.iso.date(),
  /**
   * Complete UTC days, oldest first, from the first day with data to
   * yesterday, in the preset's unit per day.
   */
  days: z.array(DaySchema)
}

/** And ends with, after its summary and whether its alert type is available. */
export const previewTail = {
  /** Settings that already watch the same number. `null`: not read. */
  existingAlerts: z.array(ExistingAlertSchema).nullable(),
  /** Every other policy, counted by type. */
  otherPolicies: z.record(z.string(), z.number().int()),
  limitations: z.array(z.string())
}

/** Every threshold App's tool only reads: the card's buttons make the writes. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
}
