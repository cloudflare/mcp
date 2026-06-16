import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CLOUDFLARE_TYPES } from '../constants'
import { createCodeExecutor } from '../executor'
import { truncateResponse } from '../truncate'
import { formatError } from '../utils/errors'
import {
  accountTokenId,
  autoResolvedAccountId,
  inlineableAccounts,
  isMultiAccountUser,
  isSingleAccountUser
} from '../auth/account-access'
import type { AuthProps } from '../auth/types'

/**
 * The `CLOUDFLARE_TYPES` block plus a per-session comment describing how
 * `accountId` is resolved for this token (pinned, single account, or chosen
 * per call).
 */
function cloudflareTypesForAccount(props?: AuthProps): string {
  // Single-account user token: name the account so the LLM can confirm it.
  if (isSingleAccountUser(props)) {
    return (
      CLOUDFLARE_TYPES +
      `\n// accountId is pre-set to "${props.accounts[0].id}" (${props.accounts[0].name}) — use it directly in API paths.\n`
    )
  }

  // Any other pinned account id (account-scoped token).
  const pinnedAccountId = autoResolvedAccountId(props)
  if (pinnedAccountId) {
    return (
      CLOUDFLARE_TYPES +
      `\n// accountId is pre-set to "${pinnedAccountId}" — use it directly in API paths.\n`
    )
  }

  if (isMultiAccountUser(props)) {
    return (
      CLOUDFLARE_TYPES +
      `\n// This token has access to multiple Cloudflare accounts.\n` +
      `// accountId is set from the account_id tool argument, or is empty when omitted.\n` +
      `// To discover account IDs, omit account_id and call GET /accounts with pagination.\n`
    )
  }

  return CLOUDFLARE_TYPES
}

/**
 * Description for the `execute` tool, including the per-session Cloudflare type
 * declarations and a multipart Worker-upload example.
 */
function executeToolDescription(props?: AuthProps): string {
  const types = cloudflareTypesForAccount(props)

  return `Execute JavaScript code against the Cloudflare API. First use the 'search' tool to find the right endpoints, then write code using the cloudflare.request() function.

Available in your code:
${types}

Your code must be an async arrow function that returns the result.

Example: Worker with bindings (requires multipart/form-data):
async () => {
  const code = \`addEventListener('fetch', e => e.respondWith(MY_KV.get('key').then(v => new Response(v || 'none'))));\`;
  const metadata = { body_part: "script", bindings: [{ type: "kv_namespace", name: "MY_KV", namespace_id: "your-kv-id" }] };
  const b = \`--F\${Date.now()}\`;
  const body = [\`--\${b}\`, 'Content-Disposition: form-data; name="metadata"', 'Content-Type: application/json', '', JSON.stringify(metadata), \`--\${b}\`, 'Content-Disposition: form-data; name="script"', 'Content-Type: application/javascript', '', code, \`--\${b}--\`].join("\\r\\n");
  return cloudflare.request({ method: "PUT", path: \`/accounts/\${accountId}/workers/scripts/my-worker\`, body, contentType: \`multipart/form-data; boundary=\${b}\`, rawBody: true });
}`
}

/**
 * Describe the optional `account_id` argument for multi-account user-token
 * `execute` sessions.
 *
 * - Small, complete account lists are inlined so the model can pick directly.
 * - Otherwise (omitted large list or incomplete legacy list) we point the model
 *   at paginated `GET /accounts` for discovery.
 */
function accountIdParamDescription(props?: AuthProps): string {
  if (!isMultiAccountUser(props)) {
    return 'Your Cloudflare account ID. Optional if you have only one account (will be auto-selected)'
  }

  const accounts = inlineableAccounts(props)
  if (accounts) {
    const list = accounts.map((a) => `${a.id} (${a.name})`).join(', ')
    return `Your Cloudflare account ID. Required for account-scoped API calls. Available accounts: ${list}`
  }

  const countNote =
    props.accountCount !== undefined
      ? ` This token has access to ${props.accountCount} accounts.`
      : ''
  return `Your Cloudflare account ID. Required for account-scoped API calls.${countNote} Omit this argument and page through GET /accounts to discover them, or filter by exact name with GET /accounts?name=<exact account name>.`
}

/**
 * Register the `execute` tool: runs sandboxed JavaScript against the Cloudflare
 * API via `cloudflare.request()`.
 *
 * Two shapes depending on the session:
 *  - Account token (pinned account): `account_id` is fixed, not a parameter.
 *  - User token: `account_id` selects the account, and may be omitted for
 *    account-independent discovery calls such as `GET /accounts`.
 */
export function registerExecuteTool(server: McpServer, props: AuthProps): void {
  const apiToken = props.accessToken
  const executeCode = createCodeExecutor()
  const description = executeToolDescription(props)
  const pinnedAccountId = accountTokenId(props)

  if (pinnedAccountId) {
    server.registerTool(
      'execute',
      {
        description,
        inputSchema: {
          code: z.string().describe('JavaScript async arrow function to execute')
        }
      },
      async ({ code }) => {
        try {
          const result = await executeCode(code, pinnedAccountId, apiToken)
          return { content: [{ type: 'text', text: truncateResponse(result) }] }
        } catch (error) {
          return formatError(error)
        }
      }
    )
    return
  }

  server.registerTool(
    'execute',
    {
      description,
      inputSchema: {
        code: z.string().describe('JavaScript async arrow function to execute'),
        account_id: z.string().optional().describe(accountIdParamDescription(props))
      }
    },
    async ({ code, account_id }) => {
      try {
        // Undefined accountId lets account-independent requests such as
        // GET /accounts run before the caller has selected an account; any
        // code that reads `accountId` then fails fast with a clear message.
        const effectiveAccountId = account_id || autoResolvedAccountId(props)

        const result = await executeCode(code, effectiveAccountId, apiToken)
        return { content: [{ type: 'text', text: truncateResponse(result) }] }
      } catch (error) {
        return formatError(error)
      }
    }
  )
}
