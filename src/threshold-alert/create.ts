import type { PolicyBody, SettingRef, ToolCall, WriteTarget } from './presets'
import { ALERTING_POLICY, SPEND_POLICY } from './presets'

/**
 * The writes the App's buttons make, with the generated tools of the preset's
 * {@link WriteTarget}. Create: `POST …/alerting/v3/policies` or
 * `POST …/billing/spend-policies`. Save, on a setting the click just made:
 * the target's update. Undo: its delete. The direct tools list them for
 * everyone; Code Mode lists them for these Apps only (`appTools` in
 * `define.ts`), so no tool is added for the writes.
 */
export const CREATE_POLICY_TOOL = ALERTING_POLICY.tools[0]
export const UPDATE_POLICY_TOOL = ALERTING_POLICY.tools[1]
export const DELETE_POLICY_TOOL = ALERTING_POLICY.tools[2]
export const POLICY_WRITE_TOOLS: ReadonlyArray<string> = ALERTING_POLICY.tools
/** The spend policy writes, for the spend presets' `appTools`. */
export const SPEND_POLICY_WRITE_TOOLS: ReadonlyArray<string> = SPEND_POLICY.tools

type ToolResult = { isError?: boolean; content?: ReadonlyArray<{ type: string; text?: string }> }
/** The host's `callServerTool`: `app.callServerTool` in the App, a direct `tools/call` in tests. */
export type CallTool = (call: ToolCall) => Promise<ToolResult>

/**
 * What a write did. `done`, with the setting it made or changed (its id and,
 * for a spend policy, its new version); `refused` with Cloudflare's reason;
 * `unavailable` when the connection lists no such tool.
 */
export type WriteResult =
  | { status: 'done'; ref?: SettingRef }
  | { status: 'refused'; error: string }
  /** No answer from Cloudflare: the write may have been made, so it isn't safe to send again. */
  | { status: 'unknown'; error: string }
  | { status: 'unavailable' }

const text = (r: ToolResult) => r.content?.find((c) => c.type === 'text')?.text ?? ''
const notFound = (s: string) => /\btool\b.*\bnot found\b|unknown tool/i.test(s)

/** One call to a generated tool. Nothing is retried: each click is one request. */
async function write(call: CallTool, request: ToolCall): Promise<WriteResult> {
  let r: ToolResult
  try {
    r = await call(request)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return notFound(message) ? { status: 'unavailable' } : { status: 'unknown', error: message }
  }
  if (r.isError) {
    if (notFound(text(r))) {
      return { status: 'unavailable' }
    }
    // Cloudflare refused: its 4xx answer is the tool error's first line. Anything else has no
    // answer the write wasn't made: a lost connection, a timeout, or a 5xx, which a gateway can
    // send after the API saved it.
    const first = text(r).split('\n', 1)[0]
    return first.startsWith('Cloudflare API error:') && !/\breturned HTTP 5\d\d\b/.test(first)
      ? { status: 'refused', error: text(r) }
      : { status: 'unknown', error: text(r) }
  }
  const ref = writtenRef(text(r))
  return ref ? { status: 'done', ref } : { status: 'done' }
}

/**
 * The setting in a write's result: the envelope's `result.id` and, for a
 * spend policy, `result.version`, as the tool returns the body.
 */
function writtenRef(body: string): SettingRef | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  const result =
    typeof parsed === 'object' && parsed !== null && 'result' in parsed ? parsed.result : undefined
  if (typeof result !== 'object' || result === null || !('id' in result)) {
    return undefined
  }
  const { id } = result
  if (typeof id !== 'string' || !id) {
    return undefined
  }
  const version = 'version' in result ? result.version : undefined
  return typeof version === 'number' ? { id, version } : { id }
}

/**
 * Create the setting the user confirmed by clicking Create, exactly as the
 * App shows it. A connection that doesn't list the tool is `unavailable`, so
 * the App hands the setting to the chat instead.
 */
export function createSetting(
  call: CallTool,
  target: WriteTarget,
  accountId: string,
  body: PolicyBody
) {
  return write(call, target.create(accountId, body))
}

/** Save: replace the setting the App created with the one it now shows. */
export function updateSetting(
  call: CallTool,
  target: WriteTarget,
  accountId: string,
  ref: SettingRef,
  body: PolicyBody
) {
  return write(call, target.update(accountId, ref, body))
}

/** Undo: delete the setting the App just created, by the id (and version) its write returned. */
export function deleteSetting(
  call: CallTool,
  target: WriteTarget,
  accountId: string,
  ref: SettingRef
) {
  return write(call, target.remove(accountId, ref))
}

/** {@link createSetting} for a notification policy. */
export function createPolicy(call: CallTool, accountId: string, policy: PolicyBody) {
  return createSetting(call, ALERTING_POLICY, accountId, policy)
}

/** {@link updateSetting} for a notification policy. */
export function updatePolicy(
  call: CallTool,
  accountId: string,
  policyId: string,
  policy: PolicyBody
) {
  return updateSetting(call, ALERTING_POLICY, accountId, { id: policyId }, policy)
}

/** {@link deleteSetting} for a notification policy. */
export function deletePolicy(call: CallTool, accountId: string, policyId: string) {
  return deleteSetting(call, ALERTING_POLICY, accountId, { id: policyId })
}
