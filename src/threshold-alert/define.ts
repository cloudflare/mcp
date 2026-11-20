/**
 * `defineThresholdAlertApp()`: an MCP App that charts the history of one
 * number, previews an alert on it and lets the user create the alert from
 * the card. Each preset (`presets.ts`) says what the alert is; each App says
 * how to read its history and how to name its output.
 *
 * The collector only reads: the history, `available_alerts` and the existing
 * policies. The view's Create alert, Save alert and Undo call the generated
 * `alerting_policies_*` tools (`create.ts`), so no App adds a write tool.
 */
import type { ToolAnnotations } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { autoResolvedAccountId, missingAccountMessage } from '../auth/account-access'
import { ScopeChallenge } from '../scope-challenge'
import { ApiReadError, ApiReadUnsupported, apiReader, type ApiReader } from '../mcp-apps/api-read'
import { defineMcpApp, type AppContext, type AppOutcome, type McpApp } from '../mcp-apps/define'
import { tools as alertingPolicyTools } from '../generated/forge-mcp/alerting/policies/tools'
import { POLICY_WRITE_TOOLS } from './create'
import { clamp, deriveModel, type Day, type Model } from './model'
import { recogniseAmong, type ExistingKind, type ThresholdAlertPreset } from './presets'
import type { ExistingAlert, ThresholdAlertInput } from './contract'

export { DaySchema, ExistingAlertSchema, thresholdAlertInput } from './contract'
export type { ExistingAlert, ThresholdAlertInput } from './contract'

/** What every threshold alert's collector established, before the App names it. */
export interface Collected {
  readonly checkedAt: string
  readonly accountId: string
  readonly userEmail?: string
  readonly today: string
  readonly days: Day[]
  readonly model: Model
  /** The input `limit`, clamped to the chart, or the model's suggestion. `null` with no typical period and no input. */
  readonly suggestedLimit: number | null
  readonly alertAvailable: boolean | null
  readonly existingAlerts: ExistingAlert[] | null
  readonly otherPolicies: Record<string, number>
  readonly limitations: string[]
}

/** A history read: complete days, oldest first, or a tool error. */
export type HistoryOutcome =
  | { readonly ok: true; readonly days: Day[]; readonly limitations?: readonly string[] }
  | { readonly ok: false; readonly text: string; readonly meta?: Record<string, unknown> }

export interface ThresholdAlertAppDefinition<Input extends z.ZodObject, Output extends z.ZodType> {
  readonly preset: ThresholdAlertPreset
  /**
   * Presets whose policies count as already on this account, including this
   * one. Other policies are only counted by type.
   */
  readonly related: readonly ThresholdAlertPreset[]
  readonly title: string
  readonly description: string
  readonly annotations: ToolAnnotations
  readonly input: Input
  readonly output: Output
  readonly resource: {
    readonly uri: `ui://${string}`
    readonly name: string
    readonly html: string
  }
  /** Always true of the result: what the numbers are and what the alert doesn't do. */
  readonly limitations: readonly string[]
  /** Read the history. A failure is the tool's error: without history there is nothing to preview. */
  readHistory(
    accountId: string,
    today: string,
    reader: ApiReader,
    signal: AbortSignal
  ): Promise<HistoryOutcome>
  /** Name the collected facts in the App's output. */
  shape(collected: Collected): z.output<Output>
}

const AvailableAlerts = z.object({
  result: z.record(z.string(), z.array(z.object({ type: z.string() })))
})

const Policies = z.object({
  result: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      alert_type: z.string(),
      filters: z.record(z.string(), z.array(z.string())).optional()
    })
  )
})

/**
 * The result as the model reads it: everything but the daily series, which
 * only the chart draws. The model summarises the history from `summary` (the
 * descriptions ask it not to repeat the daily data), and re-reads the result
 * on every later turn, so 89 days of counts there are ~2 KB it never uses.
 * `days` becomes the range read, in the same place, so the model still knows
 * what the summary covers and that the card has the rest.
 */
export function thresholdAlertModelText(value: { readonly days: readonly Day[] }): string {
  const { days } = value
  return JSON.stringify({
    ...value,
    days: days.length
      ? { from: days[0][0], to: days[days.length - 1][0], count: days.length }
      : { count: 0 }
  })
}

/**
 * Define a threshold alert App: the preset's tool, its static view and a
 * read-only collector. The generated policy write tools are its `appTools`.
 *
 * @returns The App, for `MCP_APPS` in `src/mcp-apps/registry.ts`.
 */
