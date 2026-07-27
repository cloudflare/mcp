/**
 * Truly static, dependency-free values shared across the worker.
 */

export type ServerInfo = { name: string; version: string }

/**
 * Shared MCP server identity (name + version), consumed across layers: the MCP
 * server handshake (`new McpServer(SERVER_INFO)`) and the metrics tracker
 * (reported as blob1/blob2 on every datapoint, in both the request path and the
 * OAuth handler).
 */
export const SERVER_INFO: ServerInfo = { name: 'cloudflare-api', version: '0.1.0' }

/**
 * Concise, cross-product guidance advertised during MCP discovery and
 * initialization. Keep each variant aligned with the tools exposed by its mode.
 */
export const CODEMODE_SERVER_INSTRUCTIONS =
  'Use `docs` for product questions and `search` for exact API contracts before `execute`. Before changes, verify target IDs and current state; ask if the account, zone, or resource is ambiguous. Filter and paginate results.'

export const NON_CODEMODE_SERVER_INSTRUCTIONS =
  'Use `docs` for product questions and endpoint schemas as exact API contracts. Before changes, verify target IDs and current state; ask if the account, zone, or resource is ambiguous. Filter and paginate large results.'

/**
 * TypeScript declarations describing the `cloudflare` helper and `accountId`
 * binding available to the `execute` tool's sandboxed code. Inlined into the
 * execute tool description.
 */
export const CLOUDFLARE_TYPES = `
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
