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

/** User-Agent header sent on all outbound requests to Cloudflare APIs. */
export const USER_AGENT = 'cloudflare-mcp'

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
  errors: Array<{ code?: number | string; message: string; documentation_url?: string; path?: Array<string | number> }>;
  messages: Array<{ code: number; message: string }>;
  result_info?: {
    page: number;
    per_page: number;
    total_pages: number;
    count: number;
    total_count: number;
  };
}

// API failures throw; existing try/catch code continues to work.
interface CloudflareApiError extends Error {
  status: number;
  method: string;
  path: string; // Catalog template or redacted route, never raw resource identifiers
  errors: CloudflareResponse["errors"];
  requestId?: string;
  retryAfterSeconds?: number;
  diagnostic: {
    version: 1;
    kind: "cloudflare_api_error" | "graphql_error" | "invalid_api_response";
    upstreamStatus: number;
    operation: { method: string; pathTemplate: string };
    errors: CloudflareResponse["errors"];
    authorization: "unknown";
    retry: "do_not_retry_automatically" | "wait_before_retry";
    requestId?: string;
    retryAfterSeconds?: number;
  };
}

declare const cloudflare: {
  request<T = unknown>(options: CloudflareRequestOptions): Promise<CloudflareResponse<T>>;
};

declare const accountId: string;
`