export function defineThresholdAlertApp<Input extends z.ZodObject, Output extends z.ZodType>(
  definition: ThresholdAlertAppDefinition<Input, Output>
): McpApp {
  const { preset } = definition
  async function collect(
    input: z.output<Input>,
    context: AppContext,
    signal: AbortSignal
  ): Promise<AppOutcome<z.output<Output>>> {
    const { account_id, limit, as_of } = input as ThresholdAlertInput
    const accountId = account_id ?? autoResolvedAccountId(context.props)
    if (!accountId)
      return { ok: false, text: missingAccountMessage(context.props, 'Use GET /accounts.') }

    const now = new Date()
    const today = as_of ?? now.toISOString().slice(0, 10)
    const reader = apiReader(context, signal, preset.toolName)
    const limitations = [...definition.limitations]

    // Alerting reads only add context. A refusal is noted, not fatal, and
    // never reads as "no alerts exist". They never ask for a scope: a step-up
    // would replace the whole preview with a 403 for clients that take it over
    // HTTP, though the history it needs was read. Create alert asks for the
    // scope it needs when the user clicks it.
    //
    // The three reads are independent, so they go out together: the call takes
    // the slowest of them, not their sum (about 370 ms against 545 ms measured).
    // A failed history ends the call, so it stops the alerting reads too.
    const stopAlerting = new AbortController()
    const alertingSignal = AbortSignal.any([signal, stopAlerting.signal])
    const contextReader = apiReader(
      { ...context, scopeChallenge: new ScopeChallenge(undefined) },
      alertingSignal,
      preset.toolName
    )
    // Kept apart until the history is read, so the history's notes come first as before.
    const alertingNotes: string[] = []
    const optional = async <T>(read: () => Promise<T>, what: string): Promise<T | null> => {
      try {
        return await read()
      } catch (error) {
        if (alertingSignal.aborted) throw error
        if (error instanceof ApiReadError) {
          alertingNotes.push(`${what} could not be read: ${error.text}`)
        } else if (error instanceof ApiReadUnsupported || error instanceof z.ZodError) {
          alertingNotes.push(
            `${what} could not be read: Cloudflare returned an unsupported response.`
          )
        } else throw error
        return null
      }
    }
    const prefix = `/accounts/${accountId}/alerting/v3`
    const alerting = Promise.all([
      optional(
        () => contextReader.get(`${prefix}/available_alerts`, AvailableAlerts),
        'Available alert types'
      ),
      optional(
        () => contextReader.get(`${prefix}/policies`, Policies),
        'Existing notification policies'
      )
    ])
    // Handled now, so an early return below leaves no rejection unhandled; the await rethrows.
    alerting.catch(() => {})
    const history = await definition
      .readHistory(accountId, today, reader, signal)
      .catch((error: unknown) => {
        stopAlerting.abort()
        throw error
      })
    if (!history.ok) {
      stopAlerting.abort()
      return history
    }
    const [available, policies] = await alerting
    limitations.push(...(history.limitations ?? []), ...alertingNotes)

    const otherPolicies: Record<string, number> = {}
    const existingAlerts = policies
      ? policies.result.flatMap((policy): ExistingAlert[] => {
          const watch = recogniseAmong(definition.related, policy)
          if (!watch) {
            otherPolicies[policy.alert_type] = (otherPolicies[policy.alert_type] ?? 0) + 1
            return []
          }
          return [
            {
              id: policy.id,
              name: policy.name,
              enabled: policy.enabled,
              kind: watch.kind satisfies ExistingKind,
              ...(Number.isFinite(watch.limit) ? { limit: watch.limit } : {})
            }
          ]
        })
      : null

    const days = history.days
    const model = deriveModel(days, today, preset.cadence)
    if (days.length && days.length < 7)
      limitations.push(
        `Only ${days.length} days of history: under a week, so there is no typical ${preset.copy.bucket} to compare against.`
      )
    // The line starts a tenth over the busiest period. On a rolling monitor, a number the user named
    // moves it only when it is above that period: one below would already have emailed, so it can't
    // be what they meant by "clearly bigger", and the card would open over the bars with the alert
    // firing. A monthly alert starts over each billing period, and crossing a number most months
    // (the included requests) is the point, so a named number is kept and the overlap is said.
    const monthly = preset.cadence.kind === 'month'
    const named = limit != null && (monthly || limit > model.peak)
    if (limit != null && monthly && limit <= model.peak)
      limitations.push(
        `The busiest ${preset.copy.bucket} charted (${Math.round(model.peak).toLocaleString('en')}, counting this ${preset.copy.bucket} projected to its end) is at or above ${limit.toLocaleString('en')}, so this alert would email in a ${preset.copy.bucket} like it. Say so in one sentence.`
      )
    if (limit != null && !named)
      limitations.push(
        `The line starts a tenth above the busiest ${preset.copy.bucket}, not at the number named (${limit.toLocaleString('en')}): that number is at or below the busiest ${preset.copy.bucket} (${Math.round(model.peak).toLocaleString('en')}), so it would already have emailed. Lead with this in one sentence and point to the card, where the user drags the line; don't ask for a number in chat.`
      )
    const clamped = named ? clamp(limit, model.minLimit, model.maxLimit) : null
    if (named && clamped !== limit)
      limitations.push(
        `The line starts at ${clamped!.toLocaleString('en')}, not at the number named (${limit.toLocaleString('en')}): that is the ${clamped! > limit ? 'lowest' : 'highest'} the card's line reaches for this history. Say so in one sentence.`
      )
    const suggested = clamped ?? model.suggested
    const value = definition.shape({
      checkedAt: now.toISOString(),
      accountId,
      ...(context.props.type === 'user_token' ? { userEmail: context.props.user.email } : {}),
      today,
      days,
      model,
      suggestedLimit: model.typical == null && !named ? null : suggested,
      alertAvailable: available
        ? Object.values(available.result).some((types) =>
            types.some((type) => type.type === preset.alertType)
          )
        : null,
      existingAlerts,
      otherPolicies,
      limitations
    })
    return { ok: true, value }
  }

  return defineMcpApp({
    name: preset.toolName,
    title: definition.title,
    description: definition.description,
    annotations: definition.annotations,
    input: definition.input,
    output: definition.output,
    resource: definition.resource,
    // Create alert, Save alert and Undo call the generated tools; see `create.ts`.
    appTools: alertingPolicyTools.filter((tool) => POLICY_WRITE_TOOLS.includes(tool.name)),
    modelText: thresholdAlertModelText,
    run: collect
  })
}
