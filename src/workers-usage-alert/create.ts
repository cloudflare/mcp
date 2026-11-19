import type { monitorPolicy } from './model'

type Policy = ReturnType<typeof monitorPolicy>
type ToolResult = { isError?: boolean; content?: readonly { type: string; text?: string }[] }
/** The host's `callServerTool`: `app.callServerTool` in the App, a direct `tools/call` in tests. */
export type CallTool = (call: {
  name: string
  arguments: Record<string, unknown>
}) => Promise<ToolResult>

export type CreateResult = { ok: true; id?: string } | { ok: false; error: string }

/**
 * The calls that create `policy`, with tools this server already lists: in
 * direct mode the generated `alerting_policies_create`, in Code Mode `execute`
 * with one fixed POST. The App can't tell which mode its connection is in, so
 * `createPolicy` tries them in this order.
 */
export function createCalls(accountId: string, policy: Policy) {
  return [
    {
      name: 'alerting_policies_create',
      arguments: { path: { account_id: accountId }, body: policy }
    },
    {
      name: 'execute',
      arguments: {
        account_id: accountId,
        code: `async () => cloudflare.request({ method: "POST", path: ${JSON.stringify(`/accounts/${accountId}/alerting/v3/policies`)}, body: ${JSON.stringify(policy)} })`
      }
    }
  ]
}

const text = (r: ToolResult) => r.content?.find((c) => c.type === 'text')?.text ?? ''
const notFound = (s: string) => /\btool\b.*\bnot found\b|unknown tool/i.test(s)

/**
 * Create the policy the user confirmed. A tool the connection doesn't list
 * moves on to the next; any other error is the result, with its text, so the
 * App shows Cloudflare's reason and nothing is retried. `undefined` when no
 * tool exists, so the App can hand the policy to the chat instead.
 */
export async function createPolicy(
  call: CallTool,
  accountId: string,
  policy: Policy
): Promise<CreateResult | undefined> {
  for (const c of createCalls(accountId, policy)) {
    let r: ToolResult
    try {
      r = await call(c)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (notFound(message)) continue
      return { ok: false, error: message }
    }
    if (r.isError && notFound(text(r))) continue
    if (r.isError) return { ok: false, error: text(r) }
    const id = /"id"\s*:\s*"([0-9a-f]{32})"/.exec(text(r))?.[1]
    return { ok: true, ...(id && { id }) }
  }
  return undefined
}
