/**
 * Which calls to a preset's write tools Code Mode serves. Code Mode lists
 * the generated policy writes for the App only (`_meta.ui.visibility:
 * ['app']`), which hides them from the model but doesn't limit them: a host
 * that let anything else call them could write any policy. This limits them
 * to what the card makes. Server-only; the view never imports it.
 */
import { z } from 'zod'
import type { ListedSetting, ThresholdAlertPreset, ToolCall } from './presets'

/** JSON with every object's keys sorted, so two bodies compare by value, not by key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  )
}

/** The arguments every write takes: the account, the policy for update and delete, If-Match for a spend policy. */
const WriteArgs = z.strictObject({
  path: z.strictObject({ account_id: z.string(), policy_id: z.string().optional() }),
  headers: z.strictObject({ 'if-match': z.string() }).optional(),
  body: z.unknown().optional()
})

/** A notification policy body, as far as recognising it and finding its recipient need. */
const AlertingBody = z.object({
  alert_type: z.string(),
  filters: z.record(z.string(), z.array(z.string())).optional(),
  mechanisms: z.object({ email: z.array(z.object({ id: z.string() })).min(1) })
})

/** A spend policy body, as far as recognising it and finding its recipient need. */
const SpendBody = z.object({
  product_id: z.string(),
  action: z.string(),
  threshold_cents: z.number(),
  notification_email: z.string()
})

/** The setting a body would be, as `recognise` reads it, and its recipient. */
function settingOf(
  preset: ThresholdAlertPreset,
  body: unknown
): { setting: ListedSetting; email: string } | null {
  if (preset.target.kind === 'spend_policy') {
    const spend = SpendBody.safeParse(body)
    return spend.success
      ? {
          setting: { target: 'spend_policy', ...spend.data },
          email: spend.data.notification_email
        }
      : null
  }
  const alerting = AlertingBody.safeParse(body)
  return alerting.success
    ? {
        setting: { target: 'alerting_policy', ...alerting.data },
        email: alerting.data.mechanisms.email[0].id
      }
    : null
}

/**
 * Whether a call to one of the preset's write tools is one its card makes: a
 * create or update whose body is exactly what the card builds for some
 * threshold, email and action (`preset.policy`), or a delete by id.
 */
export function isPresetWrite(preset: ThresholdAlertPreset, call: ToolCall): boolean {
  const [create, update, remove] = preset.target.tools
  const args = WriteArgs.safeParse(call.arguments)
  if (!args.success || ![create, update, remove].includes(call.name)) {
    return false
  }
  const { path, headers, body } = args.data
  // Create names no policy; update and delete name one.
  if ((call.name === create) !== (path.policy_id === undefined)) {
    return false
  }
  // If-Match is a spend policy's, on its update and delete.
  if (headers && (preset.target.kind !== 'spend_policy' || call.name === create)) {
    return false
  }
  if (call.name === remove) {
    return body === undefined
  }
  const found = settingOf(preset, body)
  const limit = found ? preset.recognise(found.setting)?.limit : undefined
  if (!found || limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return false
  }
  const sent = canonical(body)
  return preset.actions.some(
    (action) => canonical(preset.policy(path.account_id, limit, found.email, action.id)) === sent
  )
}
