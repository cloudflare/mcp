import {
  autoResolvedAccountId,
  inlineableAccounts,
  isMultiAccountUser,
  isSingleAccountUser
} from './auth/account-access'
import { SPEC_TYPES } from './openapi'
import type { AuthProps } from './auth/types'

/**
 * TypeScript declarations describing the `cloudflare` helper and `accountId`
 * binding available to the `execute` tool's sandboxed code.
 */
const CLOUDFLARE_TYPES = `
interface CloudflareRequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  contentType?: string;  // Custom Content-Type header (defaults to application/json if body is present)
  rawBody?: boolean;     // If true, sends body as-is without JSON.stringify
}

interface CloudflareResponse<T = unknown> {
  success: boolean;
  status: number;
  result: T;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result_info?: {
    page: number;
    per_page: number;
    total_pages: number;
    count: number;
    total_count: number;
  };
}

declare const cloudflare: {
  request<T = unknown>(options: CloudflareRequestOptions): Promise<CloudflareResponse<T>>;
};

declare const accountId: string;
`

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
 * Describe the optional `account_id` argument for user-token `execute` sessions.
 *
 * - Small, complete account lists are inlined so the model can pick directly.
 * - Otherwise (omitted large list or incomplete legacy list) we point the model
 *   at paginated `GET /accounts` for discovery.
 */
export function accountIdParamDescription(props?: AuthProps): string {
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
 * Description for the `search` tool, listing a sample of available products and
 * the `spec` types the sandboxed search code can use.
 */
export function searchToolDescription(products: string[]): string {
  return `Search the Cloudflare OpenAPI spec. All $refs are pre-resolved inline.

Products: ${products.slice(0, 30).join(', ')}... (${products.length} total)

Types:
${SPEC_TYPES}

Examples:

// Find endpoints by product
async () => {
  const results = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op.tags?.some(t => t.toLowerCase() === 'workers')) {
        results.push({ method: method.toUpperCase(), path, summary: op.summary });
      }
    }
  }
  return results;
}

// Get endpoint with requestBody schema (refs are resolved)
async () => {
  const op = spec.paths['/accounts/{account_id}/d1/database']?.post;
  return { summary: op?.summary, requestBody: op?.requestBody };
}

// Get endpoint parameters
async () => {
  const op = spec.paths['/accounts/{account_id}/workers/scripts']?.get;
  return op?.parameters;
}`
}

/**
 * Description for the `execute` tool, including the per-session Cloudflare type
 * declarations and a multipart Worker-upload example.
 */
export function executeToolDescription(props?: AuthProps): string {
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
