import type { PolicyBody } from './presets'

/**
 * The generated tools the App's buttons call. Create alert:
 * `POST /accounts/{account_id}/alerting/v3/policies`. Save alert, on an alert
 * the click just made: `PUT …/policies/{policy_id}`. Undo:
 * `DELETE …/policies/{policy_id}`. The direct tools list them for everyone;
 * Code Mode lists them for threshold alert Apps only (`appTools` in
 * `define.ts`), so no tool is added for the writes.
 */
export const CREATE_POLICY_TOOL = 'alerting_policies_create'
export const UPDATE_POLICY_TOOL = 'alerting_policies_update'
export const DELETE_POLICY_TOOL = 'alerting_policies_delete'
export const POLICY_WRITE_TOOLS = [CREATE_POLICY_TOOL, UPDATE_POLICY_TOOL, DELETE_POLICY_TOOL]

type Policy = PolicyBody
type ToolResult = { isError?: boolean; content?: readonly { type: string; text?: string }[] }
/** The host's `callServerTool`: `app.callServerTool` in the App, a direct `tools/call` in tests. */
export type CallTool = (call: {
  name: string
  arguments: Record<string, unknown>
}) => Promise<ToolResult>

/**
 * What a write did. `done` (with the new policy's id, for a create);
 * `refused` with Cloudflare's reason; `unavailable` when the connection lists
 * no such tool.
 */
export type WriteResult =
  | { status: 'done'; id?: string }
  | { status: 'refused'; error: string }
  | { status: 'unavailable' }

const text = (r: ToolResult) => r.content?.find((c) => c.type === 'text')?.text ?? ''
const notFound = (s: string) => /\btool\b.*\bnot found\b|unknown tool/i.test(s)

/** One call to a generated tool. Nothing is retried: each click is one request. */
async function write(
  call: CallTool,
  name: string,
  args: Record<string, unknown>
): Promise<WriteResult> {
  let r: ToolResult
  try {
    r = await call({ name, arguments: args })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return notFound(message) ? { status: 'unavailable' } : { status: 'refused', error: message }
  }
  if (r.isError)
    return notFound(text(r)) ? { status: 'unavailable' } : { status: 'refused', error: text(r) }
  const id = /"id"\s*:\s*"([0-9a-f]{32})"/.exec(text(r))?.[1]
  return { status: 'done', ...(id && { id }) }
}

/**
 * Create the policy the user confirmed by clicking Create alert, exactly as
 * the App shows it. A connection that doesn't list the tool is `unavailable`,
 * so the App hands the policy to the chat instead.
 */
export function createPolicy(call: CallTool, accountId: string, policy: Policy) {
  return write(call, CREATE_POLICY_TOOL, { path: { account_id: accountId }, body: policy })
}

/** Save alert: replace the alert the App created with the policy it now shows. */
export function updatePolicy(call: CallTool, accountId: string, policyId: string, policy: Policy) {
  return write(call, UPDATE_POLICY_TOOL, {
    path: { account_id: accountId, policy_id: policyId },
    body: policy
  })
}

/** Undo: delete the alert the App just created, by the id the create returned. */
export function deletePolicy(call: CallTool, accountId: string, policyId: string) {
  return write(call, DELETE_POLICY_TOOL, { path: { account_id: accountId, policy_id: policyId } })
}
