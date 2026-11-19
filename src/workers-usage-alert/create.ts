import type { monitorPolicy } from './model'

/**
 * The generated tool Create alert calls: `POST /accounts/{account_id}/alerting/v3/policies`.
 * The direct tools list it for everyone; Code Mode lists it for this App only
 * (`appTools` in `tool.ts`), so no tool is added for the write.
 */
export const CREATE_POLICY_TOOL = 'alerting_policies_create'

type Policy = ReturnType<typeof monitorPolicy>
type ToolResult = { isError?: boolean; content?: readonly { type: string; text?: string }[] }
/** The host's `callServerTool`: `app.callServerTool` in the App, a direct `tools/call` in tests. */
export type CallTool = (call: {
  name: string
  arguments: Record<string, unknown>
}) => Promise<ToolResult>

export type CreateResult =
  | { status: 'created'; id?: string }
  | { status: 'refused'; error: string }
  | { status: 'unavailable' }

const text = (r: ToolResult) => r.content?.find((c) => c.type === 'text')?.text ?? ''
const notFound = (s: string) => /\btool\b.*\bnot found\b|unknown tool/i.test(s)

/**
 * Create the policy the user confirmed by clicking Create alert, exactly as
 * the App shows it. A connection that doesn't list the tool is `unavailable`,
 * so the App hands the policy to the chat instead; any other error is
 * Cloudflare's reason, and nothing is retried.
 */
export async function createPolicy(
  call: CallTool,
  accountId: string,
  policy: Policy
): Promise<CreateResult> {
  let r: ToolResult
  try {
    r = await call({
      name: CREATE_POLICY_TOOL,
      arguments: { path: { account_id: accountId }, body: policy }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return notFound(message) ? { status: 'unavailable' } : { status: 'refused', error: message }
  }
  if (r.isError)
    return notFound(text(r)) ? { status: 'unavailable' } : { status: 'refused', error: text(r) }
  const id = /"id"\s*:\s*"([0-9a-f]{32})"/.exec(text(r))?.[1]
  return { status: 'created', ...(id && { id }) }
}
